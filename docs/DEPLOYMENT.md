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

### Relais TURN (facultatif)

Les transferts commencent par une connexion directe entre les deux navigateurs.
Derrière un NAT symétrique (certaines offres 4G, réseaux d'entreprise), cette
connexion ne peut pas aboutir : l'application retombe alors sur le relais
Socket.IO, plus lent puisqu'il traverse le Worker. Un serveur **TURN** débloque
ces réseaux tout en gardant le chiffrement WebRTC.

Renseignez ces **variables de dépôt** (Settings → Secrets and variables →
Actions → onglet *Variables*) ; elles sont injectées au build et, de toute
façon, visibles dans le bundle public :

| Variable | Exemple |
| --- | --- |
| `TURN_URLS` | `turn:turn.example.net:3478,turns:turn.example.net:5349` (séparés par des virgules) |
| `TURN_USERNAME` | identifiant fourni par le service TURN |
| `TURN_CREDENTIAL` | mot de passe ou jeton fourni par le service TURN |

Sans ces variables, seuls les STUN publics de Google sont utilisés et le repli
relais reste actif — rien ne casse. Comme tout identifiant embarqué côté
navigateur est public, préférez un compte TURN dédié à ce site et des
identifiants à durée de vie limitée (ou renouvelés régulièrement).

## 2. Backend — Cloudflare Worker

Le Worker est déployé automatiquement par le même workflow, **avant** le
frontend (`worker` → `build` → `deploy`). Un échec du job `worker` bloque la
publication du site : les deux restent synchronisés.

### Secret requis

Dans **Settings → Secrets and variables → Actions** :

| Secret | Rôle |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Token API Cloudflare avec la permission **Workers Scripts:Edit** |

L'identifiant de compte (`0bf0ac08e2a32bb3b08436887d9df307`) est écrit dans
`deploy.yml` : ce n'est pas un secret. Le déploiement force l'adoption immédiate
du code par les Durable Objects
(`--durable-objects-code-update-mode immediate`) ; sans cela, une instance
active peut servir l'ancienne version jusqu'à 5 minutes.

### Déploiement manuel (secours)

```bash
cd socket-server-cloudflare
npm install
npx wrangler login   # une seule fois
npx wrangler deploy --durable-objects-code-update-mode immediate
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
