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

test('revealDownload utilise ACTION_OPEN_DOCUMENT_TREE, puis replis packet', () => {
  assert.match(plugin, /Intent\.ACTION_OPEN_DOCUMENT_TREE/);
  assert.match(plugin, /DocumentsContract\.EXTRA_INITIAL_URI/);
  assert.match(plugin, /getLaunchIntentForPackage\(pkg\)/);
  assert.match(manifest, /com\.google\.android\.apps\.nbu\.files/);
  assert.match(plugin, /Intent\.ACTION_OPEN_DOCUMENT/);
  assert.match(plugin, /Intent\.createChooser\(view, "Ouvrir le dossier avec"\)/);
  assert.match(plugin, /FLAG_GRANT_READ_URI_PERMISSION/);
});

test('le manifeste rend les gestionnaires visibles sur Android 11+', () => {
  assert.match(manifest, /<package android:name="com\.google\.android\.apps\.nbu\.files"/);
  assert.match(manifest, /<package android:name="com\.android\.documentsui"/);
  assert.match(manifest, /android:name="android\.intent\.action\.OPEN_DOCUMENT"/);
});

test('la surface native a changé : nativeVersion est incrémenté', () => {
  // v1.0.51 : UpdateManager lit les notes de version (patch notes) pour l'APK.
  assert.equal(pkg.nativeVersion, 10);
});

test('deleteDownload supprime le fichier MediaStore ou le fichier legacy', () => {
  assert.match(plugin, /void deleteDownload\(PluginCall call\)/);
  assert.match(plugin, /getContentResolver\(\)\.delete/);
  assert.match(plugin, /MediaStore\.Downloads\.EXTERNAL_CONTENT_URI/);
  assert.match(plugin, /DIRECTORY_DOWNLOADS/);
});

test('listDownloads lit MediaStore et le dossier legacy', () => {
  assert.match(plugin, /void listDownloads\(PluginCall call\)/);
  assert.match(plugin, /MediaStore\.Downloads\.EXTERNAL_CONTENT_URI/);
  assert.match(plugin, /RELATIVE_PATH/);
});
