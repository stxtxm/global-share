// État de mise à jour partagé entre le processus principal Electron et l'UI.
// Toutes les valeurs numériques sont normalisées : aucun `null`/`NaN` ne doit
// jamais atteindre le rendu (une progression "null" cassait l'ancienne barre).

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'up-to-date'
  | 'unsupported'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  /** Version disponible. Égale à currentVersion tant qu'aucune maj n'est détectée. */
  version: string;
  /** Progression du téléchargement, toujours entre 0 et 100. */
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  /** rpm/deb : l'installation demandera le mot de passe administrateur. */
  requiresAdmin: boolean;
  message: string;
}

const STATUSES: ReadonlySet<string> = new Set<UpdateStatus>([
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'installing',
  'up-to-date',
  'unsupported',
  'error',
]);

export const INITIAL_UPDATE_STATE: UpdateState = {
  status: 'idle',
  currentVersion: '',
  version: '',
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  requiresAdmin: false,
  message: '',
};

function finite(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function bytes(value: unknown): number {
  return Math.max(0, Math.round(finite(value)));
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Rend un état affichable, même si le main envoie `null`, `NaN` ou un champ manquant. */
export function normalizeUpdateState(input: unknown): UpdateState {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const status = STATUSES.has(String(raw.status)) ? (String(raw.status) as UpdateStatus) : 'idle';
  const currentVersion = text(raw.currentVersion) || 'version inconnue';
  const version = text(raw.version) || currentVersion;

  return {
    status,
    currentVersion,
    version,
    percent: Math.min(100, Math.max(0, Math.round(finite(raw.percent)))),
    transferred: bytes(raw.transferred),
    total: bytes(raw.total),
    bytesPerSecond: bytes(raw.bytesPerSecond),
    requiresAdmin: raw.requiresAdmin === true,
    message: text(raw.message),
  };
}

/** Méthodes exposées par desktop/preload.js (absentes sur le web). */
export interface DesktopUpdateBridge {
  isDesktop?: boolean;
  isMobile?: boolean;
  getUpdateState?: () => Promise<unknown>;
  checkForUpdates?: () => Promise<unknown>;
  downloadUpdate?: () => Promise<unknown>;
  installUpdate?: () => Promise<unknown>;
  dismissUpdate?: () => Promise<unknown>;
  onUpdateState?: (listener: (state: unknown) => void) => (() => void) | void;
  onUpdateOpen?: (listener: () => void) => (() => void) | void;
}

export function formatUpdateBytes(value: number): string {
  const size = bytes(value);
  if (size === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
