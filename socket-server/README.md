# GlobalShare Socket Server

Serveur Socket.io pour GlobalShare. Déployez ce serveur sur Railway, Render, ou tout autre service gratuit.

## Déploiement sur Railway (Gratuit)

1. Créez un compte sur [Railway](https://railway.app)
2. Créez un nouveau projet
3. Connectez votre repository ou déployez depuis ce dossier
4. Railway détectera automatiquement Node.js
5. Ajoutez la variable d'environnement `ALLOWED_ORIGINS` avec l'URL de votre app Vercel (ex: `https://votre-app.vercel.app`)
6. Railway vous donnera une URL (ex: `https://votre-app.railway.app`)
7. Utilisez cette URL dans `NEXT_PUBLIC_SOCKET_URL` de votre app Next.js

## Déploiement sur Render (Gratuit)

1. Créez un compte sur [Render](https://render.com)
2. Créez un nouveau "Web Service"
3. Connectez votre repository
4. Configuration:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Port: `3001`
5. Ajoutez la variable d'environnement `ALLOWED_ORIGINS`
6. Render vous donnera une URL

## Variables d'environnement

- `PORT`: Port du serveur (défaut: 3001)
- `ALLOWED_ORIGINS`: Origines autorisées séparées par des virgules (ex: `https://app.vercel.app,https://app.railway.app`)

