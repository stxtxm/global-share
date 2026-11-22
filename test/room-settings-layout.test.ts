// Le salon ne doit proposer qu'un seul accès aux réglages : le bouton du haut,
// à gauche, visible sur mobile. L'ancien 4e bouton de la barre d'action
// débordait de la grille à 3 colonnes sur les écrans étroits (Pixel 9a).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const component = readFileSync(`${root}app/components/GlobalShare.tsx`, 'utf8');
const css = readFileSync(`${root}app/components/GlobalShare.css`, 'utf8');

test('la barre d’action du salon contient exactement trois boutons', () => {
  const start = component.indexOf('<div className="gs-actionbar-row">');
  assert.notEqual(start, -1, 'barre d’action introuvable');
  const end = component.indexOf('</div>', start);
  const row = component.slice(start, end);
  assert.equal((row.match(/<button/g) ?? []).length, 3);
  assert.ok(!row.includes('setRoomSettingsOpen'), 'le bouton réglages ne doit plus être en bas');
});

test('le bouton réglages du haut est visible sur mobile et placé à gauche', () => {
  const headerStart = component.indexOf('<header className="gs-topbar">');
  const headerEnd = component.indexOf('</header>', headerStart);
  const header = component.slice(headerStart, headerEnd);
  const settings = header.indexOf('setRoomSettingsOpen');
  assert.notEqual(settings, -1, 'bouton réglages du haut introuvable');
  assert.ok(settings < header.indexOf('<div className="gs-topbar-right">'), 'le bouton doit être à gauche');
  assert.ok(!header.slice(settings - 200, settings).includes('gs-hide-on-mobile'), 'doit rester visible sur mobile');
  assert.ok(css.includes('.gs-topbar-left'), 'groupe gauche absent du CSS');
  assert.ok(!css.includes('gs-hide-on-mobile'), 'ancienne règle mobile toujours présente');
});

test('le libellé « Salon » s’efface sur les écrans étroits', () => {
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*?\.gs-room-chip-label\s*\{\s*display:\s*none/);
});
