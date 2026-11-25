// Récupération de la fenêtre de bureau sur GNOME/KDE : le tray peut être
// absent, il faut un repli visible et un raccourci global.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const main = readFileSync(`${root}desktop/main.js`, 'utf8');
const builder = readFileSync(`${root}electron-builder.yml`, 'utf8');
const require = createRequire(import.meta.url);
const { detectTrayHost, isGnomeSession } = require('../desktop/linux-tray.js');

test('un raccourci global ramène la fenêtre masquée', () => {
  assert.match(main, /globalShortcut/);
  assert.match(main, /globalShortcut\.register\(RESTORE_SHORTCUT, showMainWindow\)/);
  assert.match(main, /CommandOrControl\+Alt\+G/);
  assert.match(main, /globalShortcut\.unregisterAll\(\)/);
});

test('showMainWindow restaure et focus la fenêtre', () => {
  assert.match(main, /if \(mainWindow\.isMinimized\(\)\) mainWindow\.restore\(\)/);
  assert.match(main, /mainWindow\.focus\(\)/);
});

test('la fenêtre n est jamais exclue de la barre des tâches', () => {
  assert.match(main, /skipTaskbar: false/);
});

test('un transfert en cours empêche la fermeture et affiche une notification', () => {
  assert.match(main, /if \(activeTransfers > 0\)/);
  assert.match(main, /sendToBackground\(window, 'Transfert en cours/);
  assert.match(main, /notification\.on\('click', showMainWindow\)/);
});

test('GNOME sans hôte SNI minimise au lieu de cacher la fenêtre', () => {
  assert.match(main, /const \{ detectTrayHost, ensureGnomeTrayExtension \} = require\('\.\/linux-tray'\)/);
  assert.match(main, /trayHostAvailable/);
  assert.match(main, /if \(hasTray\) window\.hide\(\);\n  else window\.minimize\(\);/);
  assert.match(main, /showBackgroundNotification/);
  assert.match(main, /Afficher l’icône dans la barre \(GNOME\)/);
  assert.match(main, /ensureGnomeTrayExtension/);
});

test('la détection GNOME ne désactive le tray que sans watcher', async () => {
  assert.equal(isGnomeSession({ XDG_CURRENT_DESKTOP: 'GNOME' }), true);
  assert.equal(isGnomeSession({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), true);
  assert.equal(isGnomeSession({ XDG_CURRENT_DESKTOP: 'GNOME-Classic:GNOME' }), true);
  assert.equal(isGnomeSession({ XDG_CURRENT_DESKTOP: 'KDE' }), false);
  assert.equal(isGnomeSession({ XDG_CURRENT_DESKTOP: 'XFCE' }), false);

  assert.equal(
    await detectTrayHost({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'GNOME' }, probe: async () => false }),
    false
  );
  assert.equal(
    await detectTrayHost({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'GNOME' }, probe: async () => true }),
    true
  );
  assert.equal(
    await detectTrayHost({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'KDE' }, probe: async () => false }),
    true
  );
  assert.equal(
    await detectTrayHost({ platform: 'win32', env: { XDG_CURRENT_DESKTOP: 'GNOME' }, probe: async () => false }),
    true
  );
});

test('le tray utilise une icône 32 px dédiée, un état actif et les deux clics', () => {
  assert.match(main, /TRAY_IDLE_IMAGE/);
  assert.match(main, /TRAY_ACTIVE_IMAGE/);
  assert.match(main, /tray\.setImage\(image\)/);
  assert.match(main, /tray\.on\('double-click', showMainWindow\)/);
  assert.match(builder, /linux-tray\.js/);
  assert.match(builder, /from: desktop\/resources\/icons\/tray\.png/);
  assert.match(builder, /to: tray\.png/);
  assert.match(builder, /from: desktop\/resources\/icons\/tray-active\.png/);
  assert.match(builder, /to: tray-active\.png/);
});

test('le menu du tray expose l état, le dossier de réception et Quitter', () => {
  assert.match(main, /GlobalShare · \$\{trayStatusLabel\(\)\}/);
  assert.match(main, /Dossier de réception/);
  assert.match(main, /Ouvrir GlobalShare \(\$\{RESTORE_SHORTCUT_LABEL\}\)/);
  assert.match(main, /setContextMenu\(buildTrayMenu\(\)\)/);
  assert.match(main, /activeTransfers = Math\.max\(0, Number\(count\) \|\| 0\);\n    refreshTray\(\);/);
});

test('les deux icônes tray sont des PNG 32x32 RGBA distincts', () => {
  const idle = readFileSync(`${root}desktop/resources/icons/tray.png`);
  const active = readFileSync(`${root}desktop/resources/icons/tray-active.png`);
  for (const png of [idle, active]) {
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 32, 'largeur');
    assert.equal(png.readUInt32BE(20), 32, 'hauteur');
    assert.equal(png[25], 6, 'RGBA (fond transparent)');
  }
  assert.notDeepEqual(idle, active);
});

test('les paquets Linux recommandent AppIndicator sans l imposer', () => {
  assert.match(builder, /gnome-shell-extension-appindicator/);
  assert.match(builder, /libayatana-appindicator3-1/);
  assert.match(builder, /--rpm-tag/);
  assert.doesNotMatch(builder, /depends:\n\s+- gnome-shell-extension-appindicator/);
});

test('les autres chemins de restauration passent par showMainWindow', () => {
  assert.match(main, /app\.on\('second-instance', showMainWindow\)/);
});

test('identité de portail Wayland et WM_CLASS alignées', () => {
  const desktopPkg = JSON.parse(readFileSync(`${root}desktop/package.json`, 'utf8')) as { desktopName: string };
  assert.equal(desktopPkg.desktopName, 'io.github.stxtxm.globalshare.desktop');
  assert.match(builder, /StartupWMClass: globalshare/);
});

test('AppIndicator est chargée à chaud via gnome-extensions', async () => {
  const { ensureGnomeTrayExtension, parseStringArray, formatStringArray } = require('../desktop/linux-tray.js');
  const uuid = 'appindicatorsupport@rgcjonas.gmail.com';
  assert.deepEqual(parseStringArray("['background-logo@fedorahosted.org']"), ['background-logo@fedorahosted.org']);
  assert.deepEqual(parseStringArray('@as []'), []);
  assert.equal(formatStringArray(['a@x', uuid]), `['a@x', '${uuid}']`);

  const dir = mkdtempSync(path.join(os.tmpdir(), 'gs-ext-'));
  try {
    const calls: [string, string[]][] = [];
    const make = (current: string, installed = true, cliFails = false) => {
      if (installed) mkdirSync(path.join(dir, uuid), { recursive: true });
      return {
        dirs: [installed ? dir : path.join(dir, 'absent')],
        env: { XDG_CURRENT_DESKTOP: 'GNOME' },
        execFileImpl: (
          cmd: string,
          args: string[],
          _opts: unknown,
          cb: (error: Error | null, stdout: string) => void,
        ) => {
          calls.push([cmd, args]);
          if (cmd === 'gnome-extensions') {
            if (cliFails) cb(new Error('commande absente'), '');
            else cb(null, '');
          } else if (args[0] === 'get') cb(null, current);
          else cb(null, '');
        },
      };
    };

    assert.equal(await ensureGnomeTrayExtension({ ...make("@as []"), env: { XDG_CURRENT_DESKTOP: 'KDE' } }), 'skipped');
    assert.equal(await ensureGnomeTrayExtension({ ...make("@as []", false) }), 'missing');
    assert.equal(calls.length, 0);

    // Commande disponible : chargement immédiat, gsettings n'est que lu.
    assert.equal(await ensureGnomeTrayExtension(make("@as []")), 'enabled');
    assert.deepEqual(calls.at(-1), ['gnome-extensions', ['enable', uuid]]);
    assert.equal(calls.filter(([cmd, args]) => cmd === 'gsettings' && args[0] === 'set').length, 0);

    // Déjà listée : on demande quand même le chargement (session démarrée
    // avant l'installation de l'extension).
    calls.length = 0;
    assert.equal(await ensureGnomeTrayExtension(make(`['${uuid}']`)), 'already');
    assert.deepEqual(calls.map(([cmd, args]) => [cmd, args[0]]), [
      ['gsettings', 'get'],
      ['gnome-extensions', 'enable'],
    ]);

    // Sans la commande : repli gsettings, effectif à la reconnexion.
    calls.length = 0;
    assert.equal(await ensureGnomeTrayExtension(make('@as []', true, true)), 'enabled');
    assert.deepEqual(calls.at(-1), ['gsettings', ['set', 'org.gnome.shell', 'enabled-extensions',
      `['${uuid}']`]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main.js charge AppIndicator avant le tray et retente si l hôte arrive en retard', () => {
  assert.match(main, /ensureGnomeTray\(\)/);
  assert.match(main, /gnomeTrayExtension === 'done-2'/);
  assert.match(main, /retryTrayHost/);
  assert.match(main, /TRAY_RETRY_DELAYS/);
  assert.match(main, /await ensureGnomeTray\(\);\n  await initTray\(\);/);
});
