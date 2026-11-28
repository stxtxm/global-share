# Application Android (APK)

L'APK embarque le même export statique Next.js que le bureau et le web. La
couche native est un projet [Capacitor](https://capacitorjs.com/) en Java :
`android/` contient le WebView, un plugin et un service système. Le frontend ne
dépend pas de Capacitor : le pont est injecté dans la page sous
`window.globalshareMobile`, exactement comme `window.globalshareDesktop` sous
Electron, et l'encart de mise à jour (`app/components/UpdateManager.tsx`) est
commun aux deux.

## Transfert écran verrouillé

Quatre mécanismes se complètent :

1. **Wake lock d'écran** (`app/lib/wake-lock.ts`) : empêche l'extinction
   automatique pendant un transfert quand l'écran est allumé. Le navigateur le
   relâque dès que la page passe en arrière-plan : il est redemandé au retour
   au premier plan, mais ce n'est **pas** lui qui maintient le CPU en veille.
2. **Service avant-plan** (`TransferForegroundService.java`) : notification
   permanente, `PARTIAL_WAKE_LOCK` (CPU éveillé, sans timeout) et verrou Wi-Fi
   basse latence. Il vit **pendant tout le salon**, pas seulement pendant les
   transferts : `mobileKeepAlive(true)` est envoyé à l'entrée dans le salon et
   réaffirmé sur `connect`, `disconnect`, au retour au premier plan et à chaque
   tick. Un transfert terminé appelle `mobileFinishTransfer()` ( compteur à 0 )
   et **non** `mobileStopTransfer()` : le service s'arrête au bouton de sortie du
   salon, ou dès que le dernier transfert se termine.
   Fermer l'app (retrait des applications récentes via `onTaskRemoved`, bouton
   Retour via `MainActivity.onDestroy` quand `isFinishing()`) appelle
   `TransferForegroundService.detach()` : le service **et sa notification**
   s'arrêtent, transfert en cours ou non. C'est le comportement juste, car tout
   le transfert vit dans le WebView, détruit avec la tâche : le service ne
   pouvait plus rien faire avancer et il ne restait que sa notification. Un
   drapeau interne « détachée » empêche un appel JS encore en vol (tick,
   progression) de rallumer la notification ; il n'est levé qu'à la recréation
   de l'activité (`attach()`). Le service n'est jamais relancé par le système
   (`START_NOT_STICKY`) : un service sans WebView ne pouvait rien faire et
   laissait sa notification affichée indéfiniment.
3. **Tick natif → WebView** (watchdog du service : toutes les 10 s au repos,
   toutes les 2 s pendant un transfert) : c'est le point essentiel pour tenir
   « des heures en veille ». Chromium bride les timers JS d'une page masquée à
   1/s puis 1/min après 5 minutes (même avec un wake lock CPU). Le watchdog
   natif, lui, continue de tourner : il réacquiert les verrous si besoin,
   rafraîchit la notification et émet `serviceTick`. Le WebView y réagit en
   reconnectant la socket, en relançant les transferts interrompus et en
   appelant directement la boucle d'envoi — sans dépendre des `setTimeout`
   bridés. Chaque ACK relance d'ailleurs la boucle par un appel direct (et non
   plus un `setTimeout(0)`) : le débit ne s'effondre plus quand l'écran est
   éteint.
4. **Reprise IndexedDB** (`app/lib/resume-store.ts`) : si Android tue quand même
   le processus (pression mémoire, Doze), si l'app est balayée ou fermée pendant
   un transfert, les chunks déjà reçus et les envois en cours sont conservés et
   le transfert reprend à partir du dernier accusé de réception. Après un
   balayage, la réception repart seule dès le retour dans le salon
   (`_restoreReceive` recharge les chunks et annonce la position exacte à
   l'expéditeur) ; un envoi interrompu propose de réassocier le fichier
   d'origine, que l'IndexedDB ne conserve pas. Sur Android, le code du salon est
   aussi doublé dans `localStorage` (`sessionStorage` disparaît avec le WebView) :
   au redémarrage, l'app rejoint le dernier salon toute seule et la reprise
   repart sans intervention. Cette copie expire après **24 h**
   (`LAST_ROOM_TTL_MS`, `app/lib/last-room.ts`) : plus tard, le salon serait vide
   et la reprise n'aurait aucun pair à qui se raccrocher. Quitter le salon
   efface les deux copies.

### Pourquoi ça se bloquait après quelques minutes

Trois bugs se combinaient (corrigés en v1.0.31) :

- `mobileStopTransfer()` était appelé dès que le compteur de transferts tombait
  à 0, et `TransferForegroundService.stop()` remettait `keepAlive = false` :
  le service s'éteignait définitivement après le premier transfert terminé.
- L'effet `mobileKeepAlive(step === 'room' && status !== 'disconnected')`
  coupait le service sur `disconnected` — exactement quand la veille coupe le
  Wi-Fi et qu'il faut au contraire garder le CPU éveillé pour se reconnecter.
- Le listener `visibilitychange` vivait dans un effet conditionné aux
  transferts actifs : il était démonté dès que les transferts passaient en
  `interrupted`, donc le retour au premier plan ne relançait rien.

À cela s'ajoutait le throttling des timers WebView décrit plus haut, et une
exemption de batterie marquée « déjà demandée » avant même l'affichage du
dialogue système (donc jamais redemandée après un refus). Le flag n'est maintenant
posé qu'après l'ouverture effective du réglage, et l'état est exposé au JS via
`getServiceState()` pour le diagnostic.

**Important** : sur les ROM agressives (Xiaomi, Samsung, Oppo…), l'exemption
« Ne pas optimiser » et l'autorisation de démarrage automatique du fabricant
restent nécessaires. Vérifiez que la notification « GlobalShare » reste visible
en permanence : si elle disparaît, le service a été tué par le système.

Permissions déclarées dans `android/app/src/main/AndroidManifest.xml` :
`INTERNET`, `ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_DATA_SYNC`, `WAKE_LOCK`, `POST_NOTIFICATIONS` (Android 13+,
demandée au démarrage d'un transfert) et `REQUEST_INSTALL_PACKAGES`.

## Mise à jour in-app depuis GitHub

`UpdateManager.java` interroge
`https://api.github.com/repos/stxtxm/global-share/releases/latest`, repère
l'asset `.apk` (et son `.apk.sha256`), compare les versions sémantiques avec
`BuildConfig.VERSION_NAME`, puis télécharge dans le cache avec progression
(même état que sur desktop : `checking`, `available`, `downloading`,
`downloaded`, `installing`, `error`).

- L'empreinte SHA-256 du fichier `.apk.sha256` est vérifiée avant installation ;
  le magic `PK\x03\x04` est contrôlé.
- **Bundle web (~1 Mo)** : si le `nativeVersion` du manifeste
  `web-bundle.json` correspond à celui de l'APK installé, l'application
  télécharge uniquement `web-bundle.zip`, le vérifie et rebase le WebView
  dessus. Aucun APK n'est téléchargé ni réinstallé pour une modification du
  frontend. Le manifeste et le zip sont publiés par le workflow desktop.
- **APK différentiel** : quand la coquille native change, l'APK complet est
  inévitable. Chaque release publie alors un `.apk.blockmap` (SHA-256 de chaque
  bloc de 64 Ko, généré par `scripts/apk-blockmap.mjs`) : seuls les blocs
  manquants sont demandés via des requêtes `Range`, avec repli sur le
  téléchargement complet si le gain est insuffisant (moins de 40 % de blocs
  réutilisés). Le fichier reconstruit reste identique à l'APK signé de la
  release.
- L'installation passe par un `FileProvider` et `ACTION_VIEW`. Sur Android 8+,
  l'utilisateur doit autoriser une fois « installer des applications inconnues »
  (`ACTION_MANAGE_UNKNOWN_APP_SOURCES`) — c'est le prix d'une distribution hors
  Play Store.
- Le bouton **Plus tard** mémorise la version refusée jusqu'à la prochaine
  vérification manuelle.
- L'API GitHub non authentifiée est limitée à 60 requêtes/heure : la
  vérification est manuelle (bouton de la barre supérieure), elle ne tourne pas
  en boucle.

## construire

En local (SDK Android 36 installé, `ANDROID_HOME` défini) :

```bash
npm install
npm run apk:debug      # APK non signé, installable via adb
```

Pour une release signée :

```bash
export ANDROID_KEYSTORE_FILE=/chemin/cle.jks
export ANDROID_STORE_PASSWORD=...
export ANDROID_KEY_ALIAS=...
export ANDROID_KEY_PASSWORD=...
npm run apk             # android/app/build/outputs/apk/release/app-release.apk
```

Générer une clé une seule fois :

```bash
keytool -genkeypair -v -keystore globalshare.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias globalshare
```

**Conservez cette clé** : une APK signée avec une autre clé ne peut pas se
mettre à jour sur une installation existante.

## Secrets du dépôt

Le workflow [`.github/workflows/android.yml`](../.github/workflows/android.yml)
se déclenche sur les tags `v*`, construit l'APK signé et l'ajoute à la release
GitHub créée par le workflow desktop. Quatre secrets sont nécessaires :

| Secret | Valeur |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 globalshare.jks` |
| `ANDROID_STORE_PASSWORD` | mot de passe du keystore |
| `ANDROID_KEY_ALIAS` | alias de la clé (ex. `globalshare`) |
| `ANDROID_KEY_PASSWORD` | mot de passe de la clé |

`versionCode` est dérivé de `package.json` (`1.0.8` → `10008`) et `versionName`
en est copié : les deux workflows restent alignés sur le tag.

## Fichiers reçus (visible dans « Fichiers »)

Sur desktop, les fichiers reçus sont écrits dans `~/Téléchargements/GlobalShare`
par l'IPC Electron. Sur Android, un `<a download>` sur une URL `blob:` est ignoré
par le WebView Capacitor (pas de `DownloadListener`) : le fichier restait uniquement
en IndexedDB — invisible de l'application Fichiers et impossible à ouvrir avec un
lecteur externe.

Depuis la v1.0.32 :

- `app/lib/mobile-files.ts` découpe le blob en morceaux de 256 Ko encodés en
  base64 et les envoie au plugin natif (`saveDownload`, puis `finishDownload`).
- `GlobalShareNativePlugin.java` crée une entrée `MediaStore.Downloads` avec
  `RELATIVE_PATH = Download/GlobalShare`, le bon MIME et `IS_PENDING = 1`,
  écrit les morceaux dans cette URI, puis rend le fichier visible (`IS_PENDING = 0`).
  Sur Android ≤ 9 (minSdk 24), il écrit dans le dossier public et lance un
  `MediaScannerConnection`.
- `revealDownload()` ouvre le gestionnaire de fichiers du système dans
  `Téléchargements/GlobalShare` : actuellement un **choisir** `ACTION_VIEW`
  avec `EXTRA_INITIAL_URI` sur l'URI DocumentsUI, qui affiche notamment
  **Google Files** (le système de Pixel). C'est l'action par défaut du bouton
  « Fichiers », l'utilisateur y choisit son lecteur audio. `openDownload()` (bouton
  « Écouter ») lance le même choisir avec l'URI `content://` : un lecteur vidéo
  qui déclare `*/*` n'est plus lancé automatiquement (il plantait sur un FLAC et
  l'application semblait figée au retour). Le manifeste déclare les `<queries>`
  audio/vidéo/image/scheme `content` nécessaires à la visibilité des paquets sur
  Android 11+, et `WRITE_EXTERNAL_STORAGE` plafonné à `maxSdkVersion="28"` pour
  les anciennes versions.

Depuis la v1.0.38 puis v1.0.43, depuis vos retours, « Fichiers » ne dépend plus
du contexte app :
1. **`ACTION_OPEN_DOCUMENT_TREE`** (DocumentsUI ≥ Android 11, v1.0.43) :
   DocumentsUI ouvre lui-même l'arbre des documents, sans contrainte de
   permission depuis notre app — évite l'erreur
   « UID does not have permission to content://com.android.externalstorage.documents/… » ;
2. **Lancement de Google Files / DocumentsUI** par `getLaunchIntentForPackage` ;
3. **`ACTION_OPEN_DOCUMENT` + createChooser** (v1.0.38) : repli robuste.

Vous pouvez aussi dans « Fichiers » activer **« Fichiers reçus »** depuis
l'onglet Téléchargements. À partir de la
v1.0.40, « Fichiers » réaffiche aussi les fichiers présents sur le téléphone
via `listDownloads()` dans l'onglet Téléchargements.
- Le MIME est inféré depuis l'extension quand `File.type` est vide (cas fréquent
  du FLAC sur Android) : `mimeFromName()` dans `app/lib/downloads.ts` renvoie
  `audio/flac`, `audio/mpeg`, etc. Les fichiers audio reçoivent une icône dédiée
  dans la liste.
- L'URI MediaStore est conservée dans `record.path` : les boutons « Fichiers » et
  « Écouter » apparaissent donc aussi sur mobile, pour **tous** les types de
  fichiers (pas seulement le FLAC). « Fichiers » ouvre directement le dossier
  `Téléchargements/GlobalShare` dans l'app du système ; « Écouter » affiche un
  choisir d'application.
- **« Tout supprimer » ne vide que l'historique.** Les fichiers déjà enregistrés
  dans `Téléchargements/GlobalShare` restent sur le téléphone : vider la liste
  des fichiers reçus est un rangement d'affichage, pas une suppression. Ils
  continuent d'apparaître dans « Sur le téléphone », d'où on peut les ouvrir ou
  les effacer explicitement.
- **Retirer** (une seule ligne) ne retire que l'entrée de l'historique : le
  fichier reste dans `Téléchargements/GlobalShare` et dans « Sur le téléphone ».
  La suppression réelle est réservée à cet onglet (`deleteDownload()`, URI
  MediaStore ou recherche par nom pour les anciennes entrées).
- Les listes restent synchronisées : « Sur le téléphone » → « Supprimer » ou
  « Effacer tout » supprime les fichiers du disque et rafraîchit « Fichiers
  reçus » ; l'autre liste est rafraîchie dès le retour dans l'onglet
  Téléchargements.
- Une section **« Sur cet appareil »** dans l'onglet Téléchargements liste les
  fichiers réellement présents dans `Téléchargements/GlobalShare`, lus via
  `listDownloads()` (MediaStore, ou le dossier public sur Android ≤ 9). C'est la
  source de vérité du disque, indépendante de l'historique IndexedDB : chaque
  fichier peut y être écouté ou supprimé. Utile quand l'historique a été perdu
  ou qu'un enregistrement a échoué sur une ancienne coquille.
- `finishDownload()` vérifie le retour de `MediaStore.update()` : si l'entrée a
  disparu, une erreur est remontée au lieu d'enregistrer une URI invalide.

## Décalage bundle web / coquille native

Les versions 1.0.32 à 1.0.35 ont ajouté des **méthodes natives** (`saveDownload`,
`finishDownload`, `openDownload`, `revealDownload`) sans changer
`nativeVersion` (resté à 2). Une APK installée avec une version antérieure
pouvait donc récupérer le nouveau bundle web (~1,4 Mo) par mise à jour delta :
l'interface affichait les boutons, mais l'appel à la méthode native absente levait
un `TypeError` — « Fichiers » ne s'ouvrait pas et les fichiers n'étaient pas
enregistrés sur le disque.

Depuis la **v1.0.36**, `nativeVersion` passe à **3** : le vérificateur de mise à
jour (`UpdateManager.java`, `desktop/web-updates.js`) refuse le bundle web quand
le compteur diffère et propose le **paquet complet**. Le pont JS vérifie aussi
l'existence de chaque méthode et affiche « mettez l'APK à jour » au lieu d'un
TypeError si une coquille obsolète est détectée.

Depuis la **v1.0.40**, `nativeVersion` est passé à **6** : la coquille 5 appelait
`deleteDownload` côté web sans exposer la méthode native, donc **Retirer**
laissait le fichier sur le téléphone. Cette version fournit la suppression
MediaStore (ou du fichier public sur Android ≤ 9) et force le téléchargement de
l'APK complet.

Depuis la **v1.0.49**, `nativeVersion` passe à **9** : les corrections du service
avant-plan (arrêt à la fermeture de l'app, et transfert en cours préservé) sont
natives. Un bundle web ne les contient pas : l'APK complet doit être installé.
(La v1.0.48, qui portait une première version de ce correctif avec
`nativeVersion` 8, n'a jamais été publiée.)

Depuis la **v1.0.58**, `nativeVersion` passe à **12** : le tick natif du
service descend à 2 s pendant un transfert, pour que le WebView traite les
chunks et les ACK même écran éteint. Le paquet desktop passe à **11**
(`backgroundThrottling: false` dans le processus principal). Un bundle web
seul ne peut pas modifier ces réveils : l'APK et le paquet complets sont
nécessaires.

Depuis la **v1.0.41**, `nativeVersion` passe à **7** : la coquille Electron a
changé (tray Linux/GNOME, repli minimisé) et le compteur est commun au bureau et
à Android. Les applications installées téléchargent donc l'APK complet plutôt
qu'un bundle web, même si le code Java Android est inchangé.

**Important pour tester** : installez l'**APK complet v1.0.41** (pas seulement la
mise à jour web) depuis la release GitHub. Les fichiers déjà reçus avec une
ancienne coquille n'existent que dans IndexedDB : recevez-les à nouveau après la
mise à jour pour qu'ils soient écrits dans `Téléchargements/GlobalShare`.

## Limites

- Distribution directe / F-Droid : le Play Store interdit le self-update par
  APK et exige l'API *Play In-App Updates*. Ce projet ne vise donc pas le Play
  Store en l'état.
- Les appareils avec Doze agressif ou économie de données peuvent couper le
  réseau malgré le service : la reprise IndexedDB prend le relais.
- macOS et iOS ne sont pas couverts ; Capacitor peut générer iOS plus tard,
  mais le service avant-plan et l'installation d'APK sont spécifiques à Android.
