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

1. déploie d'abord le Worker Cloudflare (`worker`) ;
2. installe les dépendances (`npm ci`) ;
3. lance `npm run lint` et `npx tsc --noEmit` ;
4. construit l'export statique avec `NEXT_PUBLIC_SOCKET_URL` ;
5. publie `out/` sur GitHub Pages.

Le site ne peut donc jamais être déployé avant le Worker : si le job `worker`
échoue, la publication Pages est bloquée.

Il se déclenche à **chaque push sur `main`** (donc au merge d'une pull request)
et manuellement depuis l'onglet **Actions**. GitHub Pages doit être configuré
avec la source **« GitHub Actions »** :
https://github.com/stxtxm/global-share/settings/pages

### Worker (automatique)

Le Worker est déployé par le même workflow, juste avant le frontend. Le secret
suivant doit exister dans **Settings → Secrets and variables → Actions** :

- `CLOUDFLARE_API_TOKEN` : token API Cloudflare avec la permission
  **Workers Scripts:Edit** sur le compte.

L'`account_id` est écrit dans `deploy.yml` (ce n'est pas une donnée sensible).
Le déploiement utilise `--durable-objects-code-update-mode immediate` : sans ce
flag, un Durable Object actif peut continuer à exécuter l'ancien code jusqu'à
5 minutes après le déploiement.

Déploiement manuel de secours :

```bash
cd socket-server-cloudflare
npm install
npx wrangler login
npx wrangler deploy --durable-objects-code-update-mode immediate
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

## Applications de bureau (Linux / Windows)

Le même frontend est empaqueté pour le bureau via `desktop/` et
[`electron-builder.yml`](./electron-builder.yml) :

| Fichier | Distribution |
| --- | --- |
| `.rpm` | Fedora, RHEL/Rocky/Alma, openSUSE |
| `.deb` | Debian, Ubuntu, Mint |
| `.AppImage` | toutes les distributions |
| `GlobalShare-Setup-<version>.exe` | Windows 10/11 x64 |

Les applications se mettent à jour depuis les releases GitHub
(`electron-updater`). Une release se publie en poussant un tag :

```bash
npm run dist:linux   # ou npm run dist:win
```

```bash
git tag v1.0.1
git push origin v1.0.1
```

Le workflow [`.github/workflows/release.yml`](./.github/workflows/release.yml)
construit et publie les paquets. Détails, particularités de mise à jour selon le
format et limites : [docs/DESKTOP.md](./docs/DESKTOP.md).

## Variables d'environnement

- `NEXT_PUBLIC_SOCKET_URL` : URL du Worker. Par défaut `http://localhost:3001`
  en développement ; injectée par le workflow en production.

## Fonctionnalités

- P2P direct quand le réseau le permet, relais sinon
- Envoi de fichiers, de photos (capture) et de dossiers (zip côté client)
- Salons partageables par lien `?room=CODE`
- Onglet **Téléchargements** : fichiers reçus conservés et rouverts depuis
  l'application (dossier `~/Téléchargements/GlobalShare` sur le bureau,
  IndexedDB sur le web et le mobile)
- Interface mobile, wake lock pendant le transfert, PWA installable

## Liens

- Dépôt : https://github.com/stxtxm/global-share
- Guide de déploiement : [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)
- Worker Cloudflare : [socket-server-cloudflare/README.md](./socket-server-cloudflare/README.md)
