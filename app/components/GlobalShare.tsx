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

const MAX_IN_FLIGHT_CHUNKS = 8;
import './GlobalShare.css';

// Délai au-delà duquel une tentative de connexion directe est abandonnée : le
// relais prend le relais sans que l'utilisateur ait à attendre.
const P2P_CONNECT_TIMEOUT_MS = 15_000;
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
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
const formatSpeed = (bps: number): string => {
  if (bps < 1024) return `${bps} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
};
const getSocketUrl = (): string => {
  if (typeof window !== 'undefined') {
    if (process.env.NEXT_PUBLIC_SOCKET_URL) return process.env.NEXT_PUBLIC_SOCKET_URL;
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') return 'http://localhost:3001';
    return window.location.origin;
  }
  return process.env.NEXT_PUBLIC_SOCKET_URL || '';
};

// Libellés des états de transfert, pour ne pas afficher l'identifiant brut.
const TRANSFER_LABELS: Record<string, string> = {
  pending: 'En attente',
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

function IconDevices({ className = 'gs-icon' }: IconProps) {
  return (
    <svg {...iconProps} className={className}>
      <rect x="2.5" y="5" width="13" height="9.5" rx="2" />
      <path d="M6.5 18.5h5" />
      <rect x="16.5" y="10" width="5" height="9.5" rx="1.6" />
    </svg>
  );
}

// Chrono d'un transfert : le temps est mis à jour par intervalle, jamais pendant le rendu.
function TransferElapsed({ createdAt }: { createdAt: number }) {
  const [now, setNow] = useState(createdAt);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{formatTime(now - createdAt)}</>;
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
interface ReceivedFile {
  id: number; name: string; blob: Blob; size: number;
  /** URL du blob, créée une fois et conservée tant que la page vit. */
  url: string;
  integrity: IntegrityStatus;
}

declare global {
  interface Window {
    globalShare?: {
      onFileSaved?: (blob: Blob, name: string, integrity: IntegrityStatus) => void;
    };
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
  // Blobs reçus conservés pour proposer un téléchargement sur geste explicite.
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [connectErrorMessage, setConnectErrorMessage] = useState<string | null>(null);
  // Incrémenté à chaque socket créé : le TransferManager se rattache au bon socket.
  const [socketEpoch, setSocketEpoch] = useState(0);
  const [activePeerId, setActivePeerId] = useState<string | null>(null);
  const [trackingOpen, setTrackingOpen] = useState(false);

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
  const connectDeadlineTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectErrorShownRef = useRef(false);
  const toastIdRef = useRef(0);
  const receivedFileIdRef = useRef(0);

  const showToast = useCallback((type: Toast['type'], message: string) => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 6000);
  }, []);

  // ---- Initialisation du TransferManager ----
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;
    const manager = new TransferManager(
      socket,
      socket.id ?? 'unknown',
      {
        onUpdate: (t) => setTransfers(prev => {
          const idx = prev.findIndex(x => x.id === t.id);
          if (idx >= 0) { const next = [...prev]; next[idx] = t; return next; }
          return [...prev, t];
        }),
        onComplete: (t) => {
          setTransfers(prev => prev.filter(x => x.id !== t.id));
          fileRefs.current.delete(t.id);
          showToast('success', `Fichier reçu : ${t.file.name}`);
        },
        onCancel: (t, reason) => {
          setTransfers(prev => prev.filter(x => x.id !== t.id));
          fileRefs.current.delete(t.id);
          showToast('info', `Transfert annulé : ${t.file.name} (${reason})`);
        },
        onError: (t, error) => {
          setTransfers(prev => prev.filter(x => x.id !== t.id));
          fileRefs.current.delete(t.id);
          showToast('error', `Échec du transfert : ${t.file.name} — ${error}`);
        },
        onStatus: (t) => setTransfers(prev => prev.map(x => x.id === t.id ? t : x)),
        onSendDone: () => {},
      }
    );
    managerRef.current = manager;
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
    s.on('transfer-chunk', (p) => manager.onTransferChunk(p));
    s.on('transfer-ack', (p) => manager.onTransferAck(p));
    s.on('transfer-eof', (p) => manager.onTransferEof(p));
    s.on('transfer-eof-ack', (p) => manager.onTransferEofAck(p));
    s.on('transfer-cancel', (p) => manager.onTransferCancel(p));
    s.on('transfer-end', (p) => manager.onTransferEnd(p));

    return () => {
      manager.clear();
      s.off('transfer-init'); s.off('transfer-chunk');
      s.off('transfer-ack'); s.off('transfer-eof'); s.off('transfer-eof-ack');
      s.off('transfer-cancel'); s.off('transfer-end');
    };
  }, [showToast, socketEpoch]);

  // ---- URL room param ----
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const roomParam = params.get('room');
      // Différé : évite un rendu en cascade synchrone au montage (react-hooks).
      if (roomParam) queueMicrotask(() => setRoomId(roomParam));
    }
  }, []);

  // ---- Boucle d envoi (relay + p2p) ----
  useEffect(() => {
    const sendLoop = async () => {
      // Un ACK relance la boucle pendant que le chunk courant est encore en
      // cours de lecture. Sans ce verrou, deux exécutions lisent le même
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
        const transfers = manager.getAll();
        const sendT = transfers.find(t => t.direction === 'send' && t.status === 'transferring');
        if (!sendT) return;
        const file = fileRefs.current.get(sendT.id);
        if (!file) return;
        if (sendT.offset >= file.size) {
          // N'annonce la fin qu'une fois tous les chunks acquittés.
          if (sendT.pending.size === 0) manager.sendEof(sendT.id);
          else transferTimeoutRef.current = setTimeout(() => sendLoop(), 200);
          return;
        }
        if (sendT.pending.size >= MAX_IN_FLIGHT_CHUNKS) {
          transferTimeoutRef.current = setTimeout(() => sendLoop(), 20);
          return;
        }
        const blob = file.slice(sendT.offset, Math.min(sendT.offset + sendT.chunkSize, file.size));
        const arrayBuffer = await blob.arrayBuffer();
        const chunk = new Uint8Array(arrayBuffer);
        // Le transport (canal direct ou relais) est choisi par le
        // TransferManager : sendChunk avance l'offset, arme le suivi des ACK et
        // réémet en cas de perte, quel que soit le chemin emprunté.
        manager.sendChunk(sendT.id, sendT.nextSeq, chunk);
        sendT.nextSeq++;
        const speedRatio = Math.min(sendT.speed / 2_000_000, 1);
        transferTimeoutRef.current = setTimeout(() => sendLoop(), 5 + Math.floor(20 * (1 - speedRatio)));
      } finally {
        sendLoopRunningRef.current = false;
      }
    };
    void sendLoop();
    return () => {
      if (transferTimeoutRef.current) clearTimeout(transferTimeoutRef.current);
    };
  }, [transfers]);

  // ---- Chemin direct (WebRTC) ----
  // Un canal de données par pair ; le relais Socket.IO reste le repli quand la
  // connexion directe échoue (NAT symétrique, réseau filtrant, onglet en veille).
  const destroyPeer = useCallback((peerId: string) => {
    const timer = p2pTimersRef.current[peerId];
    if (timer) {
      clearTimeout(timer);
      delete p2pTimersRef.current[peerId];
    }
    delete p2pStateRef.current[peerId];
    const peer = peersRef.current[peerId];
    delete peersRef.current[peerId];
    if (peer && !peer.destroyed) {
      try { peer.destroy(); } catch { /* ignore */ }
    }
  }, []);

  const ensureP2P = useCallback((peerId: string, initiator: boolean) => {
    if (!peerId) return;
    if (typeof window === 'undefined' || typeof window.RTCPeerConnection === 'undefined') return;
    const current = peersRef.current[peerId];
    if (current && !current.destroyed) return;
    // Une tentative ratée ne doit pas se relancer en boucle : on reste relais.
    if (p2pStateRef.current[peerId] === 'failed') return;
    p2pStateRef.current[peerId] = 'connecting';

    const peer = new SimplePeer({
      initiator,
      trickle: true,
      config: { iceServers: ICE_SERVERS },
    });
    peersRef.current[peerId] = peer;

    const fallback = () => {
      p2pStateRef.current[peerId] = 'failed';
      const timer = p2pTimersRef.current[peerId];
      if (timer) {
        clearTimeout(timer);
        delete p2pTimersRef.current[peerId];
      }
      setPeers(prev => (prev[peerId]
        ? { ...prev, [peerId]: { ...prev[peerId], method: 'relay' } }
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
      });
    });

    peer.on('error', fallback);
    peer.on('close', () => {
      if (peersRef.current[peerId] === peer) delete peersRef.current[peerId];
      fallback();
    });
  }, []);

  // ---- Gestion arrière-plan / réseau ----
  useEffect(() => {
    const onOnline = () => {
      setConnectionStatus(prev => (prev === 'connected' ? prev : 'connecting'));
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  // ---- Jointour / Rejoint / Quitter ----
  const joinRoom = useCallback((roomOverride?: string) => {
    const effectiveRoomId = (roomOverride ?? roomId).trim();
    if (!effectiveRoomId || !myName) return;
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
      socket.emit('join-room', { roomId: effectiveRoomId, name: myName });
      setStep('room');
    });
    socket.on('disconnect', (reason) => {
      console.log('Disconnected:', reason);
      setConnectionStatus('disconnected');
      // Les identifiants changent à la reconnexion : les canaux directs
      // deviennent caducs et seront renégociés sur les nouveaux ids.
      Object.keys(peersRef.current).forEach(destroyPeer);
      if (reason === 'io server disconnect') socket.connect();
    });
    socket.on('connect_error', () => {
      setConnectionStatus('disconnected');
      if (!connectErrorShownRef.current) {
        connectErrorShownRef.current = true;
        setConnectErrorMessage('Impossible de se connecter au serveur.');
        setShowErrorModal(true);
      }
    });
    socket.on('room-users', (users: { id: string; name: string }[]) => {
      const selfId = socket.id ?? '';
      const next: Record<string, PeerInfo> = {};
      users.forEach(u => {
        next[u.id] = { id: u.id, name: u.name, status: 'connected', method: 'relay' };
        // Règle déterministe pour que les deux côtés ne s'offrent pas la
        // connexion en même temps : l'id le plus petit propose.
        ensureP2P(u.id, selfId < u.id);
      });
      setPeers(prev => ({ ...prev, ...next }));
    });
    socket.on('user-joined', ({ id, name }) => {
      setPeers(prev => ({ ...prev, [id]: { id, name, status: 'connecting', method: 'relay' } }));
      ensureP2P(id, (socket.id ?? '') < id);
    });
    socket.on('user-left', (id) => {
      setPeers(prev => { const next = { ...prev }; delete next[id]; return next; });
      setActivePeerId(prev => (prev === id ? null : prev));
      destroyPeer(id);
      managerRef.current?.cancel(id, "L'appareil s'est déconnecté");
    });
    // Signalisation WebRTC : le worker ne fait que la transmettre, la connexion
    // directe se négocie entre les deux navigateurs.
    const onSignal = (data: { caller: string; sdp?: object }) => {
      if (!data?.caller || !data.sdp) return;
      ensureP2P(data.caller, false);
      const peer = peersRef.current[data.caller];
      if (!peer || peer.destroyed) return;
      try { peer.signal(data.sdp); } catch { /* signal tardif ou obsolète */ }
    };
    socket.on('offer', onSignal);
    socket.on('answer', onSignal);
    socket.on('ice-candidate', onSignal);
  }, [roomId, myName, ensureP2P, destroyPeer]);

  const exitRoom = useCallback(() => {
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
    // un fichier entier en mémoire sur un téléphone.
    let hash: string | null = null;
    if (file.size <= HASH_MAX_BYTES) {
      hash = await sha256Hex(await file.arrayBuffer());
    }
    if (!socketRef.current?.connected) {
      showToast('error', 'Connexion au serveur perdue');
      return;
    }
    const t = managerRef.current?.startSend(
      { name: file.name, size: file.size, mime: file.type },
      targetId,
      method,
      hash ?? undefined
    );
    if (t) {
      fileRefs.current.set(t.id, file);
      showToast('info', `Préparation de l envoi : ${file.name}`);
    }
  }, [showToast]);

  // ---- Sélection de fichiers ----
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const targetId = activePeerId;
    if (!file || !targetId) return;
    const peer = peers[targetId];
    if (!peer && !socketRef.current?.connected) {
      showToast('error', 'Connexion au serveur perdue.');
      e.target.value = '';
      return;
    }
    if (!peer) {
      setPeers(prev => ({ ...prev, [targetId]: { id: targetId, name: prev[targetId]?.name || 'Appareil', status: 'connected', method: 'relay' } }));
    }
    if (!peer || peer.status !== 'connected') {
      if (socketRef.current?.connected) {
        setPeers(prev => ({ ...prev, [targetId]: { id: targetId, name: prev[targetId]?.name || 'Appareil', status: 'connected', method: 'relay' } }));
      } else {
        showToast('error', 'Connexion au serveur perdue.');
        e.target.value = '';
        return;
      }
    }
    void startSending(targetId, file, peer ? (peer.method === 'p2p' ? 'p2p' : 'relay') : 'relay');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [startSending, peers, activePeerId, showToast]);

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
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const zipName = `${rootFolder}.zip`;
      const zipFile = new File([blob], zipName, { type: 'application/zip' });
      await startSending(targetId, zipFile, 'relay');
    } catch (err) {
      console.error('Folder zip failed', err);
      showToast('error', 'Erreur lors de la compression du dossier');
    }
  }, [startSending, peers, showToast, activePeerId]);

  const handleCameraSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const targetId = activePeerId;
      if (targetId) void startSending(targetId, file, 'relay');
      if (cameraInputRef.current) cameraInputRef.current.value = '';
    }
  }, [startSending, activePeerId]);

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

  const saveFile = useCallback((blob: Blob, name: string, integrity: IntegrityStatus) => {
    const id = ++receivedFileIdRef.current;
    const url = URL.createObjectURL(blob);
    setReceivedFiles(prev => [{ id, name, blob, size: blob.size, url, integrity }, ...prev]);
    if (integrity === 'mismatch') {
      showToast('error', `Fichier corrompu pendant le transfert : ${name}. Renvoyez-le.`);
      return;
    }
    downloadUrl(url, name);
  }, [downloadUrl, showToast]);

  // Partage du salon : feuille système sur mobile, presse-papiers ailleurs.
  const copyRoomLink = useCallback(async () => {
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
    const link = `${window.location.origin}${basePath}/?room=${encodeURIComponent(roomId)}`;
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
    if (step === 'room') {
      (window as unknown as { globalShare?: { onFileSaved?: (blob: Blob, name: string, integrity: IntegrityStatus) => void } }).globalShare = { onFileSaved: saveFile };
    } else {
      (window as unknown as { globalShare?: { onFileSaved?: (blob: Blob, name: string, integrity: IntegrityStatus) => void } }).globalShare = undefined;
    }
    return () => {
      (window as unknown as { globalShare?: { onFileSaved?: (blob: Blob, name: string, integrity: IntegrityStatus) => void } }).globalShare = undefined;
    };
  }, [step, saveFile]);

  // ---- Écran d accueil ----
  if (step === 'welcome') {
    return (
      <div className="gs-app gs-app--welcome">
        <div className="gs-glow" aria-hidden="true" />
        <header className="gs-topbar gs-topbar--bare">
          <Link href="/" className="gs-brand">
            <span className="gs-brand-mark"><IconBolt /></span>
            <span>GlobalShare</span>
          </Link>
        </header>
        <main className="gs-welcome-main">
          <div className="gs-hero">
            <h1>Partagez un fichier, pas un compte</h1>
            <p>Le même code sur deux appareils suffit. Le fichier part directement, sans inscription.</p>
          </div>
          <div className="gs-card">
            <div className="gs-field">
              <label htmlFor="gs-name">Votre appareil</label>
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
            <div className="gs-field">
              <label htmlFor="gs-room">Code du salon</label>
              <input
                id="gs-room"
                className="gs-input gs-input--code"
                value={roomId}
                onChange={e => setRoomId(e.target.value.toUpperCase())}
                placeholder="A1B2C3"
                onKeyDown={handleKeyDown}
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={12}
                enterKeyHint="go"
              />
              <span className="gs-hint">Le même code sur les deux appareils.</span>
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
              onClick={() => setRoomId(generateRoomId())}
            >
              <IconBolt className="gs-icon gs-icon--sm" />
              Générer un code
            </button>
          </div>
          <ul className="gs-steps" aria-label="Comment ça marche">
            <li>1. Code partagé</li>
            <li>2. Appareils reliés</li>
            <li>3. Envoi direct</li>
          </ul>
        </main>
      </div>
    );
  }

  // ---- Salon actif ----
  const activePeer = activePeerId ? peers[activePeerId] : undefined;
  const activeTransfers = transfers.filter(t => t.status === 'transferring' || t.status === 'pending' || t.status === 'paused');
  const trackingProgress = activeTransfers.length
    ? Math.round(activeTransfers.reduce((sum, t) => sum + t.progress, 0) / activeTransfers.length)
    : 0;
  const isTrackingOpen = trackingOpen && activeTransfers.length > 0;

  return (
    <div className="gs-app">
      <div className="gs-glow" aria-hidden="true" />
      <header className="gs-topbar">
        <button
          type="button"
          className="gs-room-chip"
          onClick={() => void copyRoomLink()}
          title="Partager le lien du salon"
        >
          <span className="gs-room-chip-label">Salon</span>
          <span className="gs-room-chip-code">{roomId}</span>
          <IconShare className="gs-icon gs-icon--sm" />
        </button>
        <div className="gs-topbar-right">
          <span className={`gs-status gs-status--${connectionStatus}`} role="status">
            <span className="gs-dot" aria-hidden="true" />
            {connectionStatus === 'connected' ? 'Connecté' : connectionStatus === 'connecting' ? 'Connexion' : 'Hors ligne'}
          </span>
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
        {/* Transferts en cours et terminés */}
        {transfers.length > 0 && (
          <section className="gs-section" aria-label="Transferts">
            <div className="gs-section-head">
              <h2 className="gs-section-title">Transferts</h2>
              <span className="gs-count">{transfers.length}</span>
            </div>
            <div className="gs-list">
              {transfers.map((t, i) => (
                <div
                  key={t.id}
                  className={`gs-transfer${t.status === 'completed' ? ' is-complete' : ''}`}
                  style={{ animationDelay: `${Math.min(i, 5) * 45}ms` }}
                >
                  <div className="gs-transfer-head">
                    <div className="gs-transfer-text">
                      <div className="gs-transfer-name">{t.file.name}</div>
                      <div className="gs-transfer-sub">
                        {t.direction === 'send' ? 'Vers ' : 'De '}
                        <strong>{t.targetName}</strong> · {formatBytes(t.file.size)}
                      </div>
                    </div>
                    <div className="gs-transfer-pct">{t.progress}%</div>
                  </div>
                  <div className="gs-bar">
                    <div
                      className={`gs-bar-fill${t.status === 'completed' ? ' is-done' : ''}`}
                      style={{ width: `${t.progress}%` }}
                    />
                  </div>
                  <div className="gs-transfer-foot">
                    <span>{TRANSFER_LABELS[t.status] ?? t.status} · <TransferElapsed createdAt={t.createdAt} /></span>
                    {t.direction === 'send' && (t.status === 'transferring' || t.status === 'paused') && (
                      <button
                        type="button"
                        className="gs-btn gs-btn--ghost gs-btn--sm"
                        style={{ flexShrink: 0 }}
                        onClick={() => (t.status === 'paused' ? managerRef.current?.resume(t.id) : managerRef.current?.pause(t.id))}
                      >
                        {t.status === 'paused' ? '▶ Reprendre' : '⏸ Pause'}
                      </button>
                    )}
                    <span>{formatSpeed(t.speed)}/s · {formatBytes(t.confirmed)}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Fichiers reçus : bouton requis par Android pour autoriser le téléchargement */}
        {receivedFiles.length > 0 && (
          <section className="gs-section" aria-label="Fichiers reçus">
            <div className="gs-section-head">
              <h2 className="gs-section-title">Reçus</h2>
              <span className="gs-count">{receivedFiles.length}</span>
            </div>
            <div className="gs-list">
              {receivedFiles.map((f, i) => (
                <div key={f.id} className="gs-file" style={{ animationDelay: `${Math.min(i, 5) * 45}ms` }}>
                  <span className="gs-file-icon" aria-hidden="true"><IconFile /></span>
                  <div className="gs-file-meta">
                    <div className="gs-file-name" title={f.name}>{f.name}</div>
                    <div className="gs-file-sub">
                      <span>{formatBytes(f.size)}</span>
                      <span
                        className={`gs-pill ${f.integrity === 'verified'
                          ? 'gs-pill--ok'
                          : f.integrity === 'mismatch'
                            ? 'gs-pill--bad'
                            : 'gs-pill--warn'}`}
                      >
                        {f.integrity === 'verified'
                          ? 'intégrité vérifiée'
                          : f.integrity === 'mismatch'
                            ? 'fichier corrompu'
                            : 'intégrité non vérifiée'}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="gs-dl"
                    onClick={() => downloadUrl(f.url, f.name)}
                  >
                    <IconDownload className="gs-icon gs-icon--sm" />
                    Télécharger
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Liste des pairs */}
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

      </main>

      {/* Barre d'action : toujours dans la zone du pouce */}
      <div className="gs-actionbar">
        {activeTransfers.length > 0 && (
          <div className={`gs-minibar${isTrackingOpen ? ' is-open' : ''}`}>
            {isTrackingOpen && (
              <div className="gs-minibar-panel">
                {activeTransfers.map(t => (
                  <div key={t.id} className="gs-minirow">
                    <div className="gs-minirow-head">
                      <span className="gs-minirow-name" title={t.file.name}>{t.file.name}</span>
                      <span className="gs-minirow-pct">{t.progress}%</span>
                    </div>
                    <div className="gs-bar">
                      <div className="gs-bar-fill" style={{ width: `${t.progress}%` }} />
                    </div>
                    <div className="gs-minirow-sub">
                      {t.direction === 'send' ? 'Vers ' : 'De '}{t.targetName} · {formatSpeed(t.speed)}/s · {formatBytes(t.confirmed)}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="gs-minibar-track" aria-hidden="true">
              <div className="gs-bar-fill" style={{ width: `${trackingProgress}%` }} />
            </div>
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
                    ? `${activeTransfers.length} transferts en cours`
                    : activeTransfers[0].file.name}
                </strong>
                <span>
                  {activeTransfers.length > 1
                    ? 'Progression globale'
                    : `${formatSpeed(activeTransfers[0].speed)}/s · ${formatBytes(activeTransfers[0].confirmed)}`}
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

      <input type="file" ref={fileInputRef} onChange={handleFileSelect} accept="*/*" className="hidden" />
      <input
        type="file"
        ref={folderInputRef}
        onChange={handleFolderSelect}
        className="hidden"
        // @ts-expect-error - webkitdirectory is non-standard but supported by Chromium/WebKit
        webkitdirectory=""
      />
      <input type="file" ref={cameraInputRef} onChange={handleCameraSelect} accept="image/*,video/*" capture="environment" className="hidden" />
    </div>
  );
}
