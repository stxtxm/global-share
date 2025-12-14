# GlobalShare Socket Server

Serveur Socket.io pour GlobalShare. Déployez ce serveur sur Render (gratuit) pour le connecter à votre app GitHub Pages.

## 🚀 Déploiement rapide sur Render

### Méthode 1 : Via l'interface Render (Recommandé)

Suivez le guide complet : [DEPLOY_SOCKET_RENDER.md](../DEPLOY_SOCKET_RENDER.md)

### Méthode 2 : Via render.yaml (Automatique)

1. Créez un compte sur [Render](https://render.com)
2. Connectez votre repository GitHub
3. Render détectera automatiquement le fichier `render.yaml`
4. Cliquez sur "Apply" pour créer le service

## 📋 Configuration manuelle

Si vous préférez configurer manuellement :

1. **Root Directory** : `socket-server`
2. **Build Command** : `npm install`
3. **Start Command** : `npm start`
4. **Port** : Laissez vide (Render détecte automatiquement)

## 🔐 Variables d'environnement

- `PORT`: Port du serveur (défaut: 10000 sur Render, 3001 en local)
- `ALLOWED_ORIGINS`: Origines autorisées (ex: `https://stxtxm.github.io`)

⚠️ **Important** : Pour GitHub Pages, ajoutez `https://stxtxm.github.io` dans `ALLOWED_ORIGINS`

## 🔗 Connecter à l'app GitHub Pages

Une fois déployé sur Render :

1. Récupérez l'URL de votre service (ex: `https://globalshare-socket.onrender.com`)
2. Ajoutez cette URL dans les secrets GitHub Actions :
   - Allez sur : https://github.com/stxtxm/global-share/settings/secrets/actions
   - Créez un secret : `NEXT_PUBLIC_SOCKET_URL` = URL de votre serveur Render
3. Redéployez l'app GitHub Pages

## 🧪 Tester le serveur

Visitez : `https://votre-serveur.onrender.com/health`

Vous devriez voir : `{"status":"ok","timestamp":"..."}`

## 📚 Documentation complète

Voir [DEPLOY_SOCKET_RENDER.md](../DEPLOY_SOCKET_RENDER.md) pour le guide détaillé étape par étape.

