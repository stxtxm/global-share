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
   et **non** `mobileStopTransfer()` : seul le bouton de sortie du salon arrête
   le service.
3. **Tick natif → WebView** (watchdog du service, toutes les 10 s) : c'est le
   point essentiel pour tenir « des heures en veille ». Chromium bride les
   timers JS d'une page masquée à 1/s puis 1/min après 5 minutes (même avec un
   wake lock CPU). Le watchdog natif, lui, continue de tourner : il réacquiert
   les verrous si besoin, rafraîchit la notification et émet `serviceTick`. Le
   WebView y réagit en reconnectant la socket, en relançant les transferts
   interrompus et en appelant directement la boucle d'envoi — sans dépendre des
   `setTimeout` bridés.
4. **Reprise IndexedDB** (`app/lib/resume-store.ts`) : si Android tue quand même
   le processus (pression mémoire, Doze), les chunks déjà reçus sont conservés
   et le transfert reprend à partir du dernier accusé de réception.

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

## Limites

- Distribution directe / F-Droid : le Play Store interdit le self-update par
  APK et exige l'API *Play In-App Updates*. Ce projet ne vise donc pas le Play
  Store en l'état.
- Les appareils avec Doze agressif ou économie de données peuvent couper le
  réseau malgré le service : la reprise IndexedDB prend le relais.
- macOS et iOS ne sont pas couverts ; Capacitor peut générer iOS plus tard,
  mais le service avant-plan et l'installation d'APK sont spécifiques à Android.
