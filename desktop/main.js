'use strict';

const {
  app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell,
  Notification, powerSaveBlocker, globalShortcut,
} = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { checkForUpdates, initAutoUpdater, sendUpdateState } = require('./updater');
const webUpdates = require('./web-updates');

// Identifiant Windows (raccourcis, notifications) : doit rester identique à
// `appId` dans electron-builder.yml.
const APP_ID = 'io.github.stxtxm.globalshare';
const SITE_URL = 'https://stxtxm.github.io/global-share/';

// L'export statique (`npm run build:desktop`) est copié dans resources/web par
// electron-builder ; en développement il est lu directement dans out/. Une mise
// à jour « bundle web » appliquée remplace ce dossier par le bundle extrait —
// d'où un root mutable et un repli systématique sur les ressources embarquées.
const PACKAGED_WEB_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'web')
  : path.join(__dirname, '..', 'out');
let WEB_ROOT = PACKAGED_WEB_ROOT;

// ---- Arrière-plan : icône tray + comportement de la croix ------------------
// Comme le service avant-plan sous Android : la fenêtre fermée n'arrête pas
// l'application, les transferts et la socket continuent ; l'appareil ne doit
// pas se mettre en veille pendant un transfert (powerSaveBlocker, plus bas).
// Le choix de la croix (« continuer en arrière-plan » ou « quitter ») est
// demandé une seule fois puis mémorisé — équivalent de la demande de
// permission Android, tenant à la convention des apps de bureau.
let tray = null;
let quitRequested = false;
// Compteur de transferts actifs, mis à jour par la page via le pont IPC.
// Sert à empêcher une vraie fermeture pendant un transfert et à proposer une
// notification cliquable comme voie de secours sur GNOME (tray souvent masqué).
let activeTransfers = 0;

const PREFS_FILE = () => path.join(app.getPath('userData'), 'prefs.json');

function loadPrefs() {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8'));
  } catch {
    return {};
  }
}

function savePrefs(prefs) {
  try {
    fs.writeFileSync(PREFS_FILE(), JSON.stringify(prefs));
  } catch {
    // Préférences non critiques : perdues plutôt que bloquer l'app.
  }
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (mainWindow.moveTop) mainWindow.moveTop();
  } else if (staticServer) {
    mainWindow = createWindow(staticServer.address().port);
  }
}

// Raccourci global : sur GNOME, l'icône tray (StatusNotifierItem) est souvent
// masquée et la fenêtre peut disparaître de la barre des tâches. Ce raccourci
// fonctionne sur tous les environnements, même quand l'app est masquée.
const RESTORE_SHORTCUT = 'CommandOrControl+Alt+G';

function createTray() {
  if (tray) return;
  try {
    const image = nativeImage.createFromPath(TRAY_ICON_FILE);
    // Ne jamais construire un Tray avec une image vide : certains hôtes SNI
    // plantent ou créent une entrée invisible (GNOME, XFCE).
    if (image.isEmpty()) {
      console.warn('[GlobalShare] icône tray introuvable :', TRAY_ICON_FILE);
      return;
    }
    tray = new Tray(image);
    tray.setToolTip('GlobalShare tourne en arrière-plan');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Ouvrir GlobalShare (${RESTORE_SHORTCUT})`, click: showMainWindow },
      { type: 'separator' },
      {
        label: 'Quitter',
        click: () => {
          quitRequested = true;
          app.quit();
        },
      },
    ]));
    tray.on('click', showMainWindow);
    // La spec SNI ne définit pas si le simple ou double clic déclenche
    // « click » : on couvre les deux.
    tray.on('double-click', showMainWindow);
  } catch (error) {
    // GNOME nu n'a pas d'hôte SNI : le raccourci global et le dock prennent
    // le relais. On log tout de même pour le diagnostic.
    console.warn('[GlobalShare] tray indisponible :', String(error));
  }
}

// Activation des mises à jour web uniquement dans la version installée :
// ce module ne connaît ni Electron ni le réseau, tout est injecté ici.
if (app.isPackaged) {
  webUpdates.configure({
    enabled: true,
    baseDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    nativeVersion: (() => {
      try {
        return require('./package.json').nativeVersion || 1;
      } catch {
        return 1;
      }
    })(),
    fetchImpl: (url, options) => fetch(url, options),
  });
  const hot = webUpdates.activeRoot();
  if (hot && fs.existsSync(path.join(hot, 'index.html'))) WEB_ROOT = hot;
}

// Icône de la fenêtre (barre des tâches, aperçu Alt+Tab). Elle est livrée à
// côté de l'asar : Chromium ne sait pas la lire depuis l'archive.
const ICON_FILE = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(__dirname, 'resources', 'icon.png');
// Icône 24x24 dédiée au tray (livrée hors asar, voir electron-builder.yml).
const TRAY_ICON_FILE = app.isPackaged
  ? path.join(process.resourcesPath, 'tray.png')
  : path.join(__dirname, 'resources', 'icons', '24x24.png');

// L'image est décodée ici : un chemin passé tel quel à BrowserWindow n'est pas
// toujours appliqué comme icône de fenêtre sous Linux.
const WINDOW_ICON = (() => {
  const image = nativeImage.createFromPath(ICON_FILE);
  return image.isEmpty() ? undefined : image;
})();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

let mainWindow = null;
let staticServer = null;

// Les fichiers reçus atterrissent dans un sous-dossier dédié : l'onglet
// Téléchargements peut ainsi les rouvrir sans redemander ni chemin ni blob.
const DOWNLOAD_FOLDER = 'GlobalShare';

function downloadsDir() {
  let base;
  try {
    base = app.getPath('downloads');
  } catch {
    base = app.getPath('home');
  }
  return path.join(base, DOWNLOAD_FOLDER);
}

// Même règle que app/lib/downloads.ts : pas de chemin, pas de caractère de
// contrôle, un nom toujours exploitable par le système de fichiers.
function safeFileName(name) {
  const last = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = last.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '').trim();
  return (cleaned || 'fichier').slice(0, 120);
}

function freeFileName(dir, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let target = path.join(dir, name);
  for (let index = 1; fs.existsSync(target); index += 1) {
    target = path.join(dir, `${base} (${index})${ext}`);
  }
  return target;
}

function registerDownloadHandlers() {
  ipcMain.handle('globalshare:save-download', async (_event, payload) => {
    try {
      const bytes = payload?.bytes;
      if (!bytes || typeof bytes.byteLength !== 'number') {
        return { error: 'Fichier vide : rien à enregistrer.' };
      }
      const dir = downloadsDir();
      await fs.promises.mkdir(dir, { recursive: true });
      const target = freeFileName(dir, safeFileName(payload?.name));
      await fs.promises.writeFile(target, Buffer.from(bytes));
      // Fenêtre réduite ou cachée : prévenir qu'un fichier est arrivé, comme
      // le service avant-plan informe sur Android.
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        try {
          new Notification({
            title: 'GlobalShare',
            body: `Fichier reçu : ${path.basename(target)}`,
            icon: ICON_FILE,
          }).show();
        } catch { /* notifications indisponibles : rien d'option */ }
      }
      return { path: target };
    } catch (error) {
      return { error: `Enregistrement impossible : ${String(error?.message || error)}` };
    }
  });

  // Transferts actifs : suspendre la mise en veille de la machine (équivalent
  // du wake lock Android) tant qu'un fichier circule.
  let powerBlockerId = null;
  ipcMain.handle('globalshare:set-transfers-active', (_event, count) => {
    activeTransfers = Math.max(0, Number(count) || 0);
    if (tray && !tray.isDestroyed()) {
      tray.setToolTip(activeTransfers > 0
        ? `GlobalShare · ${activeTransfers} transfert(s) en cours`
        : 'GlobalShare tourne en arrière-plan');
    }
    const active = Number(count) > 0;
    if (active && powerBlockerId === null) {
      powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!active && powerBlockerId !== null) {
      powerSaveBlocker.stop(powerBlockerId);
      powerBlockerId = null;
    }
    return true;
  });

  const insideDownloads = (filePath) => {
    const resolved = path.resolve(String(filePath || ''));
    const root = path.resolve(downloadsDir());
    if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
    return null;
  };

  ipcMain.handle('globalshare:open-download', async (_event, filePath) => {
    const resolved = insideDownloads(filePath);
    if (!resolved) return 'Fichier en dehors du dossier de téléchargements.';
    if (!fs.existsSync(resolved)) return "Ce fichier n'existe plus sur le disque.";
    // openPath renvoie un message d'erreur vide quand le système a bien ouvert
    // le fichier : on le remonte tel quel à l'interface.
    return shell.openPath(resolved);
  });

  ipcMain.handle('globalshare:reveal-download', async (_event, filePath) => {
    const resolved = insideDownloads(filePath);
    if (!resolved) return 'Fichier en dehors du dossier de téléchargements.';
    if (!fs.existsSync(resolved)) return "Ce fichier n'existe plus sur le disque.";
    shell.showItemInFolder(resolved);
    return '';
  });
}

// L'export Next.js est servi par un petit serveur HTTP local plutôt qu'en
// file:// : les chemins absolus (/_next/...), les blobs téléchargés et le
// presse-papiers se comportent alors exactement comme dans le navigateur.
function resolveAsset(pathname) {
  const target = path.resolve(WEB_ROOT, pathname.replace(/^\/+/, ''));
  // Aucune requête ne doit sortir du dossier de l'application.
  if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + path.sep)) return null;

  let stat = null;
  try { stat = fs.statSync(target); } catch { /* absent : navigation ? */ }

  // Dossier (la racine « / », ou un sous-dossier comme /_next) : servir sa
  // page index.html. Attention : un dossier de bundle s'appelle « 1.0.21 » —
  // son extname est « .21 » et ressemble à une extension ; ne jamais se
  // fonder sur extname pour décider si une cible est un fichier.
  if (stat?.isDirectory()) {
    const index = path.join(target, 'index.html');
    return fs.existsSync(index) ? index : null;
  }
  if (stat?.isFile()) return target;

  // Navigation interne (/?room=CODE, /salon) : l'export ne contient qu'une
  // page — tant que la cible absente ne ressemble pas à un fichier statique.
  if (path.extname(path.basename(target)) === '') {
    const index = path.join(WEB_ROOT, 'index.html');
    if (fs.existsSync(index)) return index;
  }
  return null;
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end();
        return;
      }

      let pathname = '/';
      try {
        pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }

      const file = resolveAsset(pathname);
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        // Application locale : aucun cache disque, donc une mise à jour
        // installée est visible dès le démarrage suivant.
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(file)
        .on('error', () => res.destroy())
        .pipe(res);
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function createWindow(port) {
  const window = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 360,
    minHeight: 540,
    show: false,
    // Jamais exclue de la barre des tâches : même masquée dans le tray,
    // l'utilisateur doit pouvoir retrouver la fenêtre (GNOME, KDE, XFCE…).
    skipTaskbar: false,
    title: 'GlobalShare',
    backgroundColor: '#0a0b10',
    icon: WINDOW_ICON,
    webPreferences: {
      // La page est du contenu web classique : aucun accès Node n'est nécessaire.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Seul pont autorisé : enregistrer/ouvrir les fichiers reçus.
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: true,
    },
  });

  const origin = `http://127.0.0.1:${port}`;
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  // Croix de la fenêtre : une première fois, demander si les transferts doivent
  // continuer en arrière-plan (équivalent de la demande de permission
  // Android). Le choix est mémorisé ; le tray et « Fichier → Quitter »
  // quittent toujours réellement.
  window.on('close', (event) => {
    if (quitRequested) return;
    // Un transfert en cours ne doit jamais être tué par un clic malencontreux
    // sur la croix : on masque la fenêtre et on affiche une notification
    // cliquable, même si le tray est invisible (GNOME sans AppIndicator).
    if (activeTransfers > 0) {
      event.preventDefault();
      window.hide();
      try {
        const notification = new Notification({
          title: 'GlobalShare',
          body: 'Transfert en cours — cliquez pour rouvrir la fenêtre',
          icon: ICON_FILE,
        });
        notification.on('click', showMainWindow);
        notification.show();
      } catch { /* notifications indisponibles : raccourci toujours là */ }
      return;
    }
    const prefs = loadPrefs();
    if (prefs.closeAction === 'background') {
      event.preventDefault();
      window.hide();
      return;
    }
    if (prefs.closeAction === 'quit') return;
    event.preventDefault();
    void dialog.showMessageBox(window, {
      type: 'question',
      buttons: ["Continuer en arrière-plan", "Quitter", "Annuler"],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: 'Ne plus demander',
      checkboxChecked: false,
      title: 'GlobalShare',
      message: 'Laisser GlobalShare continuer en arrière-plan ?',
      detail: 'La fenêtre se replie dans la zone de notification et les transferts en cours continuent. Vous retrouverez l\'application dans le tray, avec « Quitter » dans son menu.',
    }).then(({ response, checkboxChecked }) => {
      if (response === 2) return; // Annulé : la fenêtre reste ouverte.
      if (checkboxChecked) {
        savePrefs({ ...loadPrefs(), closeAction: response === 0 ? 'background' : 'quit' });
      }
      if (response === 0) window.hide();
      else {
        quitRequested = true;
        app.quit();
      }
    }).catch(() => { /* boîte impossible : ne pas fermer brutalement */ });
  });

  // Un lien sortant (dont le lien de salon vers le site) part dans le
  // navigateur par défaut, jamais dans une fenêtre Electron sans barre d'adresse.
  const openExternal = (url) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(origin)) void shell.openExternal(url);
  };
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(origin)) return;
    event.preventDefault();
    openExternal(url);
  });

  // L'interface demande l'état au montage ; ce renvoi couvre le cas où une
  // mise à jour a changé d'état pendant un rechargement de la page.
  window.webContents.on('did-finish-load', () => sendUpdateState());

  // Garde-fou du bundle chaud : si le contenu web appliqué par une mise à jour
  // ne charge pas (fichier corrompu, incompatibilité imprévue), on
  // revient aux ressources embarquées au lieu de laisser une fenêtre morte.
  window.webContents.on('did-fail-load', (_event, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED : navigation supplantée */) return;
    if (WEB_ROOT === PACKAGED_WEB_ROOT) return;
    webUpdates.reset();
    WEB_ROOT = PACKAGED_WEB_ROOT;
    if (!window.isDestroyed()) void window.loadURL(`${origin}/`);
  });

  void window.loadURL(`${origin}/`);
  return window;
}

function buildMenu() {
  const template = [];
  if (process.platform === 'darwin') template.push({ role: 'appMenu' });

  template.push(
    {
      label: 'Fichier',
      submenu: [
        { label: 'Ouvrir le site', click: () => void shell.openExternal(SITE_URL) },
        { type: 'separator' },
        process.platform === 'darwin'
          ? { role: 'close', label: 'Fermer la fenêtre' }
          : { role: 'quit', label: 'Quitter' },
      ],
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'selectAll', label: 'Tout sélectionner' },
      ],
    },
    {
      label: 'Affichage',
      submenu: [
        { role: 'reload', label: 'Recharger' },
        { role: 'toggleDevTools', label: 'Outils de développement' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Taille normale' },
        { role: 'zoomIn', label: 'Agrandir' },
        { role: 'zoomOut', label: 'Réduire' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' },
      ],
    },
    {
      label: 'Aide',
      submenu: [
        { label: 'Rechercher des mises à jour…', click: () => checkForUpdates({ manual: true }) },
        { type: 'separator' },
        { label: `Version ${webUpdates.effectiveVersion() || app.getVersion()}`, enabled: false },
      ],
    },
  );

  return Menu.buildFromTemplate(template);
}

async function start() {
  app.setAppUserModelId(APP_ID);
  registerDownloadHandlers();
  createTray();
  const registered = globalShortcut.register(RESTORE_SHORTCUT, showMainWindow);
  if (!registered) {
    // Wayland : le portail GlobalShortcuts exige un desktopName reverse-DNS
    // et un consentement utilisateur au premier lancement.
    console.warn(`[GlobalShare] raccourci ${RESTORE_SHORTCUT} refusé (conflit ou portail Wayland)`);
  }

  // Menu « Fichier → Quitter », raccourcis clavier : quitter pour de vrai,
  // sans passer par la demande de la croix.
  app.on('before-quit', () => {
    quitRequested = true;
  });

  if (!fs.existsSync(path.join(WEB_ROOT, 'index.html'))) {
    dialog.showErrorBox(
      'GlobalShare',
      "Les fichiers de l'application sont introuvables. Réinstallez GlobalShare depuis les releases GitHub.",
    );
    app.quit();
    return;
  }

  try {
    staticServer = await startStaticServer();
  } catch (error) {
    dialog.showErrorBox('GlobalShare', `Impossible de démarrer le serveur local : ${String(error)}`);
    app.quit();
    return;
  }

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (staticServer) staticServer.close();
  });

  mainWindow = createWindow(staticServer.address().port);
  Menu.setApplicationMenu(buildMenu());
  initAutoUpdater(() => mainWindow, {
    // InstallUpdate (bundle web) : bascule le serveur statique sur le nouveau
    // bundle, puis recharge la fenêtre — sans redémarrer l'application.
    applyWebRoot: (dir) => {
      if (!dir || !fs.existsSync(path.join(dir, 'index.html'))) return;
      WEB_ROOT = path.resolve(dir);
      if (mainWindow && !mainWindow.isDestroyed()) {
        void mainWindow.loadURL(`http://127.0.0.1:${staticServer.address().port}/`);
      }
    },
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(start);

  app.on('activate', () => {
    // Dock (macOS) et gestionnaires de fenêtres : rouvrir une fenêtre masquée.
    if (!staticServer) return;
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createWindow(staticServer.address().port);
    } else {
      showMainWindow();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
