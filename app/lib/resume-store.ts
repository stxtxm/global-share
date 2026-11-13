// Reprise de transfert — état conservé sur l'appareil.
//
// Un onglet de téléphone peut être tué par le système (verrouillage long,
// pression mémoire) sans cesser d'être « le même » appareil. Pour ne pas
// repartir de zéro, les chunks déjà reçus sont écrits ici au fil de l'eau, et
// les envois en cours laissent de quoi retrouver le fichier d'origine.
//
// Comme lib/downloads, ce module ne touche au DOM qu'à travers `indexedDB` et
// seulement à l'appel : il reste importable dans les tests Node.

/** Envoi interrompu, à réassocier à son fichier après un rechargement. */
export interface StoredSend {
  id: string;
  name: string;
  size: number;
  mime: string;
  hash?: string;
  chunkSize: number;
  targetId: string;
  targetName: string;
  createdAt: number;
  updatedAt: number;
}

const DB_NAME = 'globalshare-resume';
const CHUNK_STORE = 'chunks';
const SEND_STORE = 'sends';
const CHUNK_INDEX = 'byTransfer';
const DB_VERSION = 1;

// Une connexion réutilisée : un chunk fait 64 Ko, en ouvrir une base par paquet
// rendrait le débit dépendant du disque.
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const chunks = db.createObjectStore(CHUNK_STORE, { keyPath: ['transferId', 'seq'] });
        chunks.createIndex(CHUNK_INDEX, 'transferId');
      }
      if (!db.objectStoreNames.contains(SEND_STORE)) {
        db.createObjectStore(SEND_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Une autre version s'ouvre ailleurs : on referme, la prochaine écriture
      // rouvrira une connexion à jour.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      resolve(null);
    };
    request.onblocked = () => resolve(null);
  });

  return dbPromise;
}

/** Écrit un chunk reçu. Appelé à chaque paquet : jamais bloquant. */
export function saveChunk(transferId: string, seq: number, bytes: Uint8Array): void {
  void openDb().then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction(CHUNK_STORE, 'readwrite');
      tx.objectStore(CHUNK_STORE).put({ transferId, seq, bytes });
    } catch {
      // Quota refusé : la reprise repartira du dernier chunk écrit.
    }
  });
}

/** Chunks conservés d'un transfert, indexés par séquence. */
export async function loadChunks(transferId: string): Promise<Map<number, Uint8Array>> {
  const chunks = new Map<number, Uint8Array>();
  const db = await openDb();
  if (!db) return chunks;

  try {
    const rows = await new Promise<{ seq: number; bytes: Uint8Array }[]>((resolve) => {
      const request = db
        .transaction(CHUNK_STORE, 'readonly')
        .objectStore(CHUNK_STORE)
        .index(CHUNK_INDEX)
        .getAll(transferId);
      request.onsuccess = () => resolve((request.result ?? []) as { seq: number; bytes: Uint8Array }[]);
      request.onerror = () => resolve([]);
    });
    rows.forEach((row) => chunks.set(row.seq, new Uint8Array(row.bytes)));
  } catch {
    return chunks;
  }
  return chunks;
}

export function clearChunks(transferId: string): void {
  void openDb().then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction(CHUNK_STORE, 'readwrite');
      const store = tx.objectStore(CHUNK_STORE);
      const cursor = store.index(CHUNK_INDEX).openKeyCursor(transferId);
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        store.delete(current.primaryKey);
        current.continue();
      };
    } catch {
      // Rien à nettoyer.
    }
  });
}

export async function saveSend(record: StoredSend): Promise<void> {
  const db = await openDb();
  if (!db) return;

  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(SEND_STORE, 'readwrite');
      tx.objectStore(SEND_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // Un envoi non mémorisé ne pourra simplement pas être repris après un
    // rechargement : le transfert en cours n'est pas affecté.
  }
}

export async function loadSends(): Promise<StoredSend[]> {
  const db = await openDb();
  if (!db) return [];

  try {
    const rows = await new Promise<StoredSend[]>((resolve) => {
      const request = db.transaction(SEND_STORE, 'readonly').objectStore(SEND_STORE).getAll();
      request.onsuccess = () => resolve((request.result ?? []) as StoredSend[]);
      request.onerror = () => resolve([]);
    });
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function deleteSend(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;

  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(SEND_STORE, 'readwrite');
      tx.objectStore(SEND_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // Tant pis : l'entrée restera comme envoi à reprendre.
  }
}
