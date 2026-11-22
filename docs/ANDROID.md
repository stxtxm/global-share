# Application Android (APK)

L'APK embarque le même export statique Next.js que le bureau et le web. La
couche native est un projet [Capacitor](https://capacitorjs.com/) en Java :
`android/` contient le WebView, un plugin et un service système. Le frontend ne
dépend pas de Capacitor : le pont est injecté dans la page sous
`window.globalshareMobile`, exactement comme `window.globalshareDesktop` sous
Electron, et l'encart de mise à jour (`app/components/UpdateManager.tsx`) est
commun aux deux.

## Transfert écran verrouillé

Trois mécanismes se complètent :

1. **Wake lock d'écran** (`app/lib/wake-lock.ts`) : empêche l'extinction
   automatique pendant un transfert, comme dans la PWA.
2. **Service avant-plan** (`TransferForegroundService.java`) : notification
   permanente, `PARTIAL_WAKE_LOCK` (CPU éveillé) et verrou Wi-Fi haute
   performance. Il est démarré par le plugin dès qu'un transfert est actif et
   arrêté quand la liste est vide. Sans lui, Android suspend le WebView dès que
   l'écran se verrouille.
3. **Reprise IndexedDB** (`app/lib/resume-store.ts`) : si Android tue quand même
   le processus (pression mémoire, Doze), les chunks déjà reçus sont conservés
   et le transfert reprend à partir du dernier accusé de réception.

La continuité est donc « meilleur effort + reprise transparente » : un
verrouillage manuel, un changement de réseau ou une mise à jour du système peut
toujours interrompre la connexion, mais le transfert reprend sans renvoyer le
fichier depuis le début.

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
