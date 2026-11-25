// Le dossier de réception vit côté natif (Electron ici) : les fonctions de
// réglage doivent refléter le chemin choisi et son retour aux valeurs par
// défaut, tout en restant sans effet quand le pont n'existe pas.
import assert from 'node:assert/strict';
import test from 'node:test';

const DEFAULT = '/home/timo/Téléchargements/GlobalShare';
let folder = DEFAULT;
const calls: string[] = [];
const desktopFiles = [
  { path: `${DEFAULT}/photo.jpg`, name: 'photo.jpg', size: 2048, modified: 1_700_000_000_000 },
];

(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  Capacitor: {
    isNativePlatform: () => true,
    Plugins: { GlobalShareNative: {} },
  },
  globalshareDesktop: {
    isDesktop: true,
    getDownloadFolder: async () => ({ path: folder, custom: folder !== DEFAULT }),
    chooseDownloadFolder: async () => {
      calls.push('choose');
      folder = '/home/timo/Documents/Reçus';
      return { path: folder, custom: true };
    },
    resetDownloadFolder: async () => {
      calls.push('reset');
      folder = DEFAULT;
      return { path: folder, custom: false };
    },
    listDownloads: async () => ({ folder, files: desktopFiles }),
    openDownloadFolder: async () => {
      calls.push('openFolder');
      return '';
    },
  },
};

const receive = await import('../app/lib/receive-folder.ts');

test('le dossier de réception desktop se lit, se choisit et se réinitialise', async () => {
  assert.deepEqual(await receive.getReceiveFolder(), {
    path: DEFAULT,
    custom: false,
  });
  assert.deepEqual(await receive.chooseReceiveFolder(), {
    folder: { path: '/home/timo/Documents/Reçus', custom: true },
  });
  assert.deepEqual(await receive.getReceiveFolder(), {
    path: '/home/timo/Documents/Reçus',
    custom: true,
  });
  assert.deepEqual(await receive.resetReceiveFolder(), {
    folder: { path: DEFAULT, custom: false },
  });
  assert.deepEqual(calls, ['choose', 'reset']);
});

test('les fichiers du dossier de réception se listent et le dossier s ouvre', async () => {
  assert.equal(receive.isDesktopHost(), true);
  const listed = await receive.listReceiveFolderFiles();
  assert.equal(listed.folder, folder);
  assert.deepEqual(listed.files, desktopFiles);
  assert.equal(listed.error, undefined);
  assert.equal(await receive.openReceiveFolder(), '');
  assert.ok(calls.includes('openFolder'));
});