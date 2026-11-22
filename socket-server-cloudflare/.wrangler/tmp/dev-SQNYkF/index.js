var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var PING_INTERVAL_MS = 25e3;
var MAX_ROOM_LENGTH = 64;
var MAX_NAME_LENGTH = 64;
var REJOIN_GRACE_MS = 3e4;
var SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
var ALLOWED_ORIGINS = /* @__PURE__ */ new Set([
  "https://stxtxm.github.io",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  // Capacitor sert l'APK depuis https://localhost, sans port.
  "https://localhost"
]);
var LOOPBACK_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;
function isAllowedOrigin(origin) {
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin) || LOOPBACK_ORIGIN.test(origin);
}
__name(isAllowedOrigin, "isAllowedOrigin");
var TURN_DEFAULT_TTL_SECONDS = 3600;
var TURN_USER_PREFIX = "global-share";
function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
__name(toBase64, "toBase64");
async function sha1(data) {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", data));
}
__name(sha1, "sha1");
function concatBytes(left, right) {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}
__name(concatBytes, "concatBytes");
async function hmacSha1Base64(secret, message) {
  const encoder = new TextEncoder();
  let key = encoder.encode(secret);
  if (key.length > 64) key = await sha1(key);
  const inner = new Uint8Array(64);
  const outer = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) {
    const byte = key[i] ?? 0;
    inner[i] = byte ^ 54;
    outer[i] = byte ^ 92;
  }
  const digestedInner = await sha1(concatBytes(inner, encoder.encode(message)));
  return toBase64(await sha1(concatBytes(outer, digestedInner)));
}
__name(hmacSha1Base64, "hmacSha1Base64");
function turnJson(body, origin) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "*",
      "cache-control": "no-store",
      vary: "Origin"
    }
  });
}
__name(turnJson, "turnJson");
async function handleTurn(env, origin) {
  const urls = (env.TURN_URLS ?? "").split(",").map((url) => url.trim()).filter(Boolean);
  if (urls.length === 0 || !env.TURN_SECRET) {
    return turnJson({ urls: [], ttl: 0 }, origin);
  }
  const configured = Number.parseInt(env.TURN_TTL_SECONDS ?? "", 10);
  const ttl = Number.isFinite(configured) && configured > 0 ? Math.min(Math.max(configured, 60), 86400) : TURN_DEFAULT_TTL_SECONDS;
  const username = `${Math.floor(Date.now() / 1e3) + ttl}:${TURN_USER_PREFIX}`;
  const credential = await hmacSha1Base64(env.TURN_SECRET, username);
  return turnJson({ urls, username, credential, ttl }, origin);
}
__name(handleTurn, "handleTurn");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", timestamp: (/* @__PURE__ */ new Date()).toISOString() }),
        {
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "no-store"
          }
        }
      );
    }
    if (url.pathname === "/turn") {
      return handleTurn(env, request.headers.get("Origin"));
    }
    if (url.pathname === "/rooms") {
      if (request.method !== "GET") {
        return new Response("Method not allowed.", { status: 405 });
      }
      if (!isAllowedOrigin(request.headers.get("Origin"))) {
        return new Response("Origin not allowed.", { status: 403 });
      }
      const id = env.ROOMS.idFromName("global");
      const response = await env.ROOMS.get(id).fetch(new Request("https://do.internal/rooms", { method: "GET" }));
      const body = await response.text();
      const origin = request.headers.get("Origin");
      return new Response(body, {
        status: response.status,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          // Même politique CORS que le WebSocket : même origine, ou « * » pour
          // les clients natifs (APK, desktop) sans en-tête Origin.
          "access-control-allow-origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "*",
          vary: "Origin"
        }
      });
    }
    if (url.pathname.startsWith("/socket.io/")) {
      const upgrade = request.headers.get("Upgrade");
      if (upgrade?.toLowerCase() !== "websocket") {
        return new Response("This endpoint requires a WebSocket connection.", {
          status: 400
        });
      }
      if (!isAllowedOrigin(request.headers.get("Origin"))) {
        return new Response("Origin not allowed.", { status: 403 });
      }
      const id = env.ROOMS.idFromName("global");
      return env.ROOMS.get(id).fetch(request);
    }
    return new Response("GlobalShare socket server is running.\n", {
      headers: { "content-type": "text/plain" }
    });
  }
};
var GlobalRoom = class {
  static {
    __name(this, "GlobalRoom");
  }
  sockets = /* @__PURE__ */ new Map();
  /** Identité stable -> socket courante : le routage suit les reconnexions. */
  bySession = /* @__PURE__ */ new Map();
  rooms = /* @__PURE__ */ new Map();
  pendingLeaves = /* @__PURE__ */ new Map();
  pingTimer = null;
  async fetch(request) {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      const url = new URL(request.url);
      if (url.hostname === "do.internal" && url.pathname === "/rooms") {
        const rooms = [...this.rooms.entries()].filter(([, users]) => users.size > 0).map(([room, users]) => ({ roomId: room, users: users.size })).sort((a, b) => b.users - a.users || a.roomId.localeCompare(b.roomId)).slice(0, 100);
        return new Response(JSON.stringify({ rooms }), {
          headers: { "content-type": "application/json", "cache-control": "no-store" }
        });
      }
      return new Response("Expected a WebSocket upgrade.", { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.acceptSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  acceptSocket(ws) {
    ws.accept();
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    const client = {
      id,
      ws,
      alive: true,
      closed: false,
      pendingBinary: null,
      binaryQueue: Promise.resolve()
    };
    this.sockets.set(id, client);
    ws.addEventListener("message", (event) => {
      this.handleMessage(client, event.data);
    });
    ws.addEventListener("close", () => {
      this.handleClose(client);
    });
    ws.addEventListener("error", () => {
      this.handleClose(client);
    });
    this.sendRaw(
      client,
      "0" + JSON.stringify({
        sid: id,
        upgrades: [],
        pingInterval: PING_INTERVAL_MS,
        pingTimeout: 2e4,
        maxPayload: 1e6
      })
    );
    this.ensurePingTimer();
  }
  ensurePingTimer() {
    if (this.pingTimer !== null) return;
    this.pingTimer = setInterval(() => {
      for (const client of this.sockets.values()) {
        if (client.closed) continue;
        if (!client.alive) {
          try {
            client.ws.close(1001, "ping timeout");
          } catch {
          }
          this.handleClose(client);
          continue;
        }
        client.alive = false;
        this.sendRaw(client, "2");
      }
    }, PING_INTERVAL_MS);
  }
  stopPingTimerIfIdle() {
    if (this.sockets.size > 0 || this.pingTimer === null) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
  handleMessage(client, data) {
    if (client.closed) return;
    if (typeof data !== "string") {
      const task = /* @__PURE__ */ __name(async () => {
        const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
        this.handleBinaryAttachment(client, buffer);
      }, "task");
      client.binaryQueue = client.binaryQueue.then(task, task);
      return;
    }
    if (data === "2") {
      this.sendRaw(client, "3");
      return;
    }
    if (data === "3") {
      client.alive = true;
      return;
    }
    if (data === "1") {
      try {
        client.ws.close(1e3, "client close");
      } catch {
      }
      this.handleClose(client);
      return;
    }
    if (data.startsWith("40")) {
      this.sendRaw(client, "40" + JSON.stringify({ sid: client.id }));
      return;
    }
    if (data.startsWith("42")) {
      this.handleTextEvent(client, data.slice(2));
      return;
    }
    if (data.startsWith("45")) {
      this.handleBinaryEventHeader(client, data);
      return;
    }
    if (data.startsWith("41")) {
      this.handleClose(client);
    }
  }
  handleTextEvent(client, json) {
    let args;
    try {
      args = JSON.parse(json);
    } catch {
      return;
    }
    if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== "string") {
      return;
    }
    const eventName = args[0];
    const payload = args[1];
    if (eventName === "join-room") {
      this.handleJoinRoom(client, payload);
      return;
    }
    if (eventName === "offer" || eventName === "answer" || eventName === "ice-candidate") {
      this.handleSignal(client, eventName, payload);
      return;
    }
    if (eventName === "relay-data") {
      this.handleRelayText(client, payload);
      return;
    }
    if (eventName === "transfer-init" || eventName === "transfer-chunk" || eventName === "transfer-ack" || eventName === "transfer-eof" || eventName === "transfer-eof-ack" || eventName === "transfer-cancel" || eventName === "transfer-end" || eventName === "transfer-resync") {
      this.handleTransferEvent(client, eventName, payload);
      return;
    }
  }
  handleJoinRoom(client, payload) {
    if (!payload || typeof payload !== "object") return;
    const { roomId, name, sessionId } = payload;
    if (typeof roomId !== "string" || typeof name !== "string") return;
    const cleanRoom = roomId.trim().slice(0, MAX_ROOM_LENGTH);
    const cleanName = name.trim().slice(0, MAX_NAME_LENGTH) || "Appareil";
    if (!cleanRoom) return;
    if (client.room && client.room !== cleanRoom) {
      this.leaveRoom(client);
    }
    if (typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId)) {
      const previous = this.bySession.get(sessionId);
      if (previous && previous !== client) {
        this.leaveRoom(previous, true);
        previous.closed = true;
        try {
          previous.ws.close(1e3, "replaced");
        } catch {
        }
        this.sockets.delete(previous.id);
      }
      client.peerId = sessionId;
      this.bySession.set(sessionId, client);
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
      room = /* @__PURE__ */ new Set();
      this.rooms.set(cleanRoom, room);
    }
    room.add(client.id);
    const others = Array.from(room).filter((id) => id !== client.id).map((id) => {
      const peer = this.sockets.get(id);
      return {
        id: peer ? this.peerIdOf(peer) : id,
        name: peer?.name ?? "Appareil"
      };
    });
    this.sendEvent(client, "room-users", others);
    this.broadcastEvent(
      cleanRoom,
      "user-joined",
      { id: this.peerIdOf(client), name: cleanName },
      client.id
    );
  }
  handleSignal(client, eventName, payload) {
    if (!payload || typeof payload !== "object") return;
    const targetId = payload.target;
    if (typeof targetId !== "string") return;
    const target = this.resolve(targetId);
    if (!target) return;
    this.sendEvent(target, eventName, {
      ...payload,
      caller: this.peerIdOf(client)
    });
  }
  handleTransferEvent(client, eventName, payload) {
    if (!payload || typeof payload !== "object") return;
    const targetId = payload.target;
    if (typeof targetId !== "string") return;
    const target = this.resolve(targetId);
    if (!target) return;
    this.sendEvent(target, eventName, {
      ...payload,
      from: this.peerIdOf(client)
    });
  }
  handleRelayText(client, payload) {
    if (!payload || typeof payload !== "object") return;
    const { target: targetId, data, meta } = payload;
    if (typeof targetId !== "string") return;
    const target = this.resolve(targetId);
    if (!target) return;
    this.sendEvent(target, "relay-data", {
      from: this.peerIdOf(client),
      data: data ?? null,
      meta: meta ?? null
    });
  }
  handleBinaryEventHeader(client, data) {
    const dash = data.indexOf("-", 2);
    if (dash === -1) return;
    const count = Number.parseInt(data.slice(2, dash), 10);
    if (!Number.isFinite(count) || count < 1) return;
    let args;
    try {
      args = JSON.parse(data.slice(dash + 1));
    } catch {
      return;
    }
    if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== "string") {
      return;
    }
    client.pendingBinary = {
      args,
      attachments: [],
      remaining: count
    };
  }
  handleBinaryAttachment(client, data) {
    const pending = client.pendingBinary;
    if (!pending) return;
    pending.attachments.push(data);
    pending.remaining -= 1;
    if (pending.remaining > 0) return;
    client.pendingBinary = null;
    this.handleBinaryEvent(client, pending.args, pending.attachments);
  }
  handleBinaryEvent(client, args, attachments) {
    const eventName = args[0];
    if (typeof eventName !== "string") return;
    const payload = args[1];
    if (!payload || typeof payload !== "object") return;
    const targetId = payload.target;
    if (typeof targetId !== "string") return;
    const target = this.resolve(targetId);
    if (!target) return;
    if (eventName === "relay-data") {
      const meta = payload.meta ?? null;
      this.sendBinaryEvent(
        target,
        [
          "relay-data",
          {
            from: this.peerIdOf(client),
            data: { _placeholder: true, num: 0 },
            meta
          }
        ],
        [attachments[0]]
      );
      return;
    }
    if (eventName === "offer" || eventName === "answer" || eventName === "ice-candidate") {
      this.sendBinaryEvent(
        target,
        [
          eventName,
          { ...payload, caller: this.peerIdOf(client) }
        ],
        attachments
      );
      return;
    }
    if (eventName === "transfer-chunk") {
      this.sendBinaryEvent(
        target,
        [
          "transfer-chunk",
          { ...payload, from: this.peerIdOf(client) }
        ],
        attachments
      );
    }
  }
  handleClose(client) {
    if (client.closed) return;
    client.closed = true;
    this.sockets.delete(client.id);
    const peerId = client.peerId;
    const roomId = client.room;
    client.room = void 0;
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
  leaveRoom(client, silent = false) {
    const roomId = client.room;
    if (!roomId) return;
    const room = this.rooms.get(roomId);
    if (room) {
      room.delete(client.id);
      if (room.size === 0) {
        this.rooms.delete(roomId);
      } else if (!silent) {
        this.broadcastEvent(roomId, "user-left", this.peerIdOf(client));
      }
    }
    client.room = void 0;
  }
  /**
   * Annonce le départ du salon seulement si l'appareil n'est pas revenu dans le
   * délai : une coupure brève (verrouillage, changement de réseau) ne doit pas
   * faire annuler les transferts en cours côté pair.
   */
  scheduleLeave(roomId, peerId) {
    const existing = this.pendingLeaves.get(peerId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingLeaves.delete(peerId);
      if (this.bySession.has(peerId)) return;
      this.broadcastEvent(roomId, "user-left", peerId);
    }, REJOIN_GRACE_MS);
    this.pendingLeaves.set(peerId, timer);
  }
  /** Socket courante d'une identité stable (ou identifiant de socket brut). */
  resolve(targetId) {
    return this.bySession.get(targetId) ?? this.sockets.get(targetId);
  }
  peerIdOf(client) {
    return client.peerId ?? client.id;
  }
  sendRaw(client, data) {
    if (client.closed) return;
    try {
      client.ws.send(data);
    } catch {
      this.handleClose(client);
    }
  }
  sendEvent(client, eventName, payload) {
    this.sendRaw(client, "42" + JSON.stringify([eventName, payload]));
  }
  sendBinaryEvent(client, args, attachments) {
    if (client.closed) return;
    try {
      client.ws.send("45" + attachments.length + "-" + JSON.stringify(args));
      for (const attachment of attachments) {
        client.ws.send(attachment);
      }
    } catch {
      this.handleClose(client);
    }
  }
  broadcastEvent(roomId, eventName, payload, exceptId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const id of room) {
      if (id === exceptId) continue;
      const client = this.sockets.get(id);
      if (client) this.sendEvent(client, eventName, payload);
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-S3J3I1/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-S3J3I1/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  GlobalRoom,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
