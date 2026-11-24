// Le dossier de réception vit côté natif (Electron ici) : les fonctions de
// réglage doivent refléter le chemin choisi et son retour aux valeurs par
// défaut, tout en restant sans effet quand le pont n'existe pas.
import assert from 'node:assert/strict';
import test from 'node:test';

const DEFAULT = '/home/timo/Téléchargements/GlobalShare';
let folder = DEFAULT;
const calls: string[] = [];

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