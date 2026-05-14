require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const passport = require('passport');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'spinstorm-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
});
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ── Discord OAuth (optionnel) ─────────────────────────────────────────────
const discordEnabled = !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
if (discordEnabled) {
  const DiscordStrategy = require('passport-discord').Strategy;
  passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.DISCORD_CALLBACK_URL || '/auth/discord/callback',
    scope: ['identify'],
  }, (accessToken, refreshToken, profile, done) => {
    done(null, {
      id: `discord-${profile.id}`,
      username: profile.global_name || profile.username,
      type: 'discord',
      avatar: profile.avatar
        ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/${parseInt(profile.discriminator || 0) % 5}.png`,
    });
  }));

  app.get('/auth/discord', passport.authenticate('discord'));
  app.get('/auth/discord/callback',
    passport.authenticate('discord', { failureRedirect: '/?error=auth' }),
    (req, res) => res.redirect('/?loggedin=1')
  );
}

// ── Auth routes ───────────────────────────────────────────────────────────
app.post('/auth/guest', (req, res) => {
  const raw = (req.body.username || '').trim();
  if (raw.length < 2 || raw.length > 20) {
    return res.status(400).json({ error: 'Pseudo : 2 à 20 caractères.' });
  }
  const username = raw.replace(/[<>"'&]/g, '');
  req.session.user = { id: uuidv4(), username, type: 'guest', avatar: null };
  res.json({ success: true, user: req.session.user });
});

app.get('/auth/me', (req, res) => {
  const user = req.user || req.session.user || null;
  res.json({ user, discordEnabled });
});

app.get('/auth/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => res.redirect('/'));
  });
});

// ── In-memory state ───────────────────────────────────────────────────────
const players = new Map();  // socketId → playerData
const rooms = new Map();    // roomId → room

function publicPlayer(p) {
  if (!p) return null;
  return { id: p.id, username: p.username, type: p.type, avatar: p.avatar, roomId: p.roomId };
}

function publicRoom(r) {
  return {
    id: r.id, name: r.name, host: r.host,
    playerCount: r.players.length, maxPlayers: r.maxPlayers,
    state: r.state, isPrivate: r.isPrivate,
  };
}

// ── Socket.io ─────────────────────────────────────────────────────────────
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

io.on('connection', socket => {
  const rawUser = socket.request.user || socket.request.session?.user;
  if (!rawUser) { socket.disconnect(); return; }

  const me = {
    id: rawUser.id,
    username: rawUser.username,
    type: rawUser.type,
    avatar: rawUser.avatar,
    socketId: socket.id,
    roomId: null,
    friends: new Set(),
  };
  players.set(socket.id, me);

  socket.join('lobby');
  socket.emit('lobby:state', {
    players: [...players.values()].map(publicPlayer),
    rooms: [...rooms.values()].map(publicRoom),
  });
  socket.to('lobby').emit('lobby:player-joined', publicPlayer(me));

  // ── Room ──────────────────────────────────────────────────────────────
  socket.on('room:create', ({ name, maxPlayers = 8, isPrivate = false } = {}) => {
    if (me.roomId) return;
    const room = {
      id: uuidv4(),
      name: (name || `${me.username}'s arena`).slice(0, 40),
      host: socket.id,
      players: [socket.id],
      maxPlayers: Math.min(Number(maxPlayers) || 8, 12),
      state: 'waiting',
      isPrivate: !!isPrivate,
    };
    rooms.set(room.id, room);
    me.roomId = room.id;
    socket.leave('lobby');
    socket.join(`room:${room.id}`);
    socket.emit('room:joined', { room: publicRoom(room), peers: [] });
    io.to('lobby').emit('lobby:room-added', publicRoom(room));
  });

  socket.on('room:join', ({ roomId }) => {
    if (me.roomId) return;
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error', { msg: 'Arène introuvable.' });
    if (room.state !== 'waiting') return socket.emit('error', { msg: 'Partie en cours.' });
    if (room.players.length >= room.maxPlayers) return socket.emit('error', { msg: 'Arène pleine.' });

    room.players.push(socket.id);
    me.roomId = room.id;
    socket.leave('lobby');
    socket.join(`room:${room.id}`);

    const peers = room.players
      .filter(id => id !== socket.id)
      .map(id => ({ socketId: id, player: publicPlayer(players.get(id)) }));

    socket.emit('room:joined', { room: publicRoom(room), peers });
    socket.to(`room:${room.id}`).emit('room:peer-joined', { socketId: socket.id, player: publicPlayer(me) });
    io.to('lobby').emit('lobby:room-updated', publicRoom(room));
  });

  socket.on('room:leave', () => leaveRoom());

  socket.on('room:start', () => {
    const room = me.roomId ? rooms.get(me.roomId) : null;
    if (!room || room.host !== socket.id || room.state !== 'waiting') return;
    room.state = 'playing';
    const gamePlayers = room.players.map(id => publicPlayer(players.get(id)));
    io.to(`room:${room.id}`).emit('game:start', { players: gamePlayers });
    io.to('lobby').emit('lobby:room-updated', publicRoom(room));
  });

  socket.on('room:kick', ({ targetId }) => {
    const room = me.roomId ? rooms.get(me.roomId) : null;
    if (!room || room.host !== socket.id) return;
    const target = players.get(targetId);
    if (!target || target.roomId !== me.roomId) return;
    io.to(targetId).emit('room:kicked');
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) leaveRoomForSocket(targetSocket, target);
  });

  // ── WebRTC signaling ──────────────────────────────────────────────────
  socket.on('signal', ({ to, signal }) => {
    io.to(to).emit('signal', { from: socket.id, signal });
  });

  // ── Friends ───────────────────────────────────────────────────────────
  socket.on('friend:request', ({ targetId }) => {
    io.to(targetId).emit('friend:request', { from: publicPlayer(me) });
  });

  socket.on('friend:accept', ({ fromId }) => {
    me.friends.add(fromId);
    const other = players.get(fromId);
    if (other) other.friends.add(socket.id);
    socket.emit('friend:added', { player: publicPlayer(players.get(fromId)) });
    io.to(fromId).emit('friend:added', { player: publicPlayer(me) });
  });

  socket.on('friend:invite', ({ targetId }) => {
    const room = me.roomId ? rooms.get(me.roomId) : null;
    if (!room) return;
    io.to(targetId).emit('friend:invite', {
      roomId: room.id, roomName: room.name, from: publicPlayer(me),
    });
  });

  // ── Chat ──────────────────────────────────────────────────────────────
  socket.on('chat:lobby', ({ msg }) => {
    if (!msg || msg.length > 200) return;
    io.to('lobby').emit('chat:lobby', {
      player: publicPlayer(me),
      msg: msg.replace(/[<>"]/g, ''),
      t: Date.now(),
    });
  });

  socket.on('chat:room', ({ msg }) => {
    if (!msg || msg.length > 200 || !me.roomId) return;
    io.to(`room:${me.roomId}`).emit('chat:room', {
      player: publicPlayer(me),
      msg: msg.replace(/[<>"]/g, ''),
      t: Date.now(),
    });
  });

  // ── Disconnect ────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    leaveRoom();
    io.to('lobby').emit('lobby:player-left', { socketId: socket.id });
    players.delete(socket.id);
  });

  function leaveRoom() { leaveRoomForSocket(socket, me); }
});

function leaveRoomForSocket(socket, me) {
  if (!me.roomId) return;
  const room = rooms.get(me.roomId);
  if (!room) { me.roomId = null; return; }

  room.players = room.players.filter(id => id !== socket.id);
  socket.to(`room:${room.id}`).emit('room:peer-left', { socketId: socket.id });
  socket.leave(`room:${room.id}`);

  if (room.players.length === 0) {
    rooms.delete(room.id);
    io.to('lobby').emit('lobby:room-removed', { roomId: room.id });
  } else {
    if (room.host === socket.id) {
      room.host = room.players[0];
      io.to(`room:${room.id}`).emit('room:new-host', { socketId: room.host });
    }
    if (room.state === 'playing' && room.players.length < 2) {
      room.state = 'waiting';
    }
    io.to('lobby').emit('lobby:room-updated', publicRoom(room));
  }

  me.roomId = null;
  socket.join('lobby');
  io.to('lobby').emit('lobby:player-joined', publicPlayer(me));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌀 SPINSTORM.io — http://localhost:${PORT}`);
});
