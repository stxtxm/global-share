// Mise à jour Linux : pkexec doit transmettre l'environnement graphique et un
// repli « Ouvrir le paquet » doit rester disponible quand polkit échoue.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const updater = readFileSync(`${root}desktop/updater.js`, 'utf8');
const preload = readFileSync(`${root}desktop/preload.js`, 'utf8');
const ui = readFileSync(`${root}app/components/UpdateManager.tsx`, 'utf8');

test('pkexec transmet DISPLAY, DBUS et XDG_RUNTIME_DIR', () => {
  assert.match(updater, /'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS'/);
  assert.match(updater, /'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'XDG_CURRENT_DESKTOP'/);
  assert.match(updater, /\['pkexec', \['env', \.\.\.passthrough, command, \.\.\.args\]\]/);
});

test('les erreurs polkit sont traduites en message actionnable', () => {
  assert.match(updater, /function friendlyInstallError/);
  assert.match(updater, /requires root/);
  assert.match(updater, /Ouvrir le paquet/);
});

test('le repli ouvre le paquet puis son dossier', () => {
  assert.match(updater, /async function openInstaller/);
  assert.match(updater, /shell\.openPath\(installerPath\)/);
  assert.match(updater, /path\.dirname\(installerPath\)/);
  assert.match(updater, /'globalshare:update-open-installer'/);
  assert.match(preload, /openInstaller: \(\) => ipcRenderer\.invoke\('globalshare:update-open-installer'\)/);
});

test("l'encart propose Ouvrir le paquet en cas d'erreur", () => {
  assert.match(ui, /openInstaller: \(\) => void getBridge\(\)\?\.openInstaller/);
  assert.match(ui, /label: 'Ouvrir le paquet'/);
});
