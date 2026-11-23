// Salon mémorisé : rejoint tout seul après un rechargement ou un balayage, mais
// seulement s'il est récent — plusieurs jours plus tard, le salon serait vide et
// la reprise n'aurait aucun pair à qui se raccrocher.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearLastRoom,
  LAST_ROOM_KEY,
  LAST_ROOM_TTL_MS,
  loadLastRoom,
  rememberLastRoom,
} from '../app/lib/last-room.ts';

function fakeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    has: (key: string) => store.has(key),
  };
}

const session = fakeStorage();
const local = fakeStorage();
(globalThis as { window?: unknown }).window = {
  sessionStorage: session,
  localStorage: local,
};

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

test('le salon de la session est rejoint sans copie durable', () => {
  clearLastRoom();
  rememberLastRoom('42', 'Pixel');
  assert.deepEqual(loadLastRoom(), { roomId: '42', name: 'Pixel' });
  // Hors Android (`persist` faux), rien n'est écrit sur le disque.
  assert.equal(local.has(LAST_ROOM_KEY), false);
});

test('la copie durable prend le relais quand le sessionStorage a disparu', () => {
  clearLastRoom();
  rememberLastRoom('7', 'Bureau', { persist: true, now: NOW });
  // Balayage : le WebView détruit a emporté la copie de session.
  session.removeItem(LAST_ROOM_KEY);
  assert.deepEqual(
    loadLastRoom({ persist: true, now: NOW }),
    { roomId: '7', name: 'Bureau' }
  );
});

test('un salon mémorisé depuis plus de 24 h n’est pas rejoint et est effacé', () => {
  clearLastRoom();
  rememberLastRoom('9', undefined, { persist: true, now: NOW });
  session.removeItem(LAST_ROOM_KEY);
  const later = NOW + LAST_ROOM_TTL_MS + MINUTE;
  assert.equal(loadLastRoom({ persist: true, now: later }), null);
  // L'entrée périmée disparaît : elle ne sera pas reproposée au démarrage suivant.
  assert.equal(local.has(LAST_ROOM_KEY), false);
});

test('à la limite de fraîcheur, le salon est encore rejoint', () => {
  clearLastRoom();
  rememberLastRoom('3', 'Pixel', { persist: true, now: NOW });
  session.removeItem(LAST_ROOM_KEY);
  assert.deepEqual(
    loadLastRoom({ persist: true, now: NOW + LAST_ROOM_TTL_MS }),
    { roomId: '3', name: 'Pixel' }
  );
});

test('hors Android, la copie durable n’est jamais lue', () => {
  clearLastRoom();
  rememberLastRoom('5', undefined, { persist: true, now: NOW });
  session.removeItem(LAST_ROOM_KEY);
  assert.equal(loadLastRoom({ now: NOW }), null);
});

test('une entrée durable sans date est ignorée', () => {
  clearLastRoom();
  local.setItem(LAST_ROOM_KEY, JSON.stringify({ roomId: '2' }));
  assert.equal(loadLastRoom({ persist: true, now: NOW }), null);
  assert.equal(local.has(LAST_ROOM_KEY), false);
});

test('la copie de session en cours prime sur la copie durable', () => {
  clearLastRoom();
  rememberLastRoom('11', undefined, { persist: true, now: NOW });
  rememberLastRoom('12', undefined, { persist: true, now: NOW });
  assert.equal(loadLastRoom({ persist: true, now: NOW })?.roomId, '12');
});

test('quitter le salon efface les deux copies', () => {
  clearLastRoom();
  rememberLastRoom('8', undefined, { persist: true, now: NOW });
  clearLastRoom();
  assert.equal(session.has(LAST_ROOM_KEY), false);
  assert.equal(local.has(LAST_ROOM_KEY), false);
  assert.equal(loadLastRoom({ persist: true, now: NOW }), null);
});
