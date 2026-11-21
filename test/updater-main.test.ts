// Le processus principal Electron est simulé : on vérifie que les événements
// d'electron-updater (et leurs champs parfois absents) produisent toujours un
// état sérialisable et une barre de progression valide.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const autoUpdater = new EventEmitter() as EventEmitter & {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<string[]>;
  quitAndInstall: () => void;
};
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowPrerelease = false;
autoUpdater.checkForUpdates = async () => null;
autoUpdater.downloadUpdate = async () => ['/tmp/globalshare.deb'];
autoUpdater.quitAndInstall = () => {};

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown> | unknown>();
const progressBars: number[] = [];
const sent: Array<{ channel: string; value: unknown }> = [];
let mainWindow: unknown = null;
const windowMock = {
  isDestroyed: () => false,
  setProgressBar: (value: number) => progressBars.push(value),
  webContents: {
    send: (channel: string, value: unknown) => sent.push({ channel, value }),
  },
};
mainWindow = windowMock;

const electronMock = {
  app: {
    isPackaged: true,
    getVersion: () => '1.0.6',
    relaunch: () => {},
    exit: () => {},
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
};

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: Loader };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = (request, parent, isMain) => {
  if (request === 'electron') return electronMock;
  if (request === 'electron-updater') return { autoUpdater };
  return originalLoad(request, parent, isMain);
};

const updater = require('../desktop/updater.js') as {
  checkForUpdates: (options?: { manual?: boolean }) => Promise<unknown>;
  initAutoUpdater: (resolveWindow: () => unknown) => void;
};

// Les minuteurs de l'updater ne doivent pas retenir le processus de test.
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const fakeTimer = (() => ({ unref() {} })) as unknown as typeof setTimeout;
(globalThis as { setTimeout: typeof setTimeout }).setTimeout = fakeTimer;
(globalThis as { setInterval: typeof setInterval }).setInterval = fakeTimer as unknown as typeof setInterval;
updater.initAutoUpdater(() => mainWindow);
(globalThis as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
(globalThis as { setInterval: typeof setInterval }).setInterval = realSetInterval;

const state = async () => (await handlers.get('globalshare:update-state')!()) as Record<string, unknown>;

test('l état initial est toujours numérique', async () => {
  const current = await state();
  assert.equal(current.status, 'idle');
  assert.equal(current.percent, 0);
  assert.equal(current.version, null);
});

test('download-progress avec percent null ou NaN reste une barre valide', async () => {
  autoUpdater.emit('download-progress', {
    percent: null,
    transferred: undefined,
    total: NaN,
    bytesPerSecond: '512000',
  });
  const current = await state();
  assert.equal(current.status, 'downloading');
  assert.equal(current.percent, 0, 'null ne devient pas un pourcentage invalide');
  assert.equal(current.transferred, 0);
  assert.equal(current.total, 0);
  assert.equal(current.bytesPerSecond, 512000);
  assert.equal(progressBars.at(-1), 0);

  autoUpdater.emit('download-progress', { percent: NaN });
  assert.equal((await state()).percent, 0);
  assert.equal(progressBars.at(-1), 2, 'NaN passe en barre indéterminée au lieu de planter Electron');
});

test('update-available sans version retombe sur la version installée', async () => {
  autoUpdater.emit('update-available', { version: null });
  const current = await state();
  assert.equal(current.status, 'available');
  assert.equal(current.version, '1.0.6');
  assert.ok(sent.some(({ channel }) => channel === 'globalshare:update-state'));
});

test('le téléchargement aboutit en état downloaded à 100 %', async () => {
  await handlers.get('globalshare:update-download')!();
  const current = await state();
  assert.equal(current.status, 'downloaded');
  assert.equal(current.percent, 100);
  assert.equal(progressBars.at(-1), -1);
});

test('une erreur pendant le téléchargement remonte un message et aucune valeur nulle', async () => {
  autoUpdater.downloadUpdate = async () => {
    throw new Error('réseau indisponible');
  };
  await handlers.get('globalshare:update-check')!({ manual: true });
  autoUpdater.emit('update-available', { version: '1.0.7' });
  await handlers.get('globalshare:update-download')!();

  const current = await state();
  assert.equal(current.status, 'error');
  assert.equal(current.message, 'réseau indisponible');
  assert.equal(current.percent, 0);
});

test('Plus tard masque la version jusqu à la prochaine vérification manuelle', async () => {
  autoUpdater.emit('update-available', { version: '1.0.7' });
  assert.equal((await state()).status, 'available');
  await handlers.get('globalshare:update-dismiss')!();
  assert.equal((await state()).status, 'idle');

  autoUpdater.emit('update-available', { version: '1.0.7' });
  assert.equal((await state()).status, 'idle', 'la même version ne doit pas réapparaître');

  await handlers.get('globalshare:update-check')!({ manual: true });
  autoUpdater.emit('update-available', { version: '1.0.7' });
  assert.equal((await state()).status, 'available');
});
