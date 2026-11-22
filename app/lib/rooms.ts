// Salons : création instantanée à un chiffre, historique local et liste des
// salons réellement ouverts (endpoint GET /rooms du serveur Socket.IO).
// Les décisions sont des fonctions pures, testables hors navigateur ; seules
// les entrées/sorties (fetch, localStorage) touchent l'environnement hôte.

export interface LiveRoom {
  roomId: string;
  users: number;
}

export interface RoomHistoryEntry {
  roomId: string;
  name?: string;
  lastUsed: number;
}

export const ROOM_HISTORY_LIMIT = 12;

/** Base du serveur Socket.IO, même règle que l'app (GlobalShare.tsx). */
export function socketBase(): string {
  if (typeof window === 'undefined') return process.env.NEXT_PUBLIC_SOCKET_URL || '';
  if (process.env.NEXT_PUBLIC_SOCKET_URL) return process.env.NEXT_PUBLIC_SOCKET_URL;
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:3001';
  }
  return window.location.origin;
}

/**
 * Salons ouverts à cet instant. En cas d'échec (hors ligne, serveur lent) la
 * liste est vide : l'accueil reste utilisable, il ne bloque jamais dessus.
 */
export async function fetchLiveRooms(socketUrl?: string, timeoutMs = 4000): Promise<LiveRoom[]> {
  if (typeof window === 'undefined') return [];
  const base = (socketUrl ?? socketBase()).replace(/\/+$/, '');
  if (!base) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/rooms`, { signal: controller.signal });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    const raw = body as { rooms?: unknown } | null;
    if (!raw || !Array.isArray(raw.rooms)) return [];
    const seen = new Set<string>();
    const rooms: LiveRoom[] = [];
    for (const entry of raw.rooms) {
      if (!entry || typeof entry !== 'object') continue;
      const { roomId, users } = entry as { roomId?: unknown; users?: unknown };
      if (typeof roomId !== 'string' || !roomId || typeof users !== 'number' || users < 1) continue;
      const clean = roomId.trim().slice(0, 64);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      rooms.push({ roomId: clean, users: Math.floor(users) });
    }
    return rooms;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Plus petit code de salon libre : un chiffre (1, 2, 3…) d'après les salons
 * existants ; si les neuf sont pris, deux chiffres, puis trois. Retourne
 * toujours quelque chose d'exploitable, même si tout le monde occupe tout.
 */
export function pickInstantCode(taken: Iterable<string>): string {
  const busy = new Set<string>();
  for (const code of taken) {
    const clean = typeof code === 'string' ? code.trim().toUpperCase() : '';
    if (clean) busy.add(clean);
  }
  for (let digit = 1; digit <= 9; digit++) {
    const code = String(digit);
    if (!busy.has(code)) return code;
  }
  for (let n = 10; n <= 99; n++) {
    const code = String(n);
    if (!busy.has(code)) return code;
  }
  for (let attempt = 0; attempt < 1000; attempt++) {
    const code = String(100 + Math.floor(Math.random() * 900));
    if (!busy.has(code)) return code;
  }
  // Dernier recours : code long, collision chirurgicalement improbable.
  return `S${Date.now().toString(36).toUpperCase()}`;
}

// --- Historique local (localStorage) ---------------------------------------

const HISTORY_KEY = 'globalshare-rooms';

function readHistory(): RoomHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: RoomHistoryEntry[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const { roomId, name, lastUsed } = item as Record<string, unknown>;
      if (typeof roomId !== 'string' || !roomId.trim()) continue;
      const clean = roomId.trim().slice(0, 64);
      if (seen.has(clean)) continue;
      seen.add(clean);
      entries.push({
        roomId: clean,
        name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 24) : undefined,
        lastUsed: typeof lastUsed === 'number' && Number.isFinite(lastUsed)
          ? lastUsed
          : 0,
      });
    }
    return entries;
  } catch {
    return [];
  }
}

function writeHistory(entries: RoomHistoryEntry[]): void {
  try {
    window.localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(
        entries
          .sort((a, b) => b.lastUsed - a.lastUsed)
          .slice(0, ROOM_HISTORY_LIMIT)
      )
    );
  } catch {
    // Stockage refusé (navigation privée stricte) : l'historique est éphémère.
  }
}

export function loadRoomHistory(): RoomHistoryEntry[] {
  return readHistory().sort((a, b) => b.lastUsed - a.lastUsed);
}

/** À appeler à chaque rejoinsalon réussi : remonte le salon en tête. */
export function rememberRoom(roomId: string, name?: string): void {
  const clean = roomId.trim().slice(0, 64);
  if (!clean) return;
  const rest = readHistory().filter(entry => entry.roomId !== clean);
  writeHistory([{ roomId: clean, name, lastUsed: Date.now() }, ...rest]);
}

export function forgetRoom(roomId: string): RoomHistoryEntry[] {
  const clean = roomId.trim();
  const rest = readHistory().filter(entry => entry.roomId !== clean);
  writeHistory(rest);
  return rest.sort((a, b) => b.lastUsed - a.lastUsed);
}

export function clearRoomHistory(): void {
  writeHistory([]);
}

/** Libellé relatif court pour l'historique (« à l'instant », « hier »…). */
export function formatRoomAge(ms: number, now = Date.now()): string {
  if (!ms) return '';
  const minutes = Math.max(0, Math.floor((now - ms) / 60_000));
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'hier';
  if (days < 7) return `il y a ${days} j`;
  return new Date(ms).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
}
