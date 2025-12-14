# 📚 Guide Complet - GlobalShare

Guide complet pour déployer GlobalShare sur GitHub Pages avec le serveur Socket.io sur Render.

## 🎯 Vue d'ensemble

- **Frontend (Next.js)** : Déployé sur GitHub Pages
- **Backend (Socket.io)** : Déployé sur Render (gratuit)

## 📋 Checklist de déploiement

### ✅ Partie 1 : Frontend GitHub Pages

- [x] Repository GitHub créé : https://github.com/stxtxm/global-share
- [x] Application Next.js configurée
- [x] Workflow GitHub Actions créé
- [x] GitHub Pages activé avec "GitHub Actions"
- [x] Site déployé : https://stxtxm.github.io/global-share

### 🔄 Partie 2 : Backend Socket.io sur Render

Suivez ces étapes dans l'ordre :

1. **Créer un compte Render**
   - Allez sur https://render.com
   - Connectez-vous avec GitHub

2. **Créer un Web Service**
   - Cliquez sur "New +" > "Web Service"
   - Connectez le repository `stxtxm/global-share`

3. **Configurer le service**
   - **Root Directory** : `socket-server`
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Plan** : Free

4. **Ajouter les variables d'environnement**
   - `ALLOWED_ORIGINS` = `https://stxtxm.github.io`
   - `PORT` = `10000` (optionnel, Render détecte automatiquement)

5. **Créer le service et récupérer l'URL**
   - Exemple : `https://globalshare-socket.onrender.com`

6. **Tester le serveur**
   - Visitez : `https://votre-serveur.onrender.com/health`
   - Vous devriez voir : `{"status":"ok"}`

### 🔗 Partie 3 : Connecter les deux

1. **Ajouter le secret GitHub**
   - Allez sur : https://github.com/stxtxm/global-share/settings/secrets/actions
   - Créez un secret : `NEXT_PUBLIC_SOCKET_URL`
   - Valeur : L'URL de votre serveur Render (sans `/health`)

2. **Redéployer l'app GitHub Pages**
   - Allez sur : https://github.com/stxtxm/global-share/actions
   - Cliquez sur "Deploy to GitHub Pages" > "Run workflow"

3. **Vérifier que tout fonctionne**
   - Visitez : https://stxtxm.github.io/global-share
   - Ouvrez la console (F12)
   - Vous devriez voir : `Connected to server`

## 📖 Guides détaillés

- **Déployer le serveur Socket.io** : [DEPLOY_SOCKET_RENDER.md](./DEPLOY_SOCKET_RENDER.md)
- **Activer GitHub Pages** : [ACTIVATE_GITHUB_PAGES.md](./ACTIVATE_GITHUB_PAGES.md)
- **Déploiement GitHub Pages** : [GITHUB_PAGES_DEPLOY.md](./GITHUB_PAGES_DEPLOY.md)

## 🔗 URLs importantes

- **App** : https://stxtxm.github.io/global-share
- **Repository** : https://github.com/stxtxm/global-share
- **Actions GitHub** : https://github.com/stxtxm/global-share/actions
- **Secrets GitHub** : https://github.com/stxtxm/global-share/settings/secrets/actions
- **Render Dashboard** : https://dashboard.render.com

## 🐛 Dépannage

### Le serveur Render ne démarre pas
- Vérifiez les logs dans le dashboard Render
- Vérifiez que `Root Directory` est bien `socket-server`
- Vérifiez que `Start Command` est bien `npm start`

### Erreur CORS
- Vérifiez que `ALLOWED_ORIGINS` contient `https://stxtxm.github.io`
- Redéployez le service après modification

### L'app ne se connecte pas
- Vérifiez que `NEXT_PUBLIC_SOCKET_URL` est configuré dans les secrets GitHub
- Vérifiez la console du navigateur (F12)
- Vérifiez que l'URL du serveur est correcte

### Le serveur s'endort (plan gratuit)
- C'est normal, le serveur se réveillera au premier appel (30-60 secondes)
- Pour éviter cela, utilisez Railway (500h gratuites/mois)

## 🎉 C'est tout !

Une fois toutes les étapes terminées, votre application sera complètement fonctionnelle !

