# GlobalShare Socket Server — Cloudflare Workers

This is the signaling/relay server for GlobalShare. It runs on Cloudflare
Workers with a single SQLite-backed Durable Object. The browser keeps using
`socket.io-client`; only the WebSocket transport is enabled.

## Why

- No sleeping / no 40-second cold start.
- Free plan, no credit card.
- 100,000 requests/day (incoming WebSocket messages count as 1/20 of a request).
- 13,000 GB-s/day of Durable Object duration. One object running 24/7 uses
  about 10,800 GB-s/day.
- No egress fees.

The trade-off is that only the WebSocket transport is supported. The client must
use `transports: ['websocket']` (already set in `app/components/GlobalShare.tsx`).
HTTP long-polling fallback is not implemented.

## Local development

```bash
cd socket-server-cloudflare
npm install
npx wrangler dev --port 8787
```

In another terminal, run the protocol test:

```bash
npm run test:protocol
```

It checks health, room membership, WebRTC signaling, text/binary relay, a
100-chunk burst (1.6 MB) and disconnect notifications.

To point the frontend at the local worker:

```bash
NEXT_PUBLIC_SOCKET_URL=http://localhost:8787 npm run dev
```

## Deploy

```bash
cd socket-server-cloudflare
npm install
npx wrangler login
npx wrangler deploy
```

`wrangler` prints the public URL, for example:

```text
https://global-share-socket.<your-subdomain>.workers.dev
```

The GitHub Pages workflow currently embeds the deployed URL directly in
`.github/workflows/deploy.yml`:

```yaml
NEXT_PUBLIC_SOCKET_URL: https://global-share-socket.sitizstorm.workers.dev
```

Update that value if the Worker name/subdomain changes, then push or merge to
`main` (or run the `Deploy to GitHub Pages` workflow manually). No GitHub secret
is needed: the URL is public and lives in the workflow file.

## Configuration

- `wrangler.toml` defines the worker, the `GlobalRoom` Durable Object and the
  SQLite migration required by the Workers Free plan.
- `ALLOWED_ORIGINS` in `src/index.ts` contains the GitHub Pages origin and local
  development origins. Add any custom frontend domain there.
- Rooms are kept in memory in one Durable Object. If the object is restarted,
  clients reconnect and rejoin automatically.

## API

- `GET /health` — health check.
- `GET /socket.io/?EIO=4&transport=websocket` — Socket.IO WebSocket endpoint.
- Events: `join-room`, `room-users`, `user-joined`, `user-left`, `offer`,
  `answer`, `ice-candidate`, `relay-data`.
