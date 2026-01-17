# Déploiement sur Render

Ce guide explique comment déployer l'application Global Share sur Render avec le frontend et le serveur WebSocket sur un seul service.

## Prérequis

- Un compte Render.com
- Un dépôt Git (GitHub, GitLab ou autre) contenant le code source

## Étapes de déploiement

1. **Connectez votre dépôt à Render**
   - Connectez-vous à votre compte Render
   - Cliquez sur "New" puis "Web Service"
   - Connectez votre compte GitHub/GitLab et sélectionnez le dépôt

2. **Configuration du service (frontend + socket)**
   - Nom : `globalshare`
   - Région : `Frankfurt` (ou celle de votre choix)
   - Branche : `main` (ou votre branche de production)
   - Commande de build : `npm install && npm run build && cd socket-server && npm install`
   - Commande de démarrage : `node socket-server/server.js`
   - Plan : `Free`

   Variables d'environnement :
   - `NODE_ENV`: `production`
   - `PORT`: (laissez Render gérer automatiquement)

3. **Démarrez le déploiement**
   - Render va automatiquement cloner votre dépôt et déployer le service
   - Le frontend et le serveur WebSocket seront sur la même URL (ex: `https://globalshare.onrender.com`)

## Développement local

Pour exécuter l'application en local :

1. Installez les dépendances :
   ```bash
   npm install
   cd socket-server && npm install && cd ..
   ```

2. Lancez les services en mode développement :
   ```bash
   npm run dev:all
   ```
   Cela démarrera à la fois le frontend (sur http://localhost:3000) et le serveur WebSocket (sur http://localhost:3001).

## Mise à jour

Pour mettre à jour votre application :

1. Poussez vos modifications sur la branche principale
2. Render détectera automatiquement les changements et redéploiera les services

## Dépannage

- **Problèmes de connexion WebSocket** : Vérifiez que l'URL du serveur WebSocket est correctement configurée dans les variables d'environnement du frontend
- **Erreurs de build** : Consultez les logs de build dans le tableau de bord Render pour plus de détails
- **Problèmes CORS** : Assurez-vous que `ALLOWED_ORIGINS` dans le serveur WebSocket correspond à l'URL de votre frontend
