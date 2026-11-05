'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { io, Socket } from 'socket.io-client';
import SimplePeer from 'simple-peer/simplepeer.min.js';
import JSZip from 'jszip';
import { TransferManager, TransferState, CHUNK_SIZE_DEFAULT } from './TransferManager';
import './GlobalShare.css';

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
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const getSocketUrl = (): string => {
  if (typeof window !== 'undefined') {
    if (process.env.NEXT_PUBLIC_SOCKET_URL) return process.env.NEXT_PUBLIC_SOCKET_URL;
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') return 'http://localhost:3001';
    return window.location.origin;
  }
  return process.env.NEXT_PUBLIC_SOCKET_URL || '';
};

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
interface IncomingFile { buffer: Uint8Array[]; size: number; meta: { name: string; size: number; mime?: string } | null; }

declare global {
  interface Window { globalShare?: { onFileSaved?: (blob: Blob, name: string) => void }; }
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
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [connectErrorMessage, setConnectErrorMessage] = useState<string | null>(null);

  // ---- Refs ----
  const socketRef = useRef<Socket | null>(null);
  const managerRef = useRef<TransferManager | null>(null);
  const peersRef = useRef<Record<string, SimplePeer>>({});
  const fileRefs = useRef<Map<string, File>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const selectedPeerId = useRef<string | null>(null);
  const incomingRef = useRef<IncomingFile>({ buffer: [], size: 0, meta: null });
  const transferAbortRef = useRef<{ abort: boolean; targetId: string | null }>({ abort: false, targetId: null });
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const transferTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectDeadlineTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectErrorShownRef = useRef(false);
  const toastIdRef = useRef(0);

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
        onSendDone: (id) => {},
      }
    );
    managerRef.current = manager;

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
  }, [showToast]);

  // ---- Socket lifecycle ----
  useEffect(() => {
    const socket = io(getSocketUrl(), {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      timeout: 10000,
    } as Parameters<typeof io>[1]);
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to server');
      setConnectionStatus('connected');
      if (socketRef.current) socketRef.current.emit('join-room', { roomId, name: myName });
      setStep('room');
      setConnectErrorMessage(null);
      connectErrorShownRef.current = false;
    });

    socket.on('disconnect', (reason) => {
      console.log('Disconnected:', reason);
      setConnectionStatus('disconnected');
      if (reason === 'io server disconnect') socket.connect();
    });

    socket.on('connect_error', (err) => {
      console.error('Connect error:', err);
      setConnectionStatus('disconnected');
    });

    return () => {
      socket.disconnect();
    };
  }, []);

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
        manager.sendEof(sendT.id);
        return;
      }
      if (sendT.pending.size >= CHUNK_SIZE_DEFAULT) {
        transferTimeoutRef.current = setTimeout(() => sendLoop(), 50);
        return;
      }
      const blob = file.slice(sendT.offset, Math.min(sendT.offset + sendT.chunkSize, file.size));
      const arrayBuffer = await blob.arrayBuffer();
      const chunk = new Uint8Array(arrayBuffer);
      if (sendT.method === 'relay') {
        manager.sendChunk(sendT.id, sendT.nextSeq, chunk);
      } else {
        const peer = peersRef.current[sendT.targetId];
        if (peer) {
          peer.send(JSON.stringify({
            type: 'transfer-chunk', transferId: sendT.id, seq: sendT.nextSeq,
            size: chunk.length, chunk: Array.from(chunk), target: sendT.targetId,
          }));
        }
      }
      sendT.nextSeq++;
      sendT.offset += chunk.byteLength;
      const speedRatio = Math.min(sendT.speed / 2_000_000, 1);
      transferTimeoutRef.current = setTimeout(() => sendLoop(), 5 + Math.floor(20 * (1 - speedRatio)));
    };
    void sendLoop();
    return () => {
      if (transferTimeoutRef.current) clearTimeout(transferTimeoutRef.current);
    };
  }, [transfers]);

  // ---- Handlers événements Socket (hors transfer) ----
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;
    const s = socket;
    s.on('room-users', (users: { id: string; name: string }[]) => {
      const next: Record<string, PeerInfo> = {};
      users.forEach(u => next[u.id] = { id: u.id, name: u.name, status: 'connected', method: 'relay' });
      setPeers(prev => ({ ...prev, ...next }));
    });
    s.on('user-joined', ({ id, name }: { id: string; name: string }) => {
      setPeers(prev => ({ ...prev, [id]: { id, name, status: 'connecting', method: 'relay' } }));
    });
    s.on('user-left', (id: string) => {
      setPeers(prev => { const next = { ...prev }; delete next[id]; return next; });
      managerRef.current?.cancel(id, "L'appareil s'est déconnecté");
    });
    s.on('offer', (data: { caller: string; sdp: unknown }) => {
      const peer = peersRef.current[data.caller];
      if (peer && !peer.destroyed) { try { peer.signal(data.sdp as object); } catch { /* ignore */ } }
    });
    s.on('answer', (data: { caller: string; sdp: unknown }) => {
      const peer = peersRef.current[data.caller];
      if (peer && !peer.destroyed) { try { peer.signal(data.sdp as object); } catch { /* ignore */ } }
    });
    s.on('ice-candidate', (data: { caller: string; candidate: unknown }) => {
      const peer = peersRef.current[data.caller];
      if (peer && !peer.destroyed) { try { peer.signal(data.candidate); } catch { /* ignore */ } }
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
    Object.values(peersRef.current).forEach(p => { try { p.destroy(); } catch { /* ignore */ } });
    peersRef.current = {};
    setPeers({});
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
      const next: Record<string, PeerInfo> = {};
      users.forEach(u => next[u.id] = { id: u.id, name: u.name, status: 'connected', method: 'relay' });
      setPeers(prev => ({ ...prev, ...next }));
    });
    socket.on('user-joined', ({ id, name }) => {
      setPeers(prev => ({ ...prev, [id]: { id, name, status: 'connecting', method: 'relay' } }));
    });
    socket.on('user-left', (id) => {
      setPeers(prev => { const next = { ...prev }; delete next[id]; return next; });
      managerRef.current?.cancel(id, "L'appareil s'est déconnecté");
    });
    socket.on('offer', (data) => { const peer = peersRef.current[data.caller]; if (peer && !peer.destroyed) { try { peer.signal(data.sdp as object); } catch { /* ignore */ } } });
    socket.on('answer', (data) => { const peer = peersRef.current[data.caller]; if (peer && !peer.destroyed) { try { peer.signal(data.sdp as object); } catch { /* ignore */ } } });
    socket.on('ice-candidate', (data) => { const peer = peersRef.current[data.caller]; if (peer && !peer.destroyed) { try { peer.signal(data.candidate); } catch { /* ignore */ } } });
  }, [roomId, myName]);

  const resyncRoom = useCallback((reason: string) => {
    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit('join-room', { roomId, name: myName });
    }
    Object.values(peersRef.current).forEach(p => { try { p.destroy(); } catch { /* ignore */ } });
    peersRef.current = {};
    setPeers({});
  }, [roomId, myName]);

  const exitRoom = useCallback(() => {
    Object.values(peersRef.current).forEach(p => { try { p.destroy(); } catch { /* ignore */ } });
    peersRef.current = {};
    setPeers({});
    if (socketRef.current) {
      try { socketRef.current.disconnect(); } catch { /* ignore */ }
      socketRef.current = null;
    }
    fileRefs.current.clear();
    setTransfers([]);
    setStep('welcome');
    setConnectionStatus('disconnected');
    setRoomId('');
  }, []);

  // ---- Gestion des pairs (P2P) ----
  const addPeer = useCallback((id: string, name: string, initiator: boolean) => {
    if (peersRef.current[id]) return;
    setPeers(prev => ({ ...prev, [id]: { id, name, status: 'connecting', method: 'p2p' } }));
    const p = new SimplePeer({ initiator, trickle: true, config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    } } as RTCConfiguration);
    const connectionTimeout = setTimeout(() => {
      if (!p.connected) {
        console.log('P2P timeout, using relay for', id);
        setPeers(prev => ({ ...prev, [id]: { id, name, status: 'connected', method: 'relay' } }));
      }
    }, 10000);
    p.on('signal', (data: { type?: string; candidate?: unknown }) => {
      if (data.type === 'offer') {
        socketRef.current?.emit('offer', { target: id, caller: socketRef.current!.id, sdp: data });
      } else if (data.type === 'answer') {
        socketRef.current?.emit('answer', { target: id, caller: socketRef.current!.id, sdp: data });
      } else if (data.candidate) {
        socketRef.current?.emit('ice-candidate', { target: id, caller: socketRef.current!.id, candidate: data });
      }
    });
    p.on('connect', () => {
      clearTimeout(connectionTimeout);
      setPeers(prev => ({ ...prev, [id]: { id, name, status: 'connected', method: 'p2p' } }));
    });
    p.on('data', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type: string; transferId?: string; seq?: number; size?: number;
          chunk?: ArrayBuffer; target?: string; initiator?: string;
        };
        if (msg.type === 'transfer-chunk') {
          managerRef.current?.onTransferChunk({ transferId: msg.transferId!, seq: msg.seq!, size: msg.size!, chunk: Array.from(new Uint8Array(msg.chunk as ArrayBuffer)), target: socketRef.current?.id ?? '' });
        } else if (msg.type === 'transfer-eof') {
          managerRef.current?.onTransferEof({ transferId: msg.transferId!, size: msg.size!, target: socketRef.current?.id ?? '' });
        } else if (msg.type === 'transfer-ack') {
          managerRef.current?.onTransferAck({ transferId: msg.transferId!, seq: msg.seq!, size: msg.size!, initiator: socketRef.current?.id ?? '', target: msg.target! });
        }
      } catch { /* ignore */ }
    });
    p.on('error', (err: Error) => {
      console.error('Peer error:', err);
      clearTimeout(connectionTimeout);
      setPeers(prev => ({ ...prev, [id]: { id, name, status: 'connected', method: 'relay' } }));
    });
    p.on('close', () => {
      clearTimeout(connectionTimeout);
      setPeers(prev => { const next = { ...prev }; delete next[id]; return next; });
    });
    peersRef.current[id] = p;
  }, []);

  const removePeer = useCallback((id: string) => {
    const peer = peersRef.current[id];
    if (peer) { try { peer.destroy(); } catch { /* ignore */ } }
    delete peersRef.current[id];
    setPeers(prev => { const next = { ...prev }; delete next[id]; return next; });
  }, []);

  const startSending = useCallback((targetId: string, file: File, method: 'p2p' | 'relay') => {
    if (!socketRef.current?.connected) {
      showToast('error', 'Connexion au serveur perdue');
      return;
    }
    const t = managerRef.current?.startSend({ name: file.name, size: file.size, mime: file.type }, targetId, method);
    if (t) {
      fileRefs.current.set(t.id, file);
      showToast('info', `Préparation de l envoi : ${file.name}`);
    }
  }, []);

  // ---- Sélection de fichiers ----
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedPeerId.current) return;
    const targetId = selectedPeerId.current;
    const peer = peers[targetId];
    if (!peer && !socketRef.current?.connected) {
      alert('Connexion au serveur perdue.');
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
        alert('Connexion au serveur perdue.');
        e.target.value = '';
        return;
      }
    }
    startSending(targetId, file, peer ? (peer.method === 'p2p' ? 'p2p' : 'relay') : 'relay');
    e.target.value = '';
  }, [startSending, peers]);

  const handleFolderSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const targetId = selectedPeerId.current;
    e.target.value = '';
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
      startSending(targetId, zipFile, 'relay');
    } catch (err) {
      console.error('Folder zip failed', err);
      showToast('error', 'Erreur lors de la compression du dossier');
    }
  }, [startSending, peers, showToast]);

  const handleCameraSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const targetId = selectedPeerId.current;
      if (targetId) startSending(targetId, file, 'relay');
      e.target.value = '';
    }
  }, [startSending]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    if (!roomId.trim()) { e.preventDefault(); alert('Veuillez entrer un code de salon.'); return; }
    joinRoom();
  }, [roomId, joinRoom]);

  const handleReconnect = useCallback(() => {
    setShowErrorModal(false);
    joinRoom();
  }, [joinRoom]);

  // ---- Sauvegarde des fichiers reçus ----
  const saveFile = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    if (step === 'room') {
      (window as unknown as { globalShare?: { onFileSaved?: (blob: Blob, name: string) => void } }).globalShare = { onFileSaved: saveFile };
    } else {
      (window as unknown as { globalShare?: { onFileSaved?: (blob: Blob, name: string) => void } }).globalShare = undefined;
    }
    return () => {
      (window as unknown as { globalShare?: { onFileSaved?: (blob: Blob, name: string) => void } }).globalShare = undefined;
    };
  }, [step, saveFile]);

  // ---- Écran d accueil ----
  if (step === 'welcome') {
    return (
      <div className="app-wrapper">
        <header>
          <Link href="/" className="brand">
            {React.createElement('ion-icon', { name: 'planet' })} GlobalShare
          </Link>
        </header>
        <main className="welcome-screen">
          <h1>Rejoindre un Salon</h1>
          <p>Entrez le même code sur tous les appareils</p>
          <div className="input-group">
            <label>Votre Nom</label>
            <input
              value={myName}
              onChange={e => setMyName(e.target.value)}
            />
          </div>
          <div className="input-group">
            <label>Code du Salon</label>
            <input
              value={roomId}
              onChange={e => setRoomId(e.target.value.toUpperCase())}
              placeholder="Ex: A1B2C3"
              onKeyDown={handleKeyDown}
            />
          </div>
          <button className="btn-primary" onClick={() => joinRoom()}>Rejoindre</button>
          <button
            style={{ background: 'transparent', border: 'none', color: 'var(--secondary)', marginTop: '20px', cursor: 'pointer' }}
            onClick={() => setRoomId(generateRoomId())}
          >
            Générer un code aléatoire
          </button>
        </main>
      </div>
    );
  }

  // ---- Salon actif ----
  return (
    <div className="app-wrapper">
      <header>
        <div className="brand" onClick={exitRoom}>
          {React.createElement('ion-icon', { name: 'planet' })} GlobalShare
        </div>
        <div className="connection-status" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem' }}>
          {connectionStatus === 'connected' ? (
            <span style={{ color: '#03dac6', fontWeight: 600 }}>● Connecté</span>
          ) : connectionStatus === 'connecting' ? (
            <span style={{ color: '#bb86fc', fontWeight: 600 }}>● Connexion…</span>
          ) : (
            <span style={{ color: '#cf6679', fontWeight: 600 }}>● Hors ligne</span>
          )}
          {connectErrorMessage && <span style={{ color: '#cf6679' }}>{connectErrorMessage}</span>}
        </div>
      </header>

      {toasts.length > 0 && (
        <div className="toast-container" style={{ position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)', zIndex: 3000, display: 'flex', flexDirection: 'column', gap: '8px', width: '90%' }}>
          {toasts.map(t => (
            <div key={t.id} className={"toast " + (t.type === 'success' ? 'success' : t.type === 'error' ? 'error' : t.type === 'warning' ? 'warning' : 'info')} style={{ background: 'rgba(30,30,30,0.95)', border: '1px solid ' + (t.type === 'success' ? '#03dac6' : t.type === 'error' ? '#cf6679' : t.type === 'warning' ? '#ff9800' : '#bb86fc'), color: 'white', padding: '12px 16px', borderRadius: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)', maxWidth: '90%' }}>
              <div style={{ fontWeight: 600 }}>{t.type === 'success' ? '✓' : t.type === 'error' ? '✗' : t.type === 'warning' ? '⚠' : 'ℹ'}</div>
              <div style={{ fontSize: '0.9rem' }}>{t.message}</div>
            </div>
          ))}
        </div>
      )}

      {showErrorModal && (
        <div className="gs-modal-overlay" onClick={() => setShowErrorModal(false)}>
          <div className="gs-modal">
            <div className="gs-modal-title">Connexion perdue</div>
            <div className="gs-modal-body">{errorMessage || connectErrorMessage}</div>
            <div className="gs-modal-actions">
              <button className="gs-modal-btn" onClick={handleReconnect}>Reconnecter</button>
            </div>
          </div>
        </div>
      )}

      <main style={{ flex: 1, padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {/* Liste des transferts en cours */}
        {transfers.length > 0 && (
          <div style={{ background: 'rgba(30,30,30,0.5)', borderRadius: '12px', padding: '12px', border: '1px solid #333' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <h2 style={{ margin: 0, color: 'var(--primary)' }}>Transfert(s) en cours</h2>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>{transfers.length} enregistré(s)</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {transfers.map(t => (
                <div key={t.id} className="transfer-card" style={
                  { background: 'rgba(255,255,255,0.04)', borderRadius: '12px', padding: '12px', border: '1px solid rgba(255,255,255,0.06)' }
                }>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
                    <div>
                      <div style={{ fontWeight: 700, color: 'white' }}>{t.file.name}</div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>{formatBytes(t.file.size)} · {t.targetName}</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px', whiteSpace: 'nowrap' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>{t.status}</span>
                      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--secondary)' }}>{t.progress}%</span>
                    </div>
                  </div>
                  <div style={{ height: 4, background: '#333', borderRadius: '3px', marginTop: '10px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: t.status === 'completed' ? '#03dac6' : t.status === 'cancelled' ? '#888' : '#bb86fc', width: `${t.progress}%`, transition: 'width 0.2s' }}></div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                    <span>{formatSpeed(t.speed)} / s</span>
                    <span><TransferElapsed createdAt={t.createdAt} /> · {t.confirmed > 0 ? formatBytes(t.confirmed) : '0 B'} envoyé(s)</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Liste des pairs */}
        <div style={{ background: 'rgba(30,30,30,0.3)', borderRadius: '12px', padding: '12px', border: '1px solid #333' }}>
          <h2 style={{ margin: 0, color: 'white', fontSize: '1rem' }}>Appareils ({peers && Object.keys(peers).length})</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '8px' }}>
            {peers && Object.values(peers).map(p => (
              <div key={p.id} className="peer-card" style={
                { background: 'rgba(255,255,255,0.04)', borderRadius: '12px', padding: '12px', border: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }
              }>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)', fontWeight: 700 }}>{p.name.charAt(0).toUpperCase()}</div>
                  <div>
                    <div style={{ fontWeight: 600, color: 'white', fontSize: '0.9rem' }}>{p.name}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>{p.method === 'p2p' ? 'P2P direct' : 'Via relai'}</div>
                  </div>
                </div>
                <div style={{ color: 'var(--text-dim)', fontSize: '1rem' }}>▸</div>
              </div>
            ))}
            {peers && Object.keys(peers).length === 0 && (
              <div style={{ color: 'var(--text-dim)', fontSize: '0.9rem', textAlign: 'center', padding: '20px' }}>Aucun appareil join</div>
            )}
          </div>
        </div>
      </main>

      {/* Barre de transfert en cours */}
      {transfers.find(t => t.status === 'transferring' || t.status === 'pending') && (
        <div className="transfer-panel" style={{ background: 'rgba(30,30,30,0.6)', borderTop: '4px solid var(--secondary)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 700, color: 'white' }}>{transfers.find(t => t.status === 'transferring' || t.status === 'pending')?.file.name}</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>{formatBytes(transfers.find(t => t.status === 'transferring' || t.status === 'pending')?.confirmed || 0)} / {formatBytes(transfers.find(t => t.status === 'transferring' || t.status === 'pending')?.file.size || 0)}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--secondary)' }}>{transfers.find(t => t.status === 'transferring' || t.status === 'pending')?.progress || 0}%</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>{formatSpeed(transfers.find(t => t.status === 'transferring' || t.status === 'pending')?.speed || 0)} / s</div>
            </div>
          </div>
          <div style={{ height: 6, background: '#333', borderRadius: '3px', marginTop: '8px', overflow: 'hidden' }}>
            <div style={{ height: '100%', background: 'var(--secondary)', width: `${transfers.find(t => t.status === 'transferring' || t.status === 'pending')?.progress || 0}%`, transition: 'width 0.2s' }}></div>
          </div>
        </div>
      )}

      <div className="room-badge">
        <span>Salon {roomId}</span>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>{myName}</span>
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
