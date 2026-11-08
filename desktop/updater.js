'use strict';

const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 8_000;

let getWindow = () => null;
let checking = false;
let downloading = false;
let manualCheck = false;
let promptedVersion = null;

// rpm et deb s'installent via pkexec/sudo : l'utilisateur devra saisir son mot
// de passe au moment de l'installation. Un AppImage se remplace sans rien
// demander (process.env.APPIMAGE n'est défini que dans ce cas).
const needsElevation = () => process.platform === 'linux' && !process.env.APPIMAGE;

function messageBox(options) {
  const window = getWindow();
  return window && !window.isDestroyed()
    ? dialog.showMessageBox(window, options)
    : dialog.showMessageBox(options);
}

async function promptDownload(info) {
  if (downloading || info.version === promptedVersion) return;
  promptedVersion = info.version;

  const { response } = await messageBox({
    type: 'info',
    title: 'Mise à jour disponible',
    message: `GlobalShare ${info.version} est disponible.`,
    detail:
      `Vous utilisez la version ${app.getVersion()}. ` +
      "La mise à jour se télécharge en arrière-plan puis s'installe au redémarrage.",
    buttons: ['Télécharger', 'Plus tard'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return;

  downloading = true;
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    downloading = false;
    promptedVersion = null;
    reportError(error, true);
  }
}

async function promptInstall(info) {
  downloading = false;
  const window = getWindow();
  if (window && !window.isDestroyed()) window.setProgressBar(-1);

  const { response } = await messageBox({
    type: 'info',
    title: 'Mise à jour prête',
    message: `GlobalShare ${info.version} est téléchargée.`,
    detail: needsElevation()
      ? "L'installation du paquet (rpm/deb) demande le mot de passe administrateur via l'invite du système. " +
        "« Plus tard » installera la mise à jour à la fermeture de l'application."
      : "Redémarrez pour utiliser la nouvelle version. « Plus tard » l'installera à la fermeture de l'application.",
    buttons: ['Redémarrer et installer', 'Plus tard'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (response === 0) {
    // Laisse le dialogue se fermer avant que l'application ne quitte.
    setImmediate(() => autoUpdater.quitAndInstall());
  }
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

  // Le téléchargement est déclenché par l'utilisateur, l'installation peut
  // attendre la fermeture de l'application.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
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
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      window.setProgressBar(Math.min(1, Math.max(0, progress.percent / 100)));
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    void promptInstall(info);
  });

  autoUpdater.on('error', (error) => {
    downloading = false;
    reportError(error, manualCheck);
    manualCheck = false;
  });

  // Une vérification au démarrage, puis toutes les six heures pour une
  // application qui reste ouverte longtemps.
  setTimeout(() => checkForUpdates(), FIRST_CHECK_DELAY_MS);
  setInterval(() => checkForUpdates(), CHECK_INTERVAL_MS).unref?.();
}

module.exports = { checkForUpdates, initAutoUpdater };
