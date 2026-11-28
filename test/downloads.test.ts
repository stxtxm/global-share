// Historique des téléchargements : nommage sûr, déduplication et purge.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DOWNLOAD_LIMITS,
  mimeFromName,
  planRetention,
  sanitizeFileName,
  toPublicDownloads,
  uniqueFileName,
  viewerKind,
  type StoredDownload,
} from '../app/lib/downloads.ts';

const root = new URL('..', import.meta.url).pathname;
const globalShare = readFileSync(`${root}app/components/GlobalShare.tsx`, 'utf8');

/** Corps d'un callback de GlobalShare, pour vérifier ce qu'il déclenche. */
function callbackBody(name: string): string {
  const start = globalShare.indexOf(`const ${name} = useCallback`);
  assert.ok(start > 0, `${name} introuvable`);
  const end = globalShare.indexOf('}, [appSettings.confirmDelete', start);
  assert.ok(end > start, `fin de ${name} introuvable`);
  return globalShare.slice(start, end);
}

test('« Tout supprimer » ne vide que l’historique, pas les fichiers reçus', () => {
  const body = callbackBody('clearDownloadHistory');
  // Vider la liste ne doit jamais appeler la suppression native ni toucher au
  // dossier de réception : les fichiers restent sur le téléphone ou le disque.
  assert.doesNotMatch(body, /mobileDeleteDownload|deleteDownload|deleteStoredDownload/);
  assert.match(body, /clearStoredDownloads\(\)/);
});

test('« Retirer » ne supprime que l’entrée, pas le fichier', () => {
  const body = callbackBody('removeDownload');
  // Seul l'onglet « Sur le téléphone » efface le fichier du disque.
  assert.doesNotMatch(body, /mobileDeleteDownload/);
  assert.match(body, /await deleteStoredDownload\(record\.id\)/);
});

test('mimeFromName reconnaît le FLAC et les formats audio courants', () => {
  assert.equal(mimeFromName('album.flac'), 'audio/flac');
  assert.equal(mimeFromName('PISTE.FLAC'), 'audio/flac');
  assert.equal(mimeFromName('song.mp3'), 'audio/mpeg');
  assert.equal(mimeFromName('inconnu.bin'), 'application/octet-stream');
  assert.equal(mimeFromName('sans-extension'), 'application/octet-stream');
});

function record(id: string, receivedAt: number, blobSize = 0): StoredDownload {
  return {
    id,
    name: `${id}.bin`,
    size: blobSize,
    mime: 'application/octet-stream',
    from: 'Poste-A',
    receivedAt,
    integrity: 'unknown',
    ...(blobSize > 0 ? { blob: { size: blobSize } as Blob } : {}),
  };
}

test('sanitizeFileName neutralise les chemins et les caractères de contrôle', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('dossier/photo.jpg'), 'photo.jpg');
  assert.equal(sanitizeFileName('dossier\\photo.jpg'), 'photo.jpg');
  assert.equal(sanitizeFileName('nom\u0000malin.txt'), 'nommalin.txt');
  assert.equal(sanitizeFileName('...'), 'fichier');
  assert.equal(sanitizeFileName('   '), 'fichier');
  assert.equal(sanitizeFileName(''), 'fichier');

  const long = sanitizeFileName(`${'a'.repeat(200)}.pdf`);
  assert.ok(long.length <= 120, 'le nom est tronqué');
  assert.ok(long.endsWith('.pdf'), "l'extension survit à la troncature");
});

test('uniqueFileName déduplique sans écraser un fichier existant', () => {
  const taken = new Set(['photo.jpg', 'photo (1).jpg']);
  assert.equal(uniqueFileName('photo.jpg', taken), 'photo (2).jpg');
  assert.equal(uniqueFileName('autre.jpg', taken), 'autre.jpg');
  assert.equal(uniqueFileName('sans-extension', new Set(['sans-extension'])), 'sans-extension (1)');
});

test('planRetention sort les plus anciens et garde le plus récent', () => {
  const records = [record('old', 1, 10), record('mid', 2, 10), record('new', 3, 10)];

  assert.deepEqual(planRetention(records, { maxItems: 2, maxBytes: 1000 }), ['old']);
  assert.deepEqual(planRetention(records, { maxItems: 10, maxBytes: 25 }), ['old']);
  assert.deepEqual(planRetention(records, { maxItems: 10, maxBytes: 1000 }), []);

  // Un fichier plus gros que la limite reste visible : sinon il n'apparaîtrait
  // jamais dans l'onglet, et l'utilisateur croirait l'envoi perdu.
  assert.deepEqual(planRetention([record('big', 1, 5000)], { maxItems: 10, maxBytes: 100 }), []);
  assert.deepEqual(
    planRetention([record('previous', 1, 5000), record('latest', 2, 5000)], { maxItems: 10, maxBytes: 100 }),
    ['previous']
  );
});

test('planRetention compte les entrées sans blob (bureau) comme 0 octet', () => {
  const desktopOnly = [record('a', 1), record('b', 2), record('c', 3)];
  assert.deepEqual(planRetention(desktopOnly, { maxItems: 2, maxBytes: 0 }), ['a']);
});

test('viewerKind distingue ce qui s\'ouvre dans le navigateur', () => {
  assert.equal(viewerKind('image/png'), 'image');
  assert.equal(viewerKind('video/mp4'), 'video');
  assert.equal(viewerKind('audio/mpeg'), 'audio');
  assert.equal(viewerKind('application/pdf'), 'pdf');
  assert.equal(viewerKind('text/plain'), 'text');
  assert.equal(viewerKind('', 'notes.md'), 'text');
  assert.equal(viewerKind('application/zip'), 'none');
  assert.equal(viewerKind('application/vnd.android.package-archive', 'app.apk'), 'none');
});

test('toPublicDownloads retire les blobs de l\'état React', () => {
  const [publicRecord] = toPublicDownloads([record('a', 1, 10)]);
  assert.equal('blob' in publicRecord, false);
  assert.equal(publicRecord.name, 'a.bin');
  assert.equal(publicRecord.size, 10);
  assert.equal(DOWNLOAD_LIMITS.maxItems, 40);
});
