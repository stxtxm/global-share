// Garde-fous de stabilité : ces détails ont chacun provoqué des coupures ou
// des transferts figés (statut « Connexion… » permanent, minuteurs bridés en
// arrière-plan, pong manqué, barre de progression clignotante).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const component = readFileSync(`${root}app/components/GlobalShare.tsx`, 'utf8');
const css = readFileSync(`${root}app/components/GlobalShare.css`, 'utf8');
const desktopMain = readFileSync(`${root}desktop/main.js`, 'utf8');
const worker = readFileSync(`${root}socket-server-cloudflare/src/index.ts`, 'utf8');
const mobileBridge = readFileSync(`${root}app/lib/mobile-bridge.ts`, 'utf8');
const androidService = readFileSync(
  `${root}android/app/src/main/java/io/github/stxtxm/globalshare/TransferForegroundService.java`,
  'utf8'
);

test('les ACK relancent la boucle d’envoi sans minuteur bridé', () => {
  const start = component.indexOf('const kickSendLoop = useCallback');
  assert.ok(start > 0, 'kickSendLoop introuvable');
  const end = component.indexOf('}, []);', start);
  const body = component.slice(start, end);
  assert.doesNotMatch(body, /setTimeout\s*\(/, 'un kick ne doit plus passer par un timer');
  assert.match(body, /sendLoopRef\.current\?\.\(\)/);
  // La passe n'est plus cadencée à 0/2 ms : les ACK la relancent, un filet
  // de sécurité à 1 s suffit à récupérer d'un ACK perdu.
  assert.doesNotMatch(component, /anyLan \? 0 : 2/);
  assert.match(component, /setTimeout\(\(\) => sendLoop\(\), 1_000\)/);
});

test('un pair joignable par le relais n’affiche plus « Connexion… » à vie', () => {
  const joined = component.slice(
    component.indexOf("socket.on('user-joined'"),
    component.indexOf("socket.on('user-left'")
  );
  assert.match(joined, /status: 'connected'/);
  const fallback = component.slice(
    component.indexOf('const fallback = () =>'),
    component.indexOf('p2pTimersRef.current[peerId] = setTimeout')
  );
  assert.match(fallback, /status: 'connected'/);
});

test('Electron ne bride pas la fenêtre en arrière-plan', () => {
  assert.match(desktopMain, /backgroundThrottling:\s*false/);
});

test('le Worker tolère un pong manqué avant de fermer', () => {
  assert.match(worker, /missedPings >= 2/);
  assert.match(worker, /missedPings = 0/);
});

test('la présence survit à la suspension du WebView (battement natif)', () => {
  // Le Worker accepte un battement HTTP hors socket et le fait vivre plus
  // longtemps que la grâce de reconnexion, sinon le téléphone en arrière-plan
  // réapparaissait hors ligne au bout de 30 s.
  assert.match(worker, /pathname === '\/presence'/);
  assert.match(worker, /touchPresence\(/);
  assert.match(worker, /PRESENCE_TIMEOUT_MS = 120_000/);
  // Le service Android poste lui-même le battement : il ne dépend pas des
  // minuteurs (bridés) ni du réseau du WebView (suspendu).
  assert.match(androidService, /PRESENCE_EVERY_MS = 20_000/);
  assert.match(androidService, /postPresence\(/);
  assert.match(androidService, /requestPresence\(\)/);
  // Le WebView transmet l'URL et l'identité stable au service.
  assert.match(mobileBridge, /presenceUrl/);
  assert.match(mobileBridge, /roomId/);
  assert.match(mobileBridge, /sessionId/);
});

test('sélection multiple : Ctrl/Cmd+clic, plage, et bonne portée des suppressions', () => {
  assert.match(component, /ctrlKey \|\| metaKey/);
  assert.match(component, /shiftKey/);
  assert.match(component, /confirmRemoveSelected/);
  assert.match(component, /confirmDeleteSelected/);
  // La sélection de l'historique ne touche jamais au disque.
  const remove = component.slice(
    component.indexOf('const removeSelectedDownloads'),
    component.indexOf('const deleteDesktopFile')
  );
  assert.ok(remove.length > 0, 'removeSelectedDownloads introuvable');
  assert.doesNotMatch(remove, /deleteReceiveFolderFiles|mobileDeleteDownload/);
});

test('la suppression desktop reste confinée au dossier de réception', () => {
  const start = desktopMain.indexOf("globalshare:delete-downloads");
  const end = desktopMain.indexOf("globalshare:open-download-folder", start);
  assert.ok(start > 0 && end > start, 'handler de suppression introuvable');
  const handler = desktopMain.slice(start, end);
  assert.match(handler, /path\.dirname\(target\) !== folder/);
  assert.match(handler, /stat\.isFile\(\)/);
  assert.match(handler, /lstat/);
});

test('la barre de progression ne clignote plus', () => {
  assert.doesNotMatch(css, /gs-shine|gs-bar-flow|gs-bar-bandeau|gs-bar-ghost/);
  assert.doesNotMatch(css, /gs-badge-pulse|gs-badge-spin|gs-badge-tick|gs-march|gs-flow/);
  const fill = css.slice(css.indexOf('.gs-bar-fill {'), css.indexOf('.gs-bar-fill--queued {'));
  assert.doesNotMatch(fill, /animation:/);
});
