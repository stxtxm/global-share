export interface Env {
  ROOMS: DurableObjectNamespace;
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
  alive: boolean;
  closed: boolean;
  pendingBinary: PendingBinary | null;
  binaryQueue: Promise<void>;
}

const PING_INTERVAL_MS = 25_000;
const MAX_ROOM_LENGTH = 64;
const MAX_NAME_LENGTH = 64;

// The GitHub Pages origin and local development origins. Add any custom
// frontend domain here before deploying it.
const ALLOWED_ORIGINS = new Set([
  'https://stxtxm.github.io',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
]);

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

    if (url.pathname.startsWith('/socket.io/')) {
      const upgrade = request.headers.get('Upgrade');
      if (upgrade?.toLowerCase() !== 'websocket') {
        return new Response('This endpoint requires a WebSocket connection.', {
          status: 400,
        });
      }

      const origin = request.headers.get('Origin');
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
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
  private rooms = new Map<string, Set<string>>();
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
    }
  }

  private handleJoinRoom(client: Client, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const { roomId, name } = payload as { roomId?: unknown; name?: unknown };

    if (typeof roomId !== 'string' || typeof name !== 'string') return;
    const cleanRoom = roomId.trim().slice(0, MAX_ROOM_LENGTH);
    const cleanName = name.trim().slice(0, MAX_NAME_LENGTH) || 'Appareil';
    if (!cleanRoom) return;

    if (client.room && client.room !== cleanRoom) {
      this.leaveRoom(client);
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
      .map((id) => ({
        id,
        name: this.sockets.get(id)?.name ?? 'Appareil',
      }));

    this.sendEvent(client, 'room-users', others);
    this.broadcastEvent(
      cleanRoom,
      'user-joined',
      { id: client.id, name: cleanName },
      client.id
    );
  }

  private handleSignal(client: Client, eventName: string, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const targetId = (payload as { target?: unknown }).target;
    if (typeof targetId !== 'string') return;

    const target = this.sockets.get(targetId);
    if (!target) return;

    this.sendEvent(target, eventName, {
      ...(payload as Record<string, unknown>),
      caller: client.id,
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

    const target = this.sockets.get(targetId);
    if (!target) return;

    this.sendEvent(target, 'relay-data', {
      from: client.id,
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

    const target = this.sockets.get(targetId);
    if (!target) return;

    if (eventName === 'relay-data') {
      const meta = (payload as { meta?: unknown }).meta ?? null;
      this.sendBinaryEvent(
        target,
        [
          'relay-data',
          {
            from: client.id,
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
          { ...(payload as Record<string, unknown>), caller: client.id },
        ],
        attachments
      );
    }
  }

  private handleClose(client: Client): void {
    if (client.closed) return;
    client.closed = true;

    this.leaveRoom(client);
    this.sockets.delete(client.id);
    this.stopPingTimerIfIdle();
  }

  private leaveRoom(client: Client): void {
    const roomId = client.room;
    if (!roomId) return;

    const room = this.rooms.get(roomId);
    if (room) {
      room.delete(client.id);
      if (room.size === 0) {
        this.rooms.delete(roomId);
      } else {
        this.broadcastEvent(roomId, 'user-left', client.id);
      }
    }

    client.room = undefined;
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
