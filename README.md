# GlobalShare - Next.js

Application Next.js pour le partage de fichiers P2P, déployée sur GitHub Pages.

## 🚀 Déploiement sur GitHub Pages

### 1. Préparer le serveur Socket.io

Le serveur de production tourne sur **Cloudflare Workers + Durable Objects**
(gratuit, sans cold start, sans keep-alive) :

- Dossier : `socket-server-cloudflare/`
- Guide : [socket-server-cloudflare/README.md](./socket-server-cloudflare/README.md)
- URL : `https://global-share-socket.sitizstorm.workers.dev`

Le dossier `socket-server/` reste le serveur Node de secours (Render).
Il n'est plus utilisé par le déploiement GitHub Pages.

### 2. Activer GitHub Pages

1. **Activez GitHub Pages** :
   - Allez sur https://github.com/stxtxm/global-share/settings/pages
   - Sous "Source", sélectionnez **"GitHub Actions"**
   - Sauvegardez

2. **URL du serveur Socket.io** :
   - Le workflow `.github/workflows/deploy.yml` contient déjà l'URL du Worker
     Cloudflare. Elle est publique et peut être modifiée directement dans ce
     fichier si le Worker change de nom ou de domaine.
   - L'ancien secret `NEXT_PUBLIC_SOCKET_URL` n'est plus utilisé par le workflow.

3. **Déclenchez le déploiement** :
   - Faites un push sur la branche `main` OU
   - Allez dans l'onglet "Actions" et exécutez le workflow manuellement

### 3. Votre site sera disponible à :

**https://stxtxm.github.io/global-share**

## 📝 Variables d'environnement

- `NEXT_PUBLIC_SOCKET_URL` : URL du serveur Socket.io. En local, la valeur par
  défaut est `http://localhost:3001`; en production, le workflow utilise l'URL
  du Worker Cloudflare.

## 🛠️ Développement local

```bash
# Installer les dépendances
npm install

# Démarrer le serveur de développement
npm run dev
```

Assurez-vous que votre serveur Socket.io est en cours d'exécution et que `NEXT_PUBLIC_SOCKET_URL` est défini dans un fichier `.env.local`.

## 📚 Documentation complète

- **Déploiement GitHub Pages** : Voir [GITHUB_PAGES_DEPLOY.md](./GITHUB_PAGES_DEPLOY.md)
- **Déploiement GitHub** : Voir [GITHUB_DEPLOY.md](./GITHUB_DEPLOY.md)
- **Serveur Socket.io Cloudflare** : Voir [socket-server-cloudflare/README.md](./socket-server-cloudflare/README.md)
- **Serveur Socket.io Node (secours)** : Voir [socket-server/README.md](./socket-server/README.md)

## ✨ Fonctionnalités

- ✅ **P2P Direct** : Transfert ultra-rapide quand possible
- ✅ **Relay Automatique** : Fonctionne toujours, même avec pare-feu strict
- ✅ **Vérification d'intégrité** : Garantit que les fichiers arrivent complets
- ✅ **HTTPS Sécurisé** : Connexion chiffrée
- ✅ **PWA** : Installable sur mobile
- ✅ **Tous fichiers** : Photos, vidéos, documents, musique, etc.
- ✅ **Capture directe** : Prendre une photo et l'envoyer instantanément

## 🔗 Liens

- **Repository** : https://github.com/stxtxm/global-share
- **Site en ligne** : https://stxtxm.github.io/global-share
