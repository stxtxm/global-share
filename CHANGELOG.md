# GlobalShare Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.53] - 2026-11-25

### Added
- **Onglet « Sur l’ordinateur ».** La page Téléchargements du bureau propose deux listes : **Reçus** (l’historique) et **Sur l’ordinateur**, qui affiche le contenu réel du dossier de réception (`~/Téléchargements/GlobalShare` par défaut, ou le dossier choisi). La liste est relue à chaque ouverture et au retour sur la fenêtre, avec **Ouvrir**, **Afficher dans le dossier** et **Ouvrir le dossier**.

### Changed
- **GNOME : l’extension AppIndicator est activée automatiquement** au premier lancement quand elle est installée mais désactivée, pour que l’icône du tray apparaisse sans commande manuelle.
- `nativeVersion` desktop passe à **8** : le preload expose la lecture du dossier de réception, un bundle web seul ne suffit pas.

## [1.0.52] - 2026-11-24

### Added
- **Dossier de réception modifiable.** Réglages → **Fichiers → Dossier de réception** : le bouton **Modifier** ouvre le sélecteur du système (Android : arborescence SAF avec autorisation persistée ; desktop : dialogue Electron). Les fichiers reçus sont écrits dans le dossier choisi et restent ouvrables depuis l’historique, même après un changement de dossier. **Par défaut** rétablit `Téléchargements/GlobalShare`.
- Sur le web, ce réglage est masqué : le navigateur impose son propre dossier de téléchargement.

### Changed
- Le paquet desktop est mis à jour en même temps : son preload expose le sélecteur de dossier natif.
- `nativeVersion` passe à **11** : l’APK embarque le sélecteur SAF et l’écriture dans l’arborescence choisie, un bundle web ne suffit pas.
## [1.0.51] - 2026-11-24

### Added
- **Notes de version avant de mettre à jour.** L’encart de mise à jour affiche un panneau « Nouveautés » défilant, séparé des boutons : sections du CHANGELOG (Nouveautés, Corrections, Améliorations) de la version proposée, pour savoir ce qu’on installe avant de télécharger. Les notes suivent tous les canaux : bundle web (`web-bundle.json`), paquet complet Electron (flux GitHub) et APK Android (corps de la release).
- Le corps de la release GitHub reprend désormais la section du CHANGELOG (via `scripts/release-notes.mjs`) au lieu des notes générées automatiquement.

### Fixed
- **Le bouton de partage du salon est correctement centré sur Pixel 9a.** Son contenu (code + icône) est centré dans la pastille et reste sur une seule ligne : un code de salon personnalisé long est tronqué avec une ellipse au lieu de passer sur deux lignes qui remplissaient la pastille de 42 px.
- `nativeVersion` passe à **10** : l’APK embarque la lecture des notes de version (`UpdateManager`), un bundle web ne suffit pas.
## [1.0.50] - 2026-11-24

### Added
- **File d'attente multi-fichiers.** La sélection de plusieurs fichiers (et le glisser-déposer sur desktop) alimente une file : **2 envois simultanés**, les suivants attendent en file et démarrent tout seuls dès qu'un créneau se libère (fin, annulation, pause, interruption). Actions sur la file : passer un fichier en premier, trier « petits d'abord », vider la file, tout mettre en pause / tout reprendre. Encart de progression globale pondéré par octets, avec débit cumulé, ETA et volume restant + file.
- **Suivi enrichi.** Cartes de transfert dépliables : courbe de débit, débit/reçu/restant/ETA, actions individuelles. Mini-barre du bas mise à niveau avec les mêmes informations.

### Changed
- Animations de transfert refondues : barres à dégradé fluide animé et balayage lumineux, halo de flux sur la carte en cours, bordure « fourmis en marche » pour la file, tremblement à l'interruption, pastille de succès. Tout est désactivé sous `prefers-reduced-motion`.
- La reprise d'un transfert interrompu respecte les créneaux d'envoi au lieu de doubler la concurrence.

## [1.0.49] - 2026-11-23

### Added
- **APK : l'app rejoint toute seule le dernier salon après un balayage.** Le code du salon n'était mémorisé que dans `sessionStorage`, que la destruction du WebView efface : l'app rouvrait sur l'accueil et la reprise IndexedDB attendait que l'utilisateur retape le salon. Une copie du salon est maintenant aussi écrite dans `localStorage` (Android seulement), ce qui relance la reprise des chunks reçus et des envois interrompus sans intervention. Elle expire au bout de **24 h** : rouvert plusieurs jours après un balayage, le salon serait vide. Quitter le salon efface les deux copies.

### Fixed
- **APK : la notification « GlobalShare · Connectée · reste joignable en arrière-plan » ne survit plus à la fermeture de l'app.** Le service avant-plan n'écoutait ni le retrait de la tâche (`onTaskRemoved`) ni la fermeture de l'activité (bouton Retour), et le système pouvait le relancer seul après un kill du processus ; la notification restait alors affichée indéfiniment. La fermeture arrête maintenant le service et sa notification, et le service n'est plus relancé par le système (`START_NOT_STICKY`).
- Cela vaut aussi avec un transfert en cours : tout le transfert vit dans le WebView, détruit avec la tâche, donc le service ne pouvait plus rien faire avancer et seule sa notification « Transfert en cours » restait. Le transfert reprend à la réouverture depuis les chunks conservés dans IndexedDB. Un drapeau interne « détachée » empêche un appel JS encore en vol de rallumer la notification ; il n'est levé qu'à la recréation de l'activité.
- Robustesse du service : un refus de `startForeground`/`startForegroundService` (Android 12+, arrière-plan) ou un wake lock déjà relâché ne peut plus faire planter l'app.
- `nativeVersion` passe à **9** : la correction est native, un bundle web ne la contient pas, l'APK complet doit être installé.

## [1.0.47] - 2026-11-23

### Added
- **Tray Linux/GNOME** : détection du watcher StatusNotifierItem, repli minimiser dans la barre des tâches + notification cliquable sur GNOME sans AppIndicator, menu d'aide, icône tray 32 px dédiée, et recommandations AppIndicator dans les paquets.
- **CI** : workflow `ci-workflows` et couverture des chemins de test/tray.

### Changed
- **CI/CD** : `worker`, `test` et `build` démarrent en parallèle ; `deploy` attend les trois. Lint et typecheck rejoignent les tests, caches npm/Next/Gradle/Electron réutilisés, et `paths-ignore` pour les pushes documentaires. Workflows release/android/deploy refactorés.
- Documentation README/DEPLOYMENT/DESKTOP/ANDROID mise à jour.

### Fixed
- **Mise à jour Linux/Fedora** : installation RPM via `pkexec` + `dnf --nogpgcheck` en priorité, repli `pkcon --allow-untrusted install-local -y` uniquement si `pkexec` est structurellement indisponible, message distinct pour `need-untrusted` PackageKit, timeout 5 min.

## [1.0.46] - 2026-11-23

### Fixed
- **Mise à jour Linux/Fedora** : correction du chemin PackageKit/pkexec sur Fedora/GNOME (RPM local classé `need-untrusted`), avec repli actionnable et documentation.

## [1.0.45] - 2026-11-23

### Fixed
- Compatibilité desktop de la synchronisation des fichiers : hors APK, les
  helpers mobiles (`mobileListDownloads`) ne renvoient plus d'erreur « fonction
  indisponible » et la synchronisation n'est effectuée que sur Android.

## [1.0.44] - 2026-11-23

### Fixed
- **Incoherence bidirectionnelle « Fichiers reçus » / « Sur cet appareil »** :
  - Après effacement du fichier depuis Fichiers (sur le téléphone ou Fichiers
    de votre APK), la liste reçue est rafraîchie via `refreshMobileFiles()`.
  - « Sur cet appareil » vide (aucune entrée de MediaStore) ⇒ les entrées reçues
    non-validées sont retirées de la liste Fichiers reçus à l'ouverture de
    l'onglet et à la réactivation.

### Added
- **« Effacer tout » (Sur cet appareil)** : supprime en masse les fichiers
  sur MediaStore/Fichiers, avec confirmation.

## [1.0.43] - 2026-11-23

### Fixed
- **Erreur absolue « Fichiers » sur Pixel 9a** : ACTION_OPEN_DOCUMENT_TREE
  sur la racine `primary:Download/GlobalShare` via DocumentsUI (nécessite
  Android 11+), repli lancement Google Files, puis replis `ACTION_OPEN_DOCUMENT`
  et createChooser. Plus de SecurityException « UID 10415 ».

## [1.0.42] - 2026-11-23

### Fixed
- **Incohérence « Fichiers reçus » / « Sur cet appareil »** : après suppression
  d'un fichier dans la liste reçue, la liste « Sur cet appareil » est relue
  (`mobileListDownloads()`), ainsi que dans « Fichiers reçus » après suppression
  ou « Tout effacer ». L'autre direction (suppression par Fichiers) est aussi
  reflétée.

### Added
- **UX améliorée de la liste « Sur cet appareil »** : bouton « Effacer tout »
  (confirmé), lignes plus lisibles avec icônes, herse informatique, libellés
  traduits (`clearAllShared`), liste actualisée à l'ouverture de l'onglet et
  à chaque activation de la fenêtre.

## [1.0.41] - 2026-11-23

### Added
- **Transferts LAN deux fois plus rapides** : blocs P2P-direct 512 Ko (fusion
  du correctif combiné), fenêtre LAN optimisée (8 Mo en vol), burst de 12.
- **Vitesse réceptrice affichée** : `t.speed` est maintenant renseigné sur le
  receveur (affichage de la vitesse côté téléchargement) et remis à zéro à
  l'arrêt.

### Fixed
- **Auto-update consolidé** (Fedora/Nobara) : utilisation préférée de
  `pkcon` (PackageKit, D-Bus), messages polkit traduits (`pkexec must be setuid
  root`, `No authentication agent`, `No session for cookie`, `Not
  authorized`), replis **Ouvrir le paquet** / **Copier dans Fichiers**, timeout
  à 5 min.
- **Various bugs** : notifications cliquables pendant un transfert,
  restoration fenêtre (shortcut Ctrl+Alt+G + tray durable), Fichiers Android
  sans erreur, animations barre de progression, transitions menus.

## [1.0.40] - 2026-11-23

### Fixed
- **Suppression réelle des fichiers reçus sur Android** : le bouton
  **Retirer** appelait `deleteDownload` alors que le plugin natif ne
  l'exposait pas. Le fichier restait donc dans `Téléchargements/GlobalShare`
  et l'historique disparaissait quand même. La méthode supprime maintenant
  l'entrée MediaStore (Android 10+) ou le fichier public (Android 9 et
  antérieur), avec repli par nom pour les anciennes entrées ; une suppression
  déjà effectuée est traitée comme un succès. `nativeVersion` passe à 6 pour
  que les APK installées téléchargent l'APK complet au lieu du seul bundle web.

## [Unreleased]

### Added
- Comprehensive settings management system with 15+ configurable options
- New `app/lib/settings.ts` module with full TypeScript support
- New `app/components/Settings.tsx` modal component with 5 organized sections
- Settings persistence via localStorage
- Theme management (System/Light/Dark) with immediate application
- Accent color customization (6 color options)
- Display settings for file icons, sizes, dates, progress bars, and connection status
- Notification settings (enabled, sound, duration)
- Behavior settings (auto-refresh, confirmations)
- Advanced settings (compression, retries, debug mode)
- Complete documentation in `SETTINGS_DOCUMENTATION.md` and `TESTING_GUIDE.md`

### Changed
- Added settings button (⚙️) to **bottom navigation bar on mobile** (welcome screen and room action bar)
- Settings button remains in topbar on desktop/tablet for better accessibility
- Updated import statements in `GlobalShare.tsx` to include settings module
- Enhanced `GlobalShare.css` with styles for settings modal, controls, and mobile responsiveness
- Simplified and clarified UI text throughout the application:
  - "Partagez un fichier, pas un compte" → "Partage instantané"
  - "Passez le même code aux deux appareils. Direct, sans inscription." → "Un code, et c'est parti"
  - "Créer le salon {code}" → "Salon {code}"
  - "Un seul chiffre à retenir, libre à l'instant" → "Libre maintenant"
  - "Rejoindre avec un code" → "Rejoindre un salon"
  - "Tapez le code partagé..." → "Saisissez le code partagé"
  - "Téléchargements" tab → "Fichiers"
  - "Salon" tab → "Appareils"
  - "Appareils" → "Appareils connectés"
  - "En attente d'un autre appareil" → "En attente d'appareils"
  - Various other text simplifications for clarity and conciseness

### Fixed
- Minor code organization and formatting improvements

---

## [1.0.13] - Previous Version

[Content from previous changelog entries]

---

## [1.0.0] - Initial Release

Initial release of GlobalShare.

---

## 📦 Release Checklist

- [ ] Update version numbers in `package.json` and other files
- [ ] Update CHANGELOG.md with release notes
- [ ] Run all tests and verify they pass
- [ ] Build all platforms (Web, Desktop, Mobile)
- [ ] Test on all supported platforms
- [ ] Update documentation
- [ ] Create Git tag and release
- [ ] Publish to app stores (if applicable)
- [ ] Deploy web version
- [ ] Announce release

---

## 🏷️ Versioning Strategy

GlobalShare follows Semantic Versioning (SemVer) principles:

- **MAJOR** version when you make incompatible API changes
- **MINOR** version when you add functionality in a backward-compatible manner
- **PATCH** version when you make backward-compatible bug fixes

### Version Number Format

`MAJOR.MINOR.PATCH` (e.g., `1.0.14`)

### Build Metadata

For pre-release versions, we may use:
- `MAJOR.MINOR.PATCH-alpha.X` - Alpha releases
- `MAJOR.MINOR.PATCH-beta.X` - Beta releases
- `MAJOR.MINOR.PATCH-rc.X` - Release candidates

---

## 📅 Release History

| Version | Date | Description |
|---------|------|-------------|
| 1.0.14 | Current | Settings module, UI improvements |
| 1.0.13 | Previous | [Previous release] |
| ... | ... | ... |
| 1.0.0 | Initial | Initial release |

---

## 🔖 Git Tags

All releases are tagged in Git with the format `vX.X.X`:

```bash
# Create annotated tag
git tag -a v1.0.14 -m "Release v1.0.14: Settings module and UI improvements"

# Push tag to remote
git push origin v1.0.14

# Create and push tag in one command
git tag -a v1.0.14 -m "Release v1.0.14" && git push origin v1.0.14
```

---

## 🚀 Deployment Commands

### Web Deployment

```bash
# Build for production
npm run build

# Start production server
npm start

# Deploy to Vercel/Netlify/etc.
# (depends on your hosting provider)
```

### Desktop (Electron) Deployment

```bash
# Build desktop app
npm run build:desktop

# Package for specific platforms
npm run package:win  # Windows
npm run package:mac  # macOS
npm run package:linux  # Linux

# Or build all platforms
npm run package:all
```

### Mobile (Capacitor) Deployment

```bash
# Build web assets
npm run build

# Sync with Capacitor
npx cap sync

# Open in Android Studio
npx cap open android

# Open in Xcode
npx cap open ios

# Build APK (Android)
npx cap copy android && cd android && ./gradlew assembleRelease

# Build IPA (iOS)
npx cap copy ios && cd ios && fastlane ios build
```

---

**Note**: This changelog is maintained manually. For a complete history, see the Git commit log.
