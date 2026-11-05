# GlobalShare

Partage de fichiers entre appareils, sans compte ni installation : on ouvre un
salon, on partage le code, et le transfert part en **P2P WebRTC** (avec repli
automatique par relais). L'application est une PWA Next.js exportée en statique.

- **Site** : https://stxtxm.github.io/global-share
- **Signalisation / relais** : https://global-share-socket.sitizstorm.workers.dev

## Architecture

| Brique | Techno | Hébergement |
| --- | --- | --- |
| Frontend | Next.js 16, export statique (`out/`) | GitHub Pages (sous `/global-share`) |
| Signalisation + relais | Cloudflare Worker + Durable Object | Cloudflare Workers |
| Transport des fichiers | WebRTC via `simple-peer`, repli Socket.IO | Navigateur |

Le dossier [`socket-server-cloudflare/`](./socket-server-cloudflare/README.md)
contient le Worker : il implémente la signalisation Socket.IO (WebSocket
uniquement), la présence dans les salons et le relais binaire. Le frontend est
servi sous le préfixe `/global-share` (`basePath` dans `next.config.ts`).

## Déploiement

### Frontend (automatique)

Le workflow [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) :

1. installe les dépendances (`npm ci`) ;
2. lance `npm run lint` et `npx tsc --noEmit` ;
3. construit l'export statique avec `NEXT_PUBLIC_SOCKET_URL` ;
4. publie `out/` sur GitHub Pages.

Il se déclenche à **chaque push sur `main`** (donc au merge d'une pull request)
et manuellement depuis l'onglet **Actions**. GitHub Pages doit être configuré
avec la source **« GitHub Actions »** :
https://github.com/stxtxm/global-share/settings/pages

### Worker (manuel)

Le Worker n'est pas déployé par la CI :

```bash
cd socket-server-cloudflare
npm install
npx wrangler login
npx wrangler deploy
```

L'URL publique du Worker est reportée dans `deploy.yml`
(`NEXT_PUBLIC_SOCKET_URL`). Guide détaillé :
[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

## Développement local

```bash
npm install
npm --prefix socket-server-cloudflare install
npm run dev:all
```

- Frontend : http://localhost:3000
- Worker local : http://localhost:3001

Pour lancer les deux séparément :

```bash
npm run dev
npm --prefix socket-server-cloudflare run dev -- --port 3001
```

## Tests et vérifications

```bash
npm run lint
npx tsc --noEmit
npm --prefix socket-server-cloudflare run typecheck
```

Test du protocole (le Worker doit tourner) :

```bash
npm run test:protocol
# ou contre une instance distante :
SOCKET_URL=https://global-share-socket.sitizstorm.workers.dev npm run test:protocol
```

## Variables d'environnement

- `NEXT_PUBLIC_SOCKET_URL` : URL du Worker. Par défaut `http://localhost:3001`
  en développement ; injectée par le workflow en production.

## Fonctionnalités

- P2P direct quand le réseau le permet, relais sinon
- Envoi de fichiers, de photos (capture) et de dossiers (zip côté client)
- Salons partageables par lien `?room=CODE`
- Interface mobile, wake lock pendant le transfert, PWA installable

## Liens

- Dépôt : https://github.com/stxtxm/global-share
- Guide de déploiement : [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)
- Worker Cloudflare : [socket-server-cloudflare/README.md](./socket-server-cloudflare/README.md)
