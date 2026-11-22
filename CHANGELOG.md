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

## [1.0.17] — 2026-11-22

### Modifié

- **L'icône ⟳ de la barre supérieure devient le seul point d'entrée des mises
  à jour** : le badge de version sous l'écran d'accueil est supprimé (il
  doublonnait l'icône et affichait « … » le temps que le pont réponde). Le
  clic sur l'icône ouvre l'encart et lance directement une recherche quand
  l'état est « à jour » ou après une erreur ; la version courante reste
  affichée dans l'encart.

## [1.0.16] — 2026-11-22

### Corrigé

- **Mises à jour et version invisibles sur Android (toutes versions)** : le
  pont entre l'interface web et l'application Android ne s'installait jamais.
  Il exigeait `window.Capacitor.registerPlugin`, une fonction du paquet
  `@capacitor/core` qui n'est pas exposée dans le WebView natif — le
  mécanisme correct est `window.Capacitor.Plugins.GlobalShareNative`,
  injecté automatiquement pour chaque plugin enregistré. Conséquences
  corrigées : l'abonnement aux notifications du pont accepte désormais aussi
  l'écouteur synchrone du bridge natif (et plus seulement une `Promise`),
  l'icône ⟳ et le badge de version réapparaissent sur l'accueil, et les mises
  à jour rapides de ~1,4 Mo sont proposées à nouveau. Une installation
  manuelle de cette version reste nécessaire une dernière fois ; les
  suivantes sont réservées depuis l'application.

## [1.0.15] — 2026-11-22

### Ajouté

- **Version visible sur l'accueil** : un badge `v1.0.15` sous l'écran d'accueil
  (application de bureau et APK ; masqué sur le site web) affiche la version
  courante et lance une recherche manuelle des mises à jour au clic — un point
  vert signale une version disponible. Ce badge affiche la version du bundle
  web appliqué, pas seulement celle du paquet installé.

### Modifié

- **Encart de mise à jour repensé** (mobile avant tout) : pictogramme et
  couleurs distincts par état (disponible, téléchargement, prête, à jour,
  erreur), pastille « Rapide » quand la mise à jour ne télécharge que le bundle
  web (~1 Mo), temps restant estimé et taille transférée affichés pendant le
  téléchargement, cibles tactiles plus grandes.

## [1.0.14] — 2026-11-22

### Corrigé

- **Android : vérification automatique des mises à jour** ajoutée au
  démarrage de l'APK (8 s) puis toutes les 6 h, comme sur desktop. Une version
  disponible ouvre maintenant l'encart sans que l'utilisateur ait à appuyer sur
  « Rechercher ».

## [1.0.13] — 2026-11-22

### Ajouté

- **Mises à jour rapides** : chaque release publie un `web-bundle.zip` (~1 Mo)
  avec son manifeste signé. Tant que la coquille native ne change pas, le bureau
  et l'APK ne téléchargent que ce bundle, le vérifient (SHA-256) et rechargent
  l'interface — plus aucun paquet de ~80 Mo à télécharger pour une modification
  du frontend.
- **APK différentiel** : publications d'un `.apk.blockmap` (empreintes SHA-256
  par blocs de 64 Ko) pour ne demander que les blocs manquants lors d'une mise à
  jour de la coquille native, avec repli sur le téléchargement complet.

### Corrigé

- Test de typage du faux `fetch` dans les tests du bundle web.

## [1.0.12] — 2026-11-22

### Corrigé

- **Bouton de mise à jour absent sur l'APK** : le pont Capacitor pouvait être
  injecté après l'exécution du bundle. L'installation du pont est désormais
  retentée au chargement et pendant les premières secondes, et l'interface se
  réabonne dès qu'il devient disponible.

## [1.0.11] — 2026-11-21

### Corrigé

- Release de test sans changement fonctionnel : elle permet de valider de bout
  en bout la mise à jour in-app de l'APK (détection de `v1.0.11`, téléchargement,
  vérification SHA-256, installation).

## [1.0.10] — 2026-11-21

### Corrigé

- **Mise à jour desktop sur Fedora** : le `.rpm` est signé après la génération
  des métadonnées par electron-builder, ce qui change son empreinte et bloquait
  l'installation avec « sha512 checksum mismatch ». Le workflow recalcule
  désormais le sha512 et la taille du paquet signé dans `latest-linux.yml`.
  Les métadonnées de la 1.0.9 ont aussi été corrigées sur la release.
- **APK Android** : remplacement des icônes et de l'écran de démarrage Capacitor
  par ceux de GlobalShare.
- **Connexion depuis l'APK** : Capacitor charge la page depuis `https://localhost`
  (sans port), une origine refusée par le Worker. Les origines loopback sans
  port, en HTTP comme en HTTPS, sont désormais acceptées. Correctif **côté
  Worker** (déployé avec le site).

## [1.0.9] — 2026-11-21

### Ajouté

- **Application Android** : un APK Capacitor embarque le même frontend, avec
  service avant-plan, notification permanente, wake lock CPU/Wi-Fi et reprise
  des transferts écran verrouillé.
- **Mise à jour in-app dans l'APK** depuis les releases GitHub, avec
  vérification SHA-256 et installation après consentement « sources inconnues ».
- Workflow `Build Android APK` : publie l'APK signé et son empreinte dans la
  release du tag. Voir [`docs/ANDROID.md`](./docs/ANDROID.md) pour les secrets.

## [1.0.8] — 2026-11-21

### Ajouté

- **Mise à jour in-app** dans l'application de bureau : un bouton dans la barre
  supérieure ouvre un encart qui affiche la version disponible, le
  téléchargement avec barre de progression (pourcentage, octets transférés,
  débit), puis le bouton d'installation. Les erreurs s'affichent dans l'encart
  avec un bouton **Réessayer**, et la vérification depuis **Aide → Rechercher
  des mises à jour…** ouvre l'encart.

### Corrigé

- Progression de mise à jour `null`/`NaN` : l'état est normalisé côté bureau et
  côté interface. La barre du système passe en mode indéterminé au lieu
  d'afficher 0 % ou de planter, et la version disponible ne peut plus être
  `null`.
- Le message d'erreur de la mise à jour était effacé dès que l'interface
  relisait l'état.

## [1.0.7] — 2026-11-21

### Corrigé

- **Installation du paquet rpm sur Fedora 45 et plus récent** : `rpm` applique
  désormais la vérification des signatures par défaut et refuse le paquet avec
  « le paquet … n'est pas vérifié : pas de signature ». Les `.rpm` publiés sont
  signés par la clé GlobalShare ; la clé publique
  (`desktop/resources/RPM-GPG-KEY-globalshare`) est jointe à la release et
  s'importe une fois avec `sudo rpm --import <url>`. Le paquet non signé de la
  1.0.6 ne s'installe plus avec `rpm -i` sur ces systèmes : utilisez `dnf
  install` ou cette version.

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

[Non publié]: https://github.com/stxtxm/global-share/compare/v1.0.17...HEAD
[1.0.17]: https://github.com/stxtxm/global-share/compare/v1.0.16...v1.0.17
[1.0.16]: https://github.com/stxtxm/global-share/compare/v1.0.15...v1.0.16
[1.0.15]: https://github.com/stxtxm/global-share/compare/v1.0.14...v1.0.15
[1.0.14]: https://github.com/stxtxm/global-share/compare/v1.0.13...v1.0.14
[1.0.13]: https://github.com/stxtxm/global-share/compare/v1.0.12...v1.0.13
[1.0.12]: https://github.com/stxtxm/global-share/compare/v1.0.11...v1.0.12
[1.0.11]: https://github.com/stxtxm/global-share/compare/v1.0.10...v1.0.11
[1.0.10]: https://github.com/stxtxm/global-share/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/stxtxm/global-share/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/stxtxm/global-share/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/stxtxm/global-share/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/stxtxm/global-share/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/stxtxm/global-share/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/stxtxm/global-share/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/stxtxm/global-share/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/stxtxm/global-share/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/stxtxm/global-share/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/stxtxm/global-share/releases/tag/v1.0.0
