// Débit et fiabilité du relais : la vitesse doit être un débit instantané
// (et non une moyenne cumulée à 40 %), et le budget de retransmissions est par
// chunk — sinon quelques ACK perdus annulent un gros fichier.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Socket } from 'socket.io-client';
import { CHUNK_SIZE_DEFAULT, TransferManager } from '../app/components/TransferManager.ts';

const CHUNK = CHUNK_SIZE_DEFAULT;

function setup() {
  const emitted: { event: string; payload: Record<string, unknown> }[] = [];
  const socket = {
    emit: (event: string, payload: Record<string, unknown>) => void emitted.push({ event, payload }),
  } as unknown as Socket;
  const manager = new TransferManager(socket, 'self', {
    onUpdate() {}, onComplete() {}, onCancel() {}, onError() {}, onStatus() {}, onSendDone() {},
  });
  return { manager, emitted };
}

function ack(manager: TransferManager, transferId: string, seq: number) {
  manager.onTransferAck({
    transferId, seq, size: CHUNK, initiator: 'peer', target: 'self',
  });
}

test('la réception calcule un débit instantané (plus de 0 B/s permanent)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager } = setup();
  const tr = manager.startReceive({ name: 'x', size: CHUNK * 10 }, 'peer', 'relay');

  for (let seq = 0; seq < 2; seq += 1) {
    manager.onTransferChunk({
      transferId: tr.id, seq, size: CHUNK,
      chunk: new Uint8Array(CHUNK), target: 'self',
    });
  }
  assert.equal(tr.speed, 0, 'la fenêtre en cours ne publie pas encore de débit');

  // La fenêtre d'1 s se clôt au prochain octet : 2 × 128/512 Ko en 1 s.
  t.mock.timers.tick(1000);
  manager.onTransferChunk({
    transferId: tr.id, seq: 2, size: CHUNK,
    chunk: new Uint8Array(CHUNK), target: 'self',
  });
  assert.ok(tr.speed > CHUNK * 1.5, `vitesse réception ${tr.speed} attendu ~${CHUNK * 2}`);
  manager.clear();
});

test("l'expéditeur affiche le débit réel, pas 40 % d'une moyenne cumulée", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager } = setup();
  const tr = manager.startSend({ name: 'x', size: CHUNK * 10 }, 'peer', 'relay');

  for (let seq = 0; seq < 4; seq += 1) {
    manager.sendChunk(tr.id, seq, new Uint8Array(CHUNK));
    ack(manager, tr.id, seq);
  }
  t.mock.timers.tick(1000);
  manager.sendChunk(tr.id, 4, new Uint8Array(CHUNK));
  ack(manager, tr.id, 4);
  assert.ok(tr.speed > CHUNK * 3, `vitesse envoi ${tr.speed} attendu ~${CHUNK * 4}`);
  manager.clear();
});

test('la vitesse retombe à zéro après une période sans ACK', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager } = setup();
  const tr = manager.startSend({ name: 'x', size: CHUNK * 10 }, 'peer', 'relay');
  manager.sendChunk(tr.id, 0, new Uint8Array(CHUNK));
  ack(manager, tr.id, 0);
  t.mock.timers.tick(1000);
  manager.sendChunk(tr.id, 1, new Uint8Array(CHUNK));
  ack(manager, tr.id, 1);
  assert.ok(tr.speed > 0);

  t.mock.timers.tick(3000);
  manager['_tickRates']();
  assert.equal(tr.speed, 0, 'un débit figé est pire qu un débit à zéro');
  manager.clear();
});

test('le budget de tentatives est par chunk, pas global au transfert', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager } = setup();
  manager.maxRetries = 3;
  const tr = manager.startSend({ name: 'x', size: CHUNK * 10 }, 'peer', 'relay');

  for (let seq = 0; seq < 4; seq += 1) manager.sendChunk(tr.id, seq, new Uint8Array(CHUNK));
  // Quatre chunks différents n'acquittaient pas : l'ancien compteur global
  // (4 > 3) annulait tout le transfert, alors qu'aucun chunk n'a épuisé son budget.
  t.mock.timers.tick(8000);
  assert.equal(tr.status, 'transferring', 'un timeout par chunk ne doit pas annuler le transfert');
  assert.equal(tr.ackAttempts.size, 4);
  manager.clear();
});

test('un ACK déclenche immédiatement la reprise de la boucle d envoi', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager } = setup();
  let kicks = 0;
  manager.onAck = () => { kicks += 1; };
  const tr = manager.startSend({ name: 'x', size: CHUNK * 10 }, 'peer', 'relay');
  manager.sendChunk(tr.id, 0, new Uint8Array(CHUNK));
  ack(manager, tr.id, 0);
  assert.equal(kicks, 1);
  manager.clear();
});
