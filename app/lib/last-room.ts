// Dernier salon rejoint — mémorisé pour la reprise après fermeture.
//
// Un rechargement se contente de la copie de session ; un balayage Android, lui,
// détruit le WebView et son `sessionStorage` alors que les chunks d'un transfert
// survivent dans IndexedDB. On écrit donc aussi une copie durable (`persist`),
// mais elle expire : rejoindre tout seul un salon ouvert plusieurs jours plus
// tôt déposerait l'utilisateur dans une salle vide, sans pair à qui reprendre un
// transfert.
//
// Comme lib/rooms, ce module ne touche au stockage qu'à l'appel : il reste
// importable dans les tests Node.

export const LAST_ROOM_KEY = 'globalshare-last-room';

/**
 * Durée pendant laquelle le salon mémorisé reste proposé au redémarrage. Un
 * salon est éphémère : au-delà, le rejoindre tout seul n'apporte plus rien.
 */
export const LAST_ROOM_TTL_MS = 24 * 60 * 60 * 1000;

export interface RememberedRoom {
  roomId: string;
  name?: string;
  savedAt: number;
}

/** Un stockage absent (hors navigateur) ou refusé vaut un stockage vide. */
function store(name: 'sessionStorage' | 'localStorage'): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window[name];
  } catch {
    // Navigation privée stricte : l'accès lui-même peut lever.
    return undefined;
  }
}

function read(store: Storage | undefined): string | null {
  if (!store) return null;
  try {
    return store.getItem(LAST_ROOM_KEY);
  } catch {
    return null;
  }
}

function write(store: Storage | undefined, value: string): void {
  if (!store) return;
  try {
    store.setItem(LAST_ROOM_KEY, value);
  } catch {
    // Quota ou stockage refusé : la reprise attendra une saisie manuelle.
  }
}

function forget(store: Storage | undefined): void {
  if (!store) return;
  try {
    store.removeItem(LAST_ROOM_KEY);
  } catch {
    // ignore
  }
}

function parseEntry(raw: string | null): RememberedRoom | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RememberedRoom> | null;
    if (!value || typeof value.roomId !== 'string') return null;
    const roomId = value.roomId.trim().slice(0, 64);
    if (!roomId) return null;
    return {
      roomId,
      name: typeof value.name === 'string' && value.name ? value.name : undefined,
      savedAt: typeof value.savedAt === 'number' && Number.isFinite(value.savedAt)
        ? value.savedAt
        : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Mémorise le salon courant. `persist` ajoute la copie durable dont un balayage
 * Android a besoin ; `now` n'existe que pour les tests.
 */
export function rememberLastRoom(
  roomId: string,
  name?: string,
  options: { persist?: boolean; now?: number } = {}
): void {
  const clean = roomId.trim().slice(0, 64);
  if (!clean) return;
  const entry: RememberedRoom = { roomId: clean, name, savedAt: options.now ?? Date.now() };
  const payload = JSON.stringify(entry);
  write(store('sessionStorage'), payload);
  if (options.persist) write(store('localStorage'), payload);
}

/**
 * Salon à rejoindre au démarrage, ou null. La copie de session prime (elle vient
 * de la session en cours) ; la copie durable n'est lue que si `persist` est
 * demandé, et seulement si elle a moins de `LAST_ROOM_TTL_MS`. Une entrée
 * périmée — ou d'une version antérieure, sans date — est supprimée au passage.
 */
export function loadLastRoom(
  options: { persist?: boolean; now?: number } = {}
): { roomId: string; name?: string } | null {
  const sessionEntry = parseEntry(read(store('sessionStorage')));
  if (sessionEntry) return { roomId: sessionEntry.roomId, name: sessionEntry.name };

  if (!options.persist) return null;

  const persistent = store('localStorage');
  const entry = parseEntry(read(persistent));
  if (!entry) return null;

  const age = (options.now ?? Date.now()) - entry.savedAt;
  if (!entry.savedAt || age > LAST_ROOM_TTL_MS) {
    forget(persistent);
    return null;
  }
  return { roomId: entry.roomId, name: entry.name };
}

/** Sortie volontaire du salon : plus rien à rejoindre automatiquement. */
export function clearLastRoom(): void {
  forget(store('sessionStorage'));
  forget(store('localStorage'));
}
