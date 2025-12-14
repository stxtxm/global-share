#!/bin/bash

# Script pour déployer GlobalShare Next.js sur GitHub

echo "🚀 Déploiement de GlobalShare sur GitHub"
echo ""

# Vérifier si gh CLI est installé
if command -v gh &> /dev/null; then
    echo "✅ GitHub CLI détecté"
    
    # Demander le nom du repository
    read -p "Nom du repository GitHub (ex: globalshare-nextjs): " REPO_NAME
    
    if [ -z "$REPO_NAME" ]; then
        echo "❌ Le nom du repository est requis"
        exit 1
    fi
    
    # Créer le repository sur GitHub
    echo "📦 Création du repository sur GitHub..."
    gh repo create "$REPO_NAME" --public --source=. --remote=origin --push
    
    if [ $? -eq 0 ]; then
        echo ""
        echo "✅ Repository créé et code poussé avec succès !"
        echo "🌐 URL: https://github.com/$(gh api user --jq .login)/$REPO_NAME"
    else
        echo "❌ Erreur lors de la création du repository"
        exit 1
    fi
else
    echo "⚠️  GitHub CLI (gh) n'est pas installé"
    echo ""
    echo "Option 1: Installer GitHub CLI"
    echo "  sudo apt install gh  # Ubuntu/Debian"
    echo "  brew install gh      # macOS"
    echo ""
    echo "Option 2: Créer le repository manuellement"
    echo "  1. Allez sur https://github.com/new"
    echo "  2. Créez un nouveau repository (ex: globalshare-nextjs)"
    echo "  3. Exécutez les commandes suivantes :"
    echo ""
    echo "     git remote add origin https://github.com/VOTRE_USERNAME/globalshare-nextjs.git"
    echo "     git branch -M main"
    echo "     git push -u origin main"
    echo ""
    
    # Proposer de créer le remote manuellement
    read -p "Voulez-vous ajouter le remote maintenant ? (y/n): " ADD_REMOTE
    
    if [ "$ADD_REMOTE" = "y" ] || [ "$ADD_REMOTE" = "Y" ]; then
        read -p "URL du repository GitHub (ex: https://github.com/user/repo.git): " REPO_URL
        
        if [ -n "$REPO_URL" ]; then
            git remote add origin "$REPO_URL"
            git branch -M main
            echo ""
            echo "✅ Remote ajouté !"
            echo "📤 Pour pousser le code, exécutez :"
            echo "   git push -u origin main"
        fi
    fi
fi

