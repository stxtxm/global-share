// Récupération de la fenêtre de bureau sur GNOME/KDE : le tray peut être
// masqué, il faut un raccourci global et une fenêtre jamais exclue du taskbar.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const main = readFileSync(`${root}desktop/main.js`, 'utf8');

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
  assert.match(main, /notification\.on\('click', showMainWindow\)/);
});

test('le tray utilise une icône dédiée et les deux clics', () => {
  assert.match(main, /TRAY_ICON_FILE/);
  assert.match(main, /image\.isEmpty\(\)/);
  assert.match(main, /tray\.on\('double-click', showMainWindow\)/);
});

test('les autres chemins de restauration passent par showMainWindow', () => {
  assert.match(main, /app\.on\('second-instance', showMainWindow\)/);
});

test('identité de portail Wayland et WM_CLASS alignées', () => {
  const desktopPkg = JSON.parse(readFileSync(`${root}desktop/package.json`, 'utf8')) as { desktopName: string };
  const builder = readFileSync(`${root}electron-builder.yml`, 'utf8');
  assert.equal(desktopPkg.desktopName, 'io.github.stxtxm.globalshare.desktop');
  assert.match(builder, /StartupWMClass: globalshare/);
  assert.match(builder, /to: tray\.png/);
});
