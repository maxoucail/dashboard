require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6,
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'cipher-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 4 * 60 * 60 * 1000 },
});
app.use(sessionMiddleware);

// In-memory only — nothing persisted
const onlineUsers = new Map(); // socketId → { username, socketId }
const usernameMap = new Map(); // username.toLowerCase() → socketId

// ── Auth ──────────────────────────────────────────────────────────────────
app.post('/auth/join', (req, res) => {
  const raw = (req.body.callsign || '').trim();
  if (!/^[a-zA-Z0-9_-]{2,20}$/.test(raw)) {
    return res.status(400).json({ error: 'CALLSIGN: 2-20 chars, alphanumeric + _ -' });
  }
  const existing = usernameMap.get(raw.toLowerCase());
  if (existing && onlineUsers.has(existing)) {
    return res.status(409).json({ error: 'CALLSIGN ALREADY IN USE' });
  }
  req.session.user = { id: uuidv4(), username: raw };
  res.json({ success: true, username: raw });
});

app.get('/auth/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ── Socket.io — signaling only, server never sees message content ──────────
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

io.on('connection', socket => {
  const user = socket.request.session?.user;
  if (!user) { socket.disconnect(true); return; }

  const existing = usernameMap.get(user.username.toLowerCase());
  if (existing && onlineUsers.has(existing)) {
    socket.emit('auth:error', 'CALLSIGN COLLISION');
    socket.disconnect(true);
    return;
  }

  const me = { username: user.username, socketId: socket.id };
  onlineUsers.set(socket.id, me);
  usernameMap.set(user.username.toLowerCase(), socket.id);

  socket.emit('users:list', [...onlineUsers.values()]
    .filter(u => u.socketId !== socket.id)
    .map(u => ({ username: u.username, socketId: u.socketId }))
  );
  socket.broadcast.emit('users:online', { username: me.username, socketId: socket.id });

  // WebRTC signaling relay — opaque, server cannot read encrypted payload
  socket.on('signal:offer', ({ to, offer, publicKey }) => {
    if (!onlineUsers.has(to)) return;
    io.to(to).emit('signal:offer', { from: socket.id, fromUsername: me.username, offer, publicKey });
  });

  socket.on('signal:answer', ({ to, answer, publicKey }) => {
    if (!onlineUsers.has(to)) return;
    io.to(to).emit('signal:answer', { from: socket.id, answer, publicKey });
  });

  socket.on('signal:ice', ({ to, candidate }) => {
    if (!onlineUsers.has(to)) return;
    io.to(to).emit('signal:ice', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    socket.broadcast.emit('users:offline', { socketId: socket.id, username: me.username });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`▣ CIPHER — http://localhost:${PORT}`);
});
