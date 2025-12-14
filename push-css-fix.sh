#!/bin/sh

echo "🔧 Correction du basePath pour GitHub Pages..."
echo ""

cd /home/timo/.gemini/antigravity/scratch/global-share

# Ajouter les changements
echo "📦 Ajout des fichiers modifiés..."
git add next.config.ts push-css-fix.sh

# Créer le commit
echo "💾 Création du commit..."
git commit -m "fix: Configure basePath for GitHub Pages assets

- Add basePath and assetPrefix for /global-share path
- Fix CSS and JS assets loading on GitHub Pages"

# Pousser
echo "📤 Push vers GitHub..."
git push origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Push réussi !"
    echo "🔄 Le workflow GitHub Actions va se déclencher automatiquement"
    echo "📊 Suivez le déploiement : https://github.com/stxtxm/global-share/actions"
    echo "🌐 Votre site sera disponible sur : https://stxtxm.github.io/global-share"
    echo ""
    echo "⏳ Attendez 2-3 minutes pour que le build se termine"
else
    echo ""
    echo "❌ Erreur lors du push"
    exit 1
fi

