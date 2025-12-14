# GlobalShare - Next.js

Application Next.js pour le partage de fichiers P2P.

## 🚀 Déploiement sur Vercel

### 1. Préparer le serveur Socket.io

D'abord, déployez le serveur Socket.io sur Railway ou Render (gratuit) :

- Allez dans le dossier `socket-server`
- Suivez les instructions dans `socket-server/README.md`
- Notez l'URL de votre serveur Socket.io (ex: `https://votre-app.railway.app`)

### 2. Déployer sur Vercel

1. **Installez Vercel CLI** (si pas déjà fait) :
   ```bash
   npm i -g vercel
   ```

2. **Connectez-vous à Vercel** :
   ```bash
   vercel login
   ```

3. **Déployez l'application** :
   ```bash
   cd nextjs-app
   vercel
   ```

4. **Ajoutez la variable d'environnement** :
   - Allez sur [Vercel Dashboard](https://vercel.com/dashboard)
   - Sélectionnez votre projet
   - Allez dans Settings > Environment Variables
   - Ajoutez : `NEXT_PUBLIC_SOCKET_URL` = URL de votre serveur Socket.io

5. **Redéployez** :
   ```bash
   vercel --prod
   ```

### Alternative : Déploiement via GitHub

1. Poussez votre code sur GitHub
2. Allez sur [Vercel](https://vercel.com)
3. Importez votre repository
4. Vercel détectera automatiquement Next.js
5. Ajoutez la variable d'environnement `NEXT_PUBLIC_SOCKET_URL`
6. Déployez !

## 📝 Variables d'environnement

- `NEXT_PUBLIC_SOCKET_URL` : URL de votre serveur Socket.io (obligatoire)

## 🛠️ Développement local

```bash
# Installer les dépendances
npm install

# Démarrer le serveur de développement
npm run dev
```

Assurez-vous que votre serveur Socket.io est en cours d'exécution et que `NEXT_PUBLIC_SOCKET_URL` est défini dans un fichier `.env.local`.

## ✨ Fonctionnalités

- ✅ **P2P Direct** : Transfert ultra-rapide quand possible
- ✅ **Relay Automatique** : Fonctionne toujours, même avec pare-feu strict
- ✅ **Vérification d'intégrité** : Garantit que les fichiers arrivent complets
- ✅ **HTTPS Sécurisé** : Connexion chiffrée
- ✅ **PWA** : Installable sur mobile
- ✅ **Tous fichiers** : Photos, vidéos, documents, musique, etc.
- ✅ **Capture directe** : Prendre une photo et l'envoyer instantanément
