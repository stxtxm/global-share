const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

const outDir = path.join(__dirname, '..', 'out');
app.use(express.static(outDir));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

const PORT = process.env.PORT || 3001;

// Logic
const rooms = {}; // { roomId: { users: { socketId: { name } } } }

// Événements de transfert (forwardés au pair cible)
const transferEvents = [
  'transfer-init', 'transfer-chunk', 'transfer-ack', 'transfer-eof',
  'transfer-eof-ack', 'transfer-cancel', 'transfer-end'
];

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // 1. Join Room
  socket.on('join-room', ({ roomId, name }) => {
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = { users: {} };
    rooms[roomId].users[socket.id] = { name };
    socket.to(roomId).emit('user-joined', { id: socket.id, name });
    const others = Object.keys(rooms[roomId].users)
      .filter(id => id !== socket.id)
      .map(id => ({ id, name: rooms[roomId].users[id].name }));
    socket.emit('room-users', others);
    console.log(`${name} joined room ${roomId}`);
  });

  // 2. Signaling (P2P Handshake)
  socket.on('offer', (payload) => {
    io.to(payload.target).emit('offer', payload);
  });

  socket.on('answer', (payload) => {
    io.to(payload.target).emit('answer', payload);
  });

  socket.on('ice-candidate', (payload) => {
    io.to(payload.target).emit('ice-candidate', payload);
  });

  // 3. Fallback Relay (If P2P Fails)
  socket.on('relay-data', ({ target, data, meta }) => {
    io.to(target).emit('relay-data', { from: socket.id, data, meta });
  });

  // 4. Événements de transfert
  transferEvents.forEach(event => {
    socket.on(event, (payload) => {
      if (payload && typeof payload.target === 'string') {
        io.to(payload.target).emit(event, { ...payload, from: socket.id });
      }
    });
  });

  // 5. Disconnect
  socket.on('disconnecting', () => {
    const roomsJoined = Array.from(socket.rooms);
    roomsJoined.forEach(roomId => {
      if (rooms[roomId] && rooms[roomId].users[socket.id]) {
        const name = rooms[roomId].users[socket.id].name;
        delete rooms[roomId].users[socket.id];
        socket.to(roomId).emit('user-left', socket.id);
        console.log(`${name} left room ${roomId}`);
        if (Object.keys(rooms[roomId].users).length === 0) {
          delete rooms[roomId];
        }
      }
    });
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(outDir, 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
🌍 GlobalShare Socket Server Running on port ${PORT}
--------------------------------------------
Health: http://localhost:${PORT}/health
--------------------------------------------
`);
});
