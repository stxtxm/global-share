// Interruption d'un transfert : un appareil qui se verrouille, perd le réseau ou
// dont l'onglet est tué doit retrouver son transfert au retour, pas le perdre.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Socket } from 'socket.io-client';
import {
  CHUNK_SIZE_DEFAULT,
  TransferManager,
  type ChunkStore,
} from '../app/components/TransferManager.ts';

const CHUNK = CHUNK_SIZE_DEFAULT;

type Emitted = {
  event: string;
  payload: {
    transferId?: string;
    target?: string;
    reason?: string;
    resume?: boolean;
    haveBytes?: number;
  };
};

function setup(store: ChunkStore | null = null) {
  const emitted: Emitted[] = [];
  const socket = {
    id: 'self',
    emit: (event: string, payload: Emitted['payload']) => {
      emitted.push({ event, payload });
    },
  } as unknown as Socket;

  // L'interface locale doit être prévenue, sinon la ligne reste à l'écran.
  const cancelled: string[] = [];
  const manager = new TransferManager(socket, 'self', {
    onUpdate() {},
    onComplete() {},
    onCancel(t) { cancelled.push(t.id); },
    onError() {},
    onStatus() {},
    onSendDone() {},
  });
  manager.chunkStore = store;

  return {
    manager,
    cancelled,
    chunks: () => emitted.filter((e) => e.event === 'transfer-chunk'),
    events: (name: string) => emitted.filter((e) => e.event === name),
  };
}

test("un pair qui s'éloigne met son transfert en attente au lieu de l'annuler", () => {
  const { manager, events, cancelled } = setup();
  const toPhone = manager.startSend({ name: 'vers-phone.bin', size: CHUNK * 2 }, 'phone', 'relay');
  const toLaptop = manager.startSend({ name: 'vers-laptop.bin', size: CHUNK }, 'laptop', 'relay');

  manager.interruptForPeer('phone', "L'appareil s'est déconnecté");

  assert.equal(toPhone.status, 'interrupted', 'le transfert du pair parti est conservé');
  assert.equal(toLaptop.status, 'transferring', "celui d'un autre pair continue");
  assert.equal(events('transfer-cancel').length, 0, "aucune annulation n'est émise");
  assert.deepEqual(cancelled, [], "l'interface ne reçoit pas d'annulation");

  manager.clear();
});

test("interruptForPeer ne touche pas un pair qui n'a aucun transfert", () => {
  const { manager, events, cancelled } = setup();
  const transfer = manager.startSend({ name: 'a.bin', size: CHUNK }, 'phone', 'relay');

  manager.interruptForPeer('laptop', 'départ');

  assert.equal(transfer.status, 'transferring');
  assert.equal(events('transfer-cancel').length, 0);
  assert.deepEqual(cancelled, []);
  manager.clear();
});

test('la reprise réannonce le transfert et réémet les chunks non acquittés', () => {
  const { manager, chunks, events } = setup();
  const transfer = manager.startSend({ name: 'gros.bin', size: CHUNK * 2 }, 'phone', 'relay');
  manager.sendChunk(transfer.id, 0, new Uint8Array(CHUNK));
  assert.equal(chunks().length, 1, 'un chunk part avant la coupure');

  manager.interruptAll('Connexion interrompue');
  assert.equal(transfer.status, 'interrupted');
  assert.equal(transfer.ackTimers.size, 0, 'les minuteurs sont coupés');
  assert.equal(
    manager.sendChunk(transfer.id, 1, new Uint8Array(CHUNK)),
    false,
    'rien ne part tant que le transfert est interrompu'
  );

  manager.resumeInterrupted();

  assert.equal(transfer.status, 'transferring');
  assert.equal(chunks().length, 2, 'le chunk non acquitté repart');
  const init = events('transfer-init').at(-1);
  assert.equal(init?.payload.resume, true, 'le destinataire est prévenu de la reprise');
  manager.clear();
});

test("les chunks reçus survivent à un onglet tué et fixent la reprise", async () => {
  const saved = new Map<number, Uint8Array>();
  const store: ChunkStore = {
    save: (_transferId, seq, bytes) => { saved.set(seq, bytes); },
    load: async () => new Map(saved),
    clear: () => saved.clear(),
  };

  const first = setup(store);
  first.manager.onTransferInit({
    transferId: 't-tue',
    initiator: 'pc',
    target: 'self',
    file: { name: 'gros.bin', size: CHUNK * 3 },
    method: 'relay',
    chunkSize: CHUNK,
  });
  first.manager.onTransferChunk({
    transferId: 't-tue', seq: 0, size: CHUNK, chunk: new Uint8Array(CHUNK), target: 'self',
  });
  first.manager.onTransferChunk({
    transferId: 't-tue', seq: 1, size: CHUNK, chunk: new Uint8Array(CHUNK), target: 'self',
  });
  assert.equal(saved.size, 2, "chaque chunk est écrit sur l'appareil");
  first.manager.clear();

  // Nouvel onglet : plus rien en mémoire, seulement ce qui est sur le disque.
  const second = setup(store);
  second.manager.onTransferInit({
    transferId: 't-tue',
    initiator: 'pc',
    target: 'self',
    file: { name: 'gros.bin', size: CHUNK * 3 },
    method: 'relay',
    chunkSize: CHUNK,
    resume: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const restored = second.manager.get('t-tue');
  assert.ok(restored, 'le transfert est reconstruit');
  assert.equal(restored.buffer.size, 2, 'les chunks sont rechargés');
  const resync = second.events('transfer-resync');
  assert.equal(resync.length, 1);
  assert.equal(
    resync[0].payload.haveBytes,
    CHUNK * 2,
    'la reprise repart du premier octet manquant'
  );
  second.manager.clear();
});

test('la reprise repart du premier octet manquant, pas de zéro', () => {
  const { manager, events } = setup();
  const transfer = manager.startSend({ name: 'a.bin', size: CHUNK * 4 }, 'phone', 'relay');
  manager.sendChunk(transfer.id, 0, new Uint8Array(CHUNK));
  manager.sendChunk(transfer.id, 1, new Uint8Array(CHUNK));
  assert.equal(transfer.offset, CHUNK * 2);

  manager.onTransferResync({ transferId: transfer.id, target: 'self', haveBytes: CHUNK });

  assert.equal(transfer.offset, CHUNK, 'on reprend au chunk manquant');
  assert.equal(transfer.nextSeq, 1);
  assert.equal(transfer.confirmed, CHUNK);
  assert.equal(transfer.pending.size, 0);
  assert.equal(transfer.status, 'transferring');
  assert.equal(events('transfer-init').at(-1)?.payload.resume, undefined, 'envoi normal après recalage');
  manager.clear();
});
