// Les « patch notes » de l'encart de mise à jour viennent de deux formats :
// le Markdown du CHANGELOG (bundle web) et le HTML du flux GitHub (APK).
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReleaseNotes, plainReleaseNotes } from '../app/lib/release-notes.ts';

test('les notes Markdown du CHANGELOG deviennent des sections lisibles', () => {
  const notes = parseReleaseNotes([
    '### Added',
    '- **File d’attente** : 2 envois simultanés.',
    '- Sélection multi-fichiers et glisser-déposer.',
    '',
    '### Fixed',
    '- Le bouton de partage du salon est centré.',
    '- `nativeVersion` passe à 10.',
  ].join('\n'));

  assert.deepEqual(notes, [
    {
      title: 'Nouveautés',
      items: ['File d’attente : 2 envois simultanés.', 'Sélection multi-fichiers et glisser-déposer.'],
    },
    {
      title: 'Corrections',
      items: ['Le bouton de partage du salon est centré.', 'nativeVersion passe à 10.'],
    },
  ]);
});

test('le HTML du flux GitHub est nettoyé et regroupé en sections', () => {
  const html = [
    '<h3>Added</h3><ul><li>Notes de version avant mise à jour</li>',
    '<li>Bouton <strong>centré</strong></li></ul>',
    '<h3>Fixed</h3><p>Crash &amp; fuite mémoire</p>',
  ].join('');

  assert.deepEqual(parseReleaseNotes(html), [
    { title: 'Nouveautés', items: ['Notes de version avant mise à jour', 'Bouton centré'] },
    { title: 'Corrections', items: ['Crash & fuite mémoire'] },
  ]);
});

test('les notes vides ou absentes ne produisent aucune section', () => {
  assert.deepEqual(parseReleaseNotes(''), []);
  assert.deepEqual(parseReleaseNotes('   '), []);
  assert.equal(plainReleaseNotes(null), '');
  assert.equal(plainReleaseNotes(42), '');
});
