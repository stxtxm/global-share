'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { io, Socket } from 'socket.io-client';
import SimplePeer from 'simple-peer/simplepeer.min.js';
import JSZip from 'jszip';
import './GlobalShare.css';

// Helpers
const generateRoomId = () => Math.random().toString(36).substr(2, 6).toUpperCase();
const detectDevice = () => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return "Device";
  }
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return "Android";
  if (/iphone|ipad/i.test(ua)) return "iOS";
  if (/windows/i.test(ua)) return "Windows";
  return "Linux/Mac";
};

// Config
const CHUNK_SIZE = 16 * 1024; // 16KB

// Get socket server URL from environment or default
const getSocketUrl = () => {
  if (typeof window !== 'undefined') {
    return process.env.NEXT_PUBLIC_SOCKET_URL || window.location.origin;
  }
  return process.env.NEXT_PUBLIC_SOCKET_URL || '';
};

interface PeerInfo {
  name: string;
  status: 'connecting' | 'connected';
  method: 'p2p' | 'relay';
}

interface TransferInfo {
  type: 'send' | 'receive';
  name: string;
  progress: number;
  peerId?: string;
}

interface IncomingFile {
  buffer: Uint8Array[];
  size: number;
  meta: {
    name: string;
    size: number;
    mime?: string;
  } | null;
}

interface PeerData {
  type: string;
  name?: string;
  size?: number;
  mime?: string;
}

// Type for SimplePeer instance
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SimplePeerInstance = any;

export default function GlobalShare() {
  // State
  const [step, setStep] = useState<'welcome' | 'room'>('welcome');
  const [roomId, setRoomId] = useState('');
  const [myName, setMyName] = useState(() => detectDevice());
  const [peers, setPeers] = useState<Record<string, PeerInfo>>({});
  const [transfer, setTransfer] = useState<TransferInfo | null>(null);
  const [showActionSheet, setShowActionSheet] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [connectErrorMessage, setConnectErrorMessage] = useState<string | null>(null);

  // Refs
  const socketRef = useRef<Socket | null>(null);
  const peersRef = useRef<Record<string, SimplePeerInstance>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const selectedPeerId = useRef<string | null>(null);
  const incomingRef = useRef<IncomingFile>({ buffer: [], size: 0, meta: null });
  const transferAbortRef = useRef<{ abort: boolean; targetId: string | null }>({ abort: false, targetId: null });
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const connectDeadlineTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const connectErrorShownRef = useRef(false);

  // Fonction pour annuler un transfert en cours
  const cancelTransfer = useCallback((reason: string) => {
    console.error('Transfer cancelled:', reason);
    
    // Nettoyer les refs de transfert
    transferAbortRef.current = { abort: true, targetId: null };
    incomingRef.current = { buffer: [], size: 0, meta: null };
    
    // Réinitialiser l'état après un court délai
    setTimeout(() => {
      setTransfer(null);
    }, 1000);
  }, []);

  const resyncRoom = useCallback((reason: string) => {
    console.log('Resync room:', reason);

    // Annuler un éventuel transfert (évite des états bloqués après verrouillage)
    setTransfer(prev => {
      if (prev) {
        cancelTransfer('Reconnexion en cours');
      }
      return prev;
    });

    // Détruire toutes les connexions P2P (souvent cassées après background)
    Object.keys(peersRef.current).forEach((id) => {
      try {
        peersRef.current[id]?.destroy();
      } catch {
        // ignore
      }
      delete peersRef.current[id];
    });
    setPeers({});

    // Redemander l'état du salon au serveur
    if (socketRef.current?.connected) {
      socketRef.current.emit('join-room', { roomId, name: myName });
    }
  }, [cancelTransfer, myName, roomId]);

  const joinRoom = (roomOverride?: string) => {
    const effectiveRoomId = (roomOverride ?? roomId).trim();
    if (!effectiveRoomId || !myName) return;

    // Si une ancienne connexion existe, la nettoyer avant de se reconnecter
    if (socketRef.current) {
      try {
        socketRef.current.disconnect();
      } catch {
        // ignore
      }
      socketRef.current = null;
    }
    Object.keys(peersRef.current).forEach((id) => {
      try {
        peersRef.current[id]?.destroy();
      } catch {
        // ignore
      }
      delete peersRef.current[id];
    });
    setPeers({});

    setStep('room');
    setConnectionStatus('connecting');
    setConnectErrorMessage(null);
    connectErrorShownRef.current = false;

    const socket = io(getSocketUrl(), {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      timeout: 10000
    });
    socketRef.current = socket;

    const failConnect = (message: string) => {
      console.error(message);
      if (connectDeadlineTimeoutRef.current) {
        clearTimeout(connectDeadlineTimeoutRef.current);
        connectDeadlineTimeoutRef.current = null;
      }
      try {
        socket.disconnect();
      } catch {
        // ignore
      }
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      setConnectionStatus('disconnected');

      // Afficher une modale persistante, une seule fois
      if (!connectErrorShownRef.current) {
        connectErrorShownRef.current = true;
        setConnectErrorMessage(message);
      }
    };

    // Laisser Render le temps de démarrer: garder le loader et réessayer jusqu'à 1min30.
    // Au bout de 1min30 sans connexion, on abandonne.
    if (connectDeadlineTimeoutRef.current) {
      clearTimeout(connectDeadlineTimeoutRef.current);
    }
    connectDeadlineTimeoutRef.current = setTimeout(() => {
      failConnect('Impossible de se connecter au serveur après 1min30.');
    }, 90 * 1000);

    socket.on('connect', () => {
      console.log('Connected to server');
      if (connectDeadlineTimeoutRef.current) {
        clearTimeout(connectDeadlineTimeoutRef.current);
        connectDeadlineTimeoutRef.current = null;
      }
      setConnectionStatus('connected');
      socket.emit('join-room', { roomId: effectiveRoomId, name: myName });
      setStep('room');
    });

    socket.io.on('reconnect_attempt', () => {
      setConnectionStatus('connecting');
    });

    socket.io.on('reconnect_error', () => {
      setConnectionStatus('connecting');
    });

    socket.on('reconnect', () => {
      console.log('Reconnected! Rejoining room...');
      if (!transfer || transfer.type !== 'send') {
        resyncRoom('socket_reconnect');
      }
    });

    socket.on('disconnect', (reason) => {
      console.log('Disconnected:', reason);
      setConnectionStatus('disconnected');
      
      // Annuler les transferts en cours en cas de déconnexion
      setTransfer(prev => {
        if (prev) {
          cancelTransfer('Connexion perdue avec le serveur');
        }
        return prev;
      });
      
      if (reason === 'io server disconnect') {
        socket.connect();
      }
    });

    socket.on('room-users', (users: Array<{ id: string; name: string }>) => {
      users.forEach(u => addPeer(u.id, u.name, true));
    });

    socket.on('user-joined', ({ id, name }: { id: string; name: string }) => {
      addPeer(id, name, false);
    });

    socket.on('user-left', (id: string) => {
      // Si un transfert est en cours avec ce peer, l'annuler
      setTransfer(prev => {
        if (prev && prev.peerId === id) {
          const peerName = peers[id]?.name || 'L\'appareil';
          cancelTransfer(`${peerName} s'est déconnecté pendant le transfert`);
        }
        return prev;
      });
      removePeer(id);
    });

    socket.on('offer', (data: { caller: string; sdp: unknown }) => {
      const p = peersRef.current[data.caller];
      if (p) p.signal(data.sdp as { type?: string; candidate?: unknown });
    });

    socket.on('answer', (data: { caller: string; sdp: unknown }) => {
      const p = peersRef.current[data.caller];
      if (p) p.signal(data.sdp as { type?: string; candidate?: unknown });
    });

    socket.on('ice-candidate', (data: { caller: string; candidate: unknown }) => {
      const p = peersRef.current[data.caller];
      if (p) p.signal(data.candidate as { type?: string; candidate?: unknown });
    });

    socket.on('relay-data', ({ from, data, meta }: { from: string; data: unknown; meta: { type: string; name?: string; size?: number; mime?: string } | null }) => {
      handleReceivedData(from, data, meta);
    });
  };

  useEffect(() => {
    const requestWakeLock = async () => {
      if (typeof navigator === 'undefined') return;
      const wakeLock = (navigator as unknown as { wakeLock?: { request?: (type: 'screen') => Promise<WakeLockSentinel> } }).wakeLock;
      if (!wakeLock?.request) return;
      if (document.visibilityState !== 'visible') return;

      try {
        wakeLockRef.current = await wakeLock.request('screen');
      } catch {
        wakeLockRef.current = null;
      }
    };

    const releaseWakeLock = async () => {
      try {
        await wakeLockRef.current?.release();
      } catch {
        // ignore
      } finally {
        wakeLockRef.current = null;
      }
    };

    if (transfer?.type === 'send') {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }

    const handleVisibility = () => {
      if (transfer?.type !== 'send') return;
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (transfer?.type !== 'send') return;
      releaseWakeLock();
    };
  }, [transfer?.type]);

  const exitRoom = useCallback(() => {
    // Annuler un éventuel transfert
    if (transfer) {
      cancelTransfer('Sortie du salon');
    }

    // Détruire tous les peers
    Object.keys(peersRef.current).forEach((id) => {
      try {
        peersRef.current[id]?.destroy();
      } catch {
        // ignore
      }
      delete peersRef.current[id];
    });
    setPeers({});

    // Déconnecter le socket
    if (socketRef.current) {
      try {
        socketRef.current.disconnect();
      } catch {
        // ignore
      }
      socketRef.current = null;
    }

    // Nettoyer URL (?room=...)
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('room');
      window.history.replaceState({}, '', url.pathname);
    }

    // Reset UI
    setTransfer(null);
    setShowActionSheet(false);
    setConnectionStatus('disconnected');
    setRoomId('');
    setStep('welcome');
  }, [cancelTransfer, transfer]);

  useEffect(() => {
    // Determine room from URL ?room=XXXX
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const roomParam = params.get('room');
      if (roomParam) {
        setRoomId(roomParam);
      }
    }

    // Handle app coming back from background (Android)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && socketRef.current && step === 'room') {
        console.log('App visible again, checking connection...');

        if (!socketRef.current.connected) {
          console.log('Socket disconnected, reconnecting...');
          socketRef.current.connect();
        } else {
          if (!transfer || transfer.type !== 'send') {
            resyncRoom('visibilitychange');
          }
        }

        Object.keys(peersRef.current).forEach(id => {
          const peer = peersRef.current[id];
          if (peer && !peer.connected) {
            console.log('Peer disconnected, removing:', id);
            // Vérifier si un transfert est en cours avec ce peer
            setTransfer(prev => {
              if (prev && prev.peerId === id) {
                setPeers(currentPeers => {
                  const peerName = currentPeers[id]?.name || 'L\'appareil';
                  cancelTransfer(`${peerName} s'est déconnecté`);
                  return currentPeers;
                });
              }
              return prev;
            });
            // Nettoyer le peer
            if (peersRef.current[id]) {
              peersRef.current[id].destroy();
              delete peersRef.current[id];
            }
            setPeers(prev => {
              const next = { ...prev };
              delete next[id];
              return next;
            });
          }
        });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Network reconnection
    const handleOnline = () => {
      console.log('Network back online');
      if (socketRef.current && !socketRef.current.connected && step === 'room') {
        socketRef.current.connect();
      } else if (socketRef.current?.connected && step === 'room') {
        if (!transfer || transfer.type !== 'send') {
          resyncRoom('online');
        }
      }
    };

    window.addEventListener('online', handleOnline);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
    };
  }, [step, cancelTransfer, resyncRoom, transfer]);

  const addPeer = (id: string, name: string, initiator: boolean) => {
    if (peersRef.current[id]) return;

    setPeers(prev => ({ ...prev, [id]: { name, status: 'connecting', method: 'p2p' } }));

    const p = new SimplePeer({
      initiator,
      trickle: true,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      } as RTCConfiguration
    });

    const connectionTimeout = setTimeout(() => {
      if (!p.connected) {
        console.log('P2P timeout, using relay for', id);
        updatePeerStatus(id, 'connected', 'relay');
      }
    }, 10000);

    p.on('signal', (data: { type?: string; candidate?: unknown }) => {
      if (data.type === 'offer') {
        socketRef.current?.emit('offer', { target: id, caller: socketRef.current.id, sdp: data });
      } else if (data.type === 'answer') {
        socketRef.current?.emit('answer', { target: id, caller: socketRef.current.id, sdp: data });
      } else if (data.candidate) {
        socketRef.current?.emit('ice-candidate', { target: id, caller: socketRef.current.id, candidate: data });
      }
    });

    p.on('connect', () => {
      clearTimeout(connectionTimeout);
      console.log('P2P Connected with', id);
      updatePeerStatus(id, 'connected', 'p2p');
    });

    p.on('data', (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString()) as { type: string; name?: string; size?: number; mime?: string };
        if (parsed.type === 'meta' && parsed.name && parsed.size) {
          console.log(`Receiving file: ${parsed.name} (${parsed.size} bytes)`);
          
          // Réinitialiser l'état d'abort
          transferAbortRef.current = { abort: false, targetId: id };
          
          incomingRef.current = { buffer: [], size: 0, meta: { name: parsed.name, size: parsed.size, mime: parsed.mime } };
          setTransfer({ type: 'receive', name: parsed.name, progress: 0, peerId: id });

          // Pas de timeout pour la réception des fichiers volumineux
          console.log('Prêt à recevoir un fichier volumineux sans limite de temps');
        } else if (parsed.type === 'eof') {
          console.log(`EOF received. Total: ${incomingRef.current.size} bytes`);
          if (incomingRef.current.meta && incomingRef.current.size === incomingRef.current.meta.size) {
            saveFile(new Blob(incomingRef.current.buffer as BlobPart[]), incomingRef.current.meta.name);
            setTimeout(() => setTransfer(null), 1500);

          } else {
            console.error(`File incomplete! Expected ${incomingRef.current.meta?.size}, got ${incomingRef.current.size}`);
            cancelTransfer(`Fichier incomplet (${incomingRef.current.size}/${incomingRef.current.meta?.size} bytes)`);
          }
          incomingRef.current = { buffer: [], size: 0, meta: null };
        }
      } catch {
        handleReceivedChunk(id, data);
      }
    });

    p.on('error', (err: Error) => {
      console.error('Peer error with', id, err);
      clearTimeout(connectionTimeout);
      
      // Si un transfert est en cours, basculer vers relay
      setTransfer(prev => {
        if (prev && prev.peerId === id && socketRef.current?.connected) {
          console.log('P2P error, falling back to relay');
          // Réinitialiser le transfert pour permettre une nouvelle tentative
          return { ...prev, progress: 0 };
        }
        return prev;
      });
      
      // Basculer en mode relay
      updatePeerStatus(id, 'connected', 'relay');
    });

    p.on('close', () => {
      console.log('Peer connection closed', id);
      clearTimeout(connectionTimeout);
      
      // Si un transfert est en cours avec ce peer, l'annuler
      setTransfer(prev => {
        if (prev && prev.peerId === id) {
          const peerName = peers[id]?.name || 'L\'appareil';
          cancelTransfer(`Connexion P2P perdue avec ${peerName}`);
        }
        return prev;
      });
    });

    peersRef.current[id] = p;
  };

  const removePeer = (id: string) => {
    // Si un transfert est en cours avec ce peer, l'annuler
    setTransfer(prev => {
      if (prev && prev.peerId === id) {
        cancelTransfer('L\'appareil s\'est déconnecté');
      }
      return prev;
    });
    
    if (peersRef.current[id]) {
      peersRef.current[id].destroy();
      delete peersRef.current[id];
    }
    setPeers(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const updatePeerStatus = (id: string, status: 'connecting' | 'connected', method: 'p2p' | 'relay') => {
    setPeers(prev => ({
      ...prev,
      [id]: { ...prev[id], status, method: method || prev[id]?.method || 'relay' }
    }));
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedPeerId.current) return;

    const peer = peers[selectedPeerId.current];
    if (!peer || peer.status !== 'connected') {
      alert('Cet appareil n&apos;est pas encore connecté. Attendez quelques secondes.');
      e.target.value = '';
      return;
    }

    startSending(selectedPeerId.current, file);
    e.target.value = '';
  };

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const targetId = selectedPeerId.current;
    e.target.value = '';

    if (!targetId) return;
    if (files.length === 0) return;

    const peer = peers[targetId];
    if (!peer || peer.status !== 'connected') {
      alert('Cet appareil n\'est pas encore connecté. Attendez quelques secondes.');
      return;
    }

    // Simple & robust: zip folder client-side then send as a single file
    try {
      setTransfer({ type: 'send', name: 'Préparation du dossier…', progress: 0, peerId: targetId });

      const zip = new JSZip();

      // Determine folder root from webkitRelativePath if available
      const firstPath = (files[0] as unknown as { webkitRelativePath?: string }).webkitRelativePath || files[0].name;
      const rootFolder = firstPath.includes('/') ? firstPath.split('/')[0] : 'dossier';

      for (const f of files) {
        const rel = (f as unknown as { webkitRelativePath?: string }).webkitRelativePath || f.name;
        // Ensure everything stays under the same root folder in the zip
        const normalized = rel.startsWith(rootFolder + '/') ? rel : `${rootFolder}/${rel}`;
        zip.file(normalized, f);
      }

      // Generate zip as Blob
      const blob = await zip.generateAsync(
        { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
        (metadata: { percent: number }) => {
          const pct = Math.max(0, Math.min(99, Math.floor(metadata.percent)));
          setTransfer(prev => prev ? { ...prev, name: `Compression… (${pct}%)`, progress: pct } : prev);
        }
      );

      const zipName = `${rootFolder}.zip`;
      const zipFile = new File([blob], zipName, { type: 'application/zip' });

      // Start actual sending via existing pipeline
      startSending(targetId, zipFile);
    } catch (err) {
      console.error('Folder zip failed', err);
      cancelTransfer('Erreur lors de la compression du dossier');
    }
  };

  const startSending = (targetId: string, file: File) => {
    // Vérifier que le peer est toujours connecté
    const peerInfo = peers[targetId];
    if (!peerInfo || peerInfo.status !== 'connected') {
      cancelTransfer('L\'appareil n\'est plus connecté');
      return;
    }

    // Vérifier que le socket est connecté
    if (!socketRef.current?.connected) {
      cancelTransfer('Connexion au serveur perdue');
      return;
    }
    
    // Réinitialiser l'état d'abort
    transferAbortRef.current = { abort: false, targetId };

    const peerObj = peersRef.current[targetId];
    const useP2P = peerObj && peerObj.connected && peerInfo.method === 'p2p';

    console.log(`Sending "${file.name}" (${file.size} bytes) via ${useP2P ? 'P2P' : 'Relay'}`);
    
    // Pas de timeout pour permettre les transferts de longue durée
    transferAbortRef.current = { abort: false, targetId };
    
    setTransfer({ type: 'send', name: file.name, progress: 0, peerId: targetId });
    
    console.log('Début du transfert sans timeout pour les fichiers volumineux');

    const meta = { type: 'meta', name: file.name, size: file.size, mime: file.type };

    if (useP2P) {
      try {
        peerObj.send(JSON.stringify(meta));
      } catch {
        console.error('P2P send failed, falling back to relay');
        socketRef.current?.emit('relay-data', { target: targetId, data: null, meta });
      }
    } else {
      socketRef.current?.emit('relay-data', { target: targetId, data: null, meta });
    }

    const reader = new FileReader();
    let offset = 0;
    let chunksSent = 0;

    reader.onload = (e) => {
      if (!e.target?.result) return;
      
      // Vérifier si le transfert a été annulé
      if (transferAbortRef.current.abort || transferAbortRef.current.targetId !== targetId) {
        console.log('Transfer aborted, stopping file read');
        return;
      }

      // Vérifier que le peer est toujours connecté
      const currentPeer = peers[targetId];
      if (!currentPeer || currentPeer.status !== 'connected') {
        cancelTransfer('L\'appareil s\'est déconnecté pendant l\'envoi');
        return;
      }

      // Vérifier que le socket est toujours connecté
      if (!socketRef.current?.connected) {
        cancelTransfer('Connexion au serveur perdue');
        return;
      }

      const chunk = new Uint8Array(e.target.result as ArrayBuffer);
      chunksSent++;

      const sendChunk = () => {
        // Double vérification avant l'envoi
        if (transferAbortRef.current.abort || transferAbortRef.current.targetId !== targetId) {
          return;
        }

        if (useP2P && peerObj && peerObj.connected) {
          try {
            peerObj.send(chunk);
          } catch (err) {
            console.error('P2P chunk send failed', err);
            // Fallback vers relay si P2P échoue
            if (socketRef.current?.connected) {
              socketRef.current.emit('relay-data', { target: targetId, data: Array.from(chunk) });
            } else {
              cancelTransfer('Connexion P2P et relay perdues');
              return;
            }
          }
        } else {
          if (socketRef.current?.connected) {
            socketRef.current.emit('relay-data', { target: targetId, data: Array.from(chunk) });
          } else {
            cancelTransfer('Connexion au serveur perdue');
            return;
          }
        }

        offset += chunk.byteLength;
        const progress = Math.floor((offset / file.size) * 100);
        setTransfer(prev => prev ? { ...prev, progress } : null);

        if (offset < file.size) {
          // Vérifier avant de continuer
          if (transferAbortRef.current.abort || transferAbortRef.current.targetId !== targetId) {
            return;
          }
          readSlice(offset);
        } else {
          // Transfert terminé avec succès
          console.log(`Transfer complete: ${chunksSent} chunks, ${offset} bytes`);
          
          // Envoyer EOF
          if (useP2P && peerObj && peerObj.connected) {
            try {
              peerObj.send(JSON.stringify({ type: 'eof' }));
            } catch {
              if (socketRef.current?.connected) {
                socketRef.current.emit('relay-data', { target: targetId, data: null, meta: { type: 'eof' } });
              }
            }
          } else {
            if (socketRef.current?.connected) {
              socketRef.current.emit('relay-data', { target: targetId, data: null, meta: { type: 'eof' } });
            }
          }
          
          // Réinitialiser l'abort
          transferAbortRef.current = { abort: false, targetId: null };
          
          setTimeout(() => setTransfer(null), 1500);
        }
      };

      if (useP2P && peerObj._channel && peerObj._channel.bufferedAmount > 256 * 1024) {
        const checkBuffer = () => {
          if (peerObj._channel.bufferedAmount < 128 * 1024) {
            sendChunk();
          } else {
            setTimeout(checkBuffer, 50);
          }
        };
        checkBuffer();
      } else {
        sendChunk();
      }
    };

    reader.onerror = () => {
      console.error('File read error');
      cancelTransfer('Erreur lors de la lecture du fichier');
    };

    const readSlice = (o: number) => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        setTimeout(() => {
          if (transferAbortRef.current.abort || transferAbortRef.current.targetId !== targetId) return;
          readSlice(o);
        }, 500);
        return;
      }
      const slice = file.slice(o, o + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };
    readSlice(0);
  };

  const handleReceivedChunk = (senderId: string, chunk: Buffer | Uint8Array | number[]) => {
    // Vérifier si le transfert a été annulé
    if (transferAbortRef.current.abort || transferAbortRef.current.targetId !== senderId) {
      return;
    }

    if (!incomingRef.current.meta) {
      console.warn('Received chunk without metadata');
      return;
    }

    // Vérifier que la connexion est toujours présente (ne pas dépendre du state React `peers` ici)
    // Le state peut être obsolète dans les callbacks d'événements, ce qui annule le transfert à tort.
    if (!peersRef.current[senderId]) {
      console.warn('Received chunk from unknown peer (possibly stale UI state):', senderId);
      return;
    }

    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);

    incomingRef.current.buffer.push(data);
    incomingRef.current.size += data.byteLength;

    const percent = Math.floor((incomingRef.current.size / incomingRef.current.meta.size) * 100);
    setTransfer(prev => prev ? { ...prev, progress: percent } : null);
  };

  const handleReceivedData = (senderId: string, data: unknown, meta: PeerData | null) => {
    if (meta && meta.type === 'meta' && meta.name && meta.size) {
      console.log(`Receiving file via relay: ${meta.name} (${meta.size} bytes)`);
      
      // Réinitialiser l'état d'abort
      transferAbortRef.current = { abort: false, targetId: senderId };
      
      incomingRef.current = { buffer: [], size: 0, meta: { name: meta.name, size: meta.size, mime: meta.mime } };
      setTransfer({ type: 'receive', name: meta.name, progress: 0, peerId: senderId });

      // Pas de timeout pour la réception des fichiers volumineux
      console.log('Prêt à recevoir un fichier volumineux en mode relay sans limite de temps');

      const peerName = peers[senderId]?.name || 'Un appareil';
      console.log(`Prêt à recevoir de ${peerName}`);
      return;
    }

    if (meta && meta.type === 'eof') {
      console.log(`EOF received (relay). Total: ${incomingRef.current.size} bytes`);
      
      if (incomingRef.current.meta && incomingRef.current.size === incomingRef.current.meta.size) {
        saveFile(new Blob(incomingRef.current.buffer as BlobPart[]), incomingRef.current.meta.name);
        setTimeout(() => setTransfer(null), 1500);
        transferAbortRef.current = { abort: false, targetId: null };
      } else {
        console.error(`File incomplete! Expected ${incomingRef.current.meta?.size}, got ${incomingRef.current.size}`);
        cancelTransfer(`Fichier incomplet (${incomingRef.current.size}/${incomingRef.current.meta?.size} bytes)`);
      }

      incomingRef.current = { buffer: [], size: 0, meta: null };
      return;
    }

    if (data) {
      handleReceivedChunk(senderId, data as Buffer | Uint8Array | number[]);
    }
  };

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

  if (step === 'welcome') {
    return (
      <div className="app-wrapper">
        <header>
          <Link href="/" className="brand">
            {/* @ts-expect-error - ion-icon is a custom element */}
            <ion-icon name="planet"></ion-icon> GlobalShare
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
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                if (!roomId.trim()) {
                  e.preventDefault();
                  alert('Veuillez entrer un code de salon.');
                  return;
                }
                joinRoom();
              }}
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

  return (
    <div className="app-wrapper">
      <header>
        <div
          className="brand"
          onClick={exitRoom}
          role="button"
          tabIndex={0}
        >
          {/* @ts-expect-error - ion-icon is a custom element */}
          <ion-icon name="planet"></ion-icon> GlobalShare
        </div>
        <div className="room-badge" onClick={() => {
          if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && navigator.clipboard) {
            navigator.clipboard.writeText(window.location.origin + '/?room=' + roomId);
            alert('Lien copié !');
          }
        }}>
          Salon: {roomId} {/* @ts-expect-error - ion-icon is a custom element */}
          <ion-icon name="copy-outline"></ion-icon>
        </div>
      </header>

      {connectErrorMessage && (
        <div className="gs-modal-overlay">
          <div className="gs-modal">
            <div className="gs-modal-title">Connexion impossible</div>
            <div className="gs-modal-body">{connectErrorMessage}</div>
            <div className="gs-modal-actions">
              <button
                className="gs-modal-btn"
                onClick={() => {
                  setConnectErrorMessage(null);
                  exitRoom();
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {connectionStatus !== 'connected' && (
        <div className="connecting-overlay">
          <div className="spinner"></div>
          <p>Connexion en cours...</p>
        </div>
      )}

      <main>
        <div className="peer-list">
          {Object.keys(peers).length === 0 && <p style={{ textAlign: 'center', color: '#666', marginTop: '50px' }}>En attente d&apos;autres participants...</p>}

          {Object.keys(peers).map(id => (
            <div
              key={id}
              className={`peer-card ${peers[id].status === 'connected' ? 'active' : ''}`}
              onClick={() => {
                if (peers[id].status !== 'connected') {
                  alert('Connexion en cours... Attendez quelques secondes.');
                  return;
                }
                selectedPeerId.current = id;

                const isMobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
                if (isMobile) {
                  setShowActionSheet(true);
                } else {
                  fileInputRef.current?.click();
                }
              }}
            >
              <div className="peer-info">
                <div className="avatar">
                  {/* @ts-expect-error - ion-icon is a custom element */}
                  <ion-icon name="person"></ion-icon>
                </div>
                <div className="peer-details">
                  <h3>{peers[id].name}</h3>
                  <p>
                    {peers[id].status === 'connecting' && '⏳ Connexion...'}
                    {peers[id].status === 'connected' && peers[id].method === 'p2p' && '🚀 P2P Direct'}
                    {peers[id].status === 'connected' && peers[id].method === 'relay' && '📡 Via Serveur'}
                  </p>
                </div>
              </div>
              <div className="action-icon">
                {/* @ts-expect-error - ion-icon is a custom element */}
                <ion-icon name={peers[id].status === 'connected' ? 'send' : 'hourglass-outline'}></ion-icon>
              </div>
            </div>
          ))}
        </div>

        {transfer && (
          <div className="transfer-panel">
            <div className="progress-header">
              <span>{transfer.type === 'send' ? 'Envoi vers...' : 'Réception...'}</span>
              <span>{transfer.progress}%</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${transfer.progress}%` }}></div>
            </div>
            <div style={{ fontSize: '0.8rem', marginTop: '5px', color: '#aaa' }}>{transfer.name}</div>
          </div>
        )}
      </main>

      {showActionSheet && (
        <div className="action-sheet-overlay" onClick={() => setShowActionSheet(false)}>
          <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="action-sheet-header">Choisir une source</div>
            <button className="action-sheet-btn" onClick={() => {
              cameraInputRef.current?.click();
              setShowActionSheet(false);
            }}>
              {/* @ts-expect-error - ion-icon is a custom element */}
              <ion-icon name="camera"></ion-icon> Prendre une photo
            </button>
            <button className="action-sheet-btn" onClick={() => {
              fileInputRef.current?.click();
              setShowActionSheet(false);
            }}>
              {/* @ts-expect-error - ion-icon is a custom element */}
              <ion-icon name="folder-open"></ion-icon> Choisir un fichier
            </button>
            <button className="action-sheet-btn" onClick={() => {
              folderInputRef.current?.click();
              setShowActionSheet(false);
            }}>
              {/* @ts-expect-error - ion-icon is a custom element */}
              <ion-icon name="folder"></ion-icon> Choisir un dossier
            </button>
            <button className="action-sheet-btn cancel" onClick={() => setShowActionSheet(false)}>
              Annuler
            </button>
          </div>
        </div>
      )}

      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileSelect}
        accept="*/*"
        className="hidden"
      />
      <input
        type="file"
        ref={folderInputRef}
        onChange={handleFolderSelect}
        className="hidden"
        // @ts-expect-error - non standard attribute supported by Chromium/WebKit
        webkitdirectory=""
      />
      <input
        type="file"
        ref={cameraInputRef}
        onChange={handleFileSelect}
        accept="image/*,video/*"
        capture="environment"
        className="hidden"
      />
    </div>
  );
}
