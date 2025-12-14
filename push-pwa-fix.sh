#!/bin/sh

echo "🔧 Correction du manifest.json pour PWA..."
echo ""

cd /home/timo/.gemini/antigravity/scratch/global-share

# Ajouter les changements
echo "📦 Ajout des fichiers modifiés..."
git add app/layout.tsx public/manifest.json push-pwa-fix.sh

# Créer le commit
echo "💾 Création du commit..."
git commit -m "fix: Correct manifest.json paths for GitHub Pages basePath

- Update manifest path in layout.tsx to use basePath
- Fix start_url and scope in manifest.json
- Fix icon paths to include /global-share/ prefix
- Add async to ionicons script"

# Pousser
echo "📤 Push vers GitHub..."
git push origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Push réussi !"
    echo "🔄 Le workflow GitHub Actions va se déclencher automatiquement"
    echo "📊 Suivez le déploiement : https://github.com/stxtxm/global-share/actions"
    echo "🌐 Votre PWA sera disponible sur : https://stxtxm.github.io/global-share"
    echo ""
    echo "⏳ Attendez 2-3 minutes pour que le build se termine"
    echo ""
    echo "✅ Après le déploiement, la PWA devrait fonctionner correctement !"
else
    echo ""
    echo "❌ Erreur lors du push"
    exit 1
fi

