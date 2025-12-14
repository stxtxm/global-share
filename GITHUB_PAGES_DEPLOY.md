# 🚀 Déploiement sur GitHub Pages

Votre application Next.js est maintenant configurée pour être déployée automatiquement sur GitHub Pages !

## ✅ Configuration automatique

Le workflow GitHub Actions est déjà configuré dans `.github/workflows/deploy.yml`. Il se déclenchera automatiquement à chaque push sur la branche `main`.

## 📋 Étapes pour activer GitHub Pages

1. **Activez GitHub Pages dans les paramètres du repository** :
   - Allez sur https://github.com/stxtxm/global-share/settings/pages
   - Sous "Source", sélectionnez **"GitHub Actions"**
   - Sauvegardez

2. **Configurez la variable d'environnement (optionnel)** :
   - Allez sur https://github.com/stxtxm/global-share/settings/secrets/actions
   - Cliquez sur "New repository secret"
   - Nom : `NEXT_PUBLIC_SOCKET_URL`
   - Valeur : L'URL de votre serveur Socket.io (ex: `https://votre-socket-server.railway.app`)
   - Cliquez sur "Add secret"

3. **Déclenchez le déploiement** :
   - Faites un push sur la branche `main` OU
   - Allez dans l'onglet "Actions" de votre repository
   - Sélectionnez le workflow "Deploy to GitHub Pages"
   - Cliquez sur "Run workflow"

## 🌐 URL de votre site

Une fois déployé, votre site sera accessible à :
- **https://stxtxm.github.io/global-share**

## 🔧 Configuration du serveur Socket.io

⚠️ **Important** : Le serveur Socket.io doit être déployé séparément sur Railway ou Render (gratuit).

1. **Déployez le serveur Socket.io** :
   - Suivez les instructions dans `socket-server/README.md`
   - Déployez sur Railway ou Render
   - Notez l'URL (ex: `https://globalshare-socket.railway.app`)

2. **Configurez CORS sur le serveur Socket.io** :
   - Ajoutez l'URL GitHub Pages dans `ALLOWED_ORIGINS`
   - Exemple : `ALLOWED_ORIGINS=https://stxtxm.github.io`

3. **Ajoutez la variable d'environnement** :
   - Dans les secrets GitHub Actions, ajoutez `NEXT_PUBLIC_SOCKET_URL`
   - Valeur : L'URL de votre serveur Socket.io

## 📝 Variables d'environnement

- `NEXT_PUBLIC_SOCKET_URL` : URL de votre serveur Socket.io (optionnel, par défaut: `http://localhost:3001`)

## 🔄 Déploiement automatique

À chaque push sur `main`, le workflow :
1. ✅ Installe les dépendances
2. ✅ Build l'application Next.js
3. ✅ Déploie automatiquement sur GitHub Pages

## 🐛 Dépannage

### Le site ne se déploie pas
- Vérifiez que GitHub Pages est activé avec "GitHub Actions" comme source
- Vérifiez les logs dans l'onglet "Actions"

### Erreur de build
- Vérifiez que toutes les dépendances sont dans `package.json`
- Vérifiez les logs du workflow dans "Actions"

### Le serveur Socket.io ne se connecte pas
- Vérifiez que `NEXT_PUBLIC_SOCKET_URL` est configuré dans les secrets
- Vérifiez que CORS est configuré sur le serveur Socket.io
- Vérifiez que le serveur Socket.io est accessible publiquement

## 🎉 C'est tout !

Votre application sera automatiquement déployée sur GitHub Pages à chaque push !

