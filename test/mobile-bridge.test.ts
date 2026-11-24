// Continuité Android : le service avant-plan doit rester actif pendant tout le
// salon (même déconnecté), les transferts terminés ne doivent pas l'éteindre,
// et un appel natif refusé ne doit pas faire exploser l'UI.
import assert from 'node:assert/strict';
import test from 'node:test';

type Call = { name: string; args?: unknown };
const calls: Call[] = [];
const listeners = new Map<string, (value: unknown) => void>();

const plugin = {
  getUpdateState: async () => ({}),
  checkForUpdates: async () => ({}),
  downloadUpdate: async () => ({}),
  installUpdate: async () => ({}),
  dismissUpdate: async () => ({}),
  requestPermissions: async () => ({}),
  startTransfer: async (args: unknown) => void calls.push({ name: 'startTransfer', args }),
  updateTransferProgress: async (args: unknown) => void calls.push({ name: 'updateTransferProgress', args }),
  stopTransfer: async () => void calls.push({ name: 'stopTransfer' }),
  keepAlive: async (args: unknown) => void calls.push({ name: 'keepAlive', args }),
  requestBatteryExemption: async () => void calls.push({ name: 'requestBatteryExemption' }),
  saveDownload: async () => ({}),
  finishDownload: async () => ({}),
  openDownload: async () => ({}),
  revealDownload: async () => void calls.push({ name: 'revealDownload' }),
  deleteDownload: async (args: unknown) => { calls.push({ name: 'deleteDownload', args }); return { deleted: true }; },
  listDownloads: async () => ({ files: [] }),
  getReceiveFolder: async (): Promise<{ path?: string; custom?: boolean }> => ({
    path: 'Documents/Reçus',
    custom: true,
  }),
  chooseReceiveFolder: async (): Promise<{
    path?: string; custom?: boolean; canceled?: boolean;
  }> => ({ path: 'Documents/Reçus', custom: true }),
  resetReceiveFolder: async (): Promise<{ path?: string; custom?: boolean }> => ({
    path: 'Téléchargements/GlobalShare',
    custom: false,
  }),
  getServiceState: async () => ({ running: true }),
  addListener: async (name: string, listener: (value: unknown) => void) => {
    listeners.set(name, listener);
    return { remove: async () => { listeners.delete(name); } };
  },
};

(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  Capacitor: {
    isNativePlatform: () => true,
    Plugins: { GlobalShareNative: plugin },
  },
};

const bridge = await import('../app/lib/mobile-bridge.ts');

test('le maintien natif reste actif pendant le salon, même sans transfert', () => {
  calls.length = 0;
  bridge.mobileKeepAlive(true);
  assert.deepEqual(calls, [{ name: 'keepAlive', args: { enabled: true } }]);
});

test('un transfert terminé ne coupe pas le service (finish, pas stop)', () => {
  calls.length = 0;
  bridge.mobileFinishTransfer();
  assert.deepEqual(calls, [{ name: 'updateTransferProgress', args: { count: 0, progress: 0 } }]);
  assert.ok(!calls.some(c => c.name === 'stopTransfer'));
});

test('la sortie de salon, elle, arrête bien le service', () => {
  calls.length = 0;
  bridge.mobileStopTransfer();
  assert.deepEqual(calls, [{ name: 'stopTransfer' }]);
});

test('le tick natif est exposé au composant pour battre le throttling WebView', () => {
  const mobile = (globalThis as { window: { globalshareMobile?: { onServiceTick?: (l: () => void) => () => void } } })
    .window.globalshareMobile;
  assert.equal(typeof mobile?.onServiceTick, 'function');
  let ticks = 0;
  const off = mobile?.onServiceTick?.(() => { ticks += 1; }) ?? (() => {});
  // addListener est asynchrone : laisser la micro-tâche s'exécuter.
  return Promise.resolve().then(() => {
    listeners.get('serviceTick')?.({});
    assert.equal(ticks, 1);
    off();
  });
});

test('un appel natif rejeté ne propage pas son erreur', async () => {
  const original = plugin.keepAlive;
  plugin.keepAlive = async () => { throw new Error('ForegroundServiceStartNotAllowedException'); };
  try {
    bridge.mobileKeepAlive(true);
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    plugin.keepAlive = original;
  }
});

test('le bouton Fichiers ouvre le gestionnaire système, pas un lecteur vidéo', async () => {
  calls.length = 0;
  await bridge.mobileRevealDownload();
  assert.deepEqual(calls, [{ name: 'revealDownload' }]);
});

test('la suppression retire aussi le fichier du stockage partagé', async () => {
  calls.length = 0;
  const result = await bridge.mobileDeleteDownload({ uri: 'content://media/42', name: 'album.flac' });
  assert.deepEqual(result, { deleted: true });
  assert.equal(calls[0].name, 'deleteDownload');
});

test('une coquille native plus ancienne renvoie un message au lieu d un TypeError', async () => {
  const original = plugin.revealDownload;
  // @ts-expect-error simulation d'un APK dont le plugin n'a pas la méthode
  delete plugin.revealDownload;
  try {
    const message = await bridge.mobileRevealDownload();
    assert.match(message, /mettez l'APK à jour/i);
  } finally {
    plugin.revealDownload = original;
  }
});


test('le dossier de réception se lit et se choisit depuis le pont', async () => {
  assert.deepEqual(await bridge.mobileGetReceiveFolder(), {
    path: 'Documents/Reçus',
    custom: true,
  });
  assert.deepEqual(await bridge.mobileChooseReceiveFolder(), {
    folder: { path: 'Documents/Reçus', custom: true },
  });
  assert.deepEqual(await bridge.mobileResetReceiveFolder(), {
    folder: { path: 'Téléchargements/GlobalShare', custom: false },
  });
});

test('annuler le sélecteur de dossier ne change rien', async () => {
  const original = plugin.chooseReceiveFolder;
  plugin.chooseReceiveFolder = async () => ({ canceled: true });
  try {
    assert.deepEqual(await bridge.mobileChooseReceiveFolder(), { canceled: true });
  } finally {
    plugin.chooseReceiveFolder = original;
  }
});

test('listDownloads renvoie les fichiers du stockage partagé', async () => {
  calls.length = 0;
  const result = await bridge.mobileListDownloads();
  assert.equal(result.files.length, 0);
});
