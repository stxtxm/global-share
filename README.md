# GlobalShare - Next.js

Application Next.js pour le partage de fichiers P2P, déployée sur GitHub Pages.

## 🚀 Déploiement sur GitHub Pages

### 1. Préparer le serveur Socket.io

D'abord, déployez le serveur Socket.io sur Railway ou Render (gratuit) :

- Allez dans le dossier `socket-server`
- Suivez les instructions dans `socket-server/README.md`
- Notez l'URL de votre serveur Socket.io (ex: `https://votre-app.railway.app`)

### 2. Activer GitHub Pages

1. **Activez GitHub Pages** :
   - Allez sur https://github.com/stxtxm/global-share/settings/pages
   - Sous "Source", sélectionnez **"GitHub Actions"**
   - Sauvegardez

2. **Configurez la variable d'environnement** (optionnel) :
   - Allez sur https://github.com/stxtxm/global-share/settings/secrets/actions
   - Cliquez sur "New repository secret"
   - Nom : `NEXT_PUBLIC_SOCKET_URL`
   - Valeur : L'URL de votre serveur Socket.io
   - Cliquez sur "Add secret"

3. **Déclenchez le déploiement** :
   - Faites un push sur la branche `main` OU
   - Allez dans l'onglet "Actions" et exécutez le workflow manuellement

### 3. Votre site sera disponible à :

**https://stxtxm.github.io/global-share**

## 📝 Variables d'environnement

- `NEXT_PUBLIC_SOCKET_URL` : URL de votre serveur Socket.io (optionnel, par défaut: `http://localhost:3001`)

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
- **Serveur Socket.io** : Voir [socket-server/README.md](./socket-server/README.md)

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
