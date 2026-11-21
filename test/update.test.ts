// L'état de mise à jour doit rester affichable même quand le processus
// principal transmet des valeurs absentes, nulles ou non numériques.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatUpdateBytes,
  normalizeUpdateState,
  INITIAL_UPDATE_STATE,
  type UpdateState,
} from '../app/lib/update.ts';

test('normalizeUpdateState transforme null et NaN en valeurs sûres', () => {
  const state: UpdateState = normalizeUpdateState({
    status: 'downloading',
    currentVersion: '1.0.6',
    version: null,
    percent: null,
    transferred: undefined,
    total: NaN,
    bytesPerSecond: '1200000',
    requiresAdmin: null,
    message: null,
  });

  assert.equal(state.status, 'downloading');
  assert.equal(state.currentVersion, '1.0.6');
  assert.equal(state.version, '1.0.6', 'la version disponible ne peut pas être null');
  assert.equal(state.percent, 0);
  assert.equal(state.transferred, 0);
  assert.equal(state.total, 0);
  assert.equal(state.bytesPerSecond, 1200000);
  assert.equal(state.requiresAdmin, false);
  assert.equal(state.message, '');
});

test('normalizeUpdateState borne la progression et ignore les états inconnus', () => {
  assert.equal(normalizeUpdateState({ status: 'downloading', percent: 137 }).percent, 100);
  assert.equal(normalizeUpdateState({ status: 'downloading', percent: -12 }).percent, 0);
  assert.equal(normalizeUpdateState({ status: 'downloading', percent: 42.7 }).percent, 43);
  assert.equal(normalizeUpdateState({ status: 'inconnu' }).status, 'idle');
  assert.deepEqual(normalizeUpdateState(null), {
    ...INITIAL_UPDATE_STATE,
    currentVersion: 'version inconnue',
    version: 'version inconnue',
  });
});

test('normalizeUpdateState conserve les champs valides y compris requiresAdmin', () => {
  const state = normalizeUpdateState({
    status: 'downloaded',
    currentVersion: '1.0.5',
    version: '1.0.6',
    percent: 100,
    transferred: 2 * 1024 * 1024,
    total: 2 * 1024 * 1024,
    bytesPerSecond: 512000,
    requiresAdmin: true,
    message: 'Prête à installer.',
  });

  assert.equal(state.version, '1.0.6');
  assert.equal(state.percent, 100);
  assert.equal(state.requiresAdmin, true);
  assert.equal(state.message, 'Prête à installer.');
});

test('formatUpdateBytes affiche des tailles lisibles', () => {
  assert.equal(formatUpdateBytes(0), '0 B');
  assert.equal(formatUpdateBytes(512), '512 B');
  assert.equal(formatUpdateBytes(1024), '1.0 KB');
  assert.equal(formatUpdateBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(formatUpdateBytes(NaN), '0 B');
});
