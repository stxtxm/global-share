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

1. démarre ensemble le Worker (`worker`), les vérifications (`test`) et le
   build du site (`build`) ;
2. `test` installe une fois les dépendances puis lance `npm run test:unit`,
   `npm run lint` et `npx tsc --noEmit` ;
3. `build` installe les dépendances, construit l'export statique avec
   `NEXT_PUBLIC_SOCKET_URL` et prépare l'artefact Pages ;
4. `deploy` attend les trois jobs et publie `out/` sur GitHub Pages.

Le Worker est donc terminé avant le site. En revanche un échec du job
`worker` **ne bloque pas** la publication : une panne Cloudflare (jeton expiré,
API indisponible) ne doit pas empêcher de publier un client statique, qui n'a
besoin d'aucune nouvelle version du Worker. Le job reste rouge et doit être
relancé. Les jobs `test` et `build` conditionnent la publication : un test, un
lint, un typecheck ou un build en échec empêche le déploiement.

Il se déclenche à **chaque push sur `main`** (donc au merge d'une pull request),
sauf pour un changement purement documentaire (`**.md`, `docs/**`, `LICENSE`),
et manuellement depuis l'onglet **Actions**. GitHub Pages doit être configuré
avec la source **« GitHub Actions »** :
https://github.com/stxtxm/global-share/settings/pages

Les dépendances et les builds sont mis en cache (npm, Next.js, Gradle,
Electron) ; le détail du pipeline et des gains est dans
[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md#cache-et-parallélisme).

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
npm run test:unit
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

Le paquet rpm est signé : importez la clé publique une fois avant de
l'installer (Fedora 45 refuse les paquets non signés), voir
[docs/DESKTOP.md](./docs/DESKTOP.md#installer-le-paquet-rpm-fedora-45-et-plus-récent).

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

## Application Android (APK)

Un APK Capacitor embarque le même frontend, avec un service avant-plan et un
wake lock pour poursuivre les transferts écran verrouillé, et une mise à jour
in-app depuis les releases GitHub (APK signé + empreinte SHA-256). Le workflow
[`.github/workflows/android.yml`](./.github/workflows/android.yml) publie l'APK
sur chaque tag ; la signature demande quatre secrets de dépôt décrits dans
[docs/ANDROID.md](./docs/ANDROID.md). Le Play Store n'est pas visé : le
self-update par APK en est exclu par sa politique.

```bash
npm run apk:debug   # build local non signé (SDK Android 36 requis)
npm run apk         # build signé (variables ANDROID_KEY_*)
```

Les notes de version sont tenues dans [CHANGELOG.md](./CHANGELOG.md) : y ajouter
l'entrée sous `[Non publié]` avant de pousser le tag, puis la renommer avec le
numéro et la date de la version.

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
- Icône tray sur KDE/XFCE/etc. ; sur GNOME, repli minimisé + notification et
  guide d'activation de l'extension AppIndicator (voir
  [docs/DESKTOP.md](./docs/DESKTOP.md#retrouver-la-fenêtre-gnome-kde-xfce))
- Interface mobile, wake lock pendant le transfert, PWA installable

## Liens

- Dépôt : https://github.com/stxtxm/global-share
- Guide de déploiement : [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)
- Worker Cloudflare : [socket-server-cloudflare/README.md](./socket-server-cloudflare/README.md)
