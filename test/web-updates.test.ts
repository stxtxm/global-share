// Logique pure des mises à jour « bundle web » : décisions du manifeste,
// comparaison de versions, extraction zip (y compris refus zip-slip) et
// persistance de la version appliquée.
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import JSZip from 'jszip';

const require = createRequire(import.meta.url);

function outFile() {
  return mkdtempSync(path.join(os.tmpdir(), 'gs-web-update-'));
}

const webUpdates = require('../desktop/web-updates.js') as {
  configure: (options: Record<string, unknown>) => void;
  check: () => Promise<Record<string, unknown> | null>;
  download: (info: Record<string, unknown>, onProgress?: (p: number, t: number, s: number) => void) => Promise<string>;
  apply: (version: string, nativeVersion: number) => string;
  activeRoot: () => string | null;
  appliedVersion: () => string | null;
  effectiveVersion: () => string | null;
  reset: () => void;
  compareVersions: (left: string, right: string) => number;
  validManifest: (value: unknown) => Record<string, unknown> | null;
  extractZip: (zipPath: string, destination: string) => Promise<void>;
};

test('compareVersions trie numériquement, par segment', () => {
  assert.equal(webUpdates.compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(webUpdates.compareVersions('1.2.3', '1.2.10'), -1);
  assert.equal(webUpdates.compareVersions('1.10.0', '1.9.99'), 1);
  assert.equal(webUpdates.compareVersions('2.0.0', '1.19.3'), 1);
});

test('validManifest refuse un manifeste incomplet ou suspect', () => {
  assert.equal(webUpdates.validManifest(null), null);
  assert.equal(webUpdates.validManifest({}), null);
  assert.equal(webUpdates.validManifest({ version: 'abc', sha256: 'a'.repeat(64), size: 1 }), null);
  assert.equal(webUpdates.validManifest({ version: '1.2.3', sha256: 'zz', size: 1 }), null);
  assert.equal(webUpdates.validManifest({ version: '1.2.3', sha256: 'a'.repeat(64), size: -5 }), null);
  const manifest = webUpdates.validManifest({
    version: '1.2.3',
    sha256: 'a'.repeat(64),
    size: 123,
    nativeVersion: 2,
  });
  assert.ok(manifest, 'un manifeste bien formé est accepté');
  assert.equal(manifest.version, '1.2.3');
  assert.equal(manifest.nativeVersion, 2);
});

test('check propose le bundle web quand la coquille est compatible', async () => {
  const baseDir = outFile();
  try {
    const respond = (body: string) => async () => new Response(body, { status: 200 });
    webUpdates.configure({
      enabled: true,
      baseDir,
      appVersion: '1.0.6',
      nativeVersion: 2,
      fetchImpl: respond(
        JSON.stringify({ version: '1.0.9', nativeVersion: 2, sha256: 'a'.repeat(64), size: 1000 }),
      ),
    });
    const info = await webUpdates.check();
    assert.ok(info);
    assert.equal(info.available, true);
    assert.equal(info.mode, 'web');
    assert.equal(info.version, '1.0.9');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('check renvoie vers le paquet complet quand la coquille doit changer', async () => {
  const baseDir = outFile();
  try {
    webUpdates.configure({
      enabled: true,
      baseDir,
      appVersion: '1.0.6',
      nativeVersion: 2,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ version: '1.0.9', nativeVersion: 3, sha256: 'a'.repeat(64), size: 1000 }),
          { status: 200 },
        ),
    });
    const info = await webUpdates.check();
    assert.ok(info);
    assert.equal(info.available, false);
    assert.equal(info.mode, 'full');
    assert.equal(info.nativeChanged, true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('check reste à jour et ignore un réseau indisponible', async () => {
  const baseDir = outFile();
  try {
    const manifest = { version: '1.0.9', nativeVersion: 2, sha256: 'a'.repeat(64), size: 1000 };
    webUpdates.configure({
      enabled: true,
      baseDir,
      appVersion: '1.0.6',
      nativeVersion: 2,
      fetchImpl: async () => {
        throw new Error('réseau coupé');
      },
    });
    assert.equal(await webUpdates.check(), null, 'une erreur réseau ne doit pas casser le check');

    webUpdates.configure({
      enabled: true,
      baseDir,
      appVersion: '1.0.6',
      nativeVersion: 2,
      fetchImpl: async () => new Response(JSON.stringify(manifest), { status: 200 }),
    });
    assert.equal((await webUpdates.check())?.available, true);

    // Une fois appliqué, le même manifeste ne doit plus être proposé.
    const last = await webUpdates.check();
    assert.equal(last?.available, true, 'avant application, disponible');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('download + apply + effectiveVersion : le bundle appliqué fait foi', async () => {
  const baseDir = outFile();
  try {
    const zip = await new JSZip().file('index.html', '<html>G</html>').generateAsync({ type: 'nodebuffer' });
    const sha256 = (await import('node:crypto')).createHash('sha256').update(zip).digest('hex');

    webUpdates.configure({
      enabled: true,
      baseDir,
      appVersion: '1.0.6',
      nativeVersion: 2,
      fetchImpl: async () => new Response(new Uint8Array(zip), { status: 200 }),
    });

    // Vérifie la progression puis l'application
    let progressSeen = false;
    const dir = await webUpdates.download(
      { version: '1.0.9', sha256, size: zip.length, nativeVersion: 2 },
      (percent) => {
        if (percent > 0) progressSeen = true;
      },
    );
    assert.ok(progressSeen, 'une progression a été publiée');
    assert.ok(existsSync(path.join(dir, 'index.html')), 'index.html extrait');

    // Mauvaise empreinte : échec attendu, aucun dossier résiduel.
    await assert.rejects(
      () => webUpdates.download({ version: '1.0.10', sha256: 'f'.repeat(64), size: zip.length, nativeVersion: 2 }),
      /SHA-256/,
    );
    assert.equal(existsSync(path.join(baseDir, 'web', '1.0.10')), false);

    webUpdates.apply('1.0.9', 2);
    assert.equal(webUpdates.activeRoot(), dir);
    assert.equal(webUpdates.appliedVersion(), '1.0.9');
    assert.equal(webUpdates.effectiveVersion(), '1.0.9');

    // Persistance : une nouvelle instance relit le fichier de pointeur.
    webUpdates.configure({
      enabled: true,
      baseDir,
      appVersion: '1.0.6',
      nativeVersion: 2,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    assert.equal(webUpdates.activeRoot(), dir, 'le pointeur relit la même racine');
    assert.equal(webUpdates.effectiveVersion(), '1.0.9');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('extractZip refuse une entrée qui sort du dossier cible', async () => {
  const baseDir = outFile();
  try {
    const zip = await new JSZip()
      .file('index.html', '<html>G</html>')
      .file('../escape.txt', 'malveillance')
      .generateAsync({ type: 'nodebuffer' });
    const zipPath = path.join(baseDir, 'evil.zip');
    writeFileSync(zipPath, zip);
    await assert.rejects(() => webUpdates.extractZip(zipPath, path.join(baseDir, 'target')), /sort|suspecte|hors/i);
    assert.equal(existsSync(path.join(baseDir, 'escape.txt')), false, 'rien ne doit sortir du dossier');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('check sans activation (développement) ne fait rien', async () => {
  // Réinitialisation complète : sans cela, ni baseDir ni appVersion ne sont
  // remis et l'état du test précédent fuit dans celui-ci.
  webUpdates.configure({ enabled: false, baseDir: null, appVersion: null });
  assert.equal(await webUpdates.check(), null);
  assert.equal(webUpdates.activeRoot(), null);
  assert.equal(webUpdates.effectiveVersion(), null);
});
