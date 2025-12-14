# 🚀 Guide de Déploiement - GlobalShare Next.js

Ce guide vous explique comment déployer GlobalShare gratuitement sur Vercel (frontend) et Railway/Render (serveur Socket.io).

## 📋 Prérequis

- Un compte GitHub (gratuit)
- Un compte Vercel (gratuit) : https://vercel.com
- Un compte Railway (gratuit) ou Render (gratuit) pour le serveur Socket.io

## 🔧 Étape 1 : Déployer le Serveur Socket.io

### Option A : Railway (Recommandé)

1. **Créez un compte** sur [Railway](https://railway.app) (gratuit avec GitHub)

2. **Créez un nouveau projet** :
   - Cliquez sur "New Project"
   - Sélectionnez "Deploy from GitHub repo"
   - Connectez votre repository
   - Sélectionnez le dossier `socket-server`

3. **Configurez les variables d'environnement** :
   - Allez dans Settings > Variables
   - Ajoutez `ALLOWED_ORIGINS` = `https://votre-app.vercel.app` (vous pourrez mettre à jour après le déploiement Vercel)

4. **Notez l'URL** de votre service Railway (ex: `https://globalshare-socket.railway.app`)

### Option B : Render

1. **Créez un compte** sur [Render](https://render.com) (gratuit)

2. **Créez un nouveau Web Service** :
   - Cliquez sur "New" > "Web Service"
   - Connectez votre repository
   - Configuration :
     - **Root Directory** : `socket-server`
     - **Build Command** : `npm install`
     - **Start Command** : `npm start`
     - **Port** : `3001`

3. **Configurez les variables d'environnement** :
   - Allez dans Environment
   - Ajoutez `ALLOWED_ORIGINS` = `https://votre-app.vercel.app`

4. **Notez l'URL** de votre service Render

## 🌐 Étape 2 : Déployer sur Vercel

### Méthode 1 : Via GitHub (Recommandé)

1. **Poussez votre code sur GitHub** :
   ```bash
   cd nextjs-app
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/votre-username/votre-repo.git
   git push -u origin main
   ```

2. **Importez sur Vercel** :
   - Allez sur [Vercel](https://vercel.com)
   - Cliquez sur "Add New..." > "Project"
   - Importez votre repository GitHub
   - Sélectionnez le dossier `nextjs-app` comme Root Directory

3. **Configurez les variables d'environnement** :
   - Dans "Environment Variables", ajoutez :
     - `NEXT_PUBLIC_SOCKET_URL` = URL de votre serveur Socket.io (Railway/Render)

4. **Déployez** :
   - Cliquez sur "Deploy"
   - Attendez la fin du déploiement
   - Vercel vous donnera une URL (ex: `https://globalshare.vercel.app`)

5. **Mettez à jour ALLOWED_ORIGINS** :
   - Retournez sur Railway/Render
   - Mettez à jour `ALLOWED_ORIGINS` avec l'URL Vercel complète

### Méthode 2 : Via Vercel CLI

1. **Installez Vercel CLI** :
   ```bash
   npm i -g vercel
   ```

2. **Connectez-vous** :
   ```bash
   vercel login
   ```

3. **Déployez** :
   ```bash
   cd nextjs-app
   vercel
   ```

4. **Ajoutez la variable d'environnement** :
   ```bash
   vercel env add NEXT_PUBLIC_SOCKET_URL
   # Entrez l'URL de votre serveur Socket.io
   ```

5. **Déployez en production** :
   ```bash
   vercel --prod
   ```

## ✅ Vérification

1. **Testez le serveur Socket.io** :
   - Visitez `https://votre-socket-server.railway.app/health`
   - Vous devriez voir `{"status":"ok",...}`

2. **Testez l'application** :
   - Visitez votre URL Vercel
   - Créez un salon et testez le partage de fichiers

## 🔄 Mise à jour

Pour mettre à jour l'application :

1. **Frontend (Vercel)** :
   - Poussez vos changements sur GitHub
   - Vercel redéploiera automatiquement

2. **Serveur Socket.io (Railway/Render)** :
   - Poussez vos changements sur GitHub
   - Railway/Render redéploiera automatiquement

## 📝 Notes

- **Railway** offre 500 heures gratuites par mois (suffisant pour un usage personnel)
- **Render** offre un plan gratuit avec limitations (peut s'endormir après inactivité)
- **Vercel** offre un plan gratuit généreux pour les projets personnels

## 🆘 Dépannage

### Le serveur Socket.io ne répond pas
- Vérifiez que le service est bien démarré sur Railway/Render
- Vérifiez les logs dans le dashboard

### Erreur CORS
- Vérifiez que `ALLOWED_ORIGINS` contient bien l'URL Vercel complète
- Redéployez le serveur Socket.io après modification

### L'application ne se connecte pas au serveur
- Vérifiez que `NEXT_PUBLIC_SOCKET_URL` est bien défini dans Vercel
- Vérifiez que l'URL est accessible (testez `/health`)

## 🎉 C'est tout !

Votre application GlobalShare est maintenant déployée gratuitement et accessible depuis n'importe où !

