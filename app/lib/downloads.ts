// Téléchargements — historique des fichiers reçus, conservé sur l'appareil.
//
// Sur le bureau, l'application écrit le fichier dans ~/Téléchargements/GlobalShare
// et ne garde que son chemin ; sur le web et le mobile, le blob reste dans
// IndexedDB, borné en taille pour ne pas remplir le stockage du téléphone.
// Ce module ne touche au DOM qu'à travers `indexedDB`, et seulement à l'appel
// des fonctions concernées : il reste importable dans les tests Node.

export type DownloadIntegrity = 'unknown' | 'verified' | 'mismatch';

export interface DownloadRecord {
  id: string;
  name: string;
  size: number;
  mime: string;
  /** Nom de l'appareil qui a envoyé le fichier. */
  from: string;
  receivedAt: number;
  integrity: DownloadIntegrity;
  /** Chemin sur disque — application de bureau uniquement. */
  path?: string;
}

/** Enregistrement tel que stocké : le blob n'existe pas sur le bureau. */
export interface StoredDownload extends DownloadRecord {
  blob?: Blob;
}

// Plafond volontairement modeste : au-delà, le plus ancien sort de la liste
// plutôt que de risquer un quota IndexedDB dépassé sur un téléphone.
export const DOWNLOAD_LIMITS = { maxItems: 40, maxBytes: 128 * 1024 * 1024 };

const DB_NAME = 'globalshare-downloads';
const STORE = 'files';
const DB_VERSION = 1;

/**
 * Nom de fichier sûr : pas de chemin, pas de caractère de contrôle, ni de nom
 * qui se réduirait à `.` ou `..`. L'extension est conservée quand on tronque.
 */
export function sanitizeFileName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  const cleaned = last
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  const safe = cleaned || 'fichier';
  if (safe.length <= 120) return safe;
  const dot = safe.lastIndexOf('.');
  const ext = dot > 0 && safe.length - dot <= 12 ? safe.slice(dot) : '';
  return safe.slice(0, 120 - ext.length) + ext;
}

/** `photo.jpg` déjà pris devient `photo (1).jpg`. */
export function uniqueFileName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let index = 1;
  let candidate = `${base} (${index})${ext}`;
  while (taken.has(candidate)) {
    index += 1;
    candidate = `${base} (${index})${ext}`;
  }
  return candidate;
}

/**
 * Identifiants à supprimer pour rester sous les limites, le plus ancien
 * d'abord. Le fichier le plus récent est toujours conservé, même s'il dépasse
 * la limite à lui seul : sinon il n'apparaîtrait jamais dans l'onglet.
 */
export function planRetention(
  records: StoredDownload[],
  limits: { maxItems: number; maxBytes: number } = DOWNLOAD_LIMITS
): string[] {
  const newestFirst = [...records].sort((a, b) => b.receivedAt - a.receivedAt);
  const dropped: string[] = [];
  let keptItems = 0;
  let keptBytes = 0;

  newestFirst.forEach((record, index) => {
    const size = record.blob?.size ?? 0;
    const fits =
      index === 0 || (keptItems < limits.maxItems && keptBytes + size <= limits.maxBytes);
    if (fits) {
      keptItems += 1;
      keptBytes += size;
      return;
    }
    dropped.push(record.id);
  });

  return dropped;
}

export type ViewerKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'none';

/** Types qu'un navigateur sait afficher directement (sinon : téléchargement). */
export function viewerKind(mime: string, name = ''): ViewerKind {
  const type = (mime || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('text/')) return 'text';
  if (/\.(txt|md|json|csv|log|xml|ya?ml)$/i.test(name)) return 'text';
  return 'none';
}

/** Métadonnées seules : l'état React n'a pas à retenir les blobs. */
export function toPublicDownloads(records: StoredDownload[]): DownloadRecord[] {
  return records.map((record) => ({
    id: record.id,
    name: record.name,
    size: record.size,
    mime: record.mime,
    from: record.from,
    receivedAt: record.receivedAt,
    integrity: record.integrity,
    path: record.path,
  }));
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

export async function loadDownloads(): Promise<StoredDownload[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    const rows = await new Promise<StoredDownload[]>((resolve) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => resolve((request.result ?? []) as StoredDownload[]);
      request.onerror = () => resolve([]);
    });
    return rows.sort((a, b) => b.receivedAt - a.receivedAt);
  } finally {
    db.close();
  }
}

export async function putDownload(record: StoredDownload): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const read = store.getAll();
      read.onsuccess = () => {
        const rows = (read.result ?? []) as StoredDownload[];
        const others = rows.filter((row) => row.id !== record.id);
        const doomed = planRetention([record, ...others]);
        store.put(record);
        doomed.forEach((id) => store.delete(id));
      };
      read.onerror = () => store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } finally {
    db.close();
  }
}

export async function getDownloadBlob(id: string): Promise<Blob | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<Blob | null>((resolve) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      request.onsuccess = () => {
        const row = request.result as StoredDownload | undefined;
        const blob = typeof Blob !== 'undefined' ? row?.blob : undefined;
        resolve(blob instanceof Blob ? blob : null);
      };
      request.onerror = () => resolve(null);
    });
  } finally {
    db.close();
  }
}

export async function deleteDownload(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } finally {
    db.close();
  }
}

export async function clearDownloads(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } finally {
    db.close();
  }
}
