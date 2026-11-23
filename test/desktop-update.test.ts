// Mise à jour Linux : pkexec/polkit/PackageKit doivent échouer de façon
// actionnable, avec repli « Ouvrir le paquet » / « Copier dans Fichiers ».
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

test('l installation Linux préfère pkexec puis replie sur PackageKit si pkexec est inutilisable', () => {
  assert.match(updater, /function pkconCommand/);
  assert.match(updater, /\['pkcon', \['--allow-untrusted', 'install-local', '-y', installer\]\]/);
  assert.match(updater, /const elevated = elevatedCommand\(installCommand\(type, installerPath\)\);/);
  assert.match(updater, /const fallback = pkconCommand\(installerPath\);/);
  assert.match(updater, /const command = elevated \|\| fallback;/);
  assert.match(updater, /function isElevationUnavailable\(output\)/);
  assert.match(updater, /if \(!result\.ok && elevated && fallback && isElevationUnavailable\(result\.output\)\)/);
  assert.match(updater, /result = await runCommand\(fallback\);/);
});

test('les erreurs polkit/PackageKit sont traduites en message actionnable', () => {
  assert.match(updater, /function friendlyInstallError/);
  assert.match(updater, /must be setuid root/);
  assert.match(updater, /no authentication agent/i);
  assert.match(updater, /no session for cookie/i);
  assert.match(updater, /need-untrusted/);
  assert.match(updater, /package-install-untrusted/);
  assert.match(updater, /PackageKit considère ce paquet local comme non fiable/);
  assert.match(updater, /Authentification administrateur refusée ou annulée/);
  assert.match(updater, /sudo dnf install --nogpgcheck/);
  assert.match(updater, /Ouvrir le paquet/);
});

test('la commande d installation a un garde-fou de temps', () => {
  assert.match(updater, /5 \* 60_000/);
  assert.match(updater, /\[TIMEOUT\]/);
});

test("PackageKit/pkcon et l'alternative de copie vers les Fichiers", () => {
  assert.match(updater, /hasCommand\('pkcon'\)/);
  assert.match(updater, /async function revealInstaller/);
  assert.match(updater, /freeFileName\(dir, safeFileName/);
  assert.match(preload, /revealInstaller: \(\) => ipcRenderer\.invoke\('globalshare:update-reveal-installer'\)/);
  assert.match(ui, /label: 'Ouvrir le paquet'/);
  assert.match(ui, /label: 'Copier dans Fichiers'/);
  assert.match(ui, /label: 'Retenter l’installation'/);
});

test("l'état publie installerPath pour les boutons de repli", () => {
  assert.match(updater, /installerPath: patch\.installerPath === undefined/);
  assert.match(ui, /state\.installerPath/);
});

test('le repli ouvre le paquet puis son dossier', () => {
  assert.match(updater, /async function openInstaller/);
  assert.match(updater, /shell\.openPath\(installerPath\)/);
  assert.match(updater, /path\.dirname\(installerPath\)/);
  assert.match(updater, /'globalshare:update-open-installer'/);
  assert.match(preload, /openInstaller: \(\) => ipcRenderer\.invoke\('globalshare:update-open-installer'\)/);
});
