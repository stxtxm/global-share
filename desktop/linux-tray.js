'use strict';

// GNOME n'a pas de zone de notification native : il faut l'extension
// AppIndicator, qui expose le watcher StatusNotifierItem sur la session D-Bus.
// KDE, XFCE, MATE et Cinnamon ont leur propre hôte ; on ne les sonde pas.
const { execFile } = require('node:child_process');

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

module.exports = { detectTrayHost, isGnomeSession, probeStatusNotifier };
