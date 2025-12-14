# 🚀 Activer GitHub Pages pour votre build Next.js

Si vous ne voyez que le README sur GitHub Pages, voici comment activer le build Next.js :

## ✅ Étape 1 : Vérifier que le workflow est présent

Le fichier `.github/workflows/deploy.yml` doit être dans votre repository.

Vérifiez sur : https://github.com/stxtxm/global-share/tree/main/.github/workflows

## ✅ Étape 2 : Activer GitHub Pages avec GitHub Actions

1. **Allez sur les paramètres du repository** :
   - https://github.com/stxtxm/global-share/settings/pages

2. **Sous "Source"** :
   - Sélectionnez **"GitHub Actions"** (pas "Deploy from a branch")
   - Cliquez sur **"Save"**

3. **Vérifiez les permissions** :
   - Allez sur https://github.com/stxtxm/global-share/settings/actions
   - Sous "Workflow permissions", sélectionnez **"Read and write permissions"**
   - Cochez **"Allow GitHub Actions to create and approve pull requests"**
   - Cliquez sur **"Save"**

## ✅ Étape 3 : Déclencher le workflow

### Option A : Déclencher manuellement

1. Allez sur : https://github.com/stxtxm/global-share/actions
2. Cliquez sur **"Deploy to GitHub Pages"** dans la liste des workflows
3. Cliquez sur **"Run workflow"** (bouton en haut à droite)
4. Sélectionnez la branche **"main"**
5. Cliquez sur **"Run workflow"**

### Option B : Faire un nouveau commit

Faites un petit changement et poussez :

```bash
# Faire un petit changement (ex: ajouter un commentaire dans README)
git commit --allow-empty -m "chore: Trigger GitHub Pages deployment"
git push origin main
```

## ✅ Étape 4 : Vérifier le déploiement

1. **Vérifiez les Actions** :
   - https://github.com/stxtxm/global-share/actions
   - Vous devriez voir "Deploy to GitHub Pages" en cours d'exécution
   - Cliquez dessus pour voir les logs

2. **Attendez la fin du build** :
   - Le workflow prend environ 2-3 minutes
   - Vous verrez "✅ Deploy to GitHub Pages" quand c'est terminé

3. **Vérifiez votre site** :
   - https://stxtxm.github.io/global-share
   - Vous devriez voir votre application Next.js, pas juste le README

## 🐛 Dépannage

### Le workflow ne se déclenche pas

- Vérifiez que le fichier `.github/workflows/deploy.yml` est bien dans le repository
- Vérifiez que vous êtes sur la branche `main`
- Vérifiez les permissions dans Settings > Actions

### Le workflow échoue

- Cliquez sur le workflow qui a échoué
- Regardez les logs pour voir l'erreur
- Erreurs communes :
  - **"npm ci" échoue** : Vérifiez que `package-lock.json` est présent
  - **"Build fails"** : Vérifiez les erreurs TypeScript/ESLint
  - **"Upload artifact fails"** : Vérifiez que le dossier `out/` existe après le build

### Le site affiche toujours le README

- Vérifiez que GitHub Pages est configuré avec **"GitHub Actions"** (pas "Deploy from a branch")
- Attendez quelques minutes (le déploiement peut prendre du temps)
- Videz le cache de votre navigateur (Ctrl+Shift+R)

## 📝 Vérification rapide

✅ Fichier workflow présent : `.github/workflows/deploy.yml`  
✅ GitHub Pages activé avec "GitHub Actions"  
✅ Permissions Actions activées  
✅ Workflow déclenché et réussi  
✅ Site accessible : https://stxtxm.github.io/global-share

## 🎉 Une fois que ça marche

Votre site sera automatiquement mis à jour à chaque push sur `main` !

