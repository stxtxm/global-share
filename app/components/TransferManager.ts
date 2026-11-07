// TransferManager — gestionnaire de transfert (P2P + Relay)
// Protocole Socket.IO amélioré : ack, resume, dedup, débit adaptatif
import type { Socket } from 'socket.io-client';

/** Résultat du contrôle SHA-256 du fichier reconstruit. */
export type IntegrityStatus = 'unknown' | 'verified' | 'mismatch';

export type TransferStatus =
  | 'pending'
  | 'transferring'
  | 'paused'
  | 'interrupted'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface TransferFileMeta {
  name: string;
  size: number;
  mime?: string;
}

export interface TransferState {
  id: string;
  direction: 'send' | 'receive';
  targetId: string;
  targetName: string;
  file: TransferFileMeta;
  method: 'p2p' | 'relay';
  chunkSize: number;
  status: TransferStatus;
  progress: number;
  confirmed: number;
  speed: number;
  error?: string;
  attempts: number;
  createdAt: number;
  lastActivity: number;
  offset: number;
  nextSeq: number;
  pending: Map<number, Uint8Array>;
  ackedSeqs: Set<number>;
  window: { start: number; bytes: number } | null;
  buffer: Map<number, Uint8Array>;
  ackTimers: Map<number, ReturnType<typeof setTimeout>>;
  /** SHA-256 attendu du fichier complet (hexadécimal), si connu. */
  hash?: string;
  integrity: IntegrityStatus;
  /** Réémission de l'EOF tant que l'autre partie n'a pas acquitté. */
  eofTimer: ReturnType<typeof setTimeout> | null;
}

export interface TransferInitPayload {
  transferId: string;
  initiator: string;
  target: string;
  direction: 'send' | 'receive';
  file: TransferFileMeta;
  chunkSize: number;
  method: 'p2p' | 'relay';
  hash?: string;
}

export interface TransferChunkPayload {
  transferId: string;
  seq: number;
  size: number;
  chunk: number[];
  target: string;
}

export interface TransferAckPayload {
  transferId: string;
  seq: number;
  size: number;
  initiator: string;
  target: string;
}

export interface TransferEofPayload {
  transferId: string;
  size: number;
  target: string;
}

export interface TransferEofAckPayload {
  transferId: string;
  initiator: string;
  target: string;
}

export interface TransferCancelPayload {
  transferId: string;
  reason: string;
  target: string;
}

export interface TransferEndPayload {
  transferId: string;
  status: TransferStatus;
  reason?: string;
  target: string;
}

export const CHUNK_SIZE_DEFAULT = 64 * 1024;
// Sans réémission, un seul paquet d'EOF perdu bloquait le transfert pour de bon.
const EOF_RETRY_MS = 2000;
// Au-delà, lire tout le fichier en mémoire serait risqué sur un téléphone.
export const HASH_MAX_BYTES = 64 * 1024 * 1024;

/** SHA-256 hexadécimal, ou null si l'API WebCrypto n'est pas disponible. */
export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    // Copie seulement si la vue ne couvre pas tout son buffer.
    const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    const source = (exact ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
    const digest = await subtle.digest('SHA-256', source);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

export class TransferManager {
  public socket: Socket;
  public myId: string;
  private transfers = new Map<string, TransferState>();
  private nextTransferId = 0;
  private finishing = new Set<string>();

  public onUpdate: (t: TransferState) => void;
  public onComplete: (t: TransferState) => void;
  public onCancel: (t: TransferState, reason: string) => void;
  public onError: (t: TransferState, error: string) => void;
  public onStatus: (t: TransferState) => void;
  public onSendDone: (id: string) => void;

  /** Identité courante : socket.id n'est disponible qu'après la connexion. */
  get selfId(): string {
    return this.socket.id ?? this.myId;
  }

  constructor(
    socket: Socket,
    myId: string,
    cb: {
      onUpdate: (t: TransferState) => void;
      onComplete: (t: TransferState) => void;
      onCancel: (t: TransferState, reason: string) => void;
      onError: (t: TransferState, error: string) => void;
      onStatus: (t: TransferState) => void;
      onSendDone: (id: string) => void;
    }
  ) {
    this.socket = socket;
    this.myId = myId;
    this.onUpdate = cb.onUpdate;
    this.onComplete = cb.onComplete;
    this.onCancel = cb.onCancel;
    this.onError = cb.onError;
    this.onStatus = cb.onStatus;
    this.onSendDone = cb.onSendDone;
  }

  startSend(
    file: { name: string; size: number; mime?: string },
    targetId: string,
    method: 'p2p' | 'relay',
    hash?: string
  ): TransferState {
    const id = `t-${++this.nextTransferId}-${Date.now().toString(36)}`;
    const t: TransferState = {
      id,
      direction: 'send',
      targetId,
      targetName: 'Appareil',
      file,
      method,
      chunkSize: CHUNK_SIZE_DEFAULT,
      status: 'transferring',
      progress: 0,
      confirmed: 0,
      speed: 0,
      attempts: 0,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      offset: 0,
      nextSeq: 0,
      pending: new Map(),
      ackedSeqs: new Set(),
      window: null,
      buffer: new Map(),
      ackTimers: new Map(),
      hash,
      integrity: 'unknown',
      eofTimer: null,
    };
    this.transfers.set(id, t);
    this._emit('transfer-init', {
      transferId: t.id,
      initiator: this.selfId,
      target: t.targetId,
      direction: 'send',
      file: { name: file.name, size: file.size, mime: file.mime },
      chunkSize: t.chunkSize,
      method: t.method,
      hash: t.hash,
    });
    this.onUpdate(t);
    return t;
  }

  startReceive(
    file: TransferFileMeta,
    initiator: string,
    method: 'p2p' | 'relay',
    transferId?: string,
    hash?: string
  ): TransferState {
    // L'id doit être celui de l'expéditeur, sinon les chunks ne retrouvent pas le transfert.
    const id = transferId ?? `t-${++this.nextTransferId}-${Date.now().toString(36)}`;
    const t: TransferState = {
      id,
      direction: 'receive',
      targetId: initiator,
      targetName: initiator,
      file,
      method,
      chunkSize: CHUNK_SIZE_DEFAULT,
      status: 'transferring',
      progress: 0,
      confirmed: 0,
      speed: 0,
      attempts: 0,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      offset: 0,
      nextSeq: 0,
      pending: new Map(),
      ackedSeqs: new Set(),
      window: null,
      buffer: new Map(),
      ackTimers: new Map(),
      hash,
      integrity: 'unknown',
      eofTimer: null,
    };
    this.transfers.set(id, t);
    this.onUpdate(t);
    return t;
  }

  cancel(id: string, reason: string): void {
    const t = this.transfers.get(id);
    if (!t) return;
    this._setStatus(t, 'cancelled', reason);
    this._emit('transfer-cancel', {
      transferId: t.id,
      reason,
      target: t.targetId,
    });
  }

  pause(id: string): void {
    const t = this.transfers.get(id);
    if (!t) return;
    if (t.status !== 'transferring') return;
    // Une pause doit réellement arrêter le trafic : sans ça les chunks en
    // attente d'acquittement continuaient d'être réémis toutes les 15 s et
    // l'EOF était renvoyé pendant que l'utilisateur croyait le transfert figé.
    if (t.direction === 'send') {
      for (const timer of t.ackTimers.values()) clearTimeout(timer);
      t.ackTimers.clear();
      this._clearEofTimer(t);
    }
    this._setStatus(t, 'paused', 'Transfert en attente');
  }

  resume(id: string): void {
    const t = this.transfers.get(id);
    if (!t) return;
    if (t.status === 'cancelled' || t.status === 'failed' || t.status === 'completed') return;
    if (t.status !== 'paused' && t.status !== 'interrupted') return;
    this._setStatus(t, 'transferring', 'Reprise du transfert');
    if (t.direction !== 'send') return;
    // Les minuteurs d'acquittement ont été coupés à la pause (ou perdus lors
    // d'une déconnexion) : on relance l'émission des chunks encore en attente,
    // sinon un ACK perdu juste avant la pause laissait un trou définitif.
    for (const [seq, chunk] of t.pending) {
      if (t.ackedSeqs.has(seq)) continue;
      this._transmitChunk(t, seq, chunk);
      this._startAckTimeout(t, seq, chunk.length);
    }
    if (t.offset >= t.file.size && t.pending.size === 0) this.sendEof(t.id);
  }

  get(id: string): TransferState | undefined {
    return this.transfers.get(id);
  }

  getAll(): TransferState[] {
    return Array.from(this.transfers.values());
  }

  has(id: string): boolean {
    return this.transfers.has(id);
  }

  sendChunk(transferId: string, seq: number, chunk: Uint8Array): void {
    const t = this.transfers.get(transferId);
    if (!t || t.direction !== 'send') return;
    if (t.status !== 'transferring') return;
    if (!t.pending.has(seq)) {
      t.pending.set(seq, chunk);
      t.offset += chunk.length;
      t.lastActivity = Date.now();
      this._transmitChunk(t, seq, chunk);
      this._startAckTimeout(t, seq, chunk.length);
    }
  }

  sendEof(transferId: string): void {
    const t = this.transfers.get(transferId);
    if (!t || t.direction !== 'send') return;
    // Une seule boucle de réémission par transfert : le récepteur acquitte et
    // ignore les EOF suivants, donc les répéter ne coûte rien.
    if (t.status !== 'transferring' || t.eofTimer) return;
    const emitEof = () => {
      this._emit('transfer-eof', {
        transferId: t.id,
        size: t.file.size,
        target: t.targetId,
      });
      t.eofTimer = setTimeout(emitEof, EOF_RETRY_MS);
    };
    emitEof();
  }

  onTransferInit(payload: {
    transferId: string;
    initiator: string;
    target: string;
    file: { name: string; size: number; mime?: string };
    method: 'p2p' | 'relay';
    hash?: string;
  }): void {
    const known = this.transfers.get(payload.transferId);
    if (known) {
      if (known.direction === 'receive') known.targetId = payload.initiator;
      this.onUpdate(known);
      return;
    }
    const t = this.startReceive(
      payload.file,
      payload.initiator,
      payload.method,
      payload.transferId,
      payload.hash
    );
    // targetId doit rester l'expéditeur : c'est vers lui que partent les ACK.
    t.targetId = payload.initiator;
    t.targetName = payload.initiator;
    this.onUpdate(t);
  }

  onTransferChunk(payload: {
    transferId: string;
    seq: number;
    size: number;
    chunk: number[];
    target: string;
  }): void {
    if (payload.target !== this.selfId) return;
    const t = this.transfers.get(payload.transferId);
    if (!t || t.direction !== 'receive') return;
    if (t.buffer.has(payload.seq)) {
      // Chunk déjà reçu mais ACK perdu : on le renvoie.
      this._sendAck(t, payload.seq, payload.size);
      return;
    }
    t.buffer.set(payload.seq, new Uint8Array(payload.chunk));
    t.confirmed += payload.size;
    t.lastActivity = Date.now();
    this._sendAck(t, payload.seq, payload.size);
    this._updateReceiverProgress(t);
  }

  onTransferAck(payload: {
    transferId: string;
    seq: number;
    size: number;
    initiator: string;
    target: string;
  }): void {
    if (payload.target !== this.selfId) return;
    const t = this.transfers.get(payload.transferId);
    if (!t || t.direction !== 'send') return;
    if (t.ackedSeqs.has(payload.seq)) return;
    t.ackedSeqs.add(payload.seq);
    t.confirmed += payload.size;
    t.pending.delete(payload.seq);
    const ackTimer = t.ackTimers.get(payload.seq);
    if (ackTimer) clearTimeout(ackTimer);
    t.ackTimers.delete(payload.seq);
    t.lastActivity = Date.now();
    if (!t.window) t.window = { start: Date.now(), bytes: 0 };
    t.window.bytes += payload.size;
    this._updateSenderProgress(t);
  }

  onTransferEof(payload: { transferId: string; size: number; target: string }): void {
    if (payload.target !== this.selfId) return;
    const t = this.transfers.get(payload.transferId);
    if (!t || t.direction !== 'receive') return;
    t.lastActivity = Date.now();
    // L'expéditeur réémet l'EOF tant qu'il n'a pas d'ACK : n'acquitter qu'une
    // fois tout arrivé, et ne reconstruire le fichier qu'une seule fois.
    // C'est ce qui lançait plusieurs téléchargements du même fichier.
    if (!this._isComplete(t)) return;
    this._sendEofAck(t);
    void this._finishReceive(t);
  }

  onTransferEofAck(payload: { transferId: string; initiator: string; target: string }): void {
    if (payload.target !== this.selfId) return;
    const t = this.transfers.get(payload.transferId);
    if (!t || t.direction !== 'send') return;
    this._clearEofTimer(t);
    if (t.status === 'completed') return;
    this._setStatus(t, 'completed', 'Fichier reçu avec succès');
    this._emit('transfer-end', {
      transferId: t.id,
      status: 'completed',
      reason: 'Fichier livré',
      target: t.targetId,
    });
    this.onComplete(t);
  }

  onTransferCancel(payload: { transferId: string; reason: string; target: string }): void {
    if (payload.target !== this.selfId) return;
    const t = this.transfers.get(payload.transferId);
    if (!t) return;
    this._clearEofTimer(t);
    this._setStatus(t, 'cancelled', payload.reason ?? "Annulé par lautre partie");
    this._emit('transfer-end', {
      transferId: t.id,
      status: 'cancelled',
      reason: payload.reason ?? 'Cancelled',
      target: t.targetId,
    });
    this.onCancel(t, payload.reason ?? 'Cancelled by peer');
  }

  onTransferEnd(payload: {
    transferId: string;
    status: TransferStatus;
    reason?: string;
    target: string;
  }): void {
    if (payload.target !== this.selfId) return;
    const t = this.transfers.get(payload.transferId);
    if (!t) return;
    // Côté réception, seul le contrôle local termine le transfert : l'annonce
    // de l'expéditeur ne doit pas court-circuiter la vérification du fichier.
    if (t.direction === 'receive' && payload.status === 'completed') return;
    if (t.status === payload.status) return;
    this._clearEofTimer(t);
    if (payload.status === 'completed' || payload.status === 'cancelled') {
      this._setStatus(t, payload.status, payload.reason ?? 'End of transfer');
      this._emit('transfer-end', {
        transferId: t.id,
        status: payload.status,
        reason: payload.reason,
        target: t.targetId,
      });
      if (payload.status === 'completed') this.onComplete(t);
      else this.onCancel(t, payload.reason ?? 'Cancelled');
    } else {
      this._setStatus(t, 'failed', payload.reason ?? 'Erreur côté pair');
      this._emit('transfer-end', {
        transferId: t.id,
        status: 'failed',
        reason: payload.reason,
        target: t.targetId,
      });
      this.onError(t, payload.reason ?? 'Transfer failed');
    }
  }

  private _setStatus(t: TransferState, status: TransferStatus, reason?: string): void {
    if (t.status === status) return;
    t.status = status;
    if (reason) t.error = reason;
    t.lastActivity = Date.now();
    this.onUpdate(t);
  }

  private _clearEofTimer(t: TransferState): void {
    if (!t.eofTimer) return;
    clearTimeout(t.eofTimer);
    t.eofTimer = null;
  }

  private _sendAck(t: TransferState, seq: number, size: number): void {
    this._emit('transfer-ack', {
      transferId: t.id,
      seq,
      size,
      initiator: this.selfId,
      target: t.targetId,
    });
  }

  private _sendEofAck(t: TransferState): void {
    this._emit('transfer-eof-ack', {
      transferId: t.id,
      initiator: this.selfId,
      target: t.targetId,
    });
  }

  private _transmitChunk(t: TransferState, seq: number, chunk: Uint8Array): void {
    this._emit('transfer-chunk', {
      transferId: t.id,
      seq,
      size: chunk.length,
      chunk: Array.from(chunk),
      target: t.targetId,
    });
  }

  private _emit(event: string, payload: unknown): void {
    this.socket.emit(event, payload);
  }

  private _startAckTimeout(t: TransferState, seq: number, size: number, delay = 15000): void {
    if (t.ackedSeqs.has(seq)) return;
    const previous = t.ackTimers.get(seq);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      t.ackTimers.delete(seq);
      if (t.ackedSeqs.has(seq)) return;
      // En pause, plus rien ne part : la reprise reprogramme ces minuteurs.
      if (t.status !== 'transferring') return;
      const chunk = t.pending.get(seq);
      if (!chunk) return;
      t.attempts += 1;
      // Le chunk est déjà dans pending : on le retransmet sans repasser par sendChunk.
      this._transmitChunk(t, seq, chunk);
      this._startAckTimeout(t, seq, size, Math.min(delay * 2, 60000));
    }, delay);
    t.ackTimers.set(seq, timer);
  }

  private _updateReceiverProgress(t: TransferState): void {
    const totalChunks = Math.ceil(t.file.size / t.chunkSize) || 1;
    t.progress = Math.min(100, Math.round((t.buffer.size / totalChunks) * 100));
    this.onStatus(t);
    this.onUpdate(t);
  }

  private _updateSenderProgress(t: TransferState): void {
    const total = t.file.size;
    if (total <= 0) t.progress = 100;
    else t.progress = Math.min(100, Math.round((t.confirmed / total) * 100));
    if (t.window) {
      const now = Date.now();
      const elapsed = (now - t.window.start) / 1000;
      const avg = elapsed > 0 ? t.window.bytes / elapsed : 0;
      t.speed = Math.max(t.speed * 0.6, avg * 0.4);
      if (elapsed > 1) this.onStatus(t);
    }
    this.onUpdate(t);
  }

  private _isComplete(t: TransferState): boolean {
    if (t.file.size === 0) return true;
    const totalChunks = Math.ceil(t.file.size / t.chunkSize);
    return t.buffer.size >= totalChunks;
  }

  private async _finishReceive(t: TransferState): Promise<void> {
    // Un même transfert ne se termine qu'une fois : sinon le fichier était
    // proposé (et téléchargé) autant de fois que l'expéditeur réémettait l'EOF.
    if (t.status === 'completed' || this.finishing.has(t.id)) return;
    this.finishing.add(t.id);
    try {
      const totalChunks = Math.ceil(t.file.size / t.chunkSize);
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < totalChunks; i++) {
        const chunk = t.buffer.get(i);
        if (!chunk) {
          this._setStatus(t, 'failed', 'Fichier incomplet (séquence ' + i + ' manquante)');
          this._emit('transfer-end', {
            transferId: t.id,
            status: 'failed',
            reason: 'Fichier incomplet',
            target: t.targetId,
          });
          return;
        }
        chunks.push(chunk);
      }
      const merged = new Uint8Array(t.file.size);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      // Vérification avant de proposer le fichier : une corruption silencieuse
      // donnait un APK impossible à installer, sans le moindre message.
      if (t.hash) {
        const digest = await sha256Hex(merged);
        t.integrity = digest !== null && digest === t.hash.toLowerCase() ? 'verified' : 'mismatch';
      }
      t.buffer.clear();
      this._setStatus(
        t,
        'completed',
        t.integrity === 'mismatch' ? 'Fichier corrompu pendant le transfert' : 'Terminé'
      );
      this.onStatus(t);
      this.onComplete(t);
      (
        window as unknown as {
          globalShare?: {
            onFileSaved?: (blob: Blob, name: string, integrity: IntegrityStatus) => void;
          };
        }
      ).globalShare?.onFileSaved?.(
        new Blob([merged], { type: t.file.mime || 'application/octet-stream' }),
        t.file.name,
        t.integrity
      );
    } finally {
      this.finishing.delete(t.id);
    }
  }

  clear(): void {
    for (const t of this.transfers.values()) {
      for (const timer of t.ackTimers.values()) clearTimeout(timer);
      t.ackTimers.clear();
      this._clearEofTimer(t);
    }
    this.finishing.clear();
    this.transfers.clear();
  }
}
