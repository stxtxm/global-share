// Départ d'un pair : ses transferts doivent être annulés, ceux des autres
// appareils du salon doivent continuer.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Socket } from 'socket.io-client';
import { CHUNK_SIZE_DEFAULT, TransferManager } from '../app/components/TransferManager.ts';

const CHUNK = CHUNK_SIZE_DEFAULT;

type Emitted = { event: string; payload: { transferId?: string; target?: string; reason?: string } };

function setup() {
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

  return {
    manager,
    cancelled,
    events: (name: string) => emitted.filter((e) => e.event === name),
  };
}

test('cancelForPeer annule uniquement les transferts du pair qui part', () => {
  const { manager, events, cancelled } = setup();
  const toBob = manager.startSend({ name: 'vers-bob.bin', size: CHUNK * 2 }, 'bob', 'relay');
  const toEve = manager.startSend({ name: 'vers-eve.bin', size: CHUNK }, 'eve', 'relay');

  manager.cancelForPeer('bob', "L'appareil s'est déconnecté");

  assert.equal(toBob.status, 'cancelled', 'le transfert vers le pair parti est annulé');
  assert.equal(toEve.status, 'transferring', "celui d'un autre pair continue");

  const cancels = events('transfer-cancel');
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].payload.transferId, toBob.id);
  assert.equal(cancels[0].payload.target, 'bob');
  assert.equal(cancels[0].payload.reason, "L'appareil s'est déconnecté");
  assert.deepEqual(cancelled, [toBob.id], "l'interface est prévenue de l'annulation");

  manager.clear();
});

test("cancelForPeer ne touche pas un pair qui n'a aucun transfert", () => {
  const { manager, events, cancelled } = setup();
  const transfer = manager.startSend({ name: 'a.bin', size: CHUNK }, 'bob', 'relay');

  manager.cancelForPeer('carol', 'départ');

  assert.equal(transfer.status, 'transferring');
  assert.equal(events('transfer-cancel').length, 0);
  assert.deepEqual(cancelled, []);
  manager.clear();
});
