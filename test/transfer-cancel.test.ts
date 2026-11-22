// Le bouton « Annuler » doit arrêter le transfert pour de vrai : plus de
// réémission d'EOF, plus de réinjection de la ligne dans getAll(), et aucun
// message en vol ne doit faire revivre le transfert ni enregistrer le fichier.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Socket } from 'socket.io-client';
import { CHUNK_SIZE_DEFAULT, TransferManager } from '../app/components/TransferManager.ts';

const CHUNK = CHUNK_SIZE_DEFAULT;

type Emitted = { event: string; payload: Record<string, unknown> };

function setup() {
  const emitted: Emitted[] = [];
  const saved: string[] = [];
  const cleared: string[] = [];
  const socket = {
    emit: (event: string, payload: Record<string, unknown>) => void emitted.push({ event, payload }),
  } as unknown as Socket;
  const manager = new TransferManager(socket, 'self', {
    onUpdate() {}, onComplete() {}, onCancel() {}, onError() {}, onStatus() {}, onSendDone() {},
  });
  manager.chunkStore = {
    save: () => void saved.push('save'),
    load: async () => new Map(),
    clear: (id: string) => void cleared.push(id),
  };
  return {
    manager, emitted, cleared,
    events: (name: string) => emitted.filter(e => e.event === name),
  };
}

test("cancel() arrête l'EOF, vide les timers et retire le transfert du registre", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager, events } = setup();
  const tr = manager.startSend({ name: 'x', size: CHUNK * 4 }, 'peer', 'relay');
  manager.sendChunk(tr.id, 0, new Uint8Array(CHUNK));
  manager.sendEof(tr.id);
  assert.equal(events('transfer-eof').length, 1);

  manager.cancel(tr.id, 'Annulé');
  assert.equal(manager.get(tr.id), undefined, 'le transfert doit sortir du Map');
  assert.equal(manager.getAll().length, 0, "getAll() ne doit pas réinjecter la ligne annulée");
  assert.equal(tr.eofTimer, null);
  assert.equal(tr.ackTimers.size, 0);
  assert.equal(tr.pending.size, 0);
  assert.equal(events('transfer-cancel').length, 1);

  // L'ancienne closure emitEof se reprogrammait ici toutes les 2 s sans fin.
  t.mock.timers.tick(30_000);
  assert.equal(events('transfer-eof').length, 1, 'aucun EOF ne doit repartir après annulation');
  manager.clear();
});

test('les messages en vol après annulation ne font pas revivre le transfert', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager, emitted, events } = setup();
  let updates = 0;
  manager.onUpdate = () => { updates += 1; };
  (globalThis as { window?: { globalShare?: unknown } }).window = {
    globalShare: { onFileSaved: () => { throw new Error('fichier enregistré après annulation'); } },
  };
  const tr = manager.startReceive({ name: 'x', size: CHUNK * 2 }, 'peer', 'relay');
  manager.cancel(tr.id, 'Annulé');
  const before = emitted.length;
  const after = updates;

  manager.onTransferChunk({
    transferId: tr.id, seq: 0, size: CHUNK, chunk: new Uint8Array(CHUNK), target: 'self',
  });
  manager.onTransferEof({ transferId: tr.id, size: CHUNK * 2, target: 'self' });
  manager.onTransferEofAck({ transferId: tr.id, initiator: 'peer', target: 'self' });
  manager.onTransferResync({ transferId: tr.id, target: 'self', haveBytes: 0 });
  manager.onTransferEnd({ transferId: tr.id, status: 'completed', target: 'self' });

  assert.equal(emitted.length - before, 0, 'aucun événement ne doit partir après annulation');
  assert.equal(updates, after, "aucune mise à jour d'UI ne doit réinsérer la ligne");
  assert.equal(events('transfer-eof-ack').length, 0);
  assert.equal(events('transfer-init').length, 0);
  manager.clear();
});

test("l'annulation reçue du pair nettoie aussi les chunks persistés", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager, cleared, events } = setup();
  const tr = manager.startReceive({ name: 'x', size: CHUNK * 4 }, 'peer', 'relay');
  manager.onTransferChunk({
    transferId: tr.id, seq: 0, size: CHUNK, chunk: new Uint8Array(CHUNK), target: 'self',
  });

  manager.onTransferCancel({ transferId: tr.id, reason: 'Annulé', target: 'self' });
  assert.equal(manager.get(tr.id), undefined);
  assert.ok(cleared.includes(tr.id), 'les chunks partiels doivent être supprimés');
  assert.equal(events('transfer-end').length, 1);
  assert.equal(events('transfer-end')[0].payload.status, 'cancelled');
  manager.clear();
});

test('un resync tardif ne peut pas remettre un transfert annulé en cours', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager, events } = setup();
  const tr = manager.startSend({ name: 'x', size: CHUNK * 4 }, 'peer', 'relay');
  manager.sendChunk(tr.id, 0, new Uint8Array(CHUNK));
  manager.cancel(tr.id, 'Annulé');
  const before = events('transfer-init').length;

  manager.onTransferResync({ transferId: tr.id, target: 'self', haveBytes: CHUNK });
  assert.equal(tr.status, 'cancelled');
  assert.equal(events('transfer-init').length, before, 'aucune réannonce après annulation');
  manager.clear();
});
