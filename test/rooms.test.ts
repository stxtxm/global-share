// Accueil instantané : choix du chiffre de salon d'après les salons existants,
// historique local (localStorage) et libellés d'ancienneté.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearRoomHistory,
  forgetRoom,
  formatRoomAge,
  loadRoomHistory,
  pickInstantCode,
  rememberRoom,
  ROOM_HISTORY_LIMIT,
} from '../app/lib/rooms.ts';

// Faux localStorage : les fonctions d'historique ne dépendent que de cette API.
function installFakeStorage() {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => void store.clear(),
  };
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  return storage as unknown;
}

const fakeStorage = installFakeStorage();
const NOW = 1_700_000_000_000;

function clocks(now: number) {
  const original = Date.now;
  Date.now = () => now;
  return () => {
    Date.now = original;
  };
}

test('pickInstantCode prend le premier chiffre libre', () => {
  assert.equal(pickInstantCode([]), '1');
  assert.equal(pickInstantCode(['1', '2']), '3');
  assert.equal(pickInstantCode([' 1 ', '5', '2']), '3');
  // Codes de salon alphanumériques laissent les chiffres disponibles.
  assert.equal(pickInstantCode(['A1B2C3']), '1');
});

test('pickInstantCode passe à deux chiffres puis reste exploitable', () => {
  const nine = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const double = pickInstantCode([...nine]);
  assert.match(double, /^[1-9][0-9]$/);
  assert.equal(pickInstantCode([...nine, '10']), '11');
  // Même un monde saturé fournit un code long utilisable.
  const hundred = [...nine, ...Array.from({ length: 90 }, (_, i) => String(i + 10))];
  assert.match(pickInstantCode(hundred), /^[1-9][0-9][0-9]$|^S[0-9A-Z]+$/);
});

test('l’historique local enregistre, dédoublonne et borne', () => {
  const restore = clocks(NOW);
  try {
    (globalThis as { window?: unknown }).window = { localStorage: (fakeStorage as unknown as never) };
    clearRoomHistory();
    rememberRoom('3', 'Pixel');
    rememberRoom('7');
    rememberRoom('3', 'Pixel 2'); // remonte en tête, met le nom à jour
    const history = loadRoomHistory();
    assert.deepEqual(
      history.map(entry => [entry.roomId, entry.name]),
      [['3', 'Pixel 2'], ['7', undefined]]
    );
    assert.equal(history[0].lastUsed, NOW);

    for (let i = 1; i <= ROOM_HISTORY_LIMIT + 4; i++) rememberRoom(String(100 + i));
    assert.ok(loadRoomHistory().length <= ROOM_HISTORY_LIMIT);

    const after = forgetRoom(String(100 + 1));
    assert.ok(!after.some(entry => entry.roomId === String(100 + 1)));
    clearRoomHistory();
    assert.deepEqual(loadRoomHistory(), []);
  } finally {
    restore();
  }
});

test('formatRoomAge décrit l’ancienneté en toutes lettres', () => {
  const restore = clocks(NOW);
  try {
    assert.equal(formatRoomAge(0), '');
    assert.equal(formatRoomAge(NOW - 30_000), 'à l’instant');
    assert.equal(formatRoomAge(NOW - 5 * 60_000), 'il y a 5 min');
    assert.equal(formatRoomAge(NOW - 3 * 3_600_000), 'il y a 3 h');
    assert.equal(formatRoomAge(NOW - 26 * 3_600_000), 'hier');
    assert.equal(formatRoomAge(NOW - 5 * 24 * 3_600_000), 'il y a 5 j');
  } finally {
    restore();
  }
});
