# Applications de bureau (Linux & Windows)

L'application de bureau réutilise le même frontend : `next build` produit un
export statique (`out/`), embarqué dans Electron et servi par un petit serveur
HTTP local (`127.0.0.1`, port éphémère) plutôt qu'en `file://`. Les chemins
absolus de l'export, les téléchargements de fichiers reçus et le presse-papiers
se comportent donc comme dans le navigateur. La signalisation et le relais
restent le Worker Cloudflare.

| Fichier produit | Distribution | Mise à jour in-app |
| --- | --- | --- |
| `globalshare-<version>-1.x86_64.rpm` | Fedora, RHEL/Rocky/Alma, openSUSE | oui, mot de passe admin (pkexec) |
| `globalshare_<version>_amd64.deb` | Debian, Ubuntu, Mint | oui, mot de passe admin (pkexec) |
| `GlobalShare-<version>.AppImage` | toutes les distributions (`chmod +x`) | oui, sans mot de passe |
| `GlobalShare-Setup-<version>.exe` | Windows 10/11 x64 | oui, silencieuse (installation par utilisateur) |

L'AppImage est le format qui couvre « toutes les distributions » sans dépôt ni
dépendances ; le `.rpm` et le `.deb` s'intègrent au gestionnaire de paquets de la
distribution (menu, `/usr/bin/globalshare`, désinstallation propre).

## Mise à jour automatique

`electron-updater` interroge les releases GitHub du dépôt (`publish` dans
[`electron-builder.yml`](../electron-builder.yml)) :

- vérification 8 s après le démarrage, puis toutes les 6 h ;
- entrée **Aide → Rechercher des mises à jour…** pour une vérification manuelle ;
- le téléchargement démarre après accord, avec la barre de progression de la
  barre des tâches ;
- l'installation se fait au redémarrage (« Redémarrer et installer ») ou à la
  fermeture de l'application.

Deux fichiers de métadonnées accompagnent les paquets et **doivent** être
publiés dans la release : `latest.yml` (Windows) et `latest-linux.yml` (Linux).
Une release en brouillon ou marquée *pre-release* est ignorée par l'auto-update.

Particularités Linux : un `.rpm`/`.deb` s'installe via `pkexec`, l'utilisateur
saisit donc son mot de passe au moment de l'installation. L'AppImage se
remplace sans rien demander. Une installation par `dnf`/`zypper`/`apt` reste
préférable quand elle est disponible.

Windows : l'installateur est en mode « par utilisateur », sans UAC, et la mise
à jour est silencieuse. Les binaires ne sont pas signés : Windows SmartScreen
affiche un avertissement au premier téléchargement et l'auto-update ne peut pas
vérifier l'éditeur. Signer l'exécutable (certificat de signature de code) est
recommandé pour une diffusion large.

## Onglet « Téléchargements »

Les fichiers reçus restent accessibles dans l'onglet **Téléchargements** de
l'application (`Salon | Téléchargements`) et se rouvrent d'un appui, sans
repasser par un transfert :

| Contexte | Enregistrement | Bouton **Ouvrir** |
| --- | --- | --- |
| Bureau (rpm/deb/AppImage/exe) | `~/Téléchargements/GlobalShare/`, nom dédupliqué (`photo (1).jpg`) | application associée du système (`shell.openPath`) ; bouton **Dossier** pour révéler le fichier |
| Web / mobile (PWA) | blob dans IndexedDB, 40 fichiers et 128 Mo au total | onglet du navigateur pour images, PDF, vidéos, sons et textes ; sinon téléchargement |

Le pont Electron est [`desktop/preload.js`](../desktop/preload.js) : il expose
`window.globalshareDesktop` avec `saveDownload`, `openDownload` et
`revealDownload`. Le processus principal n'accepte d'ouvrir un chemin que s'il
se trouve dans son dossier de téléchargements, et le nom envoyé par la page est
assaini avant écriture. Sans ce pont (site, mobile), l'application retombe sur
`Blob` + `URL.createObjectURL`.

Un fichier dont l'empreinte SHA-256 diffère apparaît avec la pastille « fichier
corrompu » mais n'est jamais écrit sur le disque. L'historique survit à la
fermeture de l'application ; **Tout supprimer** vide la liste et les blobs
conservés, sans effacer les fichiers déjà enregistrés dans le dossier.

## Publier une version

Le tag est la source de vérité de la version :

```bash
git tag v1.0.1
git push origin v1.0.1
```

[`.github/workflows/release.yml`](../.github/workflows/release.yml) se déclenche
alors et :

1. aligne `package.json` et `desktop/package.json` sur le tag
   (`scripts/set-version.mjs`) ;
2. construit l'export statique (`npm run build:desktop`) ;
3. fabrique `rpm`, `deb` et `AppImage` sur `ubuntu-latest`, l'installateur `nsis`
   sur `windows-latest` ;
4. crée la release GitHub et y dépose les paquets, les `.exe` et les
   métadonnées `latest*.yml` (+ `.blockmap` pour les téléchargements
   différentiels).

Relance manuelle : **Actions → Release desktop apps → Run workflow** avec le tag
existant en paramètre (le workflow recharge les fichiers de la release).

## Construire en local

```bash
npm install
npm --prefix desktop install
npm run dist:linux    # rpm + deb + AppImage
npm run dist:win      # installateur Windows (à lancer sous Windows)
```

Les artefacts sortent dans `dist/`. Construire un `.rpm` depuis Debian/Ubuntu
demande l'outillage RPM : `sudo apt install rpm`.

Les helpers de l'historique (nommage sûr, déduplication, purge, types ouvrables
dans le navigateur) sont couverts par `npm run test:unit`.

Pour lancer l'application sans la packager (elle lit `out/`, l'auto-update est
désactivée) :

```bash
npm run desktop
```

## Valeurs injectées au build de bureau

`scripts/build-desktop.mjs` fixe `NEXT_PUBLIC_DESKTOP=1` (désactive le préfixe
`/global-share`, voir `next.config.ts`, ainsi que le service worker) et fournit
des valeurs de production surchargeables :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `NEXT_PUBLIC_SOCKET_URL` | `https://global-share-socket.sitizstorm.workers.dev` | Worker de signalisation / relais |
| `NEXT_PUBLIC_SHARE_BASE` | `https://stxtxm.github.io/global-share` | base des liens de salon partagés (sinon `127.0.0.1`) |
| `NEXT_PUBLIC_TURN_*` | vides | relais TURN statique (voir [DEPLOYMENT.md](./DEPLOYMENT.md)) |

## Limites connues

- Seules les architectures x64 (Linux et Windows) sont produites ; ajouter
  `arm64` dans la matrice du workflow pour les couvrir.
- Paquets Linux non signés : l'auto-update accepte les paquets non vérifiés
  (`allowUnverifiedLinuxPackages`, valeur par défaut d'`electron-updater`). Si
  vous signez les paquets, passez cette option à `false` dans
  `desktop/updater.js`.
- macOS n'est pas configuré (aucune cible ni signature Apple).
- La cible `rpm`/`deb` n'est mise à jour que si l'application a été installée
  depuis ce paquet ; une AppImage n'est mise à jour que lancée en AppImage.
