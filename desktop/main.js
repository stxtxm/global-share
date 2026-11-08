'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { checkForUpdates, initAutoUpdater } = require('./updater');

// Identifiant Windows (raccourcis, notifications) : doit rester identique à
// `appId` dans electron-builder.yml.
const APP_ID = 'io.github.stxtxm.globalshare';
const SITE_URL = 'https://stxtxm.github.io/global-share/';

// L'export statique (`npm run build:desktop`) est copié dans resources/web par
// electron-builder ; en développement il est lu directement dans out/.
const WEB_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'web')
  : path.join(__dirname, '..', 'out');

// Icône de la fenêtre (barre des tâches, aperçu Alt+Tab). Elle est livrée à
// côté de l'asar : Chromium ne sait pas la lire depuis l'archive.
const ICON_FILE = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(__dirname, 'resources', 'icon.png');

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
      return { path: target };
    } catch (error) {
      return { error: `Enregistrement impossible : ${String(error?.message || error)}` };
    }
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

  const candidates = [target];
  if (path.extname(target) === '') candidates.push(path.join(target, 'index.html'));

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Fichier absent : on essaie le candidat suivant.
    }
  }

  // Navigation interne (/?room=CODE, /salon) : l'export ne contient qu'une page.
  if (path.extname(target) === '') {
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
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  );

  return Menu.buildFromTemplate(template);
}

async function start() {
  app.setAppUserModelId(APP_ID);
  registerDownloadHandlers();

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
    if (staticServer) staticServer.close();
  });

  mainWindow = createWindow(staticServer.address().port);
  Menu.setApplicationMenu(buildMenu());
  initAutoUpdater(() => mainWindow);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(start);

  app.on('activate', () => {
    // macOS : cliquer sur l'icône du Dock rouvre la fenêtre.
    if (mainWindow || !staticServer) return;
    mainWindow = createWindow(staticServer.address().port);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
