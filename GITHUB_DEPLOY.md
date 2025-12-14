# 🚀 Déploiement sur GitHub

Votre code est prêt à être déployé sur GitHub ! Voici les étapes :

## ✅ Étape 1 : Code déjà commité

Le code a été commité avec succès :
```
feat: Convert GlobalShare to Next.js with Socket.io server
```

## 📦 Étape 2 : Créer le repository GitHub

### Option A : Avec GitHub CLI (Recommandé)

Si vous avez `gh` installé :

```bash
./deploy-github.sh
```

Ou manuellement :
```bash
gh repo create globalshare-nextjs --public --source=. --remote=origin --push
```

### Option B : Via l'interface GitHub

1. Allez sur https://github.com/new
2. Créez un nouveau repository :
   - **Nom** : `globalshare-nextjs` (ou celui de votre choix)
   - **Visibilité** : Public ou Private
   - **NE PAS** initialiser avec README, .gitignore ou license
3. Exécutez les commandes suivantes :

```bash
git remote add origin https://github.com/VOTRE_USERNAME/globalshare-nextjs.git
git branch -M main
git push -u origin main
```

## 🔐 Étape 3 : Authentification

Si vous n'êtes pas authentifié :

```bash
# Avec GitHub CLI
gh auth login

# Ou configurez votre token
git config --global credential.helper store
```

## ✅ Vérification

Une fois poussé, vérifiez que tout est bien en ligne :

```bash
git remote -v
```

Vous devriez voir :
```
origin  https://github.com/VOTRE_USERNAME/globalshare-nextjs.git (fetch)
origin  https://github.com/VOTRE_USERNAME/globalshare-nextjs.git (push)
```

## 📝 Prochaines étapes

Après avoir poussé sur GitHub, vous pouvez :

1. **Déployer sur Vercel** :
   - Allez sur https://vercel.com
   - Importez votre repository GitHub
   - Suivez les instructions dans `DEPLOY.md`

2. **Déployer le serveur Socket.io** :
   - Suivez les instructions dans `socket-server/README.md`
   - Déployez sur Railway ou Render (gratuit)

## 🎉 C'est tout !

Votre code est maintenant sur GitHub et prêt pour le déploiement !

