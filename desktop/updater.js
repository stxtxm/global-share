'use strict';

const { app, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const webUpdates = require('./web-updates');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 8_000;

const STATUSES = new Set([
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'installing',
  'up-to-date',
  'unsupported',
  'error',
]);

let getWindow = () => null;
let checking = false;
let downloading = false;
let installing = false;
let manualCheck = false;
let dismissedVersion = null;
let installerPath = null;
// Mise à jour « bundle web » : manifeste vérifié, en attente de téléchargement.
let pendingWeb = null;
// Callback fourni par main.js : bascule le serveur statique sur le nouveau
// bundle et recharge la fenêtre.
let applyWebRoot = null;

function initialState() {
  return {
    status: 'idle',
    currentVersion: app.getVersion(),
    version: null,
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    requiresAdmin: linuxPackageType() !== null,
    message: '',
  };
}

let state = initialState();

// ---------------------------------------------------------------------------
// Normalisation : electron-updater peut fournir des champs absents ou non
// numériques. On garantit à l'interface des nombres finis, jamais `null`.
// ---------------------------------------------------------------------------
function finite(value, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function bytes(value) {
  return Math.max(0, Math.round(finite(value)));
}

function percent(value) {
  return Math.min(100, Math.max(0, Math.round(finite(value))));
}

function versionOf(info) {
  const value = info && (info.version || (info.updateInfo && info.updateInfo.version));
  return typeof value === 'string' && value ? value : app.getVersion();
}

function errorText(error, fallback) {
  if (typeof error === 'string') return error || fallback;
  const value = error instanceof Error ? error.message : error && error.message;
  return typeof value === 'string' && value ? value : fallback;
}

function publish(patch = {}) {
  const next = {
    ...state,
    ...patch,
    // Un bundle web appliqué compte comme la version courante : après une
    // mise à jour « rapide », l'interface affiche la version du bundle, pas
    // celle de la coquille installée.
    currentVersion: webUpdates.effectiveVersion() || app.getVersion(),
    status: STATUSES.has(patch.status) ? patch.status : state.status,
    version: patch.version === undefined ? state.version : patch.version || app.getVersion(),
    percent: percent(patch.percent === undefined ? state.percent : patch.percent),
    transferred: bytes(patch.transferred === undefined ? state.transferred : patch.transferred),
    total: bytes(patch.total === undefined ? state.total : patch.total),
    bytesPerSecond: bytes(
      patch.bytesPerSecond === undefined ? state.bytesPerSecond : patch.bytesPerSecond,
    ),
    requiresAdmin:
      patch.requiresAdmin === undefined
        ? linuxPackageType() !== null
        : Boolean(patch.requiresAdmin),
    message:
      patch.message === undefined
        ? state.message
        : typeof patch.message === 'string'
          ? patch.message
          : '',
  };
  state = next;
  const window = getWindow();
  if (window && !window.isDestroyed()) {
    window.webContents.send('globalshare:update-state', state);
  }
  return state;
}

// 2 = barre indéterminée sous Windows/Linux ; -1 = aucune barre.
function setProgress(value) {
  const window = getWindow();
  if (!window || window.isDestroyed()) return;
  const number = Number(value);
  // -1 conserve sa signification : retirer la barre. Toute autre valeur
  // invalide devient indéterminée (2) plutôt que d'être passée à Electron.
  const progress = !Number.isFinite(number)
    ? 2
    : number < 0
      ? -1
      : number > 1
        ? 2
        : Math.min(1, number);
  window.setProgressBar(progress);
}

function sendUpdateState() {
  const window = getWindow();
  if (window && !window.isDestroyed()) window.webContents.send('globalshare:update-state', state);
}

// ---------------------------------------------------------------------------
// Installation des paquets Linux (rpm/deb). Un AppImage et Windows s'installent
// seuls via electron-updater, sans élévation.
// ---------------------------------------------------------------------------
function linuxPackageType() {
  if (process.platform !== 'linux' || process.env.APPIMAGE) return null;
  try {
    const type = fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim();
    return type === 'rpm' || type === 'deb' ? type : null;
  } catch {
    return null;
  }
}

function hasCommand(command) {
  return (process.env.PATH || '').split(path.delimiter).some((dir) => {
    if (!dir) return false;
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function installCommand(type, installer) {
  if (type === 'deb') return ['dpkg', ['-i', installer]];
  if (hasCommand('dnf')) return ['dnf', ['install', '--nogpgcheck', '-y', installer]];
  if (hasCommand('yum')) return ['yum', ['install', '--nogpgcheck', '-y', installer]];
  return ['rpm', ['-Uvh', '--replacepkgs', '--replacefiles', '--nodeps', installer]];
}

function elevatedCommand([command, args]) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return [command, args];
  // pkexec ouvre la boîte de mot de passe de la session, sans shell. Les
  // arguments doivent être dépliés (un tableau imbriqué serait joint en une
  // seule chaîne que dnf refuse).
  return hasCommand('pkexec') ? ['pkexec', [command, ...args]] : null;
}

function runCommand([command, args]) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (chunk) => {
      output = (output + String(chunk)).slice(-4000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => resolve({ ok: false, output: error.message }));
    child.on('close', (code) => resolve({ ok: code === 0, output: output.trim() }));
  });
}

// ---------------------------------------------------------------------------
// Actions exposées à l'interface
// ---------------------------------------------------------------------------
function checkForUpdates(options = {}) {
  const manual = Boolean(options.manual);

  if (manual) {
    dismissedVersion = null;
    // La vérification depuis le menu doit rendre l'encart visible dans l'app,
    // y compris en développement où l'on affiche pourquoi elle est désactivée.
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('globalshare:update-open');
  }
  if (!app.isPackaged) {
    publish({
      status: 'unsupported',
      message: 'Les mises à jour ne sont vérifiées que dans la version installée.',
    });
    return Promise.resolve(state);
  }
  if (checking) return Promise.resolve(state);

  checking = true;
  manualCheck = manual;
  publish({ status: 'checking', message: '', percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });

  // 1) Mise à jour rapide : manifeste du bundle web (~1 Ko). S'il annonce une
  // version compatible avec la coquille installée (nativeVersion identique),
  // inutile de consulter electron-updater : on proposera le zip web, pas le
  // paquet complet.
  return webUpdates
    .check()
    .catch(() => null)
    .then((info) => {
      if (info && info.available) {
        if (info.version === dismissedVersion) return state;
        pendingWeb = info;
        manualCheck = false;
        publish({
          status: 'available',
          version: info.version,
          mode: 'web',
          total: info.size || 0,
          message: `Version ${info.version} disponible — mise à jour rapide (${app.getVersion()} installée).`,
          percent: 0,
          transferred: 0,
          bytesPerSecond: 0,
        });
        return state;
      }
      pendingWeb = null;
      // 2) Paquet complet : electron-updater (deltas blockmap natifs pour
      // NSIS/AppImage). Un échec réseau silencieux garde le comportement
      // historique ci-dessous.
      return autoUpdater
        .checkForUpdates()
        .catch((error) => {
          // En arrière-plan, un réseau indisponible ne doit pas afficher d'erreur.
          publish({
            status: manual ? 'error' : state.status === 'checking' ? 'idle' : state.status,
            message: manual ? errorText(error, 'La vérification a échoué.') : '',
            percent: 0,
          });
        });
    })
    .finally(() => {
      checking = false;
    });
}

async function downloadUpdate() {
  if (downloading || installing || !app.isPackaged) return state;
  if (pendingWeb) return downloadWebUpdate(pendingWeb);

  downloading = true;
  dismissedVersion = null;
  publish({
    status: 'downloading',
    message: 'Téléchargement de la mise à jour…',
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
  });
  setProgress(0);

  try {
    const files = await autoUpdater.downloadUpdate();
    installerPath = Array.isArray(files) && files.length ? files[0] : typeof files === 'string' ? files : null;
    // L'événement update-downloaded publie normalement cet état ; ce garde-fou
    // couvre les versions d'electron-updater qui ne l'émettent pas.
    if (state.status === 'downloading') {
      setProgress(-1);
      publish({ status: 'downloaded', percent: 100, message: 'Mise à jour téléchargée.' });
    }
  } catch (error) {
    setProgress(-1);
    publish({
      status: 'error',
      message: errorText(error, 'Le téléchargement de la mise à jour a échoué.'),
      percent: 0,
    });
  } finally {
    downloading = false;
  }
  return state;
}

// Téléchargement du bundle web : quelques mégaoctets, vérification SHA-256 du
// manifeste, extraction locale. Aucun paquet système impliqué : l'application
// s'appuiera sur les fichiers extraits au prochain démarrage.
function downloadWebUpdate(info) {
  downloading = true;
  dismissedVersion = null;
  publish({
    status: 'downloading',
    version: info.version,
    mode: 'web',
    message: 'Téléchargement de la mise à jour…',
    percent: 0,
    transferred: 0,
    total: info.size || 0,
    bytesPerSecond: 0,
  });
  setProgress(0);

  let lastTime = Date.now();
  let lastBytes = 0;
  return webUpdates
    .download(info, (percent, transferred, total) => {
      const now = Date.now();
      const speed = now - lastTime >= 200 ? Math.round(((transferred - lastBytes) * 1000) / Math.max(1, now - lastTime)) : state.bytesPerSecond;
      if (now - lastTime >= 200) {
        lastTime = now;
        lastBytes = transferred;
      }
      publish({
        status: 'downloading',
        version: info.version,
        mode: 'web',
        percent,
        transferred,
        total,
        bytesPerSecond: speed,
        message: 'Téléchargement de la mise à jour…',
      });
      setProgress(Math.min(1, percent / 100));
    })
    .then(() => {
      downloading = false;
      setProgress(-1);
      publish({
        status: 'downloaded',
        version: info.version,
        mode: 'web',
        percent: 100,
        message: `${info.version} est prête à installer (sans redémarrage complet).`,
      });
    })
    .catch((error) => {
      downloading = false;
      pendingWeb = null;
      setProgress(-1);
      publish({
        status: 'error',
        mode: 'web',
        message: errorText(error, 'Le téléchargement de la mise à jour a échoué.'),
        percent: 0,
      });
    })
    .then(() => state);
}

async function installUpdate() {
  if (installing || downloading || state.status !== 'downloaded') return state;

  if (pendingWeb) {
    installing = true;
    publish({ status: 'installing', mode: 'web', message: 'Application de la mise à jour…', percent: 0 });
    try {
      const dir = webUpdates.apply(pendingWeb.version, pendingWeb.nativeVersion || 0);
      const version = pendingWeb.version;
      pendingWeb = null;
      dismissedVersion = null;
      publish({
        status: 'up-to-date',
        version,
        mode: 'web',
        percent: 0,
        message: `GlobalShare ${version} est appliquée.`,
      });
      // Rechargement de l'interface sur le nouveau bundle ; la coquille
      // (electron, paquet système) reste celle installée.
      if (applyWebRoot) applyWebRoot(dir);
    } catch (error) {
      pendingWeb = null;
      publish({
        status: 'error',
        mode: 'web',
        message: errorText(error, "L'application de la mise à jour a échoué."),
        percent: 0,
      });
    } finally {
      installing = false;
    }
    return state;
  }

  const type = linuxPackageType();
  if (!type) {
    // AppImage / Windows : aucune élévation nécessaire.
    installing = true;
    publish({ status: 'installing', message: 'Redémarrage et installation…' });
    setImmediate(() => autoUpdater.quitAndInstall());
    return state;
  }

  if (!installerPath || !fs.existsSync(installerPath)) {
    publish({ status: 'error', message: 'Le paquet téléchargé est introuvable. Relancez le téléchargement.' });
    return state;
  }
  const command = elevatedCommand(installCommand(type, installerPath));
  if (!command) {
    publish({
      status: 'error',
      message: 'pkexec est introuvable : le mot de passe administrateur ne peut pas être demandé.',
    });
    return state;
  }

  installing = true;
  publish({ status: 'installing', message: 'Installation en cours…', percent: 0 });
  // Valeur > 1 : barre indéterminée pendant la saisie du mot de passe.
  setProgress(2);
  const result = await runCommand(command);
  installing = false;
  setProgress(-1);

  if (!result.ok) {
    publish({
      status: 'error',
      message: (result.output || 'Le gestionnaire de paquets a refusé l’installation.').slice(-1500),
    });
    return state;
  }

  app.relaunch();
  app.exit(0);
  return state;
}

function dismissUpdate() {
  if (state.status === 'available' || state.status === 'downloaded') {
    dismissedVersion = state.version;
  }
  publish({ status: 'idle', message: '', percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
  return state;
}

function registerIpc() {
  ipcMain.handle('globalshare:update-state', () => publish({}));
  ipcMain.handle('globalshare:update-check', () => checkForUpdates({ manual: true }));
  ipcMain.handle('globalshare:update-download', () => downloadUpdate());
  ipcMain.handle('globalshare:update-install', () => installUpdate());
  ipcMain.handle('globalshare:update-dismiss', () => dismissUpdate());
}
registerIpc();

function initAutoUpdater(resolveWindow, options = {}) {
  getWindow = resolveWindow;
  applyWebRoot = typeof options.applyWebRoot === 'function' ? options.applyWebRoot : null;
  if (!app.isPackaged) return;

  // Le téléchargement et l'installation sont déclenchés depuis l'interface.
  autoUpdater.autoDownload = false;
  // Sur rpm/deb, l'installation à la fermeture gèlerait sur le mot de passe :
  // c'est installUpdate() qui s'en charge avec un processus non bloquant.
  autoUpdater.autoInstallOnAppQuit = linuxPackageType() === null;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('update-available', (info) => {
    const availableVersion = versionOf(info);
    manualCheck = false;
    // Un bundle web déjà appliqué fait foi : la coquille installée est plus
    // ancienne que la version qui tourne, electron-updater ne doit pas la
    // proposer de nouveau.
    const applied = webUpdates.appliedVersion();
    if (applied && webUpdates.compareVersions(availableVersion, applied) <= 0) {
      publish({
        status: 'up-to-date',
        version: applied,
        message: `GlobalShare est à jour (version ${webUpdates.effectiveVersion()}).`,
        percent: 0,
      });
      return;
    }
    if (availableVersion === dismissedVersion) return;
    publish({
      status: 'available',
      version: availableVersion,
      message: `Version ${availableVersion} disponible (${app.getVersion()} installée).`,
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
    });
  });

  autoUpdater.on('update-not-available', () => {
    manualCheck = false;
    publish({
      status: 'up-to-date',
      message: `GlobalShare est à jour (version ${app.getVersion()}).`,
      percent: 0,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    const info = progress && typeof progress === 'object' ? progress : {};
    publish({
      status: 'downloading',
      percent: info.percent,
      transferred: info.transferred,
      total: info.total,
      bytesPerSecond: info.bytesPerSecond,
      message: 'Téléchargement de la mise à jour…',
    });
    // Une progression absente/invalide affiche une barre indéterminée plutôt
    // qu'un 0 % trompeur : le téléchargement continue, on ne sait juste pas où.
    const rawPercent = Number(info.percent);
    setProgress(Number.isFinite(rawPercent) ? percent(rawPercent) / 100 : 2);
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloading = false;
    setProgress(-1);
    publish({
      status: 'downloaded',
      version: versionOf(info),
      percent: 100,
      message: `${versionOf(info)} est prête à installer.`,
    });
  });

  autoUpdater.on('error', (error) => {
    // Une vérification périodique échoue en silence ; dès que l'utilisateur est
    // impliqué (vérification manuelle, téléchargement, installation), on affiche.
    const visible = manualCheck || downloading || installing;
    downloading = false;
    installing = false;
    manualCheck = false;
    setProgress(-1);
    publish({
      status: visible ? 'error' : state.status === 'checking' ? 'idle' : state.status,
      message: visible ? errorText(error, 'La mise à jour a échoué.') : '',
      percent: 0,
    });
  });

  // Vérification au démarrage, puis toutes les six heures.
  setTimeout(() => checkForUpdates(), FIRST_CHECK_DELAY_MS);
  setInterval(() => checkForUpdates(), CHECK_INTERVAL_MS).unref?.();
}

module.exports = { checkForUpdates, initAutoUpdater, sendUpdateState };
