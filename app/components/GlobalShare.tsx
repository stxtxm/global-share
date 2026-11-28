'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { io, Socket } from 'socket.io-client';
import SimplePeer from 'simple-peer/simplepeer.min.js';
import JSZip from 'jszip';
import {
  TransferManager,
  TransferState,
  IntegrityStatus,
  sha256Hex,
  HASH_MAX_BYTES,
} from './TransferManager';
import {
  DOWNLOAD_LIMITS,
  clearDownloads as clearStoredDownloads,
  deleteDownload as deleteStoredDownload,
  getDownloadBlob,
  loadDownloads,
  putDownload,
  sanitizeFileName,
  toPublicDownloads,
  mimeFromName,
  viewerKind,
  type DownloadRecord,
  type StoredDownload,
} from '../lib/downloads';
import { keepScreenAwake, releaseScreenWakeLock } from '../lib/wake-lock';
import { clearChunks, deleteSend, loadChunks, loadSends, saveChunk, saveSend } from '../lib/resume-store';
import type { DesktopUpdateBridge } from '../lib/update';
// Installe le pont Capacitor dans l'APK avant le premier rendu.
import '../lib/mobile-bridge';
import {
  isMobileHost,
  mobileFinishTransfer,
  mobileDeleteDownload,
  mobileKeepAlive,
  mobileListDownloads,
  mobileRevealDownload,
  mobileRequestBatteryExemption,
  mobileStartTransfer,
  mobileStopTransfer,
  mobileUpdateTransfer,
} from '../lib/mobile-bridge';
import type { SharedFile } from '../lib/mobile-bridge';
import { saveBlobToSharedStorage } from '../lib/mobile-files';
import { mobileOpenDownload } from '../lib/mobile-bridge';
import {
  isDesktopHost,
  listReceiveFolderFiles,
  openReceiveFolder,
  type ReceiveFolderFile,
} from '../lib/receive-folder';
import { UpdateBanner, UpdateTrigger } from './UpdateManager';
import {
  fetchLiveRooms,
  clearRoomHistory,
  forgetRoom as forgetStoredRoom,
  formatRoomAge,
  loadRoomHistory,
  pickInstantCode,
  rememberRoom,
  type LiveRoom,
  type RoomHistoryEntry,
} from '../lib/rooms';
import { clearLastRoom, loadLastRoom, rememberLastRoom } from '../lib/last-room';
import {
  loadSettings as loadAppSettings,
  saveSettings as saveAppSettings,
  resetSettings as resetAppSettings,
  applyAppearance,
  type AppSettings,
  DEFAULT_SETTINGS,
} from '../lib/settings';
import SettingsPanel from './SettingsPanel';
import pkgVersion from '../../package.json';
import { translate as translateSetting } from '../lib/settings-i18n';

// 24 × 512 Ko = 12 Mo en vol sur le relais : de quoi remplir le tuyau même
// avec un RTT de plusieurs centaines de millisecondes (réseaux différents).
const MAX_IN_FLIGHT_CHUNKS = 24;
// Même réseau local : le canal direct est alors court, à faible latence et sans
// perte — on peut démultiplier la taille des blocs et la profondeur du pipeline
// sans risque, pour un débit proche de celui du Wi-Fi lui-même.
const MAX_IN_FLIGHT_CHUNKS_LAN = 16;
const CHUNK_SIZE_LAN = 512 * 1024;
// Garde-fou : au-delà, le tampon SCTP du canal_data sature (le navigateur
// peut clore le canal). On ralentit plutôt la boucle d'émission.
const P2P_BUFFERED_LIMIT = 4 * 1024 * 1024;
// Relais : ne pas enfoncer plus d'un mégaoctet dans la socket WebSocket. Le
// pong de keepalive voyage dans la même socket : derrière 6 Mo de chunks à
// 250 Ko/s il met 24 s à remonter, soit un ping manqué. Le Worker ne tolère
// qu'un intervalle de grâce avant de fermer, et le transfert repartait alors
// de zéro en boucle — c'est ce qui rendait le relais « lent puis cassé » entre
// deux réseaux. En gardant la socket presque vide, le pong repasse tout de
// suite et le débit reste celui du lien.
const RELAY_BUFFERED_LIMIT = 1024 * 1024;

/** Octets déjà en attente d'écriture sur la socket de signalisation. */
function socketBufferedAmount(socket: Socket | null): number {
  // `engine.transport` n'est pas typé par socket.io-client ; on lit le nombre
  // d'octets en file sans dépendre de son type interne.
  const transport = (socket as unknown as {
    engine?: { transport?: { writable?: boolean; ws?: { bufferedAmount?: number } } };
  } | null)?.engine?.transport;
  return transport?.ws?.bufferedAmount ?? 0;
}

import './GlobalShare.css';

// Délai au-delà duquel une tentative de connexion directe est abandonnée : le
// relais prend le relais sans que l'utilisateur ait à attendre.
const P2P_CONNECT_TIMEOUT_MS = 15_000;
// Serveurs ICE. Les STUN publics suffisent sur la plupart des réseaux ; derrière
// un NAT symétrique (4G de certains opérateurs, réseaux d'entreprise) seule une
// redirection TURN permet d'établir la connexion, sinon on retombe sur le relais
// Socket.IO. Le TURN se configure au build via NEXT_PUBLIC_TURN_* ; sans ces
// variables, rien ne change (STUN seul).
const TURN_URLS = (process.env.NEXT_PUBLIC_TURN_URLS ?? '')
  .split(',')
  .map(url => url.trim())
  .filter(Boolean);
// Repli statique, utile si aucun secret TURN n'est configuré côté Worker.
const BASE_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  ...(TURN_URLS.length > 0
    ? [{
      urls: TURN_URLS,
      username: process.env.NEXT_PUBLIC_TURN_USERNAME ?? '',
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL ?? '',
    }]
    : []),
];

// Trames du canal de données P2P : longueur de l'id, id, séquence (uint32),
// puis les octets bruts. Le JSON aurait quadruplé le volume (tableaux de
// nombres) et dépassé la taille de message admise par les DataChannels.
const encodeChunkFrame = (transferId: string, seq: number, chunk: Uint8Array): Uint8Array => {
  const id = new TextEncoder().encode(transferId);
  const header = 1 + id.length + 4;
  const frame = new Uint8Array(header + chunk.byteLength);
  frame[0] = id.length;
  frame.set(id, 1);
  new DataView(frame.buffer).setUint32(1 + id.length, seq);
  frame.set(chunk, header);
  return frame;
};

const decodeChunkFrame = (
  data: Uint8Array
): { transferId: string; seq: number; chunk: Uint8Array } | null => {
  if (data.byteLength < 5) return null;
  const idLength = data[0];
  const header = 1 + idLength + 4;
  if (idLength === 0 || data.byteLength < header) return null;
  const transferId = new TextDecoder().decode(data.subarray(1, 1 + idLength));
  const seq = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1 + idLength);
  return { transferId, seq, chunk: data.subarray(header) };
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
const generateRoomId = () => Math.random().toString(36).substr(2, 6).toUpperCase();
const detectDevice = () => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'Device';
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad/i.test(ua)) return 'iOS';
  if (/windows/i.test(ua)) return 'Windows';
  return 'Linux/Mac';
};
const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};
const formatTime = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};
const formatSpeed = (bytesPerSec: number): string => {
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
};

/** Temps restant estimé en texte court (« 2 min 15 », « 45 s »). */
const formatEta = (remainingBytes: number, bytesPerSec: number): string | null => {
  if (remainingBytes <= 0 || bytesPerSec <= 0) return null;
  const secs = Math.round(remainingBytes / bytesPerSec);
  if (secs < 60) return `${secs} s`;
  const mins = Math.floor(secs / 60);
  const rest = secs % 60;
  if (mins < 60) return rest ? `${mins} min ${rest} s` : `${mins} min`;
  const hours = Math.floor(mins / 60);
  return `${hours} h ${mins % 60} min`;
};

/** Bytes confirmés pondérés : la progression globale d'une file. */
const weightedProgress = (items: Pick<TransferState, 'progress' | 'confirmed' | 'file'>[]): number => {
  const totalBytes = items.reduce((sum, t) => sum + t.file.size, 0);
  if (totalBytes <= 0) return items.length ? Math.round(items.reduce((s, t) => s + t.progress, 0) / items.length) : 0;
  const done = items.reduce((sum, t) => sum + t.confirmed, 0);
  return Math.min(100, Math.round((done / totalBytes) * 100));
};

/** Courbe SVG du débit récent, normalisée par sa valeur maximale. */
function SpeedSparkline({ history, active }: { history: number[]; active: boolean }) {
  if (!history || history.length < 2) return null;
  const max = Math.max(1, ...history);
  const w = 120;
  const h = 28;
  const pts = history.map((v, i) => {
    const x = (i / (history.length - 1)) * w;
    const y = h - (v / max) * (h - 3) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg className={`gs-sparkline${active ? ' is-active' : ''}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={`${pts.join(' ')}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Barre de progression sobre : un dégradé fixe, aucun balayage clignotant. */
function TransferBar({ progress, status }: { progress: number; status: string }) {
  return (
    <div className="gs-bar" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
      <div
        className={`gs-bar-fill gs-bar-fill--${status}${progress >= 100 ? ' is-done' : ''}`}
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}
// Date de réception, dans le format court français (12 nov. 15:04).
const formatDate = (ms: number): string =>
  new Date(ms).toLocaleString('fr-FR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
const getSocketUrl = (): string => {
  if (typeof window !== 'undefined') {
    if (process.env.NEXT_PUBLIC_SOCKET_URL) return process.env.NEXT_PUBLIC_SOCKET_URL;
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') return 'http://localhost:3001';
    return window.location.origin;
  }
  return process.env.NEXT_PUBLIC_SOCKET_URL || '';
};

// Identité de session de l'onglet : conservée dans sessionStorage, elle survit
// aux reconnexions (et à un rechargement) sans être partagée entre deux onglets.
// C'est elle que visent les pairs, jamais `socket.id`, qui change à chaque
// reconnexion.
const SESSION_KEY = 'globalshare-session-id';
// Dernier salon rejoint : un onglet restauré après avoir été tué y retourne
// sans que l'utilisateur ait à retaper le code (voir lib/last-room, qui gère la
// copie durable Android et sa limite de fraîcheur).
const getSessionId = (): string => {
  if (typeof window === 'undefined') return '';
  try {
    const existing = window.sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const id = (
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
    ).replace(/-/g, '').slice(0, 20);
    window.sessionStorage.setItem(SESSION_KEY, id);
    return id;
  } catch {
    // Stockage refusé (navigation privée stricte) : identité éphémère suffit.
    return `s${Date.now().toString(36)}`;
  }
};

// Libellés des états de transfert, pour ne pas afficher l'identifiant brut.
const TRANSFER_LABELS: Record<string, string> = {
  pending: 'En attente',
  queued: 'En file',
  transferring: 'En cours',
  paused: 'En pause',
  interrupted: 'Interrompu',
  completed: 'Terminé',
  cancelled: 'Annulé',
  failed: 'Échec',
};

// ---------------------------------------------------------------------------
// Icônes — SVG inline : aucune requête réseau, taille pilotée par le CSS.
// ---------------------------------------------------------------------------
interface IconProps {
  className?: string;
}

const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

function IconBolt({ className = 'gs-icon' }: IconProps) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z" />
    </svg>
  );
}

function IconArrowLeft({ className = 'gs-icon' }: IconProps) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </svg>
  );
}

function IconKey({ className = 'gs-icon' }: IconProps) {
  return (
    <svg {...iconProps} className={className}>
      <circle cx="8.5" cy="15.5" r="4" />
      <path d="m11.5 12.5 8-8" />
      <path d="m16 5 3 3" />
      <path d="m14 7 3 3" />
    </svg>
  );
}

function IconShare({ className = 'gs-icon' }: IconProps) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M12 15V4" />
      <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
      <path d="M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6" />
    </svg>
  );
}

function IconClose({ className = 'gs-icon' }: IconProps) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function IconFile({ className = 'gs-icon' }: IconProps) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

function IconMusic({ className = 'gs-icon' }: IconProps) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

function IconFolder({ className = 'gs-icon' }: IconProps) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function IconCamera({ className = 'gs-icon' }: IconProps) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.2" />
    </svg>
  );
}

function IconDownload({ className = 'gs-icon' }: IconProps) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M12 4v10" />
      <path d="m7.5 9.5 4.5 4.5 4.5-4.5" />
      <path d="M5 20h14" />
    </svg>
  );
}

function IconOpen({ className = 'gs-icon' }: IconProps) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

function IconTrash({ className = 'gs-icon' }: IconProps) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function IconDevices({ className = 'gs-icon' }: IconProps) {
  return (
    <svg {...iconProps} className={className}>
      <rect x="2.5" y="5" width="13" height="9.5" rx="2" />
      <path d="M6.5 18.5h5" />
      <rect x="16.5" y="10" width="5" height="9.5" rx="1.6" />
    </svg>
  );
}

function IconHistory({ className = 'gs-icon' }: IconProps) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M4 5.5v4h4" />
      <path d="M4.6 9.5a8 8 0 1 1-.6 3" />
      <path d="M12 8.5V12l2.8 1.8" />
    </svg>
  );
}

function IconSettings({ className = 'gs-icon' }: IconProps) {
  return (
    <svg {...iconProps} className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------
interface PeerInfo {
  id: string; name: string; status: 'connecting' | 'connected'; method: 'p2p' | 'relay';
}
interface Toast {
  id: number; type: 'info' | 'success' | 'error' | 'warning'; message: string;
}
declare global {
  interface Window {
    globalShare?: {
      onFileSaved?: (
        blob: Blob,
        name: string,
        integrity: IntegrityStatus,
        from?: string
      ) => void;
    };
    /** Pont exposé par Electron (desktop/preload.js) ; absent sur le web. */
    globalshareDesktop?: {
      isDesktop?: boolean;
      saveDownload: (payload: {
        name: string;
        mime: string;
        bytes: ArrayBuffer;
      }) => Promise<{ path?: string; error?: string }>;
      openDownload: (filePath: string) => Promise<string>;
      revealDownload: (filePath: string) => Promise<string>;
      getDownloadFolder?: () => Promise<{ path?: string; custom?: boolean; error?: string }>;
      chooseDownloadFolder?: () => Promise<{
        path?: string; custom?: boolean; canceled?: boolean; error?: string;
      }>;
      resetDownloadFolder?: () => Promise<{ path?: string; custom?: boolean; error?: string }>;
      listDownloads?: () => Promise<{
        folder?: string;
        files?: ReceiveFolderFile[];
        error?: string;
      }>;
      openDownloadFolder?: () => Promise<string>;
      /** Prévient l'arrière-plan (anti-veille, tray) du nombre de transferts actifs. */
      setTransfersActive?: (count: number) => Promise<unknown>;
    } & DesktopUpdateBridge;
  }
}

// ----------------------------------------------------------------------------
// Composant principal
// ----------------------------------------------------------------------------
export default function GlobalShare() {
  // ---- État ----
  const [step, setStep] = useState<'welcome' | 'room'>('welcome');
  const [roomId, setRoomId] = useState('');
  const [myName, setMyName] = useState(() => detectDevice());
  const [peers, setPeers] = useState<Record<string, PeerInfo>>({});
  const [transfers, setTransfers] = useState<TransferState[]>([]);
  // Onglet actif : le salon en cours, ou l'historique des fichiers reçus.
  const [tab, setTab] = useState<'room' | 'downloads'>('room');
  // Historique des téléchargements, conservé sur l'appareil (voir lib/downloads).
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  // Fichiers réellement présents dans Téléchargements/GlobalShare (Android).
  const [sharedFiles, setSharedFiles] = useState<SharedFile[]>([]);
  // Fichiers réellement présents dans le dossier de réception du bureau.
  const [desktopFiles, setDesktopFiles] = useState<ReceiveFolderFile[]>([]);
  const [desktopFolder, setDesktopFolder] = useState('');
  // Sous-onglet de la page Téléchargements : l'historique des fichiers reçus
  // ou les fichiers réellement présents dans le dossier de réception.
  const [downloadsTab, setDownloadsTab] = useState<'received' | 'device'>('received');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [connectErrorMessage, setConnectErrorMessage] = useState<string | null>(null);
  // Incrémenté à chaque socket créé : le TransferManager se rattache au bon socket.
  const [socketEpoch, setSocketEpoch] = useState(0);
  const [activePeerId, setActivePeerId] = useState<string | null>(null);
  const [trackingOpen, setTrackingOpen] = useState(false);
  // Cartes de transfert développées (détails : débit, ETA, courbe).
  const [expandedTransfers, setExpandedTransfers] = useState<Set<string>>(new Set());
  // Glisser-déposer de fichiers sur la fenêtre (desktop).
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);
  // Encart de mise à jour : ouvert depuis le bouton de la barre supérieure,
  // depuis le menu Aide d'Electron, ou automatiquement quand une maj arrive.
  const [updateOpen, setUpdateOpen] = useState(false);
  // Accueil : salons ouverts à cet instant et historique local des salons.
  const [liveRooms, setLiveRooms] = useState<LiveRoom[]>([]);
  const [roomHistory, setRoomHistory] = useState<RoomHistoryEntry[]>([]);
  // Vue de l'accueil, pilotée par la barre de navigation basse :
  // « create » par défaut (créer un salon en un chiffre), « join » (rejoindre
  // avec un code), « rooms » (salons ouverts et récents) et « settings »
  // (réglages de l'application, toujours accessibles depuis la barre basse).
  const [homeView, setHomeView] = useState<'create' | 'join' | 'rooms' | 'settings'>('create');
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  // Réglages ouverts par-dessus le salon (page plein écran avec retour),
  // distincts de la vue accueil : quitter le salon n'est jamais nécessaire
  // pour consulter ou modifier un réglage.
  const [roomSettingsOpen, setRoomSettingsOpen] = useState(false);

  // ---- Refs ----
  const socketRef = useRef<Socket | null>(null);
  const managerRef = useRef<TransferManager | null>(null);
  const peersRef = useRef<Record<string, SimplePeer>>({});
  // État de la négociation directe par pair, et son délai d'abandon.
  const p2pStateRef = useRef<Record<string, 'connecting' | 'open' | 'failed'>>({});
  const p2pTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const fileRefs = useRef<Map<string, File>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const transferTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Empêche deux exécutions simultanées de la boucle d'envoi.
  const sendLoopRunningRef = useRef(false);
  // Calculs d'empreinte en cours, sérialisés : chaque fichier de la file était
  // sinon lu d'un bloc en mémoire en même temps que les autres, soit plusieurs
  // centaines de Mo sur un téléphone pour une sélection de gros fichiers.
  const sendHashChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const sendLoopRef = useRef<(() => void) | null>(null);
  const sendLoopKickPendingRef = useRef(false);
  // Valeur courante du réglage « Tentatives », lue à la création du manager :
  // un effet séparé ne suffisait pas après une reconnexion (manager recréé).
  const maxRetriesRef = useRef(DEFAULT_SETTINGS.maxRetries);
  const connectDeadlineTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectErrorShownRef = useRef(false);
  // Identité stable du salon : les transferts la visent, pas `socket.id`.
  const mySessionIdRef = useRef('');
  // Reprise d'un envoi après rechargement : le fichier d'origine est redemandé.
  const resumeInputRef = useRef<HTMLInputElement>(null);
  const resumeTargetRef = useRef<string | null>(null);
  const toastIdRef = useRef(0);
  const toastTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const downloadIdRef = useRef(0);
  // Blobs de la session : ouvrir un fichier juste reçu n'attend pas IndexedDB.
  const downloadBlobRef = useRef<Map<string, Blob>>(new Map());
  // Noms des pairs par identifiant : l'expéditeur n'envoie que son id.
  const peerNamesRef = useRef<Record<string, string>>({});
  const iceServersRef = useRef<RTCIceServer[]>(BASE_ICE_SERVERS);
  const turnValidUntilRef = useRef(0);
  // Pairs dont le chemin direct est un chemin local (candidats « host » des
  // deux côtés) : même réseau, on augmente blocs et pipeline pour eux.
  const lanPeersRef = useRef<Set<string>>(new Set());

  const [renderTime, setRenderTime] = useState(0);

  // ---- Réglages : chargement initial puis application en direct ----
  // Une seule source de vérité : localStorage (lib/settings). Le thème, la
  // couleur d'accent et la langue s'appliquent immédiatement, sans recharger.
  useEffect(() => {
    const loaded = loadAppSettings();
    setAppSettings(loaded);
    applyAppearance(loaded);
  }, []);

  useEffect(() => {
    applyAppearance(appSettings);
  }, [appSettings]);

  // Thème « Auto » : ré-appliquer quand l'OS bascule clair/sombre en direct.
  useEffect(() => {
    if (appSettings.theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyAppearance(appSettings);
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    }
    return undefined;
  }, [appSettings, appSettings.theme]);

  // Modifie un réglage, l'applique et persiste : renvoyé au panneau qui rend
  // les contrôles, pour que toute interaction reste un aller simple vers ici.
  const updateAppSetting = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      setAppSettings(prev => {
        const next = { ...prev, [key]: value };
        saveAppSettings(next);
        return next;
      });
    },
    []
  );

  const showToast = useCallback(
    (type: Toast['type'], message: string) => {
      // Notifications désactivées : les confirmations et infos passent sous
      // silence, les erreurs et avertissements restent visibles (sécurité).
      if (!appSettings.notificationsEnabled && (type === 'success' || type === 'info')) return;
      const id = ++toastIdRef.current;
      setToasts(prev => [...prev, { id, type, message }]);
      const duration = Math.max(2, appSettings.notificationDuration) * 1000;
      const timer = setTimeout(() => {
        toastTimersRef.current.delete(timer);
        setToasts(prev => prev.filter(t => t.id !== id));
      }, duration);
      toastTimersRef.current.add(timer);
    },
    [appSettings.notificationsEnabled, appSettings.notificationDuration]
  );

  // Petit signal sonore discret à l'arrivée d'un fichier (réglage « Son ») :
  // WebAudio, aucune ressource externe, jamais bloquant pour le transfert.
  const notificationAudioRef = useRef<AudioContext | null>(null);
  const playNotificationSound = useCallback(() => {
    if (!appSettings.notificationsEnabled || !appSettings.notificationSound) return;
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = notificationAudioRef.current ?? new Ctx();
      notificationAudioRef.current = ctx;
      if (ctx.state === 'suspended') void ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.09);
      gain.gain.setValueAtTime(0.05, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.32);
    } catch {
      /* le son ne doit jamais faire échouer la réception */
    }
  }, [appSettings.notificationsEnabled, appSettings.notificationSound]);

  // Nettoyage : aucun timer ni contexte audio ne survit au démontage (évite
  // les mises à jour sur un composant démonté et libère les ressources mobiles).
  useEffect(() => () => {
    for (const timer of toastTimersRef.current) clearTimeout(timer);
    toastTimersRef.current.clear();
    const audio = notificationAudioRef.current;
    if (audio && audio.state !== 'closed') void audio.close().catch(() => {});
  }, []);

  // Réinitialise tous les réglages aux valeurs par défaut, avec toast animé.
  const resetAllSettings = useCallback(() => {
    const defaults = resetAppSettings();
    setAppSettings(defaults);
    showToast('success', translateSetting(appSettings.language, 'settingsResetToast'));
  }, [showToast, appSettings.language]);

  const appVersion = pkgVersion?.version ?? 'dev';

  // Réglage « Tentatives » : conservé dans une ref, appliqué à chaque création
  // du gestionnaire (le socket est recréé à chaque reconnexion / changement de
  // salon) et mis à jour à chaud sur le manager courant.
  useEffect(() => {
    maxRetriesRef.current = appSettings.maxRetries;
    if (managerRef.current) managerRef.current.maxRetries = appSettings.maxRetries;
  }, [appSettings.maxRetries]);

  // Réglage « Rafraîchissement auto » : relit l'historique des salons sur
  // l'intervalle choisi, pour suivre les listes modifiées ailleurs (autre
  // onglet, autre session) et remettre le temps écoulé à l'heure.
  useEffect(() => {
    if (!appSettings.autoRefresh) return;
    const interval = Math.max(5, appSettings.autoRefreshInterval) * 1000;
    const id = setInterval(() => {
      setRoomHistory(loadRoomHistory());
      setRenderTime(Date.now());
    }, interval);
    return () => clearInterval(id);
  }, [appSettings.autoRefresh, appSettings.autoRefreshInterval, step]);

  // Maintenir un timestamp de rafraîchissement pour l'affichage du temps écoulé
  // (évite d'appeler Date.now() directement pendant le render).
  useEffect(() => {
    setRenderTime(Date.now());
    const id = setInterval(() => setRenderTime(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // ---- Écran maintenu allumé pendant un transfert ----
  // Un téléphone qui s'éteint gèle la page : la socket tombe et plus rien ne
  // circule. La Wake Lock empêche au moins l'extinction automatique ; la reprise
  // automatique couvre le verrouillage manuel et les coupures réseau.
  const hasActiveTransfers = transfers.some(
    t => t.status === 'transferring' || t.status === 'pending' || t.status === 'paused' || t.status === 'queued'
  );
  useEffect(() => {
    if (!hasActiveTransfers) {
      void releaseScreenWakeLock();
      return;
    }
    void keepScreenAwake();
    return () => { void releaseScreenWakeLock(); };
  }, [hasActiveTransfers]);

  const kickSendLoop = useCallback(() => {
    // Appel direct, sans setTimeout : écran éteint (Android) ou fenêtre
    // masquée (Electron), Chromium bride les minuteurs à ~1/min. Chaque ACK
    // reprogrammait pourtant la boucle par un timer de 0 ms : le transfert
    // avançait par à-coups d'un bloc par minute. Le verrou de sendLoop absorbe
    // les appels concurrents, et un kick reçu pendant une passe est rejoué à
    // sa sortie : aucun ACK n'est perdu, même sans minuteur.
    if (sendLoopRunningRef.current) {
      sendLoopKickPendingRef.current = true;
      return;
    }
    sendLoopRef.current?.();
  }, []);

  // Android : le service avant-plan et le wake lock partiel maintiennent le
  // WebView et le réseau en vie quand l'écran est verrouillé. Sur desktop/web,
  // les helpers ne font rien (pas de pont natif).
  const nativeTransferCount = transfers.filter(
    t => t.status === 'transferring' || t.status === 'pending' || t.status === 'paused' || t.status === 'queued'
  ).length;
  const nativeTransferProgress = nativeTransferCount
    ? weightedProgress(transfers.filter(
        t => t.status === 'transferring' || t.status === 'pending' || t.status === 'paused' || t.status === 'queued'
      ))
    : 0;
  const nativeTransferStartedRef = useRef(false);

  useEffect(() => {
    if (nativeTransferCount > 0 && !nativeTransferStartedRef.current) {
      mobileStartTransfer(nativeTransferCount, nativeTransferProgress);
      nativeTransferStartedRef.current = true;
    } else if (nativeTransferCount === 0 && nativeTransferStartedRef.current) {
      // Transfert terminé mais SALON TOUJOURS OUVERT : ne surtout pas couper le
      // service, sinon le prochain transfert part en veille sans protection.
      mobileFinishTransfer();
      nativeTransferStartedRef.current = false;
    }
    // Bureau : anti-veille système pendant les transferts (équivalent du
    // service avant-plan Android) ; ne fait rien sur le web/le mobile.
    void window.globalshareDesktop?.setTransfersActive?.(nativeTransferCount);
  }, [nativeTransferCount, nativeTransferProgress]);

  useEffect(() => {
    if (nativeTransferCount > 0 && nativeTransferStartedRef.current) {
      mobileUpdateTransfer(nativeTransferCount, nativeTransferProgress);
    }
  }, [nativeTransferCount, nativeTransferProgress]);

  // Le service avant-plan doit vivre pendant TOUT le salon, y compris quand le
  // réseau tombe en veille : c'est précisément là qu'il faut garder le CPU et
  // le Wi-Fi éveillés pour que la socket puisse se reconnecter. L'ancien code
  // appelait keepAlive(false) sur `disconnected`, ce qui éteignait le service
  // (et le wake lock) au moment exact du besoin.
  useEffect(() => {
    if (step === 'room') mobileKeepAlive(true);
  }, [step]);

  // Le tick natif (toutes les 10 s, tant que le wake lock est tenu) remplace
  // les timers JS bridés par Chromium après 5 min d'écran éteint. Il relance
  // la boucle d'envoi et la reprise sans dépendre du WebView.
  useEffect(() => {
    if (step !== 'room') return;
    const off = window.globalshareMobile?.onServiceTick?.(() => {
      mobileKeepAlive(true);
      const socket = socketRef.current;
      if (socket && !socket.connected) socket.connect();
      managerRef.current?.resumeInterrupted();
      // Appel direct (pas un setTimeout) : c'est tout l'intérêt du tick natif.
      sendLoopRef.current?.();
    });
    return () => { if (typeof off === 'function') off(); };
  }, [step, kickSendLoop]);

  // Retour au premier plan : le listener vit pour toute la session salon (et
  // non dans l'effet hasActiveTransfers, qui se démontait dès que les transferts
  // passaient en `interrupted` — le retour au premier plan ne relançait rien).
  useEffect(() => {
    if (step !== 'room') return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void keepScreenAwake();
      mobileKeepAlive(true);
      const socket = socketRef.current;
      if (socket && !socket.connected) socket.connect();
      managerRef.current?.resumeInterrupted();
      kickSendLoop();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [step, kickSendLoop]);

  // Rechargement de l'historique conservé (IndexedDB) au démarrage.
  useEffect(() => {
    let cancelled = false;
    void loadDownloads().then(rows => {
      if (cancelled) return;
      rows.forEach(row => {
        if (row.blob) downloadBlobRef.current.set(row.id, row.blob);
      });
      setDownloads(toPublicDownloads(rows));
    });
    return () => { cancelled = true; };
  }, []);

  // Les pairs ne sont connus que par leur id : on garde leur nom sous la main
  // pour étiqueter les fichiers reçus dans l'historique.
  useEffect(() => {
    peerNamesRef.current = Object.fromEntries(
      Object.entries(peers).map(([id, peer]) => [id, peer.name])
    );
  }, [peers]);

  // ---- Initialisation du TransferManager ----
  // Les mises à jour de progression (un appel par chunk reçu, par ack reçu)
  // sont regroupées : au-delà de quelques centaines de blocs/s, un re-rendu
  // React par événement consommait tout le CPU du téléphone à la place du
  // transfert. Un rafraîchissement groupé à ~5 Hz suffit pour l'affichage ;
  // débuts comme fins de transfert restent immédiats.
  const transfersSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncTransfers = useCallback(() => {
    if (transfersSyncTimerRef.current !== null) return;
    transfersSyncTimerRef.current = setTimeout(() => {
      transfersSyncTimerRef.current = null;
      // Filet de sécurité : même si le manager garde un transfert terminal,
      // il ne doit jamais réapparaître dans la liste après une annulation.
      const terminal = new Set(['cancelled', 'completed', 'failed']);
      setTransfers((managerRef.current?.getAll() ?? []).filter(t => !terminal.has(t.status)));
    }, 200);
  }, []);

  // Un ACK libère un créneau : relancer la boucle d'envoi tout de suite plutôt
  // que d'attendre son tick (les timers des WebView mobiles sont bridés en
  // arrière-plan, ce qui faisait chuter le débit après quelques secondes).
  // Annulation robuste : le manager supprime maintenant le transfert de son
  // registre et coupe tous ses timers. On gère aussi la ligne « orpheline »
  // (ancien transfert resté à l'écran après une recréation du manager) et on
  // annule le rafraîchissement groupé en attente pour éviter toute résurgence.
  const cancelTransfer = useCallback((id: string) => {
    const manager = managerRef.current;
    if (!manager?.get(id)) {
      setTransfers(prev => prev.filter(t => t.id !== id));
      fileRefs.current.delete(id);
      void deleteSend(id);
      return;
    }
    manager.cancel(id, 'Annulé');
    if (transfersSyncTimerRef.current !== null) {
      clearTimeout(transfersSyncTimerRef.current);
      transfersSyncTimerRef.current = null;
    }
    setTransfers(prev => prev.filter(t => t.id !== id));
    fileRefs.current.delete(id);
    void deleteSend(id);
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;
    const manager = new TransferManager(
      socket,
      mySessionIdRef.current || getSessionId(),
      {
        onUpdate: (t) => {
          // Nouveau transfert : ajout immédiat. Sinon, rafraîchissement groupé
          // (voir syncTransfers) : un setState par chunk saturait le rendu.
          if (t.status !== 'cancelled' && t.status !== 'completed' && t.status !== 'failed') {
            setTransfers(prev => (prev.some(x => x.id === t.id) ? [...prev] : [...prev, t]));
          }
          syncTransfers();
        },
        onComplete: (t) => {
          setTransfers(prev => prev.filter(x => x.id !== t.id));
          fileRefs.current.delete(t.id);
          void deleteSend(t.id);
          // Le message d'enregistrement est émis par saveFile, qui connaît le
          // nom de l'expéditeur et sait où le fichier a été rangé.
        },
        onCancel: (t, reason) => {
          setTransfers(prev => prev.filter(x => x.id !== t.id));
          fileRefs.current.delete(t.id);
          void deleteSend(t.id);
          showToast('info', `Transfert annulé : ${t.file.name} (${reason})`);
        },
        onError: (t, error) => {
          setTransfers(prev => prev.filter(x => x.id !== t.id));
          fileRefs.current.delete(t.id);
          void deleteSend(t.id);
          showToast('error', `Échec du transfert : ${t.file.name} — ${error}`);
        },
        onStatus: () => syncTransfers(),
        onAck: kickSendLoop,
        onSendDone: () => {},
      }
    );
    managerRef.current = manager;
    manager.maxRetries = maxRetriesRef.current;
    // Les chunks d'un transfert marqué P2P partent par le canal direct ; si le
    // canal n'est pas (ou plus) ouvert, le TransferManager retombe sur le
    // socket, donc sur le relais, sans perdre le transfert en cours.
    manager.p2pSender = (t, seq, chunk) => {
      const peer = peersRef.current[t.targetId];
      if (!peer || peer.destroyed || !peer.connected) return false;
      try {
        peer.send(encodeChunkFrame(t.id, seq, chunk));
        return true;
      } catch {
        return false;
      }
    };

    const s = socket;
    s.on('transfer-init', (p) => manager.onTransferInit(p));
    // Les chunks reçus par le socket viennent forcément du relais.
    s.on('transfer-chunk', (p) => manager.onTransferChunk({ ...p, via: 'relay' }));
    s.on('transfer-ack', (p) => manager.onTransferAck(p));
    s.on('transfer-eof', (p) => manager.onTransferEof(p));
    s.on('transfer-eof-ack', (p) => manager.onTransferEofAck(p));
    s.on('transfer-cancel', (p) => manager.onTransferCancel(p));
    s.on('transfer-end', (p) => manager.onTransferEnd(p));
    s.on('transfer-resync', (p) => {
      manager.onTransferResync(p);
      // Ne relancer la boucle que si le transfert est toujours actif : un
      // resync en vol après une annulation ne doit pas le faire revivre.
      if (manager.get(p.transferId)?.status === 'transferring') kickSendLoop();
    });

    // Les chunks reçus sont écrits au fil de l'eau : un onglet tué par le
    // système reprend à l'octet près, sans rien retélécharger.
    manager.chunkStore = {
      save: (transferId, seq, bytes) => saveChunk(transferId, seq, bytes),
      load: (transferId) => loadChunks(transferId),
      clear: (transferId) => clearChunks(transferId),
    };

    // Envois interrompus par un onglet tué : on les réinstalle pour que
    // l'utilisateur réassocie le fichier et reprenne au bon endroit.
    void loadSends().then(rows => {
      rows.forEach(row => {
        if (fileRefs.current.has(row.id)) return;
        manager.restoreSend({
          id: row.id,
          file: { name: row.name, size: row.size, mime: row.mime },
          chunkSize: row.chunkSize,
          targetId: row.targetId,
          targetName: row.targetName,
          hash: row.hash,
          createdAt: row.createdAt,
        });
      });
    });

    return () => {
      manager.clear();
      s.off('transfer-init'); s.off('transfer-chunk');
      s.off('transfer-ack'); s.off('transfer-eof'); s.off('transfer-eof-ack');
      s.off('transfer-cancel'); s.off('transfer-end'); s.off('transfer-resync');
      if (transfersSyncTimerRef.current !== null) {
        clearTimeout(transfersSyncTimerRef.current);
        transfersSyncTimerRef.current = null;
      }
    };
  }, [showToast, socketEpoch, syncTransfers, kickSendLoop]);

  // ---- URL room param ----
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const roomParam = params.get('room');
      // Différé : évite un rendu en cascade synchrone au montage (react-hooks).
      if (roomParam) queueMicrotask(() => setRoomId(roomParam));
    }
  }, []);

  /**
   * Coherence bi-directionnelle entre la liste « Fichiers reçus » et la liste
   * « Sur cet appareil » :
   *  - un fichier effacé depuis Fichiers sur le téléphone disparaît de la liste reçue ;
   *  - si MediaStore est vide, les entrées reçues deviennent non-validées et sont retirées.
   */
  const refreshMobileFiles = useCallback(async () => {
    if (!isMobileHost()) return;
    const { files, error } = await mobileListDownloads();
    if (error) showToast('warning', error);
    setSharedFiles(files);
    setDownloads(prev =>
      prev.filter(record =>
        !record.path
          ? files.some(file => file.name === record.name)
          : files.some(file => file.uri === record.path),
      ),
    );
  }, [showToast]);

  /**
   * Fichiers du dossier de réception du bureau. Le pont Electron lit le disque
   * à la demande : la liste inclut aussi les fichiers déposés hors de l'app.
   */
  const refreshDesktopFiles = useCallback(async () => {
    if (!isDesktopHost()) return;
    const { folder, files, error } = await listReceiveFolderFiles();
    if (folder) setDesktopFolder(folder);
    if (error) showToast('warning', error);
    setDesktopFiles(files);
  }, [showToast]);

  // L'onglet Téléchargements peut être ouvert plusieurs fois ; on relit le
  // dossier de réception à chaque ouverture (si une autre application avait
  // effacé ou ajouté des fichiers, la liste évolue par elle-même).
  useEffect(() => {
    if (tab !== 'downloads') return;
    const mobile = isMobileHost();
    const desktop = isDesktopHost();
    if (!mobile && !desktop) return;
    const refresh = () => {
      if (mobile) void refreshMobileFiles();
      else void refreshDesktopFiles();
    };
    refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [tab, refreshMobileFiles, refreshDesktopFiles]);

  // ---- Boucle d envoi (relay + p2p) ----
  useEffect(() => {
    const sendLoop = async () => {
      sendLoopRef.current = () => void sendLoop();
      // Une reprise après resync reprogramme la boucle : sans ce kick, un EOF
      // suivi d'un « il me manque des octets » laissait le transfert figé.
      // Sans le verrou ci-dessous, deux exécutions lisent le même
      // `offset` et envoient le même bloc sous deux séquences différentes :
      // le fichier reconstruit garde la bonne taille mais contient un bloc
      // dupliqué et un bloc manquant (APK/zip corrompu).
      if (sendLoopRunningRef.current) return;
      sendLoopRunningRef.current = true;
      try {
        if (transferTimeoutRef.current) {
          clearTimeout(transferTimeoutRef.current);
          transferTimeoutRef.current = null;
        }
        const manager = managerRef.current;
        if (!manager) return;
        // Tous les envois actifs avancent sur le même tick : jusqu'à deux flux
        // en parallèle, répartis en rounds pour qu'aucun ne monopolise la boucle.
        const activeSends = manager.getAll().filter(t => t.direction === 'send' && t.status === 'transferring');
        if (activeSends.length === 0) {
          transferTimeoutRef.current = setTimeout(() => sendLoop(), 250);
          return;
        }
        for (const sendT of activeSends) {
          const file = fileRefs.current.get(sendT.id);
          if (!file) continue;
          if (sendT.offset >= file.size) {
            if (sendT.pending.size === 0) manager.sendEof(sendT.id);
            continue;
          }
          const lan = lanPeersRef.current.has(sendT.targetId) && sendT.method === 'p2p';
          const byteTarget = 6 * 1024 * 1024;
          const byBytes = Math.max(4, Math.floor(byteTarget / sendT.chunkSize));
          const rttFactor = sendT.rttMs > 0 ? Math.min(1, 600 / Math.max(600, sendT.rttMs)) : 1;
          const maxInFlight = lan
            ? MAX_IN_FLIGHT_CHUNKS_LAN
            : Math.max(4, Math.min(MAX_IN_FLIGHT_CHUNKS, Math.round(byBytes * rttFactor)));
          if (sendT.pending.size >= maxInFlight) continue;
          if (lan && (peersRef.current[sendT.targetId]?.bufferedAmount ?? 0) > P2P_BUFFERED_LIMIT) continue;
          // Sur le relais, on attend que la socket se vide : un chunk de plus
          // dans un tampon déjà plein ne gagne aucun débit, il retarde le pong.
          if (!lan && socketBufferedAmount(socketRef.current) > RELAY_BUFFERED_LIMIT) continue;
          const burst = lan ? 12 : 3;
          for (let i = 0; i < burst; i++) {
            if (sendT.offset >= file.size) break;
            if (sendT.pending.size >= maxInFlight) break;
            if (lan && (peersRef.current[sendT.targetId]?.bufferedAmount ?? 0) > P2P_BUFFERED_LIMIT) break;
            if (!lan && socketBufferedAmount(socketRef.current) > RELAY_BUFFERED_LIMIT) break;
            const blob = file.slice(sendT.offset, Math.min(sendT.offset + sendT.chunkSize, file.size));
            const chunk = new Uint8Array(await blob.arrayBuffer());
            if (!manager.sendChunk(sendT.id, sendT.nextSeq, chunk)) break;
            sendT.nextSeq++;
          }
        }
        // Filet de sécurité seulement : chaque ACK relance la passe
        // directement, sans attendre ce minuteur (bridé à ~1/min écran
        // éteint). Une passe par seconde suffit à récupérer d'un ACK perdu.
        transferTimeoutRef.current = setTimeout(() => sendLoop(), 1_000);
      } finally {
        sendLoopRunningRef.current = false;
        // Un ACK arrivé pendant cette passe a été mis en attente : on rejoue
        // la boucle tout de suite, sans dépendre d'un minuteur bridé.
        if (sendLoopKickPendingRef.current) {
          sendLoopKickPendingRef.current = false;
          queueMicrotask(() => sendLoopRef.current?.());
        }
      }
    };
    void sendLoop();
    return () => {
      if (transferTimeoutRef.current) clearTimeout(transferTimeoutRef.current);
      sendLoopKickPendingRef.current = false;
      sendLoopRef.current = null;
    };
    // Ne dépend volontairement plus de `transfers` : chaque tick de progression
    // déclenchait une re-création d'effet dont le cleanup annulait le timer
    // programmé (la boucle repartait alors plus lentement, par à-coups).
  }, [socketEpoch]);

  // Identifiants TURN éphémères servis par le Worker : le navigateur n'embarque
  // donc aucun mot de passe durable. Renouvelés à mi-vie pour qu'une
  // négociation tardive ne tombe jamais sur des identifiants expirés ; sans
  // configuration côté Worker, l'appel renvoie une liste vide et l'on reste
  // sur les STUN publics.
  const refreshIceServers = useCallback(async () => {
    if (Date.now() < turnValidUntilRef.current) return;
    const base = getSocketUrl().replace(/\/+$/, '');
    if (!base) return;
    try {
      const res = await fetch(`${base}/turn`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as {
        urls?: string[]; username?: string; credential?: string; ttl?: number;
      };
      if (!data.urls || data.urls.length === 0) return;
      iceServersRef.current = [
        ...BASE_ICE_SERVERS,
        { urls: data.urls, username: data.username ?? '', credential: data.credential ?? '' },
      ];
      const ttl = typeof data.ttl === 'number' && data.ttl > 0 ? data.ttl : 3600;
      turnValidUntilRef.current = Date.now() + Math.max(60, ttl / 2) * 1000;
    } catch {
      // Pas de TURN joignable : les STUN suffisent sur la plupart des réseaux,
      // et le relais Socket.IO reste le dernier recours.
    }
  }, []);

  // ---- Chemin direct (WebRTC) ----
  // Un canal de données par pair ; le relais Socket.IO reste le repli quand la
  // connexion directe échoue (NAT symétrique, réseau filtrant, onglet en veille).
  const destroyPeer = useCallback((peerId: string) => {
    const timer = p2pTimersRef.current[peerId];
    if (timer) {
      clearTimeout(timer);
      delete p2pTimersRef.current[peerId];
    }
    lanPeersRef.current.delete(peerId);
    delete p2pStateRef.current[peerId];
    const peer = peersRef.current[peerId];
    delete peersRef.current[peerId];
    if (peer && !peer.destroyed) {
      try { peer.destroy(); } catch { /* ignore */ }
    }
  }, []);

  const ensureP2P = useCallback(async (peerId: string, initiator: boolean) => {
    if (!peerId) return;
    if (typeof window === 'undefined' || typeof window.RTCPeerConnection === 'undefined') return;
    const current = peersRef.current[peerId];
    if (current && !current.destroyed) return;
    // Une tentative ratée ne doit pas se relancer en boucle : on reste relais.
    if (p2pStateRef.current[peerId] === 'failed') return;
    p2pStateRef.current[peerId] = 'connecting';

    // Les identifiants TURN, s'il y en a, doivent être frais au moment où la
    // connexion se négocie.
    await refreshIceServers();

    const peer = new SimplePeer({
      initiator,
      trickle: true,
      config: { iceServers: iceServersRef.current },
    });
    peersRef.current[peerId] = peer;

    const fallback = () => {
      p2pStateRef.current[peerId] = 'failed';
      lanPeersRef.current.delete(peerId);
      const timer = p2pTimersRef.current[peerId];
      if (timer) {
        clearTimeout(timer);
        delete p2pTimersRef.current[peerId];
      }
      // Le canal direct a échoué mais le relais fonctionne : le pair reste
      // joignable. Sans ce status, la liste affichait « Connexion… » à vie et
      // l'envoi attendait un état qui n'arrivait jamais.
      setPeers(prev => (prev[peerId]
        ? { ...prev, [peerId]: { ...prev[peerId], method: 'relay', status: 'connected' } }
        : prev));
    };

    p2pTimersRef.current[peerId] = setTimeout(() => {
      if (p2pStateRef.current[peerId] === 'open') return;
      try { peer.destroy(); } catch { /* ignore */ }
      fallback();
    }, P2P_CONNECT_TIMEOUT_MS);

    peer.on('signal', (signal: { type?: string }) => {
      const socket = socketRef.current;
      if (!socket?.connected) return;
      const event = signal.type === 'offer' ? 'offer'
        : signal.type === 'answer' ? 'answer'
          : 'ice-candidate';
      socket.emit(event, { target: peerId, sdp: signal });
    });

    peer.on('connect', () => {
      p2pStateRef.current[peerId] = 'open';
      const timer = p2pTimersRef.current[peerId];
      if (timer) {
        clearTimeout(timer);
        delete p2pTimersRef.current[peerId];
      }
      setPeers(prev => (prev[peerId]
        ? { ...prev, [peerId]: { ...prev[peerId], method: 'p2p', status: 'connected' } }
        : prev));
      // Détection « même réseau local » : un candidat « host » des deux côtés
      // (aucune traversée NAT, aucun relais) signifie que les deux appareils
      // sont sur le même réseau ; les blocs échangés peuvent alors être bien
      // plus gros sans risque, pour un débit bien supérieur. Une détection
      // manquée ne dégrade rien : on garde simplement les blocs standards.
      try {
        const pc = (peer as unknown as { _pc?: RTCPeerConnection })._pc;
        pc?.getStats()?.then?.((stats) => {
          for (const report of stats.values() as unknown as Iterable<{
            type?: string; state?: string; selected?: boolean; nominated?: boolean;
            localCandidateId?: string; remoteCandidateId?: string;
          }>) {
            if (report.type !== 'candidate-pair') continue;
            if (!(report.state === 'succeeded' && (report.selected || report.nominated))) continue;
            const local = stats.get(report.localCandidateId ?? '') as
              { candidateType?: string } | undefined;
            const remote = stats.get(report.remoteCandidateId ?? '') as
              { candidateType?: string } | undefined;
            if (local?.candidateType === 'host' && remote?.candidateType === 'host') {
              lanPeersRef.current.add(peerId);
            }
          }
        }).catch(() => {});
      } catch { /* Stats indisponibles : réglages standards. */ }
    });

    peer.on('data', (data: Uint8Array) => {
      const manager = managerRef.current;
      if (!manager || !(data instanceof Uint8Array)) return;
      const frame = decodeChunkFrame(data);
      if (!frame) return;
      // Même chemin qu'en relais : acquittement, déduplication et contrôle
      // d'intégrité restent identiques.
      manager.onTransferChunk({
        transferId: frame.transferId,
        seq: frame.seq,
        size: frame.chunk.byteLength,
        chunk: frame.chunk,
        target: manager.selfId,
        via: 'p2p',
      });
    });

    peer.on('error', fallback);
    peer.on('close', () => {
      if (peersRef.current[peerId] === peer) delete peersRef.current[peerId];
      fallback();
    });
  }, [refreshIceServers]);

  // ---- Gestion arrière-plan / réseau ----
  useEffect(() => {
    const onOnline = () => {
      setConnectionStatus(prev => (prev === 'connected' ? prev : 'connecting'));
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  // ---- Jointour / Rejoint / Quitter ----
  const joinRoom = useCallback((roomOverride?: string, nameOverride?: string) => {
    const effectiveRoomId = (roomOverride ?? roomId).trim();
    const effectiveName = (nameOverride ?? myName).trim();
    if (!effectiveRoomId || !effectiveName) return;
    // Identité stable : elle ne dépend pas de la socket, donc un appareil qui
    // se reconnecte retrouve les mêmes transferts.
    const sessionId = mySessionIdRef.current || getSessionId();
    mySessionIdRef.current = sessionId;
    if (socketRef.current) {
      try { socketRef.current.disconnect(); } catch { /* ignore */ }
      socketRef.current = null;
    }
    Object.keys(peersRef.current).forEach(destroyPeer);
    peersRef.current = {};
    setPeers({});
    setActivePeerId(null);
    setTransfers(prev => prev.map(t => { t.status = 'cancelled'; t.error = 'Nouveau salon'; return t; }));
    setStep('room');
    setConnectionStatus('connecting');
    setConnectErrorMessage(null);
    connectErrorShownRef.current = false;
    const socket = io(getSocketUrl(), {
      transports: ['websocket'], reconnection: true, reconnectionDelay: 1000,
      reconnectionDelayMax: 5000, reconnectionAttempts: Infinity, timeout: 10000,
      // Les chunks de fichiers sont déjà compressés (zip, médias, chiffrement) :
      // permessage-deflate ne ferait que consommer du CPU sur le téléphone et
      // au edge sans réduire le trafic, et retarderait les acquittements.
      compression: false,
    } as Parameters<typeof io>[1]);
    socketRef.current = socket;
    setSocketEpoch(epoch => epoch + 1);
    const failConnect = (message: string) => {
      console.error(message);
      if (connectDeadlineTimeoutRef.current) { clearTimeout(connectDeadlineTimeoutRef.current); connectDeadlineTimeoutRef.current = null; }
      try { socket.disconnect(); } catch { /* ignore */ }
      socketRef.current = null;
      setConnectionStatus('disconnected');
      if (!connectErrorShownRef.current) {
        connectErrorShownRef.current = true;
        setConnectErrorMessage(message);
        setShowErrorModal(true);
      }
    };
    if (connectDeadlineTimeoutRef.current) clearTimeout(connectDeadlineTimeoutRef.current);
    connectDeadlineTimeoutRef.current = setTimeout(() => failConnect('Impossible de se connecter après 20s.'), 20 * 1000);
    socket.on('connect', () => {
      console.log('Connected to server');
      if (connectDeadlineTimeoutRef.current) { clearTimeout(connectDeadlineTimeoutRef.current); connectDeadlineTimeoutRef.current = null; }
      setConnectionStatus('connected');
      socket.emit('join-room', { roomId: effectiveRoomId, name: effectiveName, sessionId });
      rememberLastRoom(effectiveRoomId, effectiveName, { persist: isMobileHost() });
      // Historique local : le salon remonte en tête de l'accueil.
      rememberRoom(effectiveRoomId, effectiveName);
      setRoomHistory(loadRoomHistory());
      setStep('room');
      // Exemption d'optimisation de batterie : demandée une seule fois par
      // installation côté natif, au premier salon rejoint.
      mobileRequestBatteryExemption();
      // Réassérer le maintien natif : le service peut avoir été relancé par le
      // système pendant la veille (START_STICKY) avec un état périmé.
      mobileKeepAlive(true);
      // Retour en ligne : les transferts interrompus repartent d'eux-mêmes, le
      // temps que le pair se réenregistre dans le salon.
      setTimeout(() => managerRef.current?.resumeInterrupted(), 600);
    });
    socket.on('disconnect', (reason) => {
      console.log('Disconnected:', reason);
      setConnectionStatus('disconnected');
      // Ne PAS couper le service ici : la coupure réseau est justement le
      // moment où le wake lock doit rester pour permettre la reconnexion.
      mobileKeepAlive(true);
      // Le canal direct est caduc : il sera renégocié avec les mêmes
      // identités. Le transfert, lui, est conservé et reprendra au retour.
      Object.keys(peersRef.current).forEach(destroyPeer);
      managerRef.current?.interruptAll('Connexion interrompue');
      if (reason === 'io server disconnect') socket.connect();
    });
    socket.on('connect_error', () => {
      setConnectionStatus('disconnected');
      mobileKeepAlive(true);
      if (!connectErrorShownRef.current) {
        connectErrorShownRef.current = true;
        setConnectErrorMessage('Impossible de se connecter au serveur.');
        setShowErrorModal(true);
      }
    });
    socket.on('room-users', (users: { id: string; name: string }[]) => {
      // Identité stable, pas `socket.id` : après une reconnexion les deux côtés
      // doivent encore désigner le même initiateur.
      const selfId = mySessionIdRef.current || socket.id || '';
      const next: Record<string, PeerInfo> = {};
      users.forEach(u => {
        next[u.id] = { id: u.id, name: u.name, status: 'connected', method: 'relay' };
        // Règle déterministe pour que les deux côtés ne s'offrent pas la
        // connexion en même temps : l'id le plus petit propose.
        void ensureP2P(u.id, selfId < u.id);
        // Un appareil déjà connu qui revient : son transfert reprend seul, et
        // on lui redemande jusqu'où il en est s'il a perdu son état.
        setTimeout(() => managerRef.current?.reannounceFor(u.id), 600);
      });
      // La liste reçue est celle du salon : elle remplace l'état précédent. Un
      // pair parti pendant notre coupure ne nous a jamais été annoncé (pas de
      // user-left) ; sans ce nettoyage il restait affiché et ses transferts
      // attendaient un pair qui n'existe plus.
      const departed = new Set<string>(Object.keys(peersRef.current));
      managerRef.current?.getAll().forEach(t => departed.add(t.targetId));
      departed.forEach(id => {
        if (next[id]) return;
        destroyPeer(id);
        managerRef.current?.interruptForPeer(id, "L'appareil s'est déconnecté");
      });
      setPeers(next);
      setActivePeerId(prev => (prev && !next[prev] ? null : prev));
    });
    socket.on('user-joined', ({ id, name }) => {
      // Le pair est déjà joignable par le relais : le marquer « connecté »
      // tout de suite. « connecting » ne doit durer que le temps de la
      // négociation directe, pas rester bloqué si elle échoue.
      setPeers(prev => ({ ...prev, [id]: { id, name, status: 'connected', method: 'relay' } }));
      void ensureP2P(id, (mySessionIdRef.current || socket.id || '') < id);
      setTimeout(() => managerRef.current?.reannounceFor(id), 600);
    });
    socket.on('user-left', (id) => {
      setPeers(prev => { const next = { ...prev }; delete next[id]; return next; });
      setActivePeerId(prev => (prev === id ? null : prev));
      destroyPeer(id);
      managerRef.current?.interruptForPeer(id, "L'appareil s'est déconnecté");
    });
    // Signalisation WebRTC : le worker ne fait que la transmettre, la connexion
    // directe se négocie entre les deux navigateurs.
    const onSignal = (data: { caller: string; sdp?: object }) => {
      if (!data?.caller || !data.sdp) return;
      void ensureP2P(data.caller, false);
      const peer = peersRef.current[data.caller];
      if (!peer || peer.destroyed) return;
      try { peer.signal(data.sdp); } catch { /* signal tardif ou obsolète */ }
    };
    socket.on('offer', onSignal);
    socket.on('answer', onSignal);
    socket.on('ice-candidate', onSignal);
  }, [roomId, myName, ensureP2P, destroyPeer]);

  // Onglet tué par le système puis restauré : on rejoint le dernier salon tout
  // seul, sinon le pair d'en face attendrait un code que personne ne retape.
  // Sur Android, un balayage a emporté le sessionStorage : la copie durable
  // prend le relais, mais seulement si elle date de moins de 24 h — rejoindre
  // des jours plus tard un salon vide n'aurait plus rien à reprendre.
  const autoJoinedRef = useRef(false);
  useEffect(() => {
    if (autoJoinedRef.current || typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('room')) return;
    const stored = loadLastRoom({ persist: isMobileHost() });
    const storedRoom = stored?.roomId;
    if (!storedRoom) return;
    const storedName = stored?.name;
    autoJoinedRef.current = true;
    queueMicrotask(() => {
      if (storedName) setMyName(storedName);
      setRoomId(storedRoom);
      joinRoom(storedRoom, storedName);
    });
  }, [joinRoom]);

  // ---- Accueil : historique local + salons ouverts en direct ----
  // Jetés un coup d'œil seulement quand on est sur l'accueil ; l'échec réseau
  // n'affiche rien, l'accueil doit rester instantané.
  useEffect(() => {
    if (step !== 'welcome') return;
    setRoomHistory(loadRoomHistory());
    let cancelled = false;
    const refresh = async () => {
      const rooms = await fetchLiveRooms();
      if (!cancelled) setLiveRooms(rooms);
    };
    void refresh();
    const id = setInterval(() => void refresh(), 10_000);
    // Le minuteur est bridé en arrière-plan : on rafraîchit au retour à l'écran.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [step]);

  const exitRoom = useCallback(() => {
    // Sortie volontaire : le salon ne doit plus être rejoint tout seul.
    clearLastRoom();
    Object.keys(peersRef.current).forEach(destroyPeer);
    peersRef.current = {};
    setPeers({});
    setActivePeerId(null);
    if (socketRef.current) {
      try { socketRef.current.disconnect(); } catch { /* ignore */ }
      socketRef.current = null;
    }
    fileRefs.current.clear();
    setTransfers([]);
    // Sortie du salon : là seulement le service avant-plan doit s'arrêter.
    mobileStopTransfer();
    setStep('welcome');
    setConnectionStatus('disconnected');
    setRoomId('');
  }, [destroyPeer]);

  const startSending = useCallback(async (targetId: string, file: File, method: 'p2p' | 'relay') => {
    if (!socketRef.current?.connected) {
      showToast('error', 'Connexion au serveur perdue');
      return;
    }
    // Empreinte du fichier : le récepteur vérifie qu'il a reconstruit exactement
    // les mêmes octets. Au-delà de la limite on s'en passe, pour ne pas charger
    // un fichier entier en mémoire sur un téléphone. Les empreintes de la file
    // passent une par une : les lancer ensemble empilait un fichier complet par
    // entrée en mémoire au moment de la sélection.
    let hash: string | null = null;
    if (file.size <= HASH_MAX_BYTES) {
      const previous = sendHashChainRef.current;
      const task = previous
        .catch(() => undefined)
        .then(async () => (file.size <= HASH_MAX_BYTES
          ? sha256Hex(await file.arrayBuffer())
          : null));
      sendHashChainRef.current = task;
      hash = await task;
    }
    if (!socketRef.current?.connected) {
      showToast('error', 'Connexion au serveur perdue');
      return;
    }
    // Même réseau local (détecté via les candidats ICE) : blocs bien plus gros,
    // le destinataire s'aligne sur le chunkSize annoncé dans transfer-init.
    const lan = lanPeersRef.current.has(targetId) && method === 'p2p';
    const t = managerRef.current?.startSend(
      { name: file.name, size: file.size, mime: file.type || mimeFromName(file.name) },
      targetId,
      method,
      hash ?? undefined,
      lan ? CHUNK_SIZE_LAN : undefined
    );
    if (t) {
      fileRefs.current.set(t.id, file);
      // Trace de l'envoi : après un rechargement, l'app saura quel fichier
      // redemander et à quel appareil il était destiné.
      void saveSend({
        id: t.id,
        name: file.name,
        size: file.size,
        mime: file.type || mimeFromName(file.name),
        hash: hash ?? undefined,
        chunkSize: t.chunkSize,
        targetId,
        targetName: peers[targetId]?.name ?? 'Appareil',
        createdAt: t.createdAt,
        updatedAt: Date.now(),
      });
      showToast('info', t.status === 'queued'
        ? `En file (#${t.queuePosition ?? '…'}) : ${file.name}`
        : `Envoi : ${file.name}`);
    }
  }, [showToast, peers]);

  // ---- Sélection de fichiers (multi-fichiers : chaque fichier rejoint la file) ----
  const enqueueFiles = useCallback((files: File[], targetId: string | null) => {
    if (!targetId || files.length === 0) return;
    const peer = peers[targetId];
    if (!peer && !socketRef.current?.connected) {
      showToast('error', 'Connexion au serveur perdue.');
      return;
    }
    if (!peer || peer.status !== 'connected') {
      if (socketRef.current?.connected) {
        setPeers(prev => ({ ...prev, [targetId]: { id: targetId, name: prev[targetId]?.name || 'Appareil', status: 'connected', method: 'relay' } }));
      } else {
        showToast('error', 'Connexion au serveur perdue.');
        return;
      }
    }
    const method = peer ? (peer.method === 'p2p' ? 'p2p' : 'relay') : 'relay';
    // Les fichiers sont mis en file dans l'ordre sélectionné ; le moteur
    // limite à 2 envois simultanés et promeut les suivants automatiquement.
    for (const file of files) void startSending(targetId, file, method as 'p2p' | 'relay');
    if (files.length > 1) showToast('info', `${files.length} fichiers ajoutés à la file d’envoi`);
  }, [startSending, peers, showToast]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    enqueueFiles(files, activePeerId);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [enqueueFiles, activePeerId]);

  const handleFolderSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const targetId = activePeerId;
    if (folderInputRef.current) folderInputRef.current.value = '';
    if (!targetId || files.length === 0) return;
    const peer = peers[targetId];
    if (!peer && !socketRef.current?.connected) { alert('Connexion au serveur perdue.'); return; }
    if (!peer) {
      setPeers(prev => ({ ...prev, [targetId]: { id: targetId, name: prev[targetId]?.name || 'Appareil', status: 'connected', method: 'relay' } }));
    }
    if (!peer || peer.status !== 'connected') {
      if (socketRef.current?.connected) {
        setPeers(prev => ({ ...prev, [targetId]: { id: targetId, name: prev[targetId]?.name || 'Appareil', status: 'connected', method: 'relay' } }));
      } else { alert('Connexion au serveur perdue.'); return; }
    }
    try {
      const zip = new JSZip();
      const firstPath = files[0].webkitRelativePath || files[0].name;
      const rootFolder = firstPath.includes('/') ? firstPath.split('/')[0] : 'dossier';
      for (const f of files) {
        const rel = f.webkitRelativePath || f.name;
        const normalized = rel.startsWith(rootFolder + '/') ? rel : `${rootFolder}/${rel}`;
        zip.file(normalized, f);
      }
      // Réglage « Compression » : DEFLATE économise des octets mais coûte du
      // temps CPU ; désactivé, le dossier part en archive stockée sans
      // recompression (utile pour des médias déjà compressés sur LAN rapide).
      const blob = await zip.generateAsync({
        type: 'blob',
        compression: appSettings.enableCompression ? 'DEFLATE' : 'STORE',
        compressionOptions: { level: 6 },
      });
      const zipName = `${rootFolder}.zip`;
      const zipFile = new File([blob], zipName, { type: 'application/zip' });
      await startSending(targetId, zipFile, 'relay');
    } catch (err) {
      console.error('Folder zip failed', err);
      showToast('error', 'Erreur lors de la compression du dossier');
    }
  }, [startSending, peers, showToast, activePeerId, appSettings.enableCompression]);

  const handleCameraSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    enqueueFiles(files, activePeerId);
    if (cameraInputRef.current) cameraInputRef.current.value = '';
  }, [enqueueFiles, activePeerId]);

  // Reprise d'un envoi dont le fichier a été perdu avec l'onglet : on vérifie
  // qu'il s'agit bien des mêmes octets avant de repartir où l'on s'était
  // arrêté, plutôt que de tout renvoyer.
  const handleResumeSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const id = resumeTargetRef.current;
    resumeTargetRef.current = null;
    if (resumeInputRef.current) resumeInputRef.current.value = '';
    if (!file || !id) return;
    const transfer = managerRef.current?.get(id);
    if (!transfer) return;
    if (file.size !== transfer.file.size) {
      showToast('error', `Ce fichier ne correspond pas : ${formatBytes(transfer.file.size)} attendus.`);
      return;
    }
    if (transfer.hash && file.size <= HASH_MAX_BYTES) {
      const digest = await sha256Hex(await file.arrayBuffer());
      if (digest && digest !== transfer.hash.toLowerCase()) {
        showToast('error', "Le contenu du fichier a changé : reprenez avec l'original.");
        return;
      }
    }
    fileRefs.current.set(id, file);
    managerRef.current?.reopenSend(id);
  }, [showToast]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    if (!roomId.trim()) { e.preventDefault(); showToast('warning', 'Saisissez un code de salon.'); return; }
    joinRoom();
  }, [roomId, joinRoom, showToast]);

  const handleReconnect = useCallback(() => {
    setShowErrorModal(false);
    joinRoom();
  }, [joinRoom]);

  // ---- Sauvegarde des fichiers reçus ----
  // Android Chrome bloque les téléchargements lancés sans geste utilisateur :
  // le blob reste donc dans une liste avec un bouton explicite.
  // L'URL du blob est créée une seule fois par fichier et n'est plus révoquée :
  // la révoquer pendant que le navigateur écrit le fichier pouvait le tronquer.
  const downloadUrl = useCallback((url: string, name: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  // ---- Téléchargements ----
  // L'expéditeur n'envoie que son identifiant : on rétablit son nom d'appareil.
  const resolveSender = useCallback((from?: string) => {
    if (!from) return 'Un appareil';
    // Un pair déjà parti n'est plus dans la liste : mieux vaut un libellé
    // lisible qu'un identifiant de socket dans l'historique.
    return peerNamesRef.current[from] || 'Un appareil';
  }, []);

  const openDownload = useCallback(async (record: DownloadRecord) => {
    const bridge = typeof window === 'undefined' ? undefined : window.globalshareDesktop;
    // Bureau : le fichier est déjà sur le disque, l'ouvrir ne demande rien à
    // la page. Le processus principal vérifie qu'il est bien dans son dossier.
    if (bridge && record.path) {
      const error = await bridge.openDownload(record.path);
      if (error) showToast('error', error);
      return;
    }
    // Android : le fichier est dans MediaStore ; seul un intent ACTION_VIEW
    // peut lancer le lecteur FLAC/audio système (blob: n'est pas openable).
    if (isMobileHost()) {
      if (!record.path) {
        showToast('warning', "Ce fichier n'est pas enregistré sur le téléphone. Recevez-le à nouveau.");
        return;
      }
      if (!record.path.startsWith('content://') && !record.path.startsWith('file://')) {
        showToast('warning', "Emplacement du fichier invalide.");
        return;
      }
      // Un startActivity réussi peut ouvrir un lecteur qui plante sans lever
      // d'erreur : on borne l'attente et on affiche toujours un retour clair.
      const error = await Promise.race([
        mobileOpenDownload({ uri: record.path, mime: record.mime, name: record.name }),
        new Promise<string>(resolve =>
          setTimeout(() => resolve("L'ouverture a mis trop de temps."), 10_000)
        ),
      ]);
      if (error) showToast('error', error);
      return;
    }
    let blob = downloadBlobRef.current.get(record.id);
    if (!blob) {
      blob = (await getDownloadBlob(record.id)) ?? undefined;
      if (blob) downloadBlobRef.current.set(record.id, blob);
    }
    if (!blob) {
      showToast('warning', "Ce fichier n'est plus conservé sur cet appareil.");
      return;
    }
    const url = URL.createObjectURL(blob);
    // Images, PDF, vidéos et textes s'affichent dans un onglet ; pour le reste
    // (zip, apk…), un téléchargement est le seul comportement possible.
    if (viewerKind(record.mime, record.name) === 'none') {
      downloadUrl(url, record.name);
      return;
    }
    const opened = window.open(url, '_blank');
    if (!opened) downloadUrl(url, record.name);
  }, [downloadUrl, showToast]);

  const revealDownload = useCallback(async (record: DownloadRecord) => {
    // Android : ouvrir directement l'app Fichiers dans Téléchargements/GlobalShare.
    // C'est le comportement attendu pour un FLAC : l'utilisateur choisit son
    // lecteur audio depuis les Fichiers, sans qu'un lecteur vidéo casse tout.
    if (isMobileHost()) {
      const error = await mobileRevealDownload();
      if (error) showToast('error', error);
      return;
    }
    if (!record.path) return;
    const error = await window.globalshareDesktop?.revealDownload(record.path);
    if (error) showToast('error', error);
  }, [showToast]);

  const removeDownload = useCallback(async (record: DownloadRecord) => {
    if (appSettings.confirmDelete && !window.confirm(
      translateSetting(appSettings.language, 'confirmRemoveFile', { name: record.name })
    )) {
      return;
    }
    // « Retirer » ne touche qu'à l'historique. Le fichier enregistré dans
    // Téléchargements/GlobalShare reste sur l'appareil : sa suppression est
    // réservée à l'onglet « Sur le téléphone » (ou au dossier sur disque).
    downloadBlobRef.current.delete(record.id);
    setDownloads(prev => prev.filter(item => item.id !== record.id));
    await deleteStoredDownload(record.id);
    if (isMobileHost()) {
      showToast('info', `Retiré de la liste : ${record.name} reste sur le téléphone.`);
    }
  }, [appSettings.confirmDelete, appSettings.language, showToast]);

  const clearDownloadHistory = useCallback(async () => {
    if (appSettings.confirmDelete && !window.confirm(
      translateSetting(appSettings.language, 'confirmClearHistory')
    )) {
      return;
    }
    // L'historique n'est qu'une vue : vider la liste ne touche jamais aux
    // fichiers déjà enregistrés sur l'appareil (dossier de réception du
    // téléphone ou du bureau). Sinon un simple rangement faisait disparaître
    // des fichiers que l'utilisateur voulait garder ; eux se gèrent depuis
    // l'onglet « Sur le téléphone » ou le dossier sur disque.
    downloadBlobRef.current.clear();
    setDownloads([]);
    await clearStoredDownloads();
  }, [appSettings.confirmDelete, appSettings.language]);

  // ---- Enregistrement des fichiers reçus ----
  // Sur le bureau, le processus principal écrit dans ~/Téléchargements/GlobalShare
  // et renvoie le chemin, ce qui permet de rouvrir le fichier tel quel. Sur le
  // web et le mobile, le blob est conservé dans IndexedDB (borné) et le
  // téléchargement est déclenché immédiatement, comme avant.
  const saveFile = useCallback(async (
    blob: Blob,
    name: string,
    integrity: IntegrityStatus,
    from?: string
  ) => {
    const id = `d-${Date.now().toString(36)}-${++downloadIdRef.current}`;
    const record: StoredDownload = {
      id,
      name: sanitizeFileName(name),
      size: blob.size,
      mime: blob.type || mimeFromName(name),
      from: resolveSender(from),
      receivedAt: Date.now(),
      integrity,
    };
    if (appSettings.debugMode) {
      console.info('[GlobalShare] Fichier reçu', {
        name: record.name, size: record.size, integrity, from: record.from,
      });
    }
    const bridge = typeof window === 'undefined' ? undefined : window.globalshareDesktop;

    if (integrity === 'mismatch') {
      // Fichier corrompu : il reste visible dans l'historique pour que
      // l'utilisateur sache quoi renvoyer, mais rien n'est écrit ni ouvert.
      setDownloads(prev => [record, ...prev].slice(0, DOWNLOAD_LIMITS.maxItems));
      await putDownload(record);
      showToast('error', `Fichier corrompu pendant le transfert : ${record.name}. Renvoyez-le.`);
      return;
    }

    // Réglage « Confirmer l'écrasement » : une entrée du même nom existe déjà.
    if (appSettings.confirmOverwrite) {
      const existing = downloads.find(d => d.name === record.name);
      if (existing && !window.confirm(
        translateSetting(appSettings.language, 'confirmOverwriteFile', { name: record.name })
      )) {
        showToast('info', translateSetting(appSettings.language, 'fileIgnoredToast'));
        return;
      }
    }

    if (bridge) {
      try {
        const saved = await bridge.saveDownload({
          name: record.name,
          mime: record.mime,
          bytes: await blob.arrayBuffer(),
        });
        if (saved?.error) {
          showToast('warning', saved.error);
        } else if (saved?.path) {
          record.path = saved.path;
          showToast('success', `Enregistré dans le dossier de réception : ${record.name}`);
        }
      } catch {
        showToast('warning', "Enregistrement impossible : le fichier reste dans l'onglet Téléchargements.");
      }
    } else if (isMobileHost()) {
      // Le pont Capacitor n'expose pas `globalshareDesktop` : écrire le fichier
      // dans Téléchargements/GlobalShare via MediaStore le rend visible dans
      // l'app Fichiers et ouvrable par un lecteur externe.
      record.blob = blob;
      downloadBlobRef.current.set(id, blob);
      const saved = await saveBlobToSharedStorage(blob, record.name, record.mime);
      if (saved.error) {
        showToast('warning', `${saved.error} Le fichier reste dans l'onglet Téléchargements.`);
      } else if (saved.path) {
        record.path = saved.path;
        showToast('success', `Enregistré dans le dossier de réception : ${record.name}`);
      }
    } else {
      record.blob = blob;
      downloadBlobRef.current.set(id, blob);
      downloadUrl(URL.createObjectURL(blob), record.name);
    }

    setDownloads(prev => [record, ...prev].slice(0, DOWNLOAD_LIMITS.maxItems));
    await putDownload(record);
    playNotificationSound();
  }, [downloadUrl, resolveSender, showToast, playNotificationSound, appSettings.debugMode, appSettings.confirmOverwrite, appSettings.language, downloads]);

  // Partage du salon : feuille système sur mobile, presse-papiers ailleurs.
  const copyRoomLink = useCallback(async () => {
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
    // L'application de bureau tourne sur un serveur local : le lien partagé doit
    // rester l'adresse web publique (NEXT_PUBLIC_SHARE_BASE), pas 127.0.0.1.
    const base = (process.env.NEXT_PUBLIC_SHARE_BASE || `${window.location.origin}${basePath}`)
      .replace(/\/+$/, '');
    const link = `${base}/?room=${encodeURIComponent(roomId)}`;
    const shareData = { title: 'GlobalShare', text: `Rejoins le salon ${roomId}`, url: link };
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share(shareData);
        return;
      }
      await navigator.clipboard.writeText(link);
      showToast('success', 'Lien du salon copié');
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      showToast('warning', `Lien du salon : ${link}`);
    }
  }, [roomId, showToast]);

  useEffect(() => {
    window.globalShare = step === 'room' ? { onFileSaved: saveFile } : undefined;
    return () => { window.globalShare = undefined; };
  }, [step, saveFile]);

  // ---- Écran d accueil ----
  if (step === 'welcome') {
    // Suggestion instantanée : le plus petit chiffre de salon sans personne
    // dedans, recalculé à chaque rafraîchissement des salons ouverts.
    const instantCode = pickInstantCode(liveRooms.map(room => room.roomId));
    const live = [...liveRooms].sort((a, b) => a.roomId.localeCompare(b.roomId));
    return (
      <div className="gs-app gs-app--welcome">
        <div className="gs-glow" aria-hidden="true" />
        <header className="gs-topbar gs-topbar--bare">
          <Link href="/" className="gs-brand">
            <span className="gs-brand-mark"><IconBolt /></span>
            <span>GlobalShare</span>
          </Link>
          <div className="gs-topbar-right">
            <UpdateTrigger open={updateOpen} onToggle={() => setUpdateOpen(value => !value)} />
          </div>
        </header>
        <UpdateBanner open={updateOpen} onOpenChange={setUpdateOpen} />
        <main className="gs-welcome-main">
          {homeView === 'create' && (
            <>
              <div className="gs-hero">
                <h1>Partagez un fichier, pas un compte</h1>
                <p>Passez le même code aux deux appareils. Direct, sans inscription.</p>
              </div>

              {/* Création instantanée : le premier chiffre de salon libre */}
              <button
                type="button"
                className="gs-instant"
                onClick={() => joinRoom(instantCode)}
              >
                <span className="gs-instant-digit" aria-hidden="true">{instantCode}</span>
                <span className="gs-instant-text">
                  <strong>Créer le salon {instantCode}</strong>
                  <span>Un seul chiffre à retenir, libre à l’instant</span>
                </span>
                <IconBolt className="gs-icon gs-icon--sm gs-instant-arrow" />
              </button>

              <div className="gs-card">
                <div className="gs-field gs-field--row">
                  <label htmlFor="gs-name" className="gs-label">Votre appareil</label>
                  <input
                    id="gs-name"
                    className="gs-input"
                    value={myName}
                    onChange={e => setMyName(e.target.value)}
                    placeholder="Nom de l'appareil"
                    maxLength={24}
                    enterKeyHint="next"
                  />
                </div>
              </div>

              {live.length > 0 && (
                <section className="gs-live" aria-label="Salons ouverts maintenant">
                  <h2 className="gs-list-title">Salons ouverts</h2>
                  <div className="gs-roompills">
                    {live.slice(0, 4).map(room => (
                      <button
                        key={room.roomId}
                        type="button"
                        className="gs-roompill"
                        onClick={() => joinRoom(room.roomId)}
                      >
                        <span className="gs-roompill-code">{room.roomId}</span>
                        <span className="gs-roompill-meta">
                          {room.users} appareil{room.users > 1 ? 's' : ''}
                        </span>
                      </button>
                    ))}
                    {live.length > 4 && (
                      <button
                        type="button"
                        className="gs-roompill gs-roompill--more"
                        onClick={() => setHomeView('rooms')}
                      >
                        +{live.length - 4} autres
                      </button>
                    )}
                  </div>
                </section>
              )}
            </>
          )}

          {homeView === 'join' && (
            <>
              <div className="gs-hero">
                <h1>Rejoindre avec un code</h1>
                <p>Tapez le code partagé, ou générez-en un privé pour inviter quelqu’un.</p>
              </div>

              <div className="gs-card">
                <div className="gs-field gs-field--row">
                  <label htmlFor="gs-name-join" className="gs-label">Votre appareil</label>
                  <input
                    id="gs-name-join"
                    className="gs-input"
                    value={myName}
                    onChange={e => setMyName(e.target.value)}
                    placeholder="Nom de l'appareil"
                    maxLength={24}
                    enterKeyHint="next"
                  />
                </div>
                <div className="gs-field gs-field--row">
                  <label htmlFor="gs-room" className="gs-label">Code</label>
                  <input
                    id="gs-room"
                    className="gs-input gs-input--code"
                    value={roomId}
                    onChange={e => setRoomId(e.target.value.toUpperCase())}
                    placeholder="1, 42 ou A1B2C3"
                    onKeyDown={handleKeyDown}
                    autoCapitalize="characters"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={12}
                    inputMode="text"
                    enterKeyHint="go"
                  />
                </div>
                <button
                  type="button"
                  className="gs-btn gs-btn--primary gs-btn--block"
                  onClick={() => joinRoom()}
                  disabled={!roomId.trim() || !myName.trim()}
                >
                  Rejoindre le salon
                </button>
                <button
                  type="button"
                  className="gs-btn gs-btn--ghost gs-btn--block"
                  onClick={() => joinRoom(generateRoomId())}
                >
                  <IconKey className="gs-icon gs-icon--sm" />
                  Créer avec un code privé
                </button>
                <p className="gs-hint">
                  Le code privé ne peut pas être deviné : seul celui qui le reçoit
                  peut rejoindre.
                </p>
              </div>
            </>
          )}

          {homeView === 'rooms' && (
            <section className="gs-rooms-page" aria-label="Salons">
              {live.length > 0 && (
                <>
                  <h2 className="gs-list-title">Ouverts maintenant</h2>
                  <div className="gs-roompills">
                    {live.map(room => (
                      <button
                        key={room.roomId}
                        type="button"
                        className="gs-roompill"
                        onClick={() => joinRoom(room.roomId)}
                      >
                        <span className="gs-roompill-code">{room.roomId}</span>
                        <span className="gs-roompill-meta">
                          {room.users} appareil{room.users > 1 ? 's' : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              <h2 className="gs-list-title">Vos salons</h2>
              {roomHistory.length === 0 ? (
                <div className="gs-empty">
                  <span className="gs-empty-icon" aria-hidden="true"><IconHistory /></span>
                  <strong>Aucun salon récent</strong>
                  <span>Les salons créés ou rejoints depuis cet appareil apparaîtront ici.</span>
                </div>
              ) : (
                <div className="gs-history-list gs-history-list--page">
                  {roomHistory.slice(0, appSettings.itemsPerPage).map(entry => (
                    <div key={entry.roomId} className="gs-roomrow">
                      <button
                        type="button"
                        className="gs-roomrow-main"
                        onClick={() => joinRoom(entry.roomId, entry.name)}
                      >
                        <span className="gs-roomrow-code">{entry.roomId}</span>
                        <span className="gs-roomrow-meta">
                          {entry.name ? `${entry.name} · ` : ''}
                          {formatRoomAge(entry.lastUsed)}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="gs-iconbtn gs-roomrow-forget"
                        aria-label={`Retirer le salon ${entry.roomId}`}
                        title="Retirer"
                        onClick={() => setRoomHistory(forgetStoredRoom(entry.roomId))}
                      >
                        <IconTrash className="gs-icon gs-icon--sm" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {roomHistory.length > 0 && (
                <button
                  type="button"
                  className="gs-btn gs-btn--ghost gs-btn--sm"
                  onClick={() => {
                    clearRoomHistory();
                    setRoomHistory([]);
                  }}
                >
                  Effacer l’historique
                </button>
              )}
            </section>
          )}

          {homeView === 'settings' && (
            <section className="gs-settings" aria-label={translateSetting(appSettings.language, 'settings')}>
              <div className="gs-hero gs-hero--tight">
                <h1>{translateSetting(appSettings.language, 'settingsHeroTitle')}</h1>
                <p>{translateSetting(appSettings.language, 'settingsHeroSubtitle')}</p>
              </div>

              <div className="gs-settings-scroll">
                <SettingsPanel
                  appSettings={appSettings}
                  updateAppSetting={updateAppSetting}
                  resetAllSettings={resetAllSettings}
                />
              </div>
            </section>
          )}
        </main>

        <nav className="gs-homenav" aria-label="Navigation de l'accueil">
          <button
            type="button"
            className={`gs-homenav-item${homeView === 'create' ? ' is-active' : ''}`}
            aria-current={homeView === 'create' ? 'page' : undefined}
            onClick={() => setHomeView('create')}
          >
            <IconBolt className="gs-icon gs-icon--sm" />
            Créer
          </button>
          <button
            type="button"
            className={`gs-homenav-item${homeView === 'join' ? ' is-active' : ''}`}
            aria-current={homeView === 'join' ? 'page' : undefined}
            onClick={() => setHomeView('join')}
          >
            <IconKey className="gs-icon gs-icon--sm" />
            Code
          </button>
          <button
            type="button"
            className={`gs-homenav-item${homeView === 'rooms' ? ' is-active' : ''}`}
            aria-current={homeView === 'rooms' ? 'page' : undefined}
            onClick={() => {
              setRoomHistory(loadRoomHistory());
              setHomeView('rooms');
            }}
          >
            <IconHistory className="gs-icon gs-icon--sm" />
            Salons
          </button>
          <button
            type="button"
            className={`gs-homenav-item${homeView === 'settings' ? ' is-active' : ''}`}
            aria-current={homeView === 'settings' ? 'page' : undefined}
            onClick={() => setHomeView('settings')}
          >
            <IconSettings className="gs-icon gs-icon--sm" />
            {translateSetting(appSettings.language, 'settings')}
          </button>
        </nav>
      </div>
    );
  }

  // ---- Salon actif ----
  const activePeer = activePeerId ? peers[activePeerId] : undefined;
  const queuedTransfers = transfers.filter(t => t.status === 'queued');
  const activeTransfers = transfers.filter(t => t.status === 'transferring' || t.status === 'pending' || t.status === 'paused' || t.status === 'queued');
  const trackingProgress = activeTransfers.length ? weightedProgress(activeTransfers) : 0;
  const totalQueuedBytes = queuedTransfers.reduce((s, t) => s + t.file.size, 0);
  const totalActiveSpeed = activeTransfers.reduce((s, t) => s + t.speed, 0);
  const totalRemaining = activeTransfers.reduce((s, t) => s + Math.max(0, t.file.size - t.confirmed), 0);
  const queueEta = formatEta(totalRemaining, totalActiveSpeed);
  // Tri d'affichage : en cours d'abord, puis en pause/interrompu, puis la file.
  const statusRank = (t: TransferState): number =>
    t.status === 'transferring' ? 0 : t.status === 'paused' ? 1 : t.status === 'interrupted' ? 2 : t.status === 'queued' ? 3 : 4;
  const sortedTransfers = [...transfers].sort((a, b) => {
    const rank = statusRank(a) - statusRank(b);
    if (rank !== 0) return rank;
    if (a.status === 'queued' && b.status === 'queued') return (a.queuePosition ?? 0) - (b.queuePosition ?? 0);
    return a.createdAt - b.createdAt;
  });
  const isTrackingOpen = trackingOpen && activeTransfers.length > 0;

  const toggleExpanded = (id: string) => {
    setExpandedTransfers(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const pauseAll = () => {
    for (const t of transfers) {
      if (t.status === 'transferring') managerRef.current?.pause(t.id);
    }
  };
  const resumeAll = () => {
    for (const t of transfers) {
      if (t.status === 'paused' || t.status === 'interrupted') managerRef.current?.resume(t.id);
    }
    kickSendLoop();
  };

  // Glisser-déposer : compter les entrées/sorties pour ne pas clignoter.
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepthRef.current += 1;
    setIsDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);
    if (step !== 'room') return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) enqueueFiles(files, activePeerId);
  };

  return (
    <div className="gs-app" onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop}>
      <div className="gs-glow" aria-hidden="true" />
      {isDragging && step === 'room' && (
        <div className="gs-drop-overlay" aria-hidden="true">
          <div className="gs-drop-card">
            <IconShare />
            <strong>Déposez vos fichiers</strong>
            <span>Ils rejoignent la file d’envoi vers {activePeer?.name ?? 'l’appareil choisi'}</span>
          </div>
        </div>
      )}
      <header className="gs-topbar">
        <div className="gs-topbar-left">
          {/* Seul point d'accès aux réglages depuis le salon : toujours visible,
              y compris sur mobile (Pixel 9a), à gauche du code du salon. */}
          <button
            type="button"
            className="gs-iconbtn"
            onClick={() => setRoomSettingsOpen(true)}
            aria-label={translateSetting(appSettings.language, 'settings')}
            title={translateSetting(appSettings.language, 'settings')}
          >
            <IconSettings className="gs-icon" />
          </button>
          <button
            type="button"
            className="gs-room-chip"
            onClick={() => void copyRoomLink()}
            title={`Partager le lien du salon ${roomId}`}
            aria-label={`Partager le lien du salon ${roomId}`}
          >
            <span className="gs-room-chip-label">Salon</span>
            <span className="gs-room-chip-code">{roomId}</span>
            <IconShare className="gs-icon gs-icon--sm" />
          </button>
        </div>
        <div className="gs-topbar-right">
          <UpdateTrigger open={updateOpen} onToggle={() => setUpdateOpen(value => !value)} />
          {appSettings.showConnectionStatus && (
            <span className={`gs-status gs-status--${connectionStatus}`} role="status">
              <span className="gs-dot" aria-hidden="true" />
              {connectionStatus === 'connected' ? 'Connecté' : connectionStatus === 'connecting' ? 'Connexion' : 'Hors ligne'}
            </span>
          )}
          <button
            type="button"
            className="gs-iconbtn"
            onClick={exitRoom}
            aria-label="Quitter le salon"
            title="Quitter le salon"
          >
            <IconClose />
          </button>
        </div>
      </header>

      <UpdateBanner open={updateOpen} onOpenChange={setUpdateOpen} />

      <nav className="gs-tabs" role="tablist" aria-label="Sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'room'}
          className={`gs-tab${tab === 'room' ? ' is-active' : ''}`}
          onClick={() => setTab('room')}
        >
          Salon
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'downloads'}
          className={`gs-tab${tab === 'downloads' ? ' is-active' : ''}`}
          onClick={() => setTab('downloads')}
        >
          Téléchargements
          {downloads.length > 0 && <span className="gs-tab-count">{downloads.length}</span>}
        </button>
      </nav>

      {toasts.length > 0 && (
        <div className="gs-toasts" aria-live="polite">
          {toasts.map(t => (
            <div
              key={t.id}
              className={`gs-toast gs-toast--${t.type}`}
              role={t.type === 'error' ? 'alert' : 'status'}
            >
              <span className="gs-toast-icon" aria-hidden="true">
                {t.type === 'success' ? '✓' : t.type === 'error' ? '!' : t.type === 'warning' ? '⚠' : 'i'}
              </span>
              <span>{t.message}</span>
            </div>
          ))}
        </div>
      )}

      {showErrorModal && (
        <div className="gs-overlay" onClick={() => setShowErrorModal(false)}>
          <div
            className="gs-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gs-sheet-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="gs-sheet-handle" aria-hidden="true" />
            <div className="gs-sheet-title" id="gs-sheet-title">Connexion perdue</div>
            <div className="gs-sheet-body">{connectErrorMessage}</div>
            <div className="gs-sheet-actions">
              <button type="button" className="gs-btn gs-btn--ghost" onClick={() => setShowErrorModal(false)}>
                Fermer
              </button>
              <button type="button" className="gs-btn gs-btn--primary" onClick={handleReconnect}>
                Réessayer
              </button>
            </div>
          </div>
        </div>
      )}

      <main className={`gs-main${activeTransfers.length > 0 ? ' gs-main--tracking' : ''}`}>
        {/* Onglet Téléchargements : les fichiers reçus, rouverts depuis l'app */}
        {tab === 'downloads' && (
          <section className="gs-section gs-downloads" aria-label="Téléchargements">
            <div className="gs-segment" role="tablist" aria-label="Listes de fichiers">
              <button
                type="button"
                role="tab"
                aria-selected={downloadsTab === 'received'}
                className={`gs-segment-btn${downloadsTab === 'received' ? ' is-active' : ''}`}
                onClick={() => setDownloadsTab('received')}
              >
                <IconDownload className="gs-icon gs-icon--sm" />
                Reçus
                <span className="gs-segment-count">{downloads.length}</span>
              </button>
              {(isMobileHost() || isDesktopHost()) && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={downloadsTab === 'device'}
                  className={`gs-segment-btn${downloadsTab === 'device' ? ' is-active' : ''}`}
                  onClick={() => setDownloadsTab('device')}
                >
                  <IconFolder className="gs-icon gs-icon--sm" />
                  {isMobileHost() ? 'Sur le téléphone' : "Sur l'ordinateur"}
                  <span className="gs-segment-count">
                    {isMobileHost() ? sharedFiles.length : desktopFiles.length}
                  </span>
                </button>
              )}
            </div>

            {downloadsTab === 'received' && (
              <>
                <div className="gs-section-head gs-dl-head">
                  <div className="gs-dl-summary">
                    <strong>{downloads.length} fichier{downloads.length > 1 ? 's' : ''} reçu{downloads.length > 1 ? 's' : ''}</strong>
                    <span>
                      {downloads.length > 0
                        ? `${formatBytes(downloads.reduce((total, f) => total + f.size, 0))} · ouvrables d'un appui`
                        : 'Les fichiers reçus apparaissent ici.'}
                    </span>
                  </div>
                  {downloads.length > 0 && (
                    <button
                      type="button"
                      className="gs-btn gs-btn--ghost gs-btn--sm"
                      onClick={() => void clearDownloadHistory()}
                    >
                      Tout supprimer
                    </button>
                  )}
                </div>
                {downloads.length === 0 ? (
                  <div className="gs-empty">
                    <span className="gs-empty-icon" aria-hidden="true"><IconDownload /></span>
                    <strong>Aucun fichier reçu</strong>
                    <span>
                      Les fichiers reçus restent ici et s&apos;ouvrent d&apos;un appui, même après
                      avoir quitté le salon.
                    </span>
                  </div>
                ) : (
                  <div className="gs-list">
                    {downloads.map((f, i) => {
                      const kind = viewerKind(f.mime, f.name);
                      return (
                        <article
                          key={f.id}
                          className="gs-file gs-file--card"
                          style={{ animationDelay: `${Math.min(i, 5) * 45}ms` }}
                        >
                          {appSettings.showFileIcons && (
                            <span
                              className={`gs-file-icon${kind === 'audio' || kind === 'image' || kind === 'video' ? ` gs-file-icon--${kind}` : ''}`}
                              aria-hidden="true"
                            >
                              {kind === 'audio' ? <IconMusic /> : kind === 'image' ? <IconCamera /> : <IconFile />}
                            </span>
                          )}
                          <div className="gs-file-meta">
                            <div className="gs-file-top">
                              <div className="gs-file-name" title={f.name}>{f.name}</div>
                              <span
                                className={`gs-pill ${f.integrity === 'verified'
                                  ? 'gs-pill--ok'
                                  : f.integrity === 'mismatch'
                                    ? 'gs-pill--bad'
                                    : 'gs-pill--warn'}`}
                              >
                                {f.integrity === 'verified'
                                  ? 'vérifié'
                                  : f.integrity === 'mismatch'
                                    ? 'corrompu'
                                    : 'non vérifié'}
                              </span>
                            </div>
                            <div className="gs-file-sub">
                              {appSettings.showFileSize && <span>{formatBytes(f.size)}</span>}
                              <span>De {f.from}</span>
                              {appSettings.showFileDate && <span>{formatDate(f.receivedAt)}</span>}
                            </div>
                            <div className="gs-file-actions">
                              {isMobileHost() ? (
                                <>
                                  <button
                                    type="button"
                                    className="gs-dl"
                                    onClick={() => void revealDownload(f)}
                                  >
                                    <IconFolder className="gs-icon gs-icon--sm" />
                                    Fichiers
                                  </button>
                                  {f.path && (
                                    <button
                                      type="button"
                                      className="gs-dl gs-dl--ghost"
                                      onClick={() => void openDownload(f)}
                                    >
                                      <IconMusic className="gs-icon gs-icon--sm" />
                                      Écouter
                                    </button>
                                  )}
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="gs-dl"
                                    onClick={() => void openDownload(f)}
                                  >
                                    <IconOpen className="gs-icon gs-icon--sm" />
                                    Ouvrir
                                  </button>
                                  {f.path && (
                                    <button
                                      type="button"
                                      className="gs-dl gs-dl--ghost"
                                      onClick={() => void revealDownload(f)}
                                    >
                                      Dossier
                                    </button>
                                  )}
                                </>
                              )}
                              <button
                                type="button"
                                className="gs-dl gs-dl--ghost gs-dl--danger"
                                onClick={() => void removeDownload(f)}
                                aria-label={`Retirer ${f.name} de la liste`}
                              >
                                <IconTrash className="gs-icon gs-icon--sm" />
                                Retirer
                              </button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {isDesktopHost() && downloadsTab === 'device' && (
              <div className="gs-device">
                <div className="gs-section-head gs-dl-head">
                  <div className="gs-dl-summary">
                    <strong>{desktopFiles.length} fichier{desktopFiles.length > 1 ? 's' : ''} sur l&apos;ordinateur</strong>
                    <span title={desktopFolder}>{desktopFolder || 'Dossier de réception'}</span>
                  </div>
                  <div className="gs-dl-head-actions">
                    <button
                      type="button"
                      className="gs-dl gs-dl--ghost"
                      onClick={() => void (async () => {
                        const error = await openReceiveFolder();
                        if (error) showToast('error', error);
                      })()}
                    >
                      <IconFolder className="gs-icon gs-icon--sm" />
                      Ouvrir le dossier
                    </button>
                  </div>
                </div>
                {desktopFiles.length === 0 ? (
                  <div className="gs-empty">
                    <span className="gs-empty-icon" aria-hidden="true"><IconFolder /></span>
                    <strong>Aucun fichier dans le dossier de réception</strong>
                    <span>
                      Les fichiers enregistrés sur cet ordinateur apparaissent ici, même
                      s&apos;ils ont été déposés par une autre application.
                    </span>
                  </div>
                ) : (
                  <div className="gs-list">
                    {desktopFiles.map((file, i) => {
                      const kind = viewerKind(mimeFromName(file.name), file.name);
                      return (
                        <article
                          key={file.path}
                          className="gs-file gs-file--card"
                          style={{ animationDelay: `${Math.min(i, 5) * 45}ms` }}
                        >
                          <span
                            className={`gs-file-icon${kind === 'audio' || kind === 'image' || kind === 'video' ? ` gs-file-icon--${kind}` : ''}`}
                            aria-hidden="true"
                          >
                            {kind === 'audio' ? <IconMusic /> : kind === 'image' ? <IconCamera /> : <IconFile />}
                          </span>
                          <div className="gs-file-meta">
                            <div className="gs-file-top">
                              <div className="gs-file-name" title={file.path}>{file.name}</div>
                            </div>
                            <div className="gs-file-sub">
                              <span>{formatBytes(file.size)}</span>
                              <span>{formatDate(file.modified)}</span>
                              <span>Dans le dossier de réception</span>
                            </div>
                            <div className="gs-file-actions">
                              <button
                                type="button"
                                className="gs-dl"
                                onClick={() => void (async () => {
                                  const error = await window.globalshareDesktop?.openDownload(file.path);
                                  if (error) showToast('error', error);
                                })()}
                              >
                                <IconOpen className="gs-icon gs-icon--sm" />
                                Ouvrir
                              </button>
                              <button
                                type="button"
                                className="gs-dl gs-dl--ghost"
                                onClick={() => void (async () => {
                                  const error = await window.globalshareDesktop?.revealDownload(file.path);
                                  if (error) showToast('error', error);
                                })()}
                              >
                                <IconFolder className="gs-icon gs-icon--sm" />
                                Afficher dans le dossier
                              </button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {isMobileHost() && downloadsTab === 'device' && (
              <div className="gs-device">
                <div className="gs-section-head gs-dl-head">
                  <div className="gs-dl-summary">
                    <strong>{sharedFiles.length} fichier{sharedFiles.length > 1 ? 's' : ''} sur le téléphone</strong>
                    <span>Téléchargements/GlobalShare</span>
                  </div>
                  <div className="gs-dl-head-actions">
                    <button
                      type="button"
                      className="gs-dl gs-dl--ghost"
                      onClick={() => void (async () => {
                        const error = await mobileRevealDownload();
                        if (error) showToast('error', error);
                      })()}
                    >
                      <IconFolder className="gs-icon gs-icon--sm" />
                      Ouvrir Fichiers
                    </button>
                    {sharedFiles.length > 0 && (
                      <button
                        type="button"
                        className="gs-dl gs-dl--ghost gs-dl--danger"
                        onClick={() => void (async () => {
                          // Ici on efface vraiment les fichiers du disque : le
                          // dialogue doit le dire, pas parler d'historique.
                          if (!window.confirm(translateSetting(
                            appSettings.language, 'confirmClearDevice', { count: sharedFiles.length }
                          ))) return;
                          for (const file of sharedFiles) {
                            await mobileDeleteDownload({ uri: file.uri, name: file.name });
                          }
                          await refreshMobileFiles();
                        })()}
                      >
                        <IconTrash className="gs-icon gs-icon--sm" />
                        Effacer tout
                      </button>
                    )}
                  </div>
                </div>
                {sharedFiles.length === 0 ? (
                  <div className="gs-empty">
                    <span className="gs-empty-icon" aria-hidden="true"><IconFolder /></span>
                    <strong>Aucun fichier sur le téléphone</strong>
                    <span>
                      Les fichiers enregistrés dans Téléchargements/GlobalShare apparaissent ici,
                      même s&apos;ils ont été ajoutés par une autre application.
                    </span>
                  </div>
                ) : (
                  <div className="gs-list">
                    {sharedFiles.map((file, i) => {
                      const kind = viewerKind(mimeFromName(file.name), file.name);
                      return (
                        <article
                          key={file.uri}
                          className="gs-file gs-file--card"
                          style={{ animationDelay: `${Math.min(i, 5) * 45}ms` }}
                        >
                          <span
                            className={`gs-file-icon${kind === 'audio' || kind === 'image' || kind === 'video' ? ` gs-file-icon--${kind}` : ''}`}
                            aria-hidden="true"
                          >
                            {kind === 'audio' ? <IconMusic /> : kind === 'image' ? <IconCamera /> : <IconFile />}
                          </span>
                          <div className="gs-file-meta">
                            <div className="gs-file-top">
                              <div className="gs-file-name" title={file.name}>{file.name}</div>
                            </div>
                            <div className="gs-file-sub">
                              <span>{formatBytes(file.size)}</span>
                              <span>Dans Fichiers</span>
                            </div>
                            <div className="gs-file-actions">
                              <button
                                type="button"
                                className="gs-dl"
                                onClick={() => void (async () => {
                                  const error = await mobileOpenDownload({
                                    uri: file.uri, mime: mimeFromName(file.name), name: file.name,
                                  });
                                  if (error) showToast('error', error);
                                })()}
                              >
                                <IconOpen className="gs-icon gs-icon--sm" />
                                Ouvrir
                              </button>
                              <button
                                type="button"
                                className="gs-dl gs-dl--ghost gs-dl--danger"
                                onClick={() => void (async () => {
                                  const result = await mobileDeleteDownload({
                                    uri: file.uri, name: file.name,
                                  });
                                  if (result.error) showToast('error', result.error);
                                  else {
                                    setSharedFiles(prev => prev.filter(f => f.uri !== file.uri));
                                    showToast('success', `Supprimé : ${file.name}`);
                                  }
                                })()}
                              >
                                <IconTrash className="gs-icon gs-icon--sm" />
                                Supprimer
                              </button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* File d'envoi : résumé, progression globale et actions groupées */}
        {tab === 'room' && activeTransfers.length > 0 && (
          <section className="gs-section" aria-label="File d'envoi">
            <div className="gs-queue">
              <div className="gs-queue-head">
                <div className="gs-queue-title">
                  <span className="gs-queue-badge" aria-hidden="true">{trackingProgress}%</span>
                  <div className="gs-queue-text">
                    <strong>{activeTransfers.length} transfert{activeTransfers.length > 1 ? 's' : ''}{queuedTransfers.length > 0 ? ` · ${queuedTransfers.length} en file` : ''}</strong>
                    <span>{formatSpeed(totalActiveSpeed)}{queueEta ? ` · ETA ${queueEta}` : ''} · {formatBytes(totalRemaining)} restant{totalQueuedBytes > 0 ? ` (+${formatBytes(totalQueuedBytes)} en file)` : ''}</span>
                  </div>
                </div>
              </div>
              {appSettings.showProgressBar && <TransferBar progress={trackingProgress} status="transferring" />}
              <div className="gs-queue-actions">
                {activeTransfers.some(t => t.status === 'transferring') && (
                  <button type="button" className="gs-btn gs-btn--ghost gs-btn--sm" onClick={pauseAll}>⏸ Tout mettre en pause</button>
                )}
                {activeTransfers.some(t => t.status === 'paused' || t.status === 'interrupted') && (
                  <button type="button" className="gs-btn gs-btn--ghost gs-btn--sm" onClick={resumeAll}>▶ Tout reprendre</button>
                )}
                {queuedTransfers.length > 1 && (
                  <button type="button" className="gs-btn gs-btn--ghost gs-btn--sm" onClick={() => managerRef.current?.sortQueueBySize()}>⇅ Petits d’abord</button>
                )}
                {queuedTransfers.length > 0 && (
                  <button type="button" className="gs-btn gs-btn--ghost gs-btn--sm gs-btn--danger" onClick={() => managerRef.current?.cancelQueue()}>Vider la file</button>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Transferts en cours et terminés */}
        {tab === 'room' && transfers.length > 0 && (
          <section className="gs-section" aria-label="Transferts">
            <div className="gs-section-head">
              <h2 className="gs-section-title">Transferts</h2>
              <span className="gs-count">{transfers.length}</span>
            </div>
            <div className="gs-list">
              {sortedTransfers.map((t, i) => {
                const expanded = expandedTransfers.has(t.id);
                const eta = formatEta(Math.max(0, t.file.size - t.confirmed), t.speed);
                const statusIcon = t.status === 'transferring' ? '⇅' : t.status === 'queued' ? '◷' : t.status === 'paused' ? '⏸' : t.status === 'interrupted' ? '⚠' : t.status === 'completed' ? '✓' : '✕';
                return (
                <div
                  key={t.id}
                  className={`gs-transfer gs-transfer--${t.status}${t.status === 'completed' ? ' is-complete' : ''}${expanded ? ' is-expanded' : ''}`}
                  style={{ animationDelay: `${Math.min(i, 6) * 50}ms` }}
                >
                  <button type="button" className="gs-transfer-head gs-transfer-toggle" onClick={() => toggleExpanded(t.id)} aria-expanded={expanded}>
                    <span className={`gs-transfer-badge gs-transfer-badge--${t.status}`} aria-hidden="true">{statusIcon}</span>
                    <div className="gs-transfer-text">
                      <div className="gs-transfer-name">{t.file.name}</div>
                      <div className="gs-transfer-sub">
                        {t.status === 'queued' ? <>En file <strong>#{t.queuePosition ?? '…'}</strong> · </> : null}
                        {t.direction === 'send' ? 'Vers ' : 'De '}
                        <strong>{t.targetName}</strong>
                        {appSettings.showFileSize && <> · {formatBytes(t.file.size)}</>}
                        <span className={`gs-tag gs-tag--${t.transport}`} title={t.transport === 'p2p' ? 'Données échangées en direct' : 'Données relayées par le serveur'}>{t.transport === 'p2p' ? 'P2P' : 'Relais'}</span>
                      </div>
                    </div>
                    <span className={`gs-transfer-pct gs-transfer-pct--${t.status}`}>{t.progress}%</span>
                    <span className="gs-transfer-chevron" aria-hidden="true">{expanded ? '▴' : '▾'}</span>
                  </button>
                  {appSettings.showProgressBar && <TransferBar progress={t.progress} status={t.status} />}
                  <div className="gs-transfer-foot">
                    <span className="gs-transfer-status">{TRANSFER_LABELS[t.status] ?? t.status}{eta ? ` · ${eta}` : ''} · {formatTime(renderTime - t.createdAt)}</span>
                    <span className="gs-transfer-speed">{t.status === 'transferring' ? `${formatSpeed(t.speed)} · ${formatBytes(t.confirmed)}` : t.status === 'queued' ? 'En attente d’un créneau' : `${formatBytes(t.confirmed)} / ${formatBytes(t.file.size)}`}</span>
                  </div>
                  {expanded && (
                    <div className="gs-transfer-details">
                      <SpeedSparkline history={t.speedHistory} active={t.status === 'transferring'} />
                      <div className="gs-transfer-details-grid">
                        <span><em>Débit</em><strong>{formatSpeed(t.speed)}</strong></span>
                        <span><em>Reçu</em><strong>{formatBytes(t.confirmed)}</strong></span>
                        <span><em>Restant</em><strong>{formatBytes(Math.max(0, t.file.size - t.confirmed))}</strong></span>
                        <span><em>ETA</em><strong>{eta ?? '—'}</strong></span>
                      </div>
                      <div className="gs-transfer-actions">
                        {t.status === 'queued' && (
                          <button type="button" className="gs-btn gs-btn--primary gs-btn--sm" onClick={() => managerRef.current?.prioritize(t.id)}>Passer en premier</button>
                        )}
                        {t.direction === 'send' && (t.status === 'transferring' || t.status === 'paused') && (
                          <button type="button" className="gs-btn gs-btn--ghost gs-btn--sm" onClick={() => (t.status === 'paused' ? managerRef.current?.resume(t.id) : managerRef.current?.pause(t.id))}>
                            {t.status === 'paused' ? '▶ Reprendre' : '⏸ Pause'}
                          </button>
                        )}
                        {(t.status === 'transferring' || t.status === 'paused' || t.status === 'queued') && (
                          <button type="button" className="gs-btn gs-btn--ghost gs-btn--sm gs-btn--danger" onClick={() => cancelTransfer(t.id)}>Annuler</button>
                        )}
                        {t.direction === 'send' && t.status === 'interrupted' && !fileRefs.current.has(t.id) && (
                          <button type="button" className="gs-btn gs-btn--primary gs-btn--sm" onClick={() => { resumeTargetRef.current = t.id; resumeInputRef.current?.click(); }}>Choisir le fichier</button>
                        )}
                        {t.status === 'interrupted' && (
                          <button type="button" className="gs-btn gs-btn--ghost gs-btn--sm" title={t.error ?? 'Transfert interrompu'} onClick={() => cancelTransfer(t.id)}>Annuler</button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Liste des pairs */}
        {tab === 'room' && (
        <section className="gs-section" aria-label="Appareils du salon">
          <div className="gs-section-head">
            <h2 className="gs-section-title">Appareils</h2>
            <span className="gs-count">{Object.keys(peers).length}</span>
          </div>
          {Object.keys(peers).length === 0 ? (
            <div className="gs-empty">
              <span className="gs-empty-icon" aria-hidden="true"><IconDevices /></span>
              <strong>En attente d&apos;un autre appareil</strong>
              <span>
                Ouvrez GlobalShare sur l&apos;autre appareil et saisissez le code{' '}
                <b className="gs-room-chip-code">{roomId}</b>.
              </span>
              <button type="button" className="gs-btn gs-btn--ghost gs-btn--sm" onClick={() => void copyRoomLink()}>
                <IconShare className="gs-icon gs-icon--sm" />
                Partager le lien
              </button>
            </div>
          ) : (
            <div className="gs-list">
              {Object.values(peers).map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  className={`gs-peer${p.status === 'connected' ? ' is-ready' : ''}`}
                  style={{ animationDelay: `${Math.min(i, 5) * 45}ms` }}
                  aria-pressed={activePeerId === p.id}
                  onClick={() => setActivePeerId(prev => (prev === p.id ? null : p.id))}
                >
                  <span className="gs-avatar" aria-hidden="true">{p.name.charAt(0).toUpperCase()}</span>
                  <span className="gs-peer-meta">
                    <span className="gs-peer-name">{p.name}</span>
                    <span className="gs-peer-sub">
                      <span className="gs-tag">{p.method === 'p2p' ? 'P2P' : 'Relais'}</span>
                      {p.status === 'connected' ? 'Prêt à recevoir' : 'Connexion…'}
                    </span>
                  </span>
                  {activePeerId === p.id && <span className="gs-check" aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          )}
        </section>
        )}

      </main>

      {/* Barre d'action : toujours dans la zone du pouce, seulement dans le salon */}
      {tab === 'room' && (
      <div className="gs-actionbar">
        {activeTransfers.length > 0 && (
          <div className={`gs-minibar${isTrackingOpen ? ' is-open' : ''}`}>
            {isTrackingOpen && (
              <div className="gs-minibar-panel">
                {activeTransfers.map(t => (
                  <div key={t.id} className="gs-minirow">
                    <div className="gs-minirow-head">
                      <span className="gs-minirow-name" title={t.file.name}>{t.status === 'queued' ? `◷ #${t.queuePosition ?? '…'} ` : ''}{t.file.name}</span>
                      <span className="gs-minirow-pct">{t.progress}%</span>
                      <button type="button" className="gs-minirow-cancel" onClick={() => cancelTransfer(t.id)} aria-label="Annuler le transfert" title="Annuler le transfert">✕</button>
                    </div>
                    {appSettings.showProgressBar && <TransferBar progress={t.progress} status={t.status} />}
                    <div className="gs-minirow-sub">
                      {t.status === 'queued' ? 'En file' : `${t.direction === 'send' ? 'Vers ' : 'De '}${t.targetName} · ${formatSpeed(t.speed)}` } · {formatBytes(t.confirmed)}
                    </div>
                    <SpeedSparkline history={t.speedHistory} active={t.status === 'transferring'} />
                  </div>
                ))}
              </div>
            )}
            {appSettings.showProgressBar && (
              <div className="gs-minibar-track gs-minibar-track--animated" aria-hidden="true">
                <TransferBar progress={trackingProgress} status="transferring" />
              </div>
            )}
            <button
              type="button"
              className="gs-minibar-toggle"
              onClick={() => setTrackingOpen(open => !open)}
              aria-expanded={isTrackingOpen}
            >
              <span className="gs-minibar-badge" aria-hidden="true">{trackingProgress}%</span>
              <span className="gs-minibar-text">
                <strong>
                  {activeTransfers.length > 1
                    ? `${activeTransfers.length} transferts${queuedTransfers.length > 0 ? ` (${queuedTransfers.length} en file)` : ''}`
                    : activeTransfers[0].file.name}
                </strong>
                <span>
                  {activeTransfers.length > 1
                    ? `${formatSpeed(totalActiveSpeed)} · ${queueEta ? `ETA ${queueEta} · ` : ''}Progression globale`
                    : activeTransfers[0].status === 'queued'
                      ? `En file #${activeTransfers[0].queuePosition ?? '…'} · ${formatBytes(activeTransfers[0].file.size)}`
                      : `${formatSpeed(activeTransfers[0].speed)} · ${formatBytes(activeTransfers[0].confirmed)}`}
                </span>
              </span>
              <span className="gs-minibar-chevron" aria-hidden="true">▾</span>
            </button>
          </div>
        )}
        <div className="gs-actionbar-target">
          {activePeer ? (
            <>Envoyer vers <strong>{activePeer.name}</strong></>
          ) : (
            'Choisissez un appareil ci-dessus'
          )}
        </div>
        <div className="gs-actionbar-row">
          <button
            type="button"
            className="gs-action gs-action--primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={!activePeerId}
          >
            <IconFile />
            <span>Fichier</span>
          </button>
          <button
            type="button"
            className="gs-action"
            onClick={() => folderInputRef.current?.click()}
            disabled={!activePeerId}
          >
            <IconFolder />
            <span>Dossier</span>
          </button>
          <button
            type="button"
            className="gs-action"
            onClick={() => cameraInputRef.current?.click()}
            disabled={!activePeerId}
          >
            <IconCamera />
            <span>Photo</span>
          </button>
        </div>
      </div>
      )}

      <input type="file" ref={fileInputRef} onChange={handleFileSelect} accept="*/*" className="hidden" multiple />
      <input
        type="file"
        ref={folderInputRef}
        onChange={handleFolderSelect}
        className="hidden"
        // @ts-expect-error - webkitdirectory is non-standard but supported by Chromium/WebKit
        webkitdirectory=""
      />
      <input type="file" ref={cameraInputRef} onChange={handleCameraSelect} accept="image/*,video/*" capture="environment" className="hidden" multiple />
      <input type="file" ref={resumeInputRef} onChange={handleResumeSelect} accept="*/*" className="hidden" />

      {/* ---- Réglages par-dessus le salon : page plein écran, retour direct ---- */}
      {roomSettingsOpen && (
        <div
          className="gs-settings-overlay"
          role="dialog"
          aria-label={translateSetting(appSettings.language, 'settings')}
        >
          <div className="gs-glow" aria-hidden="true" />
          <header className="gs-settings-topbar">
            <button
              type="button"
              className="gs-btn gs-btn--ghost gs-settings-back"
              onClick={() => setRoomSettingsOpen(false)}
            >
              <IconArrowLeft className="gs-icon gs-icon--sm" />
              {translateSetting(appSettings.language, 'roomBack')}
            </button>
            <h1>{translateSetting(appSettings.language, 'settingsHeroTitle')}</h1>
            <span className="gs-settings-topbar-version">v{appVersion}</span>
          </header>
          <div className="gs-settings-inner">
            <div className="gs-settings-scroll">
              <SettingsPanel
                appSettings={appSettings}
                updateAppSetting={updateAppSetting}
                resetAllSettings={resetAllSettings}
                showVersion={false}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
