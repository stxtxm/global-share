export interface Env {
  ROOMS: DurableObjectNamespace;
  /** URLs TURN séparées par des virgules (ex. "turn:h:3478,turns:h:5349"). */
  TURN_URLS?: string;
  /** Secret partagé avec le serveur TURN, pour la TURN REST API. */
  TURN_SECRET?: string;
  /** Durée de vie des identifiants TURN, en secondes (défaut 3600). */
  TURN_TTL_SECONDS?: string;
}

type BinaryAttachment = ArrayBuffer | ArrayBufferView;

interface PendingBinary {
  args: unknown[];
  attachments: BinaryAttachment[];
  remaining: number;
}

interface Client {
  id: string;
  ws: WebSocket;
  name?: string;
  room?: string;
  /** Identité stable fournie par le client, conservée d'une socket à l'autre. */
  peerId?: string;
  alive: boolean;
  closed: boolean;
  pendingBinary: PendingBinary | null;
  binaryQueue: Promise<void>;
}

const PING_INTERVAL_MS = 25_000;
const MAX_ROOM_LENGTH = 64;
const MAX_NAME_LENGTH = 64;
// Un appareil qui se verrouille ou change de réseau perd sa socket quelques
// instants. On laisse ce délai avant d'annoncer son départ au salon : revenir
// dans ce laps de temps n'interrompt donc aucun transfert.
const REJOIN_GRACE_MS = 30_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

// The GitHub Pages origin and local development origins. Add any custom
// frontend domain here before deploying it.
const ALLOWED_ORIGINS = new Set([
  'https://stxtxm.github.io',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
]);

// L'application de bureau sert sa page depuis un serveur local sur un port
// choisi au hasard : toute origine de loopback est donc acceptée, sinon la
// connexion au salon échoue en « Origin not allowed ».
const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/;

function isAllowedOrigin(origin: string | null): boolean {
  // Une requête sans Origin ne vient pas d'une page web (client natif, test).
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin) || LOOPBACK_ORIGIN.test(origin);
}

// --- Identifiants TURN éphémères -------------------------------------------
// Le serveur TURN et le Worker partagent un secret : le nom d'utilisateur porte
// la date d'expiration et le mot de passe en est la signature HMAC-SHA1, comme
// le définit la TURN REST API. Les identifiants servis au navigateur expirent
// d'eux-mêmes, donc aucun mot de passe durable ne traîne dans le bundle public.
const TURN_DEFAULT_TTL_SECONDS = 3600;
const TURN_USER_PREFIX = 'global-share';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha1(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', data));
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  let key = encoder.encode(secret);
  if (key.length > 64) key = await sha1(key);
  // HMAC n'existe pas pour SHA-1 dans WebCrypto : on applique la construction
  // générique (blocs ipad/opad) sur le digest SHA-1.
  const inner = new Uint8Array(64);
  const outer = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) {
    const byte = key[i] ?? 0;
    inner[i] = byte ^ 0x36;
    outer[i] = byte ^ 0x5c;
  }
  const digestedInner = await sha1(concatBytes(inner, encoder.encode(message)));
  return toBase64(await sha1(concatBytes(outer, digestedInner)));
}

function turnJson(body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': origin && ALLOWED_ORIGINS.has(origin) ? origin : '*',
      'cache-control': 'no-store',
      vary: 'Origin',
    },
  });
}

async function handleTurn(env: Env, origin: string | null): Promise<Response> {
  const urls = (env.TURN_URLS ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  if (urls.length === 0 || !env.TURN_SECRET) {
    // Rien de configuré : le client reste sur les STUN publics, et le repli
    // relais Socket.IO continue de fonctionner.
    return turnJson({ urls: [], ttl: 0 }, origin);
  }
  const configured = Number.parseInt(env.TURN_TTL_SECONDS ?? '', 10);
  const ttl = Number.isFinite(configured) && configured > 0
    ? Math.min(Math.max(configured, 60), 86_400)
    : TURN_DEFAULT_TTL_SECONDS;
  const username = `${Math.floor(Date.now() / 1000) + ttl}:${TURN_USER_PREFIX}`;
  const credential = await hmacSha1Base64(env.TURN_SECRET, username);
  return turnJson({ urls, username, credential, ttl }, origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }),
        {
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
            'cache-control': 'no-store',
          },
        }
      );
    }

    if (url.pathname === '/turn') {
      return handleTurn(env, request.headers.get('Origin'));
    }

    if (url.pathname.startsWith('/socket.io/')) {
      const upgrade = request.headers.get('Upgrade');
      if (upgrade?.toLowerCase() !== 'websocket') {
        return new Response('This endpoint requires a WebSocket connection.', {
          status: 400,
        });
      }

      if (!isAllowedOrigin(request.headers.get('Origin'))) {
        return new Response('Origin not allowed.', { status: 403 });
      }

      // A single Durable Object keeps the same room state as the previous
      // in-memory Node server. It can be sharded by room later if needed.
      const id = env.ROOMS.idFromName('global');
      return env.ROOMS.get(id).fetch(request);
    }

    return new Response('GlobalShare socket server is running.\n', {
      headers: { 'content-type': 'text/plain' },
    });
  },
};

export class GlobalRoom {
  private sockets = new Map<string, Client>();
  /** Identité stable -> socket courante : le routage suit les reconnexions. */
  private bySession = new Map<string, Client>();
  private rooms = new Map<string, Set<string>>();
  private pendingLeaves = new Map<string, ReturnType<typeof setTimeout>>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get('Upgrade');
    if (upgrade?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.acceptSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private acceptSocket(ws: WebSocket): void {
    ws.accept();

    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    const client: Client = {
      id,
      ws,
      alive: true,
      closed: false,
      pendingBinary: null,
      binaryQueue: Promise.resolve(),
    };
    this.sockets.set(id, client);

    ws.addEventListener('message', (event) => {
      this.handleMessage(client, event.data);
    });
    ws.addEventListener('close', () => {
      this.handleClose(client);
    });
    ws.addEventListener('error', () => {
      this.handleClose(client);
    });

    this.sendRaw(
      client,
      '0' +
        JSON.stringify({
          sid: id,
          upgrades: [],
          pingInterval: PING_INTERVAL_MS,
          pingTimeout: 20_000,
          maxPayload: 1_000_000,
        })
    );

    this.ensurePingTimer();
  }

  private ensurePingTimer(): void {
    if (this.pingTimer !== null) return;

    this.pingTimer = setInterval(() => {
      for (const client of this.sockets.values()) {
        if (client.closed) continue;

        if (!client.alive) {
          try {
            client.ws.close(1001, 'ping timeout');
          } catch {
            // ignore
          }
          this.handleClose(client);
          continue;
        }

        client.alive = false;
        this.sendRaw(client, '2');
      }
    }, PING_INTERVAL_MS);
  }

  private stopPingTimerIfIdle(): void {
    if (this.sockets.size > 0 || this.pingTimer === null) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private handleMessage(
    client: Client,
    data: string | ArrayBuffer | ArrayBufferView | Blob
  ): void {
    if (client.closed) return;

    if (typeof data !== 'string') {
      // Binary attachments follow the BINARY_EVENT header. In some runtimes
      // (and in Miniflare) they are delivered as Blob, so normalize them and
      // preserve their order with a per-client queue.
      const task = async () => {
        const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
        this.handleBinaryAttachment(client, buffer);
      };
      client.binaryQueue = client.binaryQueue.then(task, task);
      return;
    }

    if (data === '2') {
      this.sendRaw(client, '3');
      return;
    }

    if (data === '3') {
      client.alive = true;
      return;
    }

    if (data === '1') {
      try {
        client.ws.close(1000, 'client close');
      } catch {
        // ignore
      }
      this.handleClose(client);
      return;
    }

    if (data.startsWith('40')) {
      this.sendRaw(client, '40' + JSON.stringify({ sid: client.id }));
      return;
    }

    if (data.startsWith('42')) {
      this.handleTextEvent(client, data.slice(2));
      return;
    }

    if (data.startsWith('45')) {
      this.handleBinaryEventHeader(client, data);
      return;
    }

    if (data.startsWith('41')) {
      this.handleClose(client);
    }
  }

  private handleTextEvent(client: Client, json: string): void {
    let args: unknown[];
    try {
      args = JSON.parse(json);
    } catch {
      return;
    }
    if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== 'string') {
      return;
    }

    const eventName = args[0];
    const payload = args[1];

    if (eventName === 'join-room') {
      this.handleJoinRoom(client, payload);
      return;
    }

    if (eventName === 'offer' || eventName === 'answer' || eventName === 'ice-candidate') {
      this.handleSignal(client, eventName, payload);
      return;
    }

    if (eventName === 'relay-data') {
      this.handleRelayText(client, payload);
      return;
    }

    // Événements de transfert (forwardés au pair cible)
    if (eventName === 'transfer-init' || eventName === 'transfer-chunk' ||
      eventName === 'transfer-ack' || eventName === 'transfer-eof' ||
      eventName === 'transfer-eof-ack' || eventName === 'transfer-cancel' ||
      eventName === 'transfer-end' || eventName === 'transfer-resync') {
      this.handleTransferEvent(client, eventName, payload);
      return;
    }
  }

  private handleJoinRoom(client: Client, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const { roomId, name, sessionId } = payload as {
      roomId?: unknown;
      name?: unknown;
      sessionId?: unknown;
    };

    if (typeof roomId !== 'string' || typeof name !== 'string') return;
    const cleanRoom = roomId.trim().slice(0, MAX_ROOM_LENGTH);
    const cleanName = name.trim().slice(0, MAX_NAME_LENGTH) || 'Appareil';
    if (!cleanRoom) return;

    if (client.room && client.room !== cleanRoom) {
      this.leaveRoom(client);
    }

    // Identité stable entre deux connexions : un téléphone verrouillé perd sa
    // socket mais garde son identité, donc les transferts retrouvent le bon
    // pair au retour au lieu d'être annulés.
    if (typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId)) {
      const previous = this.bySession.get(sessionId);
      if (previous && previous !== client) {
        // Même identité sur deux sockets (onglet dupliqué) : la plus récente
        // prend le relais, sans annoncer de départ au salon.
        this.leaveRoom(previous, true);
        previous.closed = true;
        try {
          previous.ws.close(1000, 'replaced');
        } catch {
          // ignore
        }
        this.sockets.delete(previous.id);
      }
      client.peerId = sessionId;
      this.bySession.set(sessionId, client);
      // Revenu avant l'expiration du délai : le salon n'a jamais vu le départ.
      const pendingLeave = this.pendingLeaves.get(sessionId);
      if (pendingLeave) {
        clearTimeout(pendingLeave);
        this.pendingLeaves.delete(sessionId);
      }
    }

    client.room = cleanRoom;
    client.name = cleanName;

    let room = this.rooms.get(cleanRoom);
    if (!room) {
      room = new Set();
      this.rooms.set(cleanRoom, room);
    }
    room.add(client.id);

    const others = Array.from(room)
      .filter((id) => id !== client.id)
      .map((id) => {
        const peer = this.sockets.get(id);
        // Les pairs sont désignés par leur identité stable, pas par leur socket.
        return {
          id: peer ? this.peerIdOf(peer) : id,
          name: peer?.name ?? 'Appareil',
        };
      });

    this.sendEvent(client, 'room-users', others);
    this.broadcastEvent(
      cleanRoom,
      'user-joined',
      { id: this.peerIdOf(client), name: cleanName },
      client.id
    );
  }

  private handleSignal(client: Client, eventName: string, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const targetId = (payload as { target?: unknown }).target;
    if (typeof targetId !== 'string') return;

    const target = this.resolve(targetId);
    if (!target) return;

    this.sendEvent(target, eventName, {
      ...(payload as Record<string, unknown>),
      caller: this.peerIdOf(client),
    });
  }

  private handleTransferEvent(client: Client, eventName: string, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const targetId = (payload as { target?: unknown }).target;
    if (typeof targetId !== 'string') return;
    const target = this.resolve(targetId);
    if (!target) return;
    this.sendEvent(target, eventName, {
      ...(payload as Record<string, unknown>),
      from: this.peerIdOf(client),
    });
  }

  private handleRelayText(client: Client, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const { target: targetId, data, meta } = payload as {
      target?: unknown;
      data?: unknown;
      meta?: unknown;
    };
    if (typeof targetId !== 'string') return;

    const target = this.resolve(targetId);
    if (!target) return;

    this.sendEvent(target, 'relay-data', {
      from: this.peerIdOf(client),
      data: data ?? null,
      meta: meta ?? null,
    });
  }

  private handleBinaryEventHeader(client: Client, data: string): void {
    // Wire format: "45" + attachment count + "-" + JSON args.
    const dash = data.indexOf('-', 2);
    if (dash === -1) return;

    const count = Number.parseInt(data.slice(2, dash), 10);
    if (!Number.isFinite(count) || count < 1) return;

    let args: unknown[];
    try {
      args = JSON.parse(data.slice(dash + 1));
    } catch {
      return;
    }
    if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== 'string') {
      return;
    }

    client.pendingBinary = {
      args,
      attachments: [],
      remaining: count,
    };
  }

  private handleBinaryAttachment(
    client: Client,
    data: ArrayBuffer | ArrayBufferView
  ): void {
    const pending = client.pendingBinary;
    if (!pending) return;

    pending.attachments.push(data);
    pending.remaining -= 1;

    if (pending.remaining > 0) return;

    client.pendingBinary = null;
    this.handleBinaryEvent(client, pending.args, pending.attachments);
  }

  private handleBinaryEvent(
    client: Client,
    args: unknown[],
    attachments: BinaryAttachment[]
  ): void {
    const eventName = args[0];
    if (typeof eventName !== 'string') return;

    const payload = args[1];
    if (!payload || typeof payload !== 'object') return;
    const targetId = (payload as { target?: unknown }).target;
    if (typeof targetId !== 'string') return;

    const target = this.resolve(targetId);
    if (!target) return;

    if (eventName === 'relay-data') {
      const meta = (payload as { meta?: unknown }).meta ?? null;
      this.sendBinaryEvent(
        target,
        [
          'relay-data',
          {
            from: this.peerIdOf(client),
            data: { _placeholder: true, num: 0 },
            meta,
          },
        ],
        [attachments[0]]
      );
      return;
    }

    if (eventName === 'offer' || eventName === 'answer' || eventName === 'ice-candidate') {
      this.sendBinaryEvent(
        target,
        [
          eventName,
          { ...(payload as Record<string, unknown>), caller: this.peerIdOf(client) },
        ],
        attachments
      );
    }
  }

  private handleClose(client: Client): void {
    if (client.closed) return;
    client.closed = true;

    this.sockets.delete(client.id);
    const peerId = client.peerId;
    const roomId = client.room;
    client.room = undefined;

    if (roomId) {
      const room = this.rooms.get(roomId);
      if (room) {
        room.delete(client.id);
        if (room.size === 0) this.rooms.delete(roomId);
      }
    }

    if (peerId) {
      if (this.bySession.get(peerId) === client) this.bySession.delete(peerId);
      if (roomId) this.scheduleLeave(roomId, peerId);
    }

    this.stopPingTimerIfIdle();
  }

  private leaveRoom(client: Client, silent = false): void {
    const roomId = client.room;
    if (!roomId) return;

    const room = this.rooms.get(roomId);
    if (room) {
      room.delete(client.id);
      if (room.size === 0) {
        this.rooms.delete(roomId);
      } else if (!silent) {
        this.broadcastEvent(roomId, 'user-left', this.peerIdOf(client));
      }
    }

    client.room = undefined;
  }

  /**
   * Annonce le départ du salon seulement si l'appareil n'est pas revenu dans le
   * délai : une coupure brève (verrouillage, changement de réseau) ne doit pas
   * faire annuler les transferts en cours côté pair.
   */
  private scheduleLeave(roomId: string, peerId: string): void {
    const existing = this.pendingLeaves.get(peerId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.pendingLeaves.delete(peerId);
      if (this.bySession.has(peerId)) return;
      this.broadcastEvent(roomId, 'user-left', peerId);
    }, REJOIN_GRACE_MS);

    this.pendingLeaves.set(peerId, timer);
  }

  /** Socket courante d'une identité stable (ou identifiant de socket brut). */
  private resolve(targetId: string): Client | undefined {
    return this.bySession.get(targetId) ?? this.sockets.get(targetId);
  }

  private peerIdOf(client: Client): string {
    return client.peerId ?? client.id;
  }

  private sendRaw(client: Client, data: string): void {
    if (client.closed) return;
    try {
      client.ws.send(data);
    } catch {
      this.handleClose(client);
    }
  }

  private sendEvent(client: Client, eventName: string, payload: unknown): void {
    this.sendRaw(client, '42' + JSON.stringify([eventName, payload]));
  }

  private sendBinaryEvent(
    client: Client,
    args: unknown[],
    attachments: BinaryAttachment[]
  ): void {
    if (client.closed) return;
    try {
      client.ws.send('45' + attachments.length + '-' + JSON.stringify(args));
      for (const attachment of attachments) {
        client.ws.send(attachment);
      }
    } catch {
      this.handleClose(client);
    }
  }

  private broadcastEvent(
    roomId: string,
    eventName: string,
    payload: unknown,
    exceptId?: string
  ): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const id of room) {
      if (id === exceptId) continue;
      const client = this.sockets.get(id);
      if (client) this.sendEvent(client, eventName, payload);
    }
  }
}
