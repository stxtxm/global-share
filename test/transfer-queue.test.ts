// File d'envoi multi-fichiers : 2 flux simultanés, le reste attend en file
// et avance automatiquement dès qu'un créneau se libère.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Socket } from 'socket.io-client';
import { CHUNK_SIZE_DEFAULT, TransferManager } from '../app/components/TransferManager.ts';

const CHUNK = CHUNK_SIZE_DEFAULT;

function setup() {
  const emitted: { event: string; payload: Record<string, unknown> }[] = [];
  const socket = {
    id: 'self',
    emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }),
  } as unknown as Socket;
  const manager = new TransferManager(socket, 'self', {
    onUpdate() {}, onComplete() {}, onCancel() {}, onError() {}, onStatus() {}, onSendDone() {},
  });
  return { manager, emitted };
}

test('deux envois simultanés, le troisième attend en file', () => {
  const { manager, emitted } = setup();
  const a = manager.startSend({ name: 'a.bin', size: CHUNK }, 'peer', 'relay');
  const b = manager.startSend({ name: 'b.bin', size: CHUNK }, 'peer', 'relay');
  const c = manager.startSend({ name: 'c.bin', size: CHUNK }, 'peer', 'relay');
  assert.equal(a.status, 'transferring');
  assert.equal(b.status, 'transferring');
  assert.equal(c.status, 'queued');
  assert.equal(c.queuePosition, 1);
  assert.equal(manager.getQueue().length, 1);
  // Aucune annonce émise pour le fichier en file.
  assert.equal(emitted.filter(e => e.event === 'transfer-init' && e.payload.transferId === c.id).length, 0);
  manager.clear();
});

test("l'annulation d'un envoi actif promeut le premier de la file", () => {
  const { manager, emitted } = setup();
  const a = manager.startSend({ name: 'a.bin', size: CHUNK }, 'peer', 'relay');
  manager.startSend({ name: 'b.bin', size: CHUNK }, 'peer', 'relay');
  const c = manager.startSend({ name: 'c.bin', size: CHUNK }, 'peer', 'relay');
  manager.cancel(a.id, 'Annulé');
  assert.equal(c.status, 'transferring', 'le fichier en file démarre');
  assert.equal(c.queuePosition, undefined);
  assert.equal(
    emitted.filter(e => e.event === 'transfer-init' && e.payload.transferId === c.id).length,
    1,
    'annonce émise à la promotion',
  );
  manager.clear();
});

test('la fin d’un envoi promeut le suivant (EOF-ACK)', () => {
  const { manager } = setup();
  const a = manager.startSend({ name: 'a.bin', size: CHUNK }, 'peer', 'relay');
  manager.startSend({ name: 'b.bin', size: CHUNK }, 'peer', 'relay');
  const c = manager.startSend({ name: 'c.bin', size: CHUNK }, 'peer', 'relay');
  manager.onTransferEofAck({ transferId: a.id, initiator: 'peer', target: 'self' });
  assert.equal(c.status, 'transferring');
  manager.clear();
});

test('la pause d’un envoi libère son créneau pour la file', () => {
  const { manager } = setup();
  const a = manager.startSend({ name: 'a.bin', size: CHUNK }, 'peer', 'relay');
  manager.startSend({ name: 'b.bin', size: CHUNK }, 'peer', 'relay');
  const c = manager.startSend({ name: 'c.bin', size: CHUNK }, 'peer', 'relay');
  manager.pause(a.id);
  assert.equal(a.status, 'paused');
  assert.equal(c.status, 'transferring');
  manager.clear();
});

test('passer en premier remontre un fichier en file', () => {
  const { manager } = setup();
  manager.startSend({ name: 'a.bin', size: CHUNK }, 'peer', 'relay');
  manager.startSend({ name: 'b.bin', size: CHUNK }, 'peer', 'relay');
  const c = manager.startSend({ name: 'c.bin', size: CHUNK }, 'peer', 'relay');
  const d = manager.startSend({ name: 'd.bin', size: CHUNK }, 'peer', 'relay');
  assert.equal(d.queuePosition, 2);
  assert.equal(manager.prioritize(d.id), true);
  assert.equal(d.queuePosition, 1);
  assert.equal(c.queuePosition, 2);
  manager.clear();
});

test('petits d’abord trie la file par taille croissante', () => {
  const { manager } = setup();
  manager.startSend({ name: 'a.bin', size: CHUNK }, 'peer', 'relay');
  manager.startSend({ name: 'b.bin', size: CHUNK }, 'peer', 'relay');
  const big = manager.startSend({ name: 'big.bin', size: CHUNK * 50 }, 'peer', 'relay');
  const small = manager.startSend({ name: 'small.bin', size: CHUNK }, 'peer', 'relay');
  manager.sortQueueBySize();
  assert.equal(small.queuePosition, 1);
  assert.equal(big.queuePosition, 2);
  manager.clear();
});

test('vider la file annule l’attente sans toucher aux envois actifs', () => {
  const { manager } = setup();
  const a = manager.startSend({ name: 'a.bin', size: CHUNK }, 'peer', 'relay');
  manager.startSend({ name: 'b.bin', size: CHUNK }, 'peer', 'relay');
  const c = manager.startSend({ name: 'c.bin', size: CHUNK }, 'peer', 'relay');
  manager.cancelQueue();
  assert.equal(manager.get(c.id), undefined);
  assert.equal(a.status, 'transferring');
  manager.clear();
});

test("la reprise d'un transfert interrompu respecte les créneaux", () => {
  const { manager } = setup();
  const a = manager.startSend({ name: 'a.bin', size: CHUNK }, 'peer', 'relay');
  manager.startSend({ name: 'b.bin', size: CHUNK }, 'peer', 'relay');
  const c = manager.startSend({ name: 'c.bin', size: CHUNK }, 'peer', 'relay');
  manager.interruptAll('réseau perdu');
  // Tout le monde est interrompu, y compris la file (le réseau est perdu).
  assert.equal(c.status, 'interrupted');
  manager.resumeInterrupted();
  // a et b reprennent leurs créneaux ; c retourne en file faute de créneau.
  assert.equal(manager.activeSendCount(), 2);
  assert.equal(a.status, 'transferring');
  assert.equal(c.status, 'queued');
  manager.clear();
});
