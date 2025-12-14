# 🚀 Déployer le serveur Socket.io sur Render

Guide complet pour déployer le serveur Socket.io sur Render et le connecter à votre app GitHub Pages.

## 📋 Étape 1 : Préparer le repository

Assurez-vous que le dossier `socket-server` est bien dans votre repository GitHub :
- https://github.com/stxtxm/global-share/tree/main/socket-server

## 🌐 Étape 2 : Créer un compte Render

1. Allez sur [Render](https://render.com)
2. Cliquez sur **"Get Started for Free"**
3. Connectez-vous avec votre compte GitHub
4. Autorisez Render à accéder à vos repositories

## 🔧 Étape 3 : Créer un nouveau Web Service

1. Dans le dashboard Render, cliquez sur **"New +"**
2. Sélectionnez **"Web Service"**
3. Cliquez sur **"Connect account"** si ce n'est pas déjà fait
4. Sélectionnez le repository **"stxtxm/global-share"**

## ⚙️ Étape 4 : Configurer le service

Remplissez le formulaire avec ces informations :

### Informations de base
- **Name** : `globalshare-socket` (ou le nom de votre choix)
- **Region** : Choisissez la région la plus proche (ex: `Frankfurt` pour l'Europe)
- **Branch** : `main`

### Configuration du build
- **Root Directory** : `socket-server`
- **Runtime** : `Node`
- **Build Command** : `npm install`
- **Start Command** : `npm start`

### Configuration avancée
- **Port** : Laissez vide (Render détectera automatiquement le PORT de l'environnement)
- **Plan** : Sélectionnez **"Free"**

## 🔐 Étape 5 : Configurer les variables d'environnement

Avant de créer le service, ajoutez les variables d'environnement :

1. Cliquez sur **"Advanced"** pour voir plus d'options
2. Dans **"Environment Variables"**, ajoutez :

   **Variable 1 :**
   - **Key** : `ALLOWED_ORIGINS`
   - **Value** : `https://stxtxm.github.io`
   
   **Variable 2 (optionnel) :**
   - **Key** : `PORT`
   - **Value** : `10000` (Render utilise le port 10000 par défaut, mais le serveur s'adapte automatiquement)

## 🚀 Étape 6 : Créer le service

1. Cliquez sur **"Create Web Service"**
2. Render va commencer à déployer votre service
3. Attendez 2-3 minutes pour que le déploiement se termine

## ✅ Étape 7 : Récupérer l'URL du serveur

Une fois le déploiement terminé :

1. Vous verrez un message **"Your service is live"**
2. L'URL sera affichée en haut (ex: `https://globalshare-socket.onrender.com`)
3. **Copiez cette URL** - vous en aurez besoin pour la prochaine étape

## 🧪 Étape 8 : Tester le serveur

1. Ouvrez l'URL de votre service dans un navigateur
2. Ajoutez `/health` à la fin (ex: `https://globalshare-socket.onrender.com/health`)
3. Vous devriez voir : `{"status":"ok","timestamp":"..."}`

✅ Si ça fonctionne, votre serveur est prêt !

## 🔗 Étape 9 : Connecter l'app GitHub Pages au serveur

### Option A : Via les secrets GitHub Actions (Recommandé)

1. Allez sur : https://github.com/stxtxm/global-share/settings/secrets/actions
2. Cliquez sur **"New repository secret"**
3. **Name** : `NEXT_PUBLIC_SOCKET_URL`
4. **Value** : L'URL de votre serveur Render (ex: `https://globalshare-socket.onrender.com`)
5. Cliquez sur **"Add secret"**

### Option B : Mettre à jour le workflow directement

Si vous préférez, vous pouvez modifier le workflow pour utiliser l'URL directement (mais l'option A est plus sécurisée).

## 🔄 Étape 10 : Redéployer l'app GitHub Pages

1. Allez sur : https://github.com/stxtxm/global-share/actions
2. Cliquez sur **"Deploy to GitHub Pages"**
3. Cliquez sur **"Run workflow"**
4. Sélectionnez la branche **"main"**
5. Cliquez sur **"Run workflow"**

Attendez 2-3 minutes pour que le déploiement se termine.

## ✅ Étape 11 : Vérifier que tout fonctionne

1. Allez sur : https://stxtxm.github.io/global-share
2. Ouvrez la console du navigateur (F12)
3. Vous devriez voir : `Connected to server`
4. Testez en créant un salon et en rejoignant depuis un autre onglet

## 🐛 Dépannage

### Le serveur ne démarre pas sur Render

- Vérifiez les logs dans le dashboard Render
- Vérifiez que `Root Directory` est bien `socket-server`
- Vérifiez que `Start Command` est bien `npm start`

### Erreur CORS

- Vérifiez que `ALLOWED_ORIGINS` contient bien `https://stxtxm.github.io`
- Redéployez le service après avoir modifié les variables d'environnement

### L'app ne se connecte pas au serveur

- Vérifiez que `NEXT_PUBLIC_SOCKET_URL` est bien configuré dans les secrets GitHub
- Vérifiez que l'URL du serveur est correcte (sans `/health` à la fin)
- Vérifiez la console du navigateur pour les erreurs

### Le serveur s'endort après inactivité (plan gratuit)

- C'est normal avec le plan gratuit de Render
- Le serveur se réveillera automatiquement au premier appel (peut prendre 30-60 secondes)
- Pour éviter cela, vous pouvez utiliser Railway qui offre 500h gratuites par mois

## 📝 Résumé des URLs

- **App GitHub Pages** : https://stxtxm.github.io/global-share
- **Serveur Socket.io Render** : https://globalshare-socket.onrender.com (remplacez par votre URL)
- **Health Check** : https://globalshare-socket.onrender.com/health

## 🎉 C'est tout !

Votre application est maintenant complètement déployée et fonctionnelle !

