// Le panneau de réglages est intégré à GlobalShare : ses libellés doivent
// suivre la langue choisie, avec un repli sûr vers le français.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ACCENT_SWATCHES, translate } from '../app/lib/settings-i18n.ts';

test('les libellés sont traduits dans les cinq langues proposées', () => {
  assert.equal(translate('fr', 'settings'), 'Réglages');
  assert.equal(translate('en', 'settings'), 'Settings');
  assert.equal(translate('es', 'settings'), 'Configuración');
  assert.equal(translate('de', 'settings'), 'Einstellungen');
  assert.equal(translate('it', 'settings'), 'Impostazioni');
});

test('une langue inconnue ou une clé absente retombe sur le français', () => {
  assert.equal(translate('xx', 'settings'), 'Réglages');
  assert.equal(translate('en', 'cleInexistante'), 'cleInexistante');
  assert.equal(translate('fr', 'appearance'), 'Apparence');
});

test('les espaces réservés sont remplacés dans les dialogues', () => {
  assert.equal(
    translate('en', 'confirmRemoveFile', { name: 'photo.zip' }),
    'Remove “photo.zip” from the list?'
  );
  assert.equal(
    translate('fr', 'confirmOverwriteFile', { name: 'film.mp4' }),
    '« film.mp4 » a déjà été reçu. Remplacer l’entrée existante ?'
  );
});

test('chaque couleur d’accent possède un libellé traduit', () => {
  assert.equal(ACCENT_SWATCHES.length, 10);
  for (const swatch of ACCENT_SWATCHES) {
    for (const lang of ['fr', 'en', 'es', 'de', 'it']) {
      assert.notEqual(translate(lang, swatch.labelKey), swatch.labelKey);
    }
  }
});
