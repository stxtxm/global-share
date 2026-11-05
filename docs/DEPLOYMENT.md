# Déploiement

GlobalShare est composé de deux parties indépendantes :

- le **frontend** statique (Next.js `output: 'export'`) sur GitHub Pages ;
- le **Worker Cloudflare** pour la signalisation Socket.IO et le relais.

## 1. Frontend — GitHub Pages

### Configuration du dépôt

Dans **Settings → Pages**, la source doit être **« GitHub Actions »** (et non
« Deploy from a branch »). Le préfixe `/global-share` vient du `basePath` de
`next.config.ts` ; les assets sont produits dans `out/`.

### Déclenchement

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) se déclenche :

- à chaque **push sur `main`**, ce qui couvre le **merge d'une pull request** ;
- manuellement via **Actions → Deploy to GitHub Pages → Run workflow**.

Avant de publier, le workflow exécute `npm run lint` et `npx tsc --noEmit` : un
build qui ne passe pas ces étapes n'est pas déployé.

### URL du Worker

L'URL publique du Worker est injectée au build :

```yaml
env:
  NEXT_PUBLIC_SOCKET_URL: https://global-share-socket.sitizstorm.workers.dev
```

Si le Worker change de nom ou de sous-domaine, mettez à jour cette valeur dans
le workflow. Cette URL est publique (elle finit dans le bundle navigateur).

## 2. Backend — Cloudflare Worker

Le Worker n'est **pas** déployé par la CI. Après une modification de
`socket-server-cloudflare/` :

```bash
cd socket-server-cloudflare
npm install
npx wrangler login   # une seule fois
npx wrangler deploy
```

`wrangler.toml` déclare le Worker `global-share-socket`, le Durable Object
`GlobalRoom` et sa migration SQLite. La configuration des origines autorisées se
trouve dans `ALLOWED_ORIGINS` (`src/index.ts`) : elle doit contenir l'origine du
frontend (`https://stxtxm.github.io`) et les origines de développement.

Vérification rapide :

```bash
curl https://global-share-socket.sitizstorm.workers.dev/health
# {"status":"ok","timestamp":"..."}
```

Les logs en production sont accessibles avec `npx wrangler tail`.

## 3. Vérifications

| Commande | Portée |
| --- | --- |
| `npm run lint` | frontend |
| `npx tsc --noEmit` | frontend |
| `npm --prefix socket-server-cloudflare run typecheck` | Worker |
| `npm run test:protocol` | protocole Socket.IO (Worker local) |
| `npm run build` | export statique |

Le test de protocole a besoin d'un Worker qui tourne :

```bash
cd socket-server-cloudflare
npm run dev -- --port 8787
# dans un autre terminal, à la racine :
npm run test:protocol
```

Il couvre `/health`, la présence dans un salon, l'isolation entre salons, la
signalisation WebRTC, le relais texte/binaire, un burst de 100 chunks et la
notification de déconnexion. Pour le lancer contre une instance distante :

```bash
SOCKET_URL=https://global-share-socket.sitizstorm.workers.dev npm run test:protocol
```

## 4. Dépannage

- **Page blanche ou assets en 404** : vérifier que Pages utilise bien
  « GitHub Actions » et que le build a été fait avec `basePath=/global-share`.
- **Le site ne se met pas à jour** : le workflow ne se déclenche que sur `main` ;
  vérifier l'onglet Actions et la protection de branche.
- **Connexion Socket.IO impossible** : vérifier `NEXT_PUBLIC_SOCKET_URL`, que
  l'origine figure dans `ALLOWED_ORIGINS`, et `/health`.
- **Le merge d'une PR ne déploie pas** : le merge doit produire un push sur
  `main` (merge commit ou squash) ; un merge dans une autre branche ne déploie
  rien.
