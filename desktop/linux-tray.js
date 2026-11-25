'use strict';

// GNOME n'a pas de zone de notification native : il faut l'extension
// AppIndicator, qui expose le watcher StatusNotifierItem sur la session D-Bus.
// KDE, XFCE, MATE et Cinnamon ont leur propre hôte ; on ne les sonde pas.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APPINDICATOR_UUID = 'appindicatorsupport@rgcjonas.gmail.com';
const EXTENSION_DIRS = [
  '/usr/share/gnome-shell/extensions',
  path.join(os.homedir(), '.local/share/gnome-shell/extensions'),
];

const WATCHER = 'org.kde.StatusNotifierWatcher';
const WATCHER_PATH = '/StatusNotifierWatcher';

function isGnomeSession(env = process.env) {
  const desktop = `${env.XDG_CURRENT_DESKTOP || ''} ${env.DESKTOP_SESSION || ''}`;
  return /(^|[^a-z])(gnome|ubuntu)([^a-z]|$)/i.test(desktop);
}

/**
 * Vrai si un hôte SNI répond. Si gdbus n'est pas installé, on ne peut pas
 * conclure : on laisse le tray activé pour ne pas casser KDE/XFCE.
 */
function probeStatusNotifier({ execFileImpl = execFile, timeout = 1500 } = {}) {
  return new Promise((resolve) => {
    execFileImpl(
      'gdbus',
      ['introspect', '--session', '--dest', WATCHER, '--object-path', WATCHER_PATH],
      { timeout },
      (error) => {
        if (error && error.code === 'ENOENT') {
          resolve(true);
          return;
        }
        resolve(!error);
      }
    );
  });
}

async function detectTrayHost({
  env = process.env,
  platform = process.platform,
  probe = probeStatusNotifier,
} = {}) {
  if (platform !== 'linux') return true;
  if (!isGnomeSession(env)) return true;
  return probe();
}

function isExtensionInstalled(uuid = APPINDICATOR_UUID, dirs = EXTENSION_DIRS) {
  return dirs.some((dir) => fs.existsSync(path.join(dir, uuid)));
}

// Sortie de `gsettings get` : `['a', 'b']` ou `@as []`.
function parseStringArray(text) {
  return [...String(text).matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

function formatStringArray(values) {
  return `[${values.map((value) => `'${value}'`).join(', ')}]`;
}

function runGsettings(args, { execFileImpl = execFile, timeout = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl('gsettings', args, { timeout }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

/**
 * Ajoute AppIndicator à la liste des extensions activées de GNOME. GNOME ne
 * charge une extension qu'à l'ouverture de session : l'icône apparaît donc
 * après une reconnexion. Renvoie 'skipped', 'missing', 'already' ou 'enabled'.
 */
async function ensureGnomeTrayExtension({
  env = process.env,
  platform = process.platform,
  dirs = EXTENSION_DIRS,
  execFileImpl = execFile,
} = {}) {
  if (platform !== 'linux' || !isGnomeSession(env)) return 'skipped';
  if (!isExtensionInstalled(APPINDICATOR_UUID, dirs)) return 'missing';
  const options = { execFileImpl };
  const current = parseStringArray(
    await runGsettings(['get', 'org.gnome.shell', 'enabled-extensions'], options)
  );
  if (current.includes(APPINDICATOR_UUID)) return 'already';
  await runGsettings(
    ['set', 'org.gnome.shell', 'enabled-extensions', formatStringArray([...current, APPINDICATOR_UUID])],
    options
  );
  return 'enabled';
}

module.exports = {
  detectTrayHost,
  isGnomeSession,
  probeStatusNotifier,
  ensureGnomeTrayExtension,
  parseStringArray,
  formatStringArray,
};
