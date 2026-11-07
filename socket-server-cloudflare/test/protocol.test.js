const { io } = require('socket.io-client');

const URL = process.env.SOCKET_URL || 'http://127.0.0.1:8787';
const ROOM = `TEST-${Date.now()}`;

function waitFor(socket, event, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeout);
    function handler(...args) {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(args);
    }
    socket.on(event, handler);
  });
}

function connectClient(name) {
  const socket = io(URL, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 5_000,
    ...(process.env.ORIGIN
      ? { extraHeaders: { Origin: process.env.ORIGIN } }
      : {}),
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout connecting ${name}`)),
      5_000
    );
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  const health = await fetch(`${URL}/health`);
  if (!health.ok) throw new Error(`health returned ${health.status}`);
  console.log('health ok');

  const turn = await fetch(`${URL}/turn`, {
    headers: process.env.ORIGIN ? { Origin: process.env.ORIGIN } : {},
  });
  if (!turn.ok) throw new Error(`turn returned ${turn.status}`);
  if (!turn.headers.get('access-control-allow-origin')) {
    throw new Error('turn response lacks a CORS header');
  }
  const turnBody = await turn.json();
  if (!Array.isArray(turnBody.urls)) throw new Error('turn body has no urls array');
  if (turnBody.urls.length === 0) {
    // Aucun secret configuré : la route doit rester servie et vide, pour que
    // le client retombe simplement sur les STUN publics.
    if (turnBody.ttl !== 0) throw new Error('empty turn body should carry ttl 0');
    console.log('turn endpoint ok (not configured)');
  } else {
    const [expiry] = String(turnBody.username).split(':');
    if (!/^\d+$/.test(expiry) || Number(expiry) * 1000 <= Date.now()) {
      throw new Error(`turn username is not dated in the future: ${turnBody.username}`);
    }
    if (typeof turnBody.credential !== 'string' || turnBody.credential.length < 8) {
      throw new Error('turn credential missing');
    }
    if (!(turnBody.ttl > 0)) throw new Error('configured turn body should carry a positive ttl');
    console.log(`turn endpoint ok (ephemeral credentials, ttl ${turnBody.ttl}s)`);
  }

  const alice = await connectClient('alice');
  const bob = await connectClient('bob');

  const aliceUsers = waitFor(alice, 'room-users');
  alice.emit('join-room', { roomId: ROOM, name: 'Alice' });
  const [alicePeers] = await aliceUsers;
  if (alicePeers.length !== 0) throw new Error('alice should start alone');

  const bobUsers = waitFor(bob, 'room-users');
  const aliceJoined = waitFor(alice, 'user-joined');
  bob.emit('join-room', { roomId: ROOM, name: 'Bob' });

  const [bobPeers] = await bobUsers;
  const [joinedUser] = await aliceJoined;
  if (bobPeers.length !== 1 || bobPeers[0].id !== alice.id) {
    throw new Error('bob did not receive alice');
  }
  if (joinedUser.id !== bob.id || joinedUser.name !== 'Bob') {
    throw new Error('alice did not receive bob');
  }
  console.log('room membership ok');

  const carol = await connectClient('carol');
  const carolUsers = waitFor(carol, 'room-users');
  carol.emit('join-room', { roomId: `${ROOM}-OTHER`, name: 'Carol' });
  const [carolPeers] = await carolUsers;
  if (carolPeers.length !== 0) throw new Error('rooms are not isolated');
  carol.disconnect();
  console.log('room isolation ok');

  const offerPromise = waitFor(bob, 'offer');
  alice.emit('offer', {
    target: bob.id,
    caller: alice.id,
    sdp: { type: 'offer', sdp: 'test' },
  });
  const [offer] = await offerPromise;
  if (offer.caller !== alice.id) throw new Error('offer caller mismatch');
  console.log('signaling ok');

  const binaryPromise = waitFor(bob, 'relay-data');
  alice.emit('relay-data', {
    target: bob.id,
    data: new Uint8Array([1, 2, 3, 4, 5]),
    meta: { type: 'chunk' },
  });
  const [binary] = await binaryPromise;
  if (binary.from !== alice.id) throw new Error('binary from mismatch');
  if (Array.from(binary.data).join(',') !== '1,2,3,4,5') {
    throw new Error('binary payload mismatch');
  }
  console.log('binary relay ok');

  const metaPromise = waitFor(bob, 'relay-data');
  alice.emit('relay-data', {
    target: bob.id,
    data: null,
    meta: { type: 'meta', name: 'hello.txt', size: 5 },
  });
  const [meta] = await metaPromise;
  if (meta.from !== alice.id || meta.data !== null) {
    throw new Error('text relay mismatch');
  }
  console.log('text relay ok');

  const chunks = 100;
  const size = 16 * 1024;
  const received = [];
  const burstDone = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`only got ${received.length}/${chunks} chunks`)),
      20_000
    );
    bob.on('relay-data', ({ data }) => {
      const bytes = new Uint8Array(data);
      received.push(new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0));
      if (received.length === chunks) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  for (let i = 0; i < chunks; i += 1) {
    const bytes = new Uint8Array(size);
    new DataView(bytes.buffer).setUint32(0, i);
    alice.emit('relay-data', {
      target: bob.id,
      data: bytes,
      meta: { type: 'chunk', seq: i },
    });
  }

  await burstDone;
  const ordered = received.every((value, index) => value === index);
  if (!ordered) throw new Error('burst arrived out of order');
  console.log(`burst ok (${received.length} chunks, ${received.length * size} bytes)`);

  const bobId = bob.id;
  const leftPromise = waitFor(alice, 'user-left');
  bob.disconnect();
  const [leftId] = await leftPromise;
  if (leftId !== bobId) throw new Error('user-left id mismatch');
  console.log('disconnect ok');

  alice.disconnect();
  console.log('ALL OK');
}

main().catch((error) => {
  console.error('TEST FAILED', error);
  process.exit(1);
});
