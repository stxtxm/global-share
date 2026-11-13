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

Avant de publier, le workflow exécute `npm run test:unit`, puis `npm run lint`
et `npx tsc --noEmit` : un build qui ne passe pas ces étapes n'est pas déployé.

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

Les identifiants sont **générés à la demande par le Worker**, jamais embarqués
dans le bundle : le navigateur appelle `GET /turn` au moment de négocier et
reçoit un nom d'utilisateur daté plus sa signature HMAC-SHA1 (TURN REST API).
Ils expirent d'eux-mêmes (`TURN_TTL_SECONDS`, une heure par défaut, renouvelés
à mi-vie par le client).

Côté Worker, deux valeurs suffisent :

| Nom | Nature | Exemple |
| --- | --- | --- |
| `TURN_URLS` | variable | `turn:turn.example.net:3478,turns:turn.example.net:5349` (séparés par des virgules) |
| `TURN_SECRET` | **secret** | secret partagé avec le serveur TURN (`wrangler secret put TURN_SECRET`) |
| `TURN_TTL_SECONDS` | variable, facultative | `3600` |

Le serveur TURN doit accepter ce mode (`use-auth-secret` pour coturn, ou
l'équivalent chez un fournisseur managé). Vérification rapide une fois
configuré :

```bash
curl -s https://global-share-socket.sitizstorm.workers.dev/turn
# {"urls":["turn:…"],"username":"<expiration>:global-share","credential":"…","ttl":3600}
# {"urls":[],"ttl":0} tant que rien n'est configuré
```

Sans configuration, seuls les STUN publics de Google sont utilisés et le repli
relais reste actif — rien ne casse. À défaut de secret partagé, il reste
possible de figer des identifiants au build avec les variables de dépôt
`TURN_URLS`, `TURN_USERNAME` et `TURN_CREDENTIAL`, mais ils sont alors lisibles
par n'importe qui dans le bundle public.

## 2. Backend — Cloudflare Worker

Le Worker est déployé automatiquement par le même workflow, **avant** le
frontend : `worker` et `test` démarrent en parallèle, puis `build` et `deploy`
suivent.

Un échec du job `worker` **ne bloque pas** la publication du site. Le job
`build` porte la condition :

```yaml
if: always() && needs.worker.result != 'cancelled' && needs.test.result == 'success'
```

C'est volontaire : une panne Cloudflare (jeton expiré, API indisponible) ne doit
pas empêcher de publier un client statique, qui n'a besoin d'aucune nouvelle
version du Worker. Le job `worker` reste rouge et doit être relancé. En
revanche, un échec du job `test` empêche bien le déploiement.

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

L'application de bureau, elle, n'a pas d'origine fixe : elle sert sa page depuis
`http://127.0.0.1:<port>` avec un **port tiré au hasard** au lancement. La règle
`LOOPBACK_ORIGIN` accepte donc toute origine `http://localhost:<port>` et
`http://127.0.0.1:<port>`, quel que soit le port ; ne la remplacez pas par une
liste de ports fixes, sinon la création et l'entrée dans un salon échouent dans
l'app installée alors que le site web continue de fonctionner. Le test
`npm run test:origin` couvre les deux côtés (loopback accepté, origine distante
refusée).

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
| `npm run test:origin` | origines autorisées (Worker local ou distant) |
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

Le test d'origines fait de même et peut viser aussi bien le Worker local que la
production :

```bash
SOCKET_URL=https://global-share-socket.sitizstorm.workers.dev npm run test:origin
# allowed  http://127.0.0.1:51234
# allowed  http://localhost:51234
# allowed  https://stxtxm.github.io
# refused  https://evil.example
# refused  http://192.168.1.20:51234
# ALL OK
```

## 4. Dépannage

- **Page blanche ou assets en 404** : vérifier que Pages utilise bien
  « GitHub Actions » et que le build a été fait avec `basePath=/global-share`.
- **Le site ne se met pas à jour** : le workflow ne se déclenche que sur `main` ;
  vérifier l'onglet Actions et la protection de branche.
- **Connexion Socket.IO impossible** : vérifier `NEXT_PUBLIC_SOCKET_URL`, que
  l'origine figure dans `ALLOWED_ORIGINS`, et `/health`.
- **App de bureau : « échec de connexion » en créant ou en rejoignant un salon**
  alors que le site web fonctionne. Le Worker répond `403 Origin not allowed`
  parce que la page Electron est servie sur `http://127.0.0.1:<port aléatoire>`.
  Diagnostiquer avec un **vrai handshake WebSocket** : `curl` en HTTP/2 renvoie
  toujours `400` (pas d'upgrade) et ne prouve rien, utilisez `--http1.1`.

  ```bash
  curl -sS --http1.1 -o /dev/null -w '%{http_code}\n' \
    -H 'Origin: http://127.0.0.1:45123' \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==' \
    'https://global-share-socket.sitizstorm.workers.dev/socket.io/?EIO=4&transport=websocket'
  # 101 = origine acceptée, 403 = « Origin not allowed »
  ```

  Le contrôle est fait par `isAllowedOrigin()` dans `src/index.ts` :
  `ALLOWED_ORIGINS` pour les origines distantes, `LOOPBACK_ORIGIN` pour tout
  port local. Le correctif est côté Worker uniquement — inutile de publier une
  nouvelle version de l'app — et `npm run test:origin` empêche la régression.
- **Le merge d'une PR ne déploie pas** : le merge doit produire un push sur
  `main` (merge commit ou squash) ; un merge dans une autre branche ne déploie
  rien.
