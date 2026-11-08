# Notes de version

Toutes les versions notables de GlobalShare, la plus récente en premier. Le
format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et les
numéros suivent [SemVer](https://semver.org/lang/fr/).

## Convention

1. Toute modification visible pour l'utilisateur s'ajoute sous
   **`## [Non publié]`**, dans la catégorie qui convient (`Ajouté`, `Modifié`,
   `Corrigé`, `Retiré`, `Sécurité`). Une entrée décrit le comportement, pas le
   nom du fichier modifié.
2. Pour publier : renommer la section en `## [x.y.z] — AAAA-MM-JJ`, reporter le
   lien de comparaison en bas du fichier, puis pousser le tag `vx.y.z`. Le
   workflow [`.github/workflows/release.yml`](./.github/workflows/release.yml)
   aligne les `package.json` sur le tag, construit les paquets et publie la
   release.
3. Les notes de la release GitHub sont générées automatiquement à partir des
   commits (`--generate-notes`) ; recopier la section correspondante quand un
   récapitulatif rédigé est préférable pour les utilisateurs.
4. Une correction livrée **uniquement côté Worker** est active dès le
   déploiement, sans réinstallation : l'entrée doit le préciser, sinon on croit
   à tort qu'une nouvelle version de l'application est nécessaire.

## [Non publié]

## [1.0.6] — 2026-11-08

### Corrigé

- Quitter le salon pendant un transfert laissait la ligne bloquée sur
  « En cours » : les transferts du pair qui part sont désormais annulés, la
  ligne disparaît et un message explique la cause
  (« Transfert annulé : … (L'appareil s'est déconnecté) »).

## [1.0.5] — 2026-11-08

### Ajouté

- **Onglet « Téléchargements »** : les fichiers reçus restent accessibles après
  le transfert, avec nom, taille, appareil expéditeur, date et état d'intégrité.
  - Bureau : enregistrement dans `~/Téléchargements/GlobalShare/` (nom
    dédupliqué), boutons **Ouvrir** (application associée du système) et
    **Dossier**.
  - Web et mobile : fichier conservé dans l'application (IndexedDB, 40 fichiers
    ou 128 Mo, le plus ancien sort en premier) et ouvert dans un onglet pour les
    images, PDF, vidéos, sons et textes ; les autres formats sont téléchargés.
  - Actions **Retirer** et **Tout supprimer**.
- Un fichier dont l'empreinte SHA-256 diffère apparaît avec la pastille
  « fichier corrompu » : il reste listé pour savoir quoi renvoyer, mais n'est
  jamais écrit sur le disque ni ouvert.

### Corrigé

- **Salon inaccessible depuis l'application de bureau** (« échec de connexion »)
  alors que le site fonctionnait : le Worker refusait l'origine
  `http://127.0.0.1:<port>` de la page locale (`403 Origin not allowed`). Toute
  origine de boucle locale est acceptée, quel que soit le port ; le site
  GitHub Pages et les origines distantes sont inchangés. Correctif **côté
  Worker**.

### Interne

- `npm run test:origin` (origines acceptées et refusées) et tests unitaires de
  l'historique des téléchargements.
- Documentation de l'onglet et du pont Electron (`docs/DESKTOP.md`), diagnostic
  `Origin not allowed` (`docs/DEPLOYMENT.md`).

## [1.0.4] — 2026-11-08

### Corrigé

- Mise à jour in-app des paquets rpm et deb : chaque argument de `pkexec` est
  transmis séparément, l'installation échouait quand la commande partait en un
  seul argument.

## [1.0.3] — 2026-11-08

Aucun changement de code : même commit que la 1.0.2, publiée avec des numéros de
version à jour.

## [1.0.2] — 2026-11-08

### Corrigé

- Installation des mises à jour rpm et deb sans blocage sur l'invite polkit.
- `package.json` racine restauré après avoir été écrasé par une extraction
  `asar`, qui cassait les scripts de build.

## [1.0.1] — 2026-11-08

### Corrigé

- Toutes les tailles d'icônes hicolor sont installées : les lanceurs affichent
  l'icône de l'application au lieu d'un carré générique.

## [1.0.0] — 2026-11-08

### Ajouté

- Applications de bureau Electron (rpm, deb, AppImage, installateur Windows) à
  partir du même frontend, avec mise à jour in-app depuis les releases GitHub
  (`electron-updater`) et vérification manuelle via **Aide → Rechercher des
  mises à jour…**.

## Avant la 1.0.0

Résumé de l'application web, publiée sans numéro de version : P2P WebRTC avec
repli par relais, salons partageables par lien `?room=CODE`, envoi de fichiers,
de photos et de dossiers (zip côté client), pause et reprise des transferts,
signalisation et relais sur Cloudflare Worker, identifiants TURN éphémères,
PWA installable et interface mobile avec wake lock.

[Non publié]: https://github.com/stxtxm/global-share/compare/v1.0.6...HEAD
[1.0.6]: https://github.com/stxtxm/global-share/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/stxtxm/global-share/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/stxtxm/global-share/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/stxtxm/global-share/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/stxtxm/global-share/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/stxtxm/global-share/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/stxtxm/global-share/releases/tag/v1.0.0
