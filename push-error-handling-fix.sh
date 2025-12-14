#!/bin/sh

echo "🔧 Amélioration de la gestion des erreurs de transfert..."
echo ""

cd /home/timo/.gemini/antigravity/scratch/global-share

# Ajouter les changements
echo "📦 Ajout des fichiers modifiés..."
git add app/components/GlobalShare.tsx push-error-handling-fix.sh

# Créer le commit
echo "💾 Création du commit..."
git commit -m "feat: Improve error handling for disconnections during file transfer

- Add cancelTransfer function with proper cleanup
- Detect and cancel transfers when peer disconnects
- Detect and cancel transfers when socket disconnects
- Add timeout protection (10 minutes) for transfers
- Add connection checks before sending chunks
- Improve error messages with notifications
- Clean up buffers and timeouts on cancellation
- Handle P2P errors gracefully with fallback to relay"

# Pousser
echo "📤 Push vers GitHub..."
git push origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Push réussi !"
    echo "🔄 Le workflow GitHub Actions va se déclencher automatiquement"
    echo "📊 Suivez le déploiement : https://github.com/stxtxm/global-share/actions"
    echo "🌐 Votre app améliorée sera disponible sur : https://stxtxm.github.io/global-share"
    echo ""
    echo "✨ Améliorations apportées :"
    echo "  - Détection des déconnexions pendant les transferts"
    echo "  - Annulation propre des transferts en cours"
    echo "  - Timeout de sécurité (10 minutes)"
    echo "  - Vérifications de connexion avant chaque envoi"
    echo "  - Messages d'erreur clairs avec notifications"
    echo "  - Nettoyage automatique des buffers"
else
    echo ""
    echo "❌ Erreur lors du push"
    exit 1
fi

