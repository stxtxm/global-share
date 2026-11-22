// Le bouton « Fichiers » doit ouvrir le gestionnaire du système, y compris
// Google Files sur Pixel. On verrouille la chaîne de repli et la visibilité
// des paquets dans le manifeste (régressions vues sur Pixel 9a).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const plugin = readFileSync(
  `${root}android/app/src/main/java/io/github/stxtxm/globalshare/GlobalShareNativePlugin.java`,
  'utf8'
);
const manifest = readFileSync(`${root}android/app/src/main/AndroidManifest.xml`, 'utf8');
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { nativeVersion: number };

test('revealDownload essaie DocumentsUI puis Google Files puis le sélecteur', () => {
  assert.match(plugin, /DocumentsContract\.buildDocumentUri/);
  assert.match(plugin, /com\.google\.android\.apps\.nbu\.files/);
  assert.match(plugin, /Intent\.ACTION_OPEN_DOCUMENT/);
  assert.match(plugin, /getLaunchIntentForPackage/);
});

test('le manifeste rend les gestionnaires visibles sur Android 11+', () => {
  assert.match(manifest, /<package android:name="com\.google\.android\.apps\.nbu\.files"/);
  assert.match(manifest, /<package android:name="com\.android\.documentsui"/);
  assert.match(manifest, /android:name="android\.intent\.action\.OPEN_DOCUMENT"/);
});

test('la surface native a changé : nativeVersion est incrémenté', () => {
  assert.equal(pkg.nativeVersion, 4);
});

test('listDownloads lit MediaStore et le dossier legacy', () => {
  assert.match(plugin, /void listDownloads\(PluginCall call\)/);
  assert.match(plugin, /MediaStore\.Downloads\.EXTERNAL_CONTENT_URI/);
  assert.match(plugin, /RELATIVE_PATH/);
});
