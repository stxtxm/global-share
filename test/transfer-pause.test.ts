// Timers d'acquittement pendant une pause : la pause doit couper les
// réémissions, la reprise doit les réarmer sans perdre de chunk.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Socket } from 'socket.io-client';
import { CHUNK_SIZE_DEFAULT, TransferManager } from '../app/components/TransferManager.ts';

const CHUNK = CHUNK_SIZE_DEFAULT;
const ACK_DELAY_MS = 15_000;

type Emitted = { event: string; payload: { transferId?: string } };

function setup() {
  const emitted: Emitted[] = [];
  const socket = {
    id: 'self',
    emit: (event: string, payload: { transferId?: string }) => {
      emitted.push({ event, payload });
    },
  } as unknown as Socket;

  const manager = new TransferManager(socket, 'self', {
    onUpdate() {},
    onComplete() {},
    onCancel() {},
    onError() {},
    onStatus() {},
    onSendDone() {},
  });

  return {
    manager,
    chunks: () => emitted.filter((e) => e.event === 'transfer-chunk'),
    events: (name: string) => emitted.filter((e) => e.event === name),
  };
}

test('la pause suspend les réémissions et la reprise les réarme', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, chunks } = setup();
  const transfer = manager.startSend({ name: 'a.bin', size: CHUNK * 4 }, 'peer', 'relay');

  manager.sendChunk(transfer.id, 0, new Uint8Array(CHUNK));
  assert.equal(chunks().length, 1, 'un chunk part avant la pause');

  manager.pause(transfer.id);
  assert.equal(transfer.status, 'paused');
  assert.equal(transfer.ackTimers.size, 0, 'les minuteurs sont coupés à la pause');

  t.mock.timers.tick(4 * ACK_DELAY_MS);
  assert.equal(chunks().length, 1, 'aucune réémission pendant la pause');

  manager.resume(transfer.id);
  assert.equal(transfer.status, 'transferring');
  assert.equal(chunks().length, 2, 'le chunk en attente repart une fois à la reprise');

  t.mock.timers.tick(ACK_DELAY_MS);
  assert.equal(chunks().length, 3, 'le minuteur est réarmé après la reprise');

  manager.onTransferAck({
    transferId: transfer.id,
    seq: 0,
    size: CHUNK,
    initiator: 'peer',
    target: 'self',
  });
  t.mock.timers.tick(2 * ACK_DELAY_MS);
  assert.equal(chunks().length, 3, 'un chunk acquitté ne se réémet plus');
  manager.clear();
});

test("la reprise réarme l'EOF quand tous les octets sont acquittés", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, events } = setup();
  const transfer = manager.startSend({ name: 'b.bin', size: CHUNK }, 'peer', 'relay');

  manager.sendChunk(transfer.id, 0, new Uint8Array(CHUNK));
  manager.onTransferAck({
    transferId: transfer.id,
    seq: 0,
    size: CHUNK,
    initiator: 'peer',
    target: 'self',
  });
  assert.equal(events('transfer-eof').length, 0, 'pas encore de fin annoncée');

  manager.pause(transfer.id);
  manager.resume(transfer.id);
  assert.equal(events('transfer-eof').length, 1, "l'EOF repart à la reprise");
  manager.clear();
});

test('sendChunk est ignoré pendant la pause', () => {
  const { manager, chunks } = setup();
  const transfer = manager.startSend({ name: 'c.bin', size: CHUNK * 2 }, 'peer', 'relay');

  manager.pause(transfer.id);
  manager.sendChunk(transfer.id, 0, new Uint8Array(CHUNK));

  assert.equal(transfer.offset, 0, "l'offset n'avance plus en pause");
  assert.equal(chunks().length, 0, 'aucun chunk émis en pause');
  manager.clear();
});
