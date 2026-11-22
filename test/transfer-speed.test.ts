// Débit et fiabilité du relais : la vitesse doit être un débit instantané
// (et non une moyenne cumulée à 40 %), et le budget de retransmissions est par
// chunk — sinon quelques ACK perdus annulent un gros fichier.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Socket } from 'socket.io-client';
import { CHUNK_SIZE_DEFAULT, TransferManager } from '../app/components/TransferManager.ts';

const CHUNK = CHUNK_SIZE_DEFAULT;

function setup(t: import('node:test').TestContext) {
  const emitted: { event: string; payload: Record<string, unknown> }[] = [];
  const socket = {
    emit: (event: string, payload: Record<string, unknown>) => void emitted.push({ event, payload }),
  } as unknown as Socket;
  const manager = new TransferManager(socket, 'self', {
    onUpdate() {}, onComplete() {}, onCancel() {}, onError() {}, onStatus() {}, onSendDone() {},
  });
  // Même si une assertion échoue, l'horloge de débit ne doit pas retenir Node.
  t.after(() => manager.clear());
  return { manager, emitted };
}

function ack(manager: TransferManager, transferId: string, seq: number) {
  manager.onTransferAck({
    transferId, seq, size: CHUNK, initiator: 'peer', target: 'self',
  });
}

test('la réception calcule un débit instantané (plus de 0 B/s permanent)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager } = setup(t);
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
});

test("l'expéditeur affiche le débit réel, pas 40 % d'une moyenne cumulée", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager } = setup(t);
  const tr = manager.startSend({ name: 'x', size: CHUNK * 10 }, 'peer', 'relay');

  for (let seq = 0; seq < 4; seq += 1) {
    manager.sendChunk(tr.id, seq, new Uint8Array(CHUNK));
    ack(manager, tr.id, seq);
  }
  t.mock.timers.tick(1000);
  manager.sendChunk(tr.id, 4, new Uint8Array(CHUNK));
  ack(manager, tr.id, 4);
  assert.ok(tr.speed > CHUNK * 3, `vitesse envoi ${tr.speed} attendu ~${CHUNK * 4}`);
});

test('la vitesse retombe à zéro après une période sans ACK', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager } = setup(t);
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
});

test('le budget de tentatives est par chunk, pas global au transfert', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager } = setup(t);
  manager.maxRetries = 3;
  const tr = manager.startSend({ name: 'x', size: CHUNK * 10 }, 'peer', 'relay');

  for (let seq = 0; seq < 4; seq += 1) manager.sendChunk(tr.id, seq, new Uint8Array(CHUNK));
  // Quatre chunks différents n'acquittaient pas : l'ancien compteur global
  // (4 > 3) annulait tout le transfert, alors qu'aucun chunk n'a épuisé son budget.
  // Timeout relais plancher 12 s + étalement déterministe (seq % 8) × 250 ms.
  t.mock.timers.tick(14_000);
  assert.equal(tr.status, 'transferring', 'un timeout par chunk ne doit pas annuler le transfert');
  assert.equal(tr.ackAttempts.size, 4);
});

test('pas de retransmission prématurée sur un lien lent (24 chunks en vol)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager, emitted } = setup(t);
  const tr = manager.startSend({ name: 'x', size: CHUNK * 120 }, 'peer', 'relay');
  for (let seq = 0; seq < 24; seq += 1) manager.sendChunk(tr.id, seq, new Uint8Array(CHUNK));

  // Un relais à 180 Ko/s met ~9 s pour accusé réception des premiers blocs.
  // Avec l'ancien timeout plancher (3 s), les 24 chunks étaient tous
  // retransmis à 9 s, saturant le relais et figeant le transfert à 50 %.
  t.mock.timers.tick(9000);
  const retransmissions = emitted.filter(e => e.event === 'transfer-chunk').length - 24;
  assert.equal(retransmissions, 0, `${retransmissions} retransmissions prématurées`);
  assert.equal(tr.status, 'transferring');
});

test("un ACK tardif ne remet pas le budget de tentatives à zéro (livelock)", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager } = setup(t);
  manager.maxRetries = 2;
  const tr = manager.startSend({ name: 'x', size: CHUNK * 10 }, 'peer', 'relay');
  manager.sendChunk(tr.id, 0, new Uint8Array(CHUNK));

  // Le minuteur a retransmis (le chunk n'était pas encore acquitté).
  t.mock.timers.tick(13_000);
  assert.equal(tr.ackAttempts.get(0), 1);
  // L'ACK arrive après coup : il ne doit PAS effacer la tentative consommée,
  // sinon un relais saturé retransmet à l'infini sans jamais progresser.
  ack(manager, tr.id, 0);
  assert.equal(tr.ackAttempts.get(0), 1, 'budget remis à zéro sur ACK tardif');
});

test('un ACK déclenche immédiatement la reprise de la boucle d envoi', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager } = setup(t);
  let kicks = 0;
  manager.onAck = () => { kicks += 1; };
  const tr = manager.startSend({ name: 'x', size: CHUNK * 10 }, 'peer', 'relay');
  manager.sendChunk(tr.id, 0, new Uint8Array(CHUNK));
  ack(manager, tr.id, 0);
  assert.equal(kicks, 1);
});
