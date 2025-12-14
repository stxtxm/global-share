#!/bin/sh

echo "🔧 Poussage des corrections du build..."
echo ""

cd /home/timo/.gemini/antigravity/scratch/global-share

# Ajouter les changements
echo "📦 Ajout des fichiers modifiés..."
git add app/components/GlobalShare.tsx PUSH_FIX.md

# Créer le commit
echo "💾 Création du commit..."
git commit -m "fix: Resolve navigator is not defined error for SSR

- Add typeof checks for navigator in detectDevice()
- Use lazy initialization for useState
- Protect all navigator usages with client-side checks
- Fix TypeScript annotations"

# Pousser
echo "📤 Push vers GitHub..."
git push origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Push réussi !"
    echo "🔄 Le workflow GitHub Actions va se déclencher automatiquement"
    echo "📊 Suivez le déploiement : https://github.com/stxtxm/global-share/actions"
    echo "🌐 Votre site sera disponible sur : https://stxtxm.github.io/global-share"
else
    echo ""
    echo "❌ Erreur lors du push"
    exit 1
fi

