# Thèmes, couleurs et design

GlobalShare utilise un seul design system pour le web, Electron et Android.
Les réglages sont stockés dans `localStorage` par `app/lib/settings.ts` et
appliqués **immédiatement**, sans rechargement.

## Les trois réglages d'apparence

| Réglage | Valeurs | Effet |
| --- | --- | --- |
| `theme` | `system` (Auto), `light` (Clair), `dark` (Sombre) | Classe `gs-theme--light` / `gs-theme--dark` sur `<html>` et couleurs natives du WebView |
| `accentColor` | 10 pastilles (violet, rose, bleu, cyan, vert, ambre, rouge, indigo, citron, orange) | `--gs-accent` / `--gs-accent-deep` / `--gs-on-accent` |
| `language` | `fr`, `en`, `es`, `de`, `it` | `lang` du document et libellés du panneau de réglages |

Le mode **Auto** réécoute `prefers-color-scheme` : basculer le thème du système
pendant que l'application est ouverte met à jour l'interface et la barre de
navigation Android en direct.

## Pourquoi la barre du bas restait noire sur Android

Le `viewport` Next.js (`app/layout.tsx`) déclare `theme-color: #0a0b10` et
`colorScheme: "dark"` au moment du build. Ces valeurs sont figées dans le HTML :
le WebView Android/Capacitor s'en sert pour colorer la barre de statut **et la
barre de navigation**, même quand l'utilisateur choisit le mode clair.

`applyTheme()` appelle désormais `syncSystemTheme()` qui :

1. pose `data-theme="light"|"dark"` et `style.colorScheme` sur `<html>` ;
2. met à jour le contenu de `<meta name="theme-color">` (`#eef0f7` en clair,
   `#0a0b10` en sombre) et de `<meta name="color-scheme">`.

En complément, toutes les surfaces qui étaient codées en dur (`rgba(10, 11, 16, …)`
pour la barre d'action, la mini-barre de transfert, la navigation basse et le
haut de page) utilisent maintenant la variable `--gs-bg-rgb`. Le thème clair
la redéfinit à `238, 240, 247` : le bas de l'écran suit donc réellement le thème
choisi, y compris dans l'APK.

## Variables à utiliser (ne jamais coder une couleur en dur)

Définies dans `:root` (`app/components/GlobalShare.css`), redéfinies dans
`html.gs-theme--light` :

| Variable | Rôle |
| --- | --- |
| `--gs-bg`, `--gs-bg-soft` | Fond général et surfaces secondaires |
| `--gs-bg-rgb` | Triplet RVB du fond, pour les dégradés translucides des barres |
| `--gs-surface`, `--gs-surface-strong` | Cartes, champs, pistes de progression, badges |
| `--gs-border`, `--gs-border-strong` | Bordures et séparateurs |
| `--gs-text`, `--gs-dim`, `--gs-placeholder` | Texte principal, secondaire, champs vides |
| `--gs-accent`, `--gs-accent-2`, `--gs-on-accent` | Couleurs d'accent et texte posé dessus |
| `--gs-success`, `--gs-danger`, `--gs-warning` | États des transferts et intégrité |
| `--gs-sheet-bg`, `--gs-overlay-bg` | Feuille modale et voile (connexion perdue) |
| `--gs-shadow`, `--gs-card-shadow` | Ombres portées, adaptées à chaque thème |
| `--gs-toast-*`, `--gs-hero-*` | Variantes de notifications et titre d'accueil |

Pour ajouter une couleur d'accent : une entrée dans `ACCENT_SWATCHES`
(`app/lib/settings-i18n.ts`) et sa clé `swatch…` dans les cinq dictionnaires.

## Réglages d'affichage appliqués

Les options du panneau ne sont pas décoratives :

- **Icônes / taille / date des fichiers** contrôlent chaque ligne de la liste des
  téléchargements et la taille dans les transferts.
- **Barre de progression** masque les barres de la liste et de la mini-barre de
  suivi (le pourcentage reste affiché).
- **Statut de connexion** masque le badge « Connecté / Connexion / Hors ligne »
  du salon.
- **Salons affichés** limite la liste « Vos salons » (`itemsPerPage`).
- **Rafraîchissement auto** relit l'historique et l'heure écoulée à l'intervalle
  choisi.
- **Notifications / Son / Durée** pilotent les toasts et le petit signal WebAudio.
- **Compression / Tentatives** pilotent `JSZip` et `TransferManager.maxRetries`.
- **Confirmer la suppression / l'écrasement** ajoutent les dialogues correspondants.
- **Mode débogage** journalise les fichiers reçus dans la console.

## Tests

`npm run test:unit` couvre `resolveTheme`, `applyTheme`, `syncSystemTheme`,
`applyAppearance` (avec un DOM factice) ainsi que les traductions et le repli
sur le français. Le build CI (`deploy.yml`) vérifie aussi le typecheck et le
lint sur les deux thèmes.
