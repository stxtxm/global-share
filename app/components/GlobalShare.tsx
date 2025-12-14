'use client';

import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import SimplePeer from 'simple-peer/simplepeer.min.js';
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

  // Refs
  const socketRef = useRef<Socket | null>(null);
  const peersRef = useRef<Record<string, SimplePeerInstance>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const selectedPeerId = useRef<string | null>(null);
  const incomingRef = useRef<{ buffer: Uint8Array[]; size: number; meta: { name: string; size: number; mime?: string } | null }>({ buffer: [], size: 0, meta: null });

  // Request notification permission
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(permission => {
        console.log('Notification permission:', permission);
      });
    }
  }, []);

  // Helper to show notification
  const showNotification = (title: string, body: string) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      if (document.visibilityState === 'hidden') {
        new Notification(title, {
          body,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: 'globalshare-transfer'
        });
      }
    }
  };

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
        }

        Object.keys(peersRef.current).forEach(id => {
          const peer = peersRef.current[id];
          if (peer && !peer.connected) {
            console.log('Peer disconnected, removing:', id);
            removePeer(id);
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
      }
    };

    window.addEventListener('online', handleOnline);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
    };
  }, [step]);

  const joinRoom = () => {
    if (!roomId || !myName) return;

    const socket = io(getSocketUrl(), {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to server');
      socket.emit('join-room', { roomId, name: myName });
      setStep('room');
    });

    socket.on('reconnect', () => {
      console.log('Reconnected! Rejoining room...');
      socket.emit('join-room', { roomId, name: myName });
    });

    socket.on('disconnect', (reason) => {
      console.log('Disconnected:', reason);
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
          incomingRef.current = { buffer: [], size: 0, meta: { name: parsed.name, size: parsed.size, mime: parsed.mime } };
          setTransfer({ type: 'receive', name: parsed.name, progress: 0 });

          const peerName = peers[id]?.name || 'Un appareil';
          showNotification(
            '📥 Fichier entrant',
            `${peerName} vous envoie "${parsed.name}"`
          );
        } else if (parsed.type === 'eof') {
          console.log(`EOF received. Total: ${incomingRef.current.size} bytes`);
          if (incomingRef.current.meta && incomingRef.current.size === incomingRef.current.meta.size) {
            saveFile(new Blob(incomingRef.current.buffer as BlobPart[]), incomingRef.current.meta.name);
            setTimeout(() => setTransfer(null), 1500);

            showNotification(
              '✅ Fichier reçu',
              `"${incomingRef.current.meta.name}" téléchargé avec succès`
            );
          } else {
            console.error(`File incomplete! Expected ${incomingRef.current.meta?.size}, got ${incomingRef.current.size}`);
            alert(`Erreur: fichier incomplet (${incomingRef.current.size}/${incomingRef.current.meta?.size} bytes)`);
            setTransfer(null);
          }
          incomingRef.current = { buffer: [], size: 0, meta: null };
        }
      } catch {
        handleReceivedChunk(id, data);
      }
    });

    p.on('error', () => {
      console.error('Peer error with', id);
      clearTimeout(connectionTimeout);
      updatePeerStatus(id, 'connected', 'relay');
    });

    p.on('close', () => {
      console.log('Peer connection closed', id);
      clearTimeout(connectionTimeout);
    });

    peersRef.current[id] = p;
  };

  const removePeer = (id: string) => {
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

  const startSending = (targetId: string, file: File) => {
    const peerObj = peersRef.current[targetId];
    const peerInfo = peers[targetId];
    const useP2P = peerObj && peerObj.connected && peerInfo.method === 'p2p';

    console.log(`Sending "${file.name}" (${file.size} bytes) via ${useP2P ? 'P2P' : 'Relay'}`);
    setTransfer({ type: 'send', name: file.name, progress: 0 });

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
      const chunk = new Uint8Array(e.target.result as ArrayBuffer);
      chunksSent++;

      const sendChunk = () => {
        if (useP2P) {
          try {
            peerObj.send(chunk);
          } catch {
            console.error('P2P chunk send failed');
            socketRef.current?.emit('relay-data', { target: targetId, data: Array.from(chunk) });
          }
        } else {
          socketRef.current?.emit('relay-data', { target: targetId, data: Array.from(chunk) });
        }

        offset += chunk.byteLength;
        const progress = Math.floor((offset / file.size) * 100);
        setTransfer(prev => prev ? { ...prev, progress } : null);

        if (offset < file.size) {
          readSlice(offset);
        } else {
          console.log(`Transfer complete: ${chunksSent} chunks, ${offset} bytes`);
          if (useP2P) {
            try {
              peerObj.send(JSON.stringify({ type: 'eof' }));
            } catch {
              socketRef.current?.emit('relay-data', { target: targetId, data: null, meta: { type: 'eof' } });
            }
          } else {
            socketRef.current?.emit('relay-data', { target: targetId, data: null, meta: { type: 'eof' } });
          }
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
      alert('Erreur lors de la lecture du fichier');
      setTransfer(null);
    };

    const readSlice = (o: number) => {
      const slice = file.slice(o, o + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };
    readSlice(0);
  };

  const handleReceivedChunk = (senderId: string, chunk: Buffer | Uint8Array) => {
    if (!incomingRef.current.meta) {
      console.warn('Received chunk without metadata');
      return;
    }

    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);

    incomingRef.current.buffer.push(data);
    incomingRef.current.size += data.byteLength;

    const percent = Math.floor((incomingRef.current.size / incomingRef.current.meta.size) * 100);
    setTransfer(prev => prev ? { ...prev, progress: percent } : null);
  };

  const handleReceivedData = (senderId: string, data: unknown, meta: { type: string; name?: string; size?: number; mime?: string } | null) => {
    if (meta && meta.type === 'meta' && meta.name && meta.size) {
      console.log(`Receiving file via relay: ${meta.name} (${meta.size} bytes)`);
      incomingRef.current = { buffer: [], size: 0, meta: { name: meta.name, size: meta.size, mime: meta.mime } };
      setTransfer({ type: 'receive', name: meta.name, progress: 0 });

      const peerName = peers[senderId]?.name || 'Un appareil';
      showNotification(
        '📥 Fichier entrant (Relay)',
        `${peerName} vous envoie "${meta.name}"`
      );
      return;
    }

    if (meta && meta.type === 'eof') {
      console.log(`EOF received (relay). Total: ${incomingRef.current.size} bytes`);
      if (incomingRef.current.meta && incomingRef.current.size === incomingRef.current.meta.size) {
        saveFile(new Blob(incomingRef.current.buffer as BlobPart[]), incomingRef.current.meta.name);
        setTimeout(() => setTransfer(null), 1500);

        showNotification(
          '✅ Fichier reçu',
          `"${incomingRef.current.meta.name}" téléchargé avec succès`
        );
      } else {
        console.error(`File incomplete! Expected ${incomingRef.current.meta?.size}, got ${incomingRef.current.size}`);
        alert(`Erreur: fichier incomplet (${incomingRef.current.size}/${incomingRef.current.meta?.size} bytes)`);
        setTransfer(null);
      }
      incomingRef.current = { buffer: [], size: 0, meta: null };
      return;
    }

    if (data) {
      handleReceivedChunk(senderId, data as Buffer | Uint8Array);
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
          <div className="brand">
            {/* @ts-expect-error - ion-icon is a custom element */}
            <ion-icon name="planet"></ion-icon> GlobalShare
          </div>
        </header>
        <main className="welcome-screen">
          <h1>Rejoindre un Salon</h1>
          <p>Entrez le même code sur tous les appareils</p>

          <div className="input-group">
            <label>Votre Nom</label>
            <input value={myName} onChange={e => setMyName(e.target.value)} />
          </div>

          <div className="input-group">
            <label>Code du Salon</label>
            <input
              value={roomId}
              onChange={e => setRoomId(e.target.value.toUpperCase())}
              placeholder="Ex: A1B2C3"
            />
          </div>

          <button className="btn-primary" onClick={joinRoom}>Rejoindre</button>
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
        <div className="brand">
          {/* @ts-expect-error - ion-icon is a custom element */}
          <ion-icon name="planet"></ion-icon> GlobalShare
        </div>
        <div className="room-badge" onClick={() => {
          if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && navigator.clipboard) {
            navigator.clipboard.writeText(window.location.origin + '/?room=' + roomId);
            alert('Lien copié !');
          }
        }}>
          Salon: {roomId} {/* @ts-ignore - ion-icon is a custom element */}
          <ion-icon name="copy-outline"></ion-icon>
        </div>
      </header>

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
        ref={cameraInputRef}
        onChange={handleFileSelect}
        accept="image/*,video/*"
        capture="environment"
        className="hidden"
      />
    </div>
  );
}
