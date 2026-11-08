'use strict';

const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 8_000;

let getWindow = () => null;
let checking = false;
let downloading = false;
let installing = false;
let manualCheck = false;
let promptedVersion = null;

function messageBox(options) {
  const window = getWindow();
  return window && !window.isDestroyed()
    ? dialog.showMessageBox(window, options)
    : dialog.showMessageBox(options);
}

function setProgress(value) {
  const window = getWindow();
  if (window && !window.isDestroyed()) window.setProgressBar(value);
}

// Type du paquet Linux installé, écrit par electron-builder dans
// resources/package-type. Un AppImage (et Windows) renvoie null : sa mise à
// jour s'installe toute seule, sans mot de passe.
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

// electron-updater 6 installe les rpm/deb avec un spawnSync sous pkexec : le
// processus principal reste gelé pendant la saisie du mot de passe (le bureau
// propose alors de forcer la fermeture) et un échec n'est pas remonté.
// Le téléchargement reste celui d'electron-updater ; l'installation est faite
// ici, sans bloquer, avec les erreurs du gestionnaire de paquets affichées.
function installCommand(type, installerPath) {
  if (type === 'deb') return ['dpkg', ['-i', installerPath]];
  if (hasCommand('dnf')) return ['dnf', ['install', '--nogpgcheck', '-y', installerPath]];
  if (hasCommand('yum')) return ['yum', ['install', '--nogpgcheck', '-y', installerPath]];
  return ['rpm', ['-Uvh', '--replacepkgs', '--replacefiles', '--nodeps', installerPath]];
}

function elevatedCommand([command, args]) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return [command, args];
  // pkexec ouvre la boîte de mot de passe de la session (polkit), sans shell.
  // Les arguments doivent être dépliés : un tableau imbriqué serait converti
  // en une seule chaîne « install,--nogpgcheck,… » que dnf refuse.
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

function reportError(error, alwaysShow) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[updater] ${message}`);
  if (!alwaysShow) return;
  void messageBox({
    type: 'error',
    title: 'Mise à jour impossible',
    message: 'La mise à jour a échoué.',
    detail: `${message}\n\nVous pouvez retélécharger GlobalShare depuis les releases GitHub.`,
    buttons: ['Fermer'],
    noLink: true,
  });
}

function reportInstallFailure(detail, installerPath) {
  console.error(`[updater] ${detail}`);
  void messageBox({
    type: 'error',
    title: 'Mise à jour impossible',
    message: "L'installation de la mise à jour a échoué.",
    detail:
      (installerPath ? `Le paquet téléchargé est conservé ici :\n${installerPath}\n\n` : '') +
      detail +
      '\n\nVous pouvez aussi installer la nouvelle version depuis les releases GitHub.',
    buttons: ['Fermer'],
    noLink: true,
  });
}

async function installLinuxPackage(info, installerPath) {
  const type = linuxPackageType();
  const command = elevatedCommand(installCommand(type, installerPath));
  if (!command) {
    reportInstallFailure(
      "pkexec est introuvable : le mot de passe administrateur ne peut pas être demandé.",
      installerPath,
    );
    return;
  }

  installing = true;
  setProgress(2); // barre indéterminée pendant l'installation
  const result = await runCommand(command);
  installing = false;
  setProgress(-1);

  if (!result.ok) {
    reportInstallFailure(result.output || "Le gestionnaire de paquets a refusé l'installation.", installerPath);
    return;
  }

  // Le paquet installé remplace l'application : on relance la nouvelle version.
  app.relaunch();
  app.exit(0);
}

async function promptInstall(info, installerPath) {
  downloading = false;
  setProgress(-1);
  const isPackage = linuxPackageType() !== null;

  const { response } = await messageBox({
    type: 'info',
    title: 'Mise à jour prête',
    message: `GlobalShare ${info.version} est téléchargée.`,
    detail: isPackage
      ? "L'installation demande le mot de passe administrateur dans la fenêtre du système, puis GlobalShare redémarre. " +
        '« Plus tard » n’installe rien maintenant.'
      : 'GlobalShare va redémarrer pour utiliser la nouvelle version.',
    buttons: ['Installer et redémarrer', 'Plus tard'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return;

  if (!isPackage) {
    // AppImage et Windows : electron-updater sait installer sans élévation.
    setImmediate(() => autoUpdater.quitAndInstall());
    return;
  }

  if (!installerPath) {
    reportInstallFailure("Le fichier téléchargé est introuvable.", null);
    return;
  }

  await installLinuxPackage(info, installerPath);
}

async function promptDownload(info) {
  if (downloading || installing || info.version === promptedVersion) return;
  promptedVersion = info.version;

  const { response } = await messageBox({
    type: 'info',
    title: 'Mise à jour disponible',
    message: `GlobalShare ${info.version} est disponible.`,
    detail:
      `Vous utilisez la version ${app.getVersion()}. ` +
      'La mise à jour se télécharge en arrière-plan ; vous choisirez ensuite de l’installer.',
    buttons: ['Télécharger', 'Plus tard'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return;

  downloading = true;
  try {
    const files = await autoUpdater.downloadUpdate();
    const installerPath = Array.isArray(files) ? files[0] : undefined;
    await promptInstall(info, installerPath);
  } catch (error) {
    downloading = false;
    promptedVersion = null;
    reportError(error, true);
  }
}

function checkForUpdates(options = {}) {
  const manual = Boolean(options.manual);

  if (!app.isPackaged) {
    if (manual) {
      void messageBox({
        type: 'info',
        title: 'Mise à jour',
        message: 'Les mises à jour ne sont vérifiées que dans la version installée.',
        buttons: ['Fermer'],
        noLink: true,
      });
    }
    return;
  }
  if (checking) return;

  checking = true;
  manualCheck = manual;
  autoUpdater
    .checkForUpdates()
    .catch((error) => reportError(error, manual))
    .finally(() => {
      checking = false;
    });
}

function initAutoUpdater(resolveWindow) {
  getWindow = resolveWindow;
  if (!app.isPackaged) return;

  // Le téléchargement est déclenché par l'utilisateur, l'installation aussi.
  autoUpdater.autoDownload = false;
  // Sur rpm/deb, l'installation à la fermeture d'electron-updater gèle le
  // processus sur la boîte de mot de passe : cette voie est désactivée, c'est
  // installLinuxPackage() qui s'en charge.
  autoUpdater.autoInstallOnAppQuit = linuxPackageType() === null;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('update-available', (info) => {
    if (manualCheck) manualCheck = false;
    void promptDownload(info);
  });

  autoUpdater.on('update-not-available', () => {
    if (!manualCheck) return;
    manualCheck = false;
    void messageBox({
      type: 'info',
      title: 'Mise à jour',
      message: 'GlobalShare est à jour.',
      detail: `Version installée : ${app.getVersion()}.`,
      buttons: ['Fermer'],
      noLink: true,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    setProgress(Math.min(1, Math.max(0, progress.percent / 100)));
  });

  autoUpdater.on('error', (error) => {
    // Une vérification périodique échoue en silence ; dès que l'utilisateur a
    // demandé le téléchargement ou l'installation, l'erreur est affichée.
    const visible = manualCheck || downloading || installing;
    downloading = false;
    installing = false;
    reportError(error, visible);
    manualCheck = false;
  });

  // Une vérification au démarrage, puis toutes les six heures pour une
  // application qui reste ouverte longtemps.
  setTimeout(() => checkForUpdates(), FIRST_CHECK_DELAY_MS);
  setInterval(() => checkForUpdates(), CHECK_INTERVAL_MS).unref?.();
}

module.exports = { checkForUpdates, initAutoUpdater };
