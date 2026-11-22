// Les fichiers reçus doivent être écrits dans le stockage partagé Android par
// morceaux (le pont Capacitor ne supporte pas un base64 de 80 Mo d'un coup).
import assert from 'node:assert/strict';
import test from 'node:test';

const calls: { name: string; args?: unknown }[] = [];
let failOnChunk = -1;
let chunkIndex = 0;

const plugin = {
  getUpdateState: async () => ({}),
  checkForUpdates: async () => ({}),
  downloadUpdate: async () => ({}),
  installUpdate: async () => ({}),
  dismissUpdate: async () => ({}),
  requestPermissions: async () => ({}),
  startTransfer: async () => {},
  updateTransferProgress: async () => {},
  stopTransfer: async () => {},
  keepAlive: async () => {},
  requestBatteryExemption: async () => {},
  getServiceState: async () => ({}),
  saveDownload: async (args: { append?: boolean }) => {
    const index = chunkIndex++;
    calls.push({ name: 'saveDownload', args });
    if (index === failOnChunk) return { error: 'Quota dépassé' };
    return { uri: 'content://media/external/downloads/42' };
  },
  finishDownload: async (args: unknown) => {
    calls.push({ name: 'finishDownload', args });
    return {};
  },
  openDownload: async () => '',
  revealDownload: async () => {},
  deleteDownload: async (args: unknown) => { calls.push({ name: 'deleteDownload', args }); return { deleted: true }; },
  listDownloads: async () => ({ files: [] }),
  addListener: async () => ({ remove: async () => {} }),
};

(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  Capacitor: { isNativePlatform: () => true, Plugins: { GlobalShareNative: plugin } },
};

const { blobBase64Chunks, saveBlobToSharedStorage } = await import('../app/lib/mobile-files.ts');

function reset() {
  calls.length = 0;
  chunkIndex = 0;
  failOnChunk = -1;
}

test('un blob est découpé en morceaux de 256 Ko correctement encodés', async () => {
  const bytes = new Uint8Array(600 * 1024).fill(0x41);
  const chunks: string[] = [];
  for await (const chunk of blobBase64Chunks(new Blob([bytes]))) chunks.push(chunk);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, Math.ceil((256 * 1024) / 3) * 4);
  assert.equal(Buffer.from(chunks[0], 'base64').length, 256 * 1024);
  assert.equal(Buffer.from(chunks[2], 'base64').length, 88 * 1024);
});

test('saveBlobToSharedStorage enchaîne les morceaux puis finalise', async () => {
  reset();
  const result = await saveBlobToSharedStorage(
    new Blob([new Uint8Array(600 * 1024)]), 'album.flac', 'audio/flac'
  );
  assert.deepEqual(result, { path: 'content://media/external/downloads/42' });
  const saves = calls.filter(c => c.name === 'saveDownload');
  assert.equal(saves.length, 3);
  assert.equal((saves[0].args as { append?: boolean }).append, false);
  assert.equal((saves[1].args as { append?: boolean }).append, true);
  assert.equal(calls.filter(c => c.name === 'finishDownload').length, 1);
});

test('une erreur du natif est renvoyée et la finalisation est annulée', async () => {
  reset();
  failOnChunk = 1;
  const result = await saveBlobToSharedStorage(
    new Blob([new Uint8Array(600 * 1024)]), 'album.flac', 'audio/flac'
  );
  assert.deepEqual(result, { error: 'Quota dépassé' });
  assert.equal(calls.filter(c => c.name === 'finishDownload').length, 0);
});
