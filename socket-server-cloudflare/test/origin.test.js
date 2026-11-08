const { io } = require('socket.io-client');

const URL = process.env.SOCKET_URL || 'http://127.0.0.1:8787';

// Un vrai handshake WebSocket, comme le fait le client : curl (surtout en
// HTTP/2) ne déclenche pas l'upgrade et ne prouve donc rien sur les origines.
function attempt(origin) {
  const socket = io(URL, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 5_000,
    extraHeaders: { Origin: origin },
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`timeout with origin ${origin}`));
    }, 6_000);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.close();
      resolve();
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

async function expectAllowed(origin) {
  await attempt(origin);
  console.log(`allowed  ${origin}`);
}

async function expectRefused(origin) {
  try {
    await attempt(origin);
  } catch {
    console.log(`refused  ${origin}`);
    return;
  }
  throw new Error(`origin should have been refused: ${origin}`);
}

async function main() {
  // L'application de bureau sert sa page depuis 127.0.0.1 sur un port tiré au
  // hasard à chaque lancement : ce cas a déjà régressé (tous les salons
  // répondaient « Origin not allowed »), il est donc vérifié en priorité.
  await expectAllowed('http://127.0.0.1:51234');
  await expectAllowed('http://localhost:51234');
  await expectAllowed('https://stxtxm.github.io');

  await expectRefused('https://evil.example');
  await expectRefused('http://192.168.1.20:51234');

  console.log('ALL OK');
}

main().catch((error) => {
  console.error('TEST FAILED', error.message || error);
  process.exit(1);
});
