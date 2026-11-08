'use strict';

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
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
    icon: path.join(__dirname, 'resources', 'icon.png'),
    webPreferences: {
      // La page est du contenu web classique : aucun accès Node n'est nécessaire.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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
