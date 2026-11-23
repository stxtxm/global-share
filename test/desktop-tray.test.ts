// Récupération de la fenêtre de bureau sur GNOME/KDE : le tray peut être
// absent, il faut un repli visible et un raccourci global.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.match(main, /const \{ detectTrayHost \} = require\('\.\/linux-tray'\)/);
  assert.match(main, /trayHostAvailable/);
  assert.match(main, /if \(hasTray\) window\.hide\(\);\n  else window\.minimize\(\);/);
  assert.match(main, /showBackgroundNotification/);
  assert.match(main, /Afficher l’icône dans la barre \(GNOME\)/);
  assert.match(main, /gnome-extensions enable appindicatorsupport@rgcjonas\.gmail\.com/);
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

test('le tray utilise une icône 32 px dédiée et les deux clics', () => {
  assert.match(main, /TRAY_ICON_FILE/);
  assert.match(main, /image\.isEmpty\(\)/);
  assert.match(main, /tray\.on\('double-click', showMainWindow\)/);
  assert.match(builder, /linux-tray\.js/);
  assert.match(builder, /from: desktop\/resources\/icons\/tray\.png/);
  assert.match(builder, /to: tray\.png/);
});

test('l icône tray est un PNG 32x32 avec transparence', () => {
  const png = readFileSync(`${root}desktop/resources/icons/tray.png`);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 32, 'largeur');
  assert.equal(png.readUInt32BE(20), 32, 'hauteur');
  assert.equal(png[25], 6, 'RGBA (fond transparent)');
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
