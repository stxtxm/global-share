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
  /** Transport réellement emprunté par les données ; il peut changer en cours de route. */
  transport: 'p2p' | 'relay';
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
  /**
   * Position de reprise inconnue : on a demandé au destinataire combien
   * d'octets il possède et on n'émet rien avant sa réponse.
   */
  awaitingResync: boolean;
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
  chunk: number[] | Uint8Array;
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

/** Conservation des chunks reçus, pour survivre à un onglet tué. */
export interface ChunkStore {
  save: (transferId: string, seq: number, bytes: Uint8Array) => void;
  load: (transferId: string) => Promise<Map<number, Uint8Array>>;
  clear: (transferId: string) => void;
}

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

  /** Écriture des chunks reçus sur l'appareil (facultatif). */
  public chunkStore: ChunkStore | null = null;

  /**
   * Transport direct optionnel (canal WebRTC). Renvoie true quand le chunk est
   * réellement parti par ce canal ; false fait retomber l'émission sur le
   * socket, c'est-à-dire sur le relais.
   */
  public p2pSender:
    | ((t: TransferState, seq: number, chunk: Uint8Array) => boolean)
    | null = null;

  public onUpdate: (t: TransferState) => void;
  public onComplete: (t: TransferState) => void;
  public onCancel: (t: TransferState, reason: string) => void;
  public onError: (t: TransferState, error: string) => void;
  public onStatus: (t: TransferState) => void;
  public onSendDone: (id: string) => void;

  /** Identité courante : socket.id n'est disponible qu'après la connexion. */
  get selfId(): string {
    // Identité stable de session, pas `socket.id` : elle survit à une
    // reconnexion, sinon les ACK d'un transfert repris viseraient une socket
    // qui n'existe plus.
    return this.myId;
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
      transport: method,
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
      awaitingResync: false,
    };
    this.transfers.set(id, t);
    this._announce(t, false);
    this.onUpdate(t);
    return t;
  }

  /**
   * Réinstalle un envoi interrompu après un rechargement : le fichier n'est
   * plus en mémoire, l'utilisateur le réassocie avant la reprise.
   */
  restoreSend(meta: {
    id: string;
    file: TransferFileMeta;
    chunkSize: number;
    targetId: string;
    targetName: string;
    hash?: string;
    createdAt: number;
  }): TransferState {
    const existing = this.transfers.get(meta.id);
    if (existing) return existing;
    const t: TransferState = {
      id: meta.id,
      direction: 'send',
      targetId: meta.targetId,
      targetName: meta.targetName,
      file: meta.file,
      method: 'relay',
      transport: 'relay',
      chunkSize: meta.chunkSize > 0 ? meta.chunkSize : CHUNK_SIZE_DEFAULT,
      status: 'interrupted',
      progress: 0,
      confirmed: 0,
      speed: 0,
      attempts: 0,
      createdAt: meta.createdAt,
      lastActivity: Date.now(),
      offset: 0,
      nextSeq: 0,
      pending: new Map(),
      ackedSeqs: new Set(),
      window: null,
      buffer: new Map(),
      ackTimers: new Map(),
      hash: meta.hash,
      integrity: 'unknown',
      eofTimer: null,
      awaitingResync: true,
      error: 'Fichier à resélectionner',
    };
    this.transfers.set(t.id, t);
    this.onUpdate(t);
    return t;
  }

  /** Reprend un envoi restauré : le destinataire fixe la position exacte. */
  reopenSend(id: string): boolean {
    const t = this.transfers.get(id);
    if (!t || t.direction !== 'send' || t.status !== 'interrupted') return false;
    // Le fichier est revenu, mais la position ne l'est pas : on la redemande
    // au destinataire avant d'émettre quoi que ce soit.
    t.awaitingResync = true;
    this._resume(t);
    return true;
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
      transport: method,
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
      awaitingResync: false,
    };
    this.transfers.set(id, t);
    this.onUpdate(t);
    return t;
  }

  cancel(id: string, reason: string): void {
    const t = this.transfers.get(id);
    if (!t) return;
    this._setStatus(t, 'cancelled', reason);
    this.chunkStore?.clear(t.id);
    this._emit('transfer-cancel', {
      transferId: t.id,
      reason,
      target: t.targetId,
    });
    // `_setStatus` ne prévient que du changement d'état : sans cet appel, la
    // ligne annulée restait affichée « En cours » dans l'interface locale.
    this.onCancel(t, reason);
  }

  /**
   * Met en attente les transferts qui visent un pair précis (départ du salon,
   * perte de réseau). L'événement `user-left` porte l'identifiant du pair, pas
   * celui du transfert. On n'annule pas : un appareil qui se verrouille ou
   * change de réseau revient, et la reprise doit pouvoir repartir de là.
   */
  interruptForPeer(peerId: string, reason: string): void {
    for (const t of this.transfers.values()) {
      if (t.targetId === peerId) this._interrupt(t, reason);
    }
  }

  /** Même chose pour tous les transferts : la connexion au serveur est tombée. */
  interruptAll(reason: string): void {
    for (const t of this.transfers.values()) this._interrupt(t, reason);
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
    if (t.status !== 'paused' && t.status !== 'interrupted') return;
    this._resume(t);
  }

  /** Reprise automatique après une reconnexion ou un retour au premier plan. */
  resumeInterrupted(): void {
    for (const t of this.transfers.values()) {
      if (t.status === 'interrupted') this._resume(t);
    }
  }

  /**
   * Un pair vient de (re)apparaître : on lui redemande où il en est. Sans ça,
   * un destinataire rechargé ignorait les chunks déjà en vol, l'expéditeur les
   * renvoyait indéfiniment et plus rien n'avançait.
   */
  reannounceFor(peerId: string): void {
    for (const t of this.transfers.values()) {
      if (t.direction !== 'send' || t.targetId !== peerId) continue;
      if (t.status === 'interrupted' || t.status === 'paused') this._resume(t);
      else if (t.status === 'transferring') this._announce(t, true);
    }
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

  /** Renvoie true quand le chunk est réellement accepté et émis. */
  sendChunk(transferId: string, seq: number, chunk: Uint8Array): boolean {
    const t = this.transfers.get(transferId);
    if (!t || t.direction !== 'send') return false;
    if (t.status !== 'transferring') return false;
    if (t.pending.has(seq)) return false;
    t.pending.set(seq, chunk);
    t.offset += chunk.length;
    t.lastActivity = Date.now();
    this._transmitChunk(t, seq, chunk);
    this._startAckTimeout(t, seq, chunk.length);
    return true;
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
    chunkSize?: number;
    /** L'expéditeur reprend un transfert déjà annoncé. */
    resume?: boolean;
  }): void {
    const known = this.transfers.get(payload.transferId);
    if (known) {
      if (known.direction === 'receive') known.targetId = payload.initiator;
      // L'expéditeur reprend : le transfert redevient actif côté réception.
      if (known.status === 'interrupted') this._resume(known);
      else this.onUpdate(known);
      return;
    }
    if (payload.resume) {
      // Nous ne connaissons plus ce transfert (onglet tué, page rechargée) :
      // les chunks déjà reçus sont sur l'appareil, on les recharge et on dit
      // à l'expéditeur où reprendre.
      void this._restoreReceive(payload);
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
    chunk: number[] | Uint8Array;
    target: string;
    /** Chemin réel de ce chunk ; absent = relais (les chunks socket passent par là). */
    via?: 'p2p' | 'relay';
  }): void {
    if (payload.target !== this.selfId) return;
    const t = this.transfers.get(payload.transferId);
    if (!t || t.direction !== 'receive') return;
    if (t.buffer.has(payload.seq)) {
      // Chunk déjà reçu mais ACK perdu : on le renvoie.
      this._sendAck(t, payload.seq, payload.size);
      return;
    }
    const via = payload.via ?? 'relay';
    if (t.transport !== via) {
      t.transport = via;
      this.onStatus(t);
    }
    const bytes = new Uint8Array(payload.chunk);
    t.buffer.set(payload.seq, bytes);
    // Conservé tout de suite : un onglet tué par le système doit pouvoir
    // reprendre exactement là où il s'est arrêté.
    this.chunkStore?.save(t.id, payload.seq, bytes);
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

  onTransferCancel(payload: { transferId: string; reason: string; target: string }): void {    if (payload.target !== this.selfId) return;
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

  /**
   * Le destinataire indique combien d'octets il possède déjà : l'envoi
   * reprend exactement à cet endroit, sans rien renvoyer d'inutile.
   */
  onTransferResync(payload: {
    transferId: string;
    target: string;
    haveBytes?: number;
  }): void {
    if (payload.target !== this.selfId) return;
    const t = this.transfers.get(payload.transferId);
    if (!t || t.direction !== 'send') return;
    this._seekTo(t, typeof payload.haveBytes === 'number' ? payload.haveBytes : 0);
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

  private _interrupt(t: TransferState, reason: string): void {
    if (t.status !== 'transferring' && t.status !== 'pending') return;
    if (t.direction === 'send') {
      for (const timer of t.ackTimers.values()) clearTimeout(timer);
      t.ackTimers.clear();
      this._clearEofTimer(t);
    }
    this._setStatus(t, 'interrupted', reason);
  }

  private _resume(t: TransferState): void {
    if (t.awaitingResync) {
      // On ignore où en est le destinataire : on le lui redemande et on
      // n'émet pas un octet avant sa réponse, sinon on repartirait de zéro.
      this._announce(t, true);
      return;
    }
    this._setStatus(t, 'transferring', 'Reprise du transfert');
    if (t.direction !== 'send') return;
    // Le destinataire doit savoir que ce transfert repart : s'il ne le connaît
    // plus, il répond `transfer-resync` et l'envoi reprend à zéro.
    this._announce(t, true);
    // Les minuteurs ont été coupés à l'interruption : on relance l'émission des
    // chunks encore en attente, sinon un ACK perdu laissait un trou définitif.
    for (const [seq, chunk] of t.pending) {
      if (t.ackedSeqs.has(seq)) continue;
      this._transmitChunk(t, seq, chunk);
      this._startAckTimeout(t, seq, chunk.length);
    }
    if (t.offset >= t.file.size && t.pending.size === 0) this.sendEof(t.id);
  }

  /** Annonce (ou réannonce) l'envoi au destinataire. */
  private _announce(t: TransferState, resume: boolean): void {
    this._emit('transfer-init', {
      transferId: t.id,
      initiator: this.selfId,
      target: t.targetId,
      direction: 'send',
      file: { name: t.file.name, size: t.file.size, mime: t.file.mime },
      chunkSize: t.chunkSize,
      method: t.method,
      hash: t.hash,
      ...(resume ? { resume: true } : {}),
    });
  }

  /**
   * Recharge les chunks conservés d'un transfert que cet onglet ne connaît
   * plus, puis indique à l'expéditeur la position exacte de reprise.
   */
  private async _restoreReceive(payload: {
    transferId: string;
    initiator: string;
    target: string;
    file: TransferFileMeta;
    method: 'p2p' | 'relay';
    hash?: string;
    chunkSize?: number;
  }): Promise<void> {
    const stored = this.chunkStore
      ? await this.chunkStore.load(payload.transferId).catch(() => null)
      : null;
    const t = this.startReceive(
      payload.file,
      payload.initiator,
      payload.method,
      payload.transferId,
      payload.hash
    );
    if (payload.chunkSize && payload.chunkSize > 0) t.chunkSize = payload.chunkSize;
    stored?.forEach((bytes, seq) => t.buffer.set(seq, bytes));
    t.confirmed = this._prefixBytes(t);
    this._updateReceiverProgress(t);
    this._emit('transfer-resync', {
      transferId: t.id,
      target: t.targetId,
      haveBytes: t.confirmed,
    });
  }

  /** Octets reçus sans trou depuis le début du fichier. */
  private _prefixBytes(t: TransferState): number {
    let bytes = 0;
    let seq = 0;
    while (bytes < t.file.size) {
      const chunk = t.buffer.get(seq);
      if (!chunk) break;
      bytes += chunk.byteLength;
      seq += 1;
    }
    return Math.min(bytes, t.file.size);
  }

  /** Repositionne un envoi au premier octet manquant chez le destinataire. */
  private _seekTo(t: TransferState, bytes: number): void {
    for (const timer of t.ackTimers.values()) clearTimeout(timer);
    t.ackTimers.clear();
    this._clearEofTimer(t);
    t.pending.clear();
    t.ackedSeqs.clear();
    const clamped = Math.max(0, Math.min(bytes, t.file.size));
    // La reprise se fait toujours sur une frontière de chunk.
    const aligned = Math.floor(clamped / t.chunkSize) * t.chunkSize;
    t.awaitingResync = false;
    t.offset = aligned;
    t.nextSeq = aligned / t.chunkSize;
    t.confirmed = aligned;
    t.progress = t.file.size > 0 ? Math.min(100, Math.round((aligned / t.file.size) * 100)) : 0;
    t.speed = 0;
    t.status = 'transferring';
    t.error = undefined;
    t.lastActivity = Date.now();
    this._announce(t, false);
    this.onUpdate(t);
  }

  private _setStatus(t: TransferState, status: TransferStatus, reason?: string): void {    if (t.status === status) return;
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
    // P2P d'abord, relais ensuite : une réémission après perte d'ACK suit le
    // même choix, et retombe automatiquement sur le socket si le canal direct
    // a disparu entre-temps.
    if (t.method === 'p2p' && this.p2pSender?.(t, seq, chunk)) {
      if (t.transport !== 'p2p') {
        t.transport = 'p2p';
        this.onStatus(t);
      }
      return;
    }
    if (t.transport !== 'relay') {
      t.transport = 'relay';
      this.onStatus(t);
    }
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
      this.chunkStore?.clear(t.id);
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
            onFileSaved?: (
              blob: Blob,
              name: string,
              integrity: IntegrityStatus,
              from?: string
            ) => void;
          };
        }
      ).globalShare?.onFileSaved?.(
        new Blob([merged], { type: t.file.mime || 'application/octet-stream' }),
        t.file.name,
        t.integrity,
        // Pour une réception, targetId est l'expéditeur : l'interface y associe
        // le nom de l'appareil dans l'historique des téléchargements.
        t.targetId
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
