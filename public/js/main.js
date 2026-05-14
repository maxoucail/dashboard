import { P2PManager } from './p2p.js';
import { SpinstormGame, NEON } from './game.js';

// ── App state ──────────────────────────────────────────────────────────────
let me = null;       // { id, socketId, username, type, avatar }
let socket = null;
let p2p    = null;
let game   = null;
let myRoom = null;   // current room info
let friends = new Set(); // socketId of friends

// ── Boot ───────────────────────────────────────────────────────────────────
(async () => {
  const { user, discordEnabled } = await fetch('/auth/me').then(r => r.json());

  // Show Discord button only if server has it configured
  if (!discordEnabled) q('#btn-discord').style.display = 'none';

  if (user) {
    me = user;
    await enterLobby();
  } else {
    showScreen('login');
  }
})();

// ── Login handlers ─────────────────────────────────────────────────────────
q('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const username = q('#input-username').value.trim();
  if (!username) return;
  const res = await fetch('/auth/guest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  const data = await res.json();
  if (data.error) { q('#login-error').textContent = data.error; return; }
  me = data.user;
  await enterLobby();
});

q('#btn-discord').addEventListener('click', () => { location.href = '/auth/discord'; });
q('#btn-logout').addEventListener('click', () => { location.href = '/auth/logout'; });

// ── Lobby setup ────────────────────────────────────────────────────────────
async function enterLobby() {
  q('#lobby-username').textContent = me.username;
  q('#lobby-badge').textContent    = me.type === 'discord' ? '🔷 Discord' : '👤 Invité';
  q('#lobby-avatar').src           = me.avatar || avatarPlaceholder(me.username);

  socket = io({ transports: ['websocket'] });

  socket.on('connect', () => {
    me.socketId = socket.id;
    showScreen('lobby');
  });

  socket.on('lobby:state', ({ players, rooms }) => {
    renderPlayerList(players);
    renderRoomList(rooms);
  });

  socket.on('lobby:player-joined', p  => addOrUpdatePlayer(p));
  socket.on('lobby:player-left',   ({ socketId }) => removePlayer(socketId));

  socket.on('lobby:room-added',   r  => addOrUpdateRoom(r));
  socket.on('lobby:room-updated', r  => addOrUpdateRoom(r));
  socket.on('lobby:room-removed', ({ roomId }) => removeRoom(roomId));

  socket.on('room:joined', ({ room, peers }) => {
    myRoom = room;
    showScreen('room');
    renderWaitingRoom(room, peers);
    // Initiate P2P with existing peers
    p2p = new P2PManager(socket, me.socketId);
    peers.forEach(({ socketId }) => p2p.initiateTo(socketId));
  });

  socket.on('room:peer-joined', ({ socketId, player }) => {
    appendWaitingPlayer(player);
    // We are an existing member → wait for their offer
    // p2p already handles incoming signal
  });

  socket.on('room:peer-left', ({ socketId }) => {
    q(`#wp-${socketId}`)?.remove();
    p2p?._closePeer(socketId);
  });

  socket.on('room:new-host', ({ socketId }) => {
    if (socketId === me.socketId) {
      myRoom.host = socketId;
      q('#btn-start')?.classList.remove('hidden');
    }
  });

  socket.on('room:kicked', () => {
    alert('Tu as été expulsé de l\'arène.');
    leaveRoom();
  });

  socket.on('game:start', ({ players }) => {
    startGame(players);
  });

  // Friends
  socket.on('friend:request', ({ from }) => {
    showToast(`${from.username} vous envoie une demande d'ami !`, [
      { label: '✔ Accepter', action: () => { socket.emit('friend:accept', { fromId: from.id }); } },
      { label: '✖ Refuser', action: () => {} },
    ]);
  });
  socket.on('friend:added', ({ player }) => {
    friends.add(player.id);
    showToast(`${player.username} est maintenant votre ami !`);
    markFriend(player.id);
  });
  socket.on('friend:invite', ({ roomId, roomName, from }) => {
    showToast(`${from.username} vous invite dans « ${roomName} »`, [
      { label: '▶ Rejoindre', action: () => socket.emit('room:join', { roomId }) },
      { label: '✖ Ignorer', action: () => {} },
    ]);
  });

  // Chat
  socket.on('chat:lobby', ({ player, msg, t }) => appendChat('lobby-chat-log', player, msg, t));
  socket.on('chat:room',  ({ player, msg, t }) => appendChat('room-chat-log', player, msg, t));

  socket.on('error', ({ msg }) => showToast('⚠ ' + msg));
}

// ── Room actions ───────────────────────────────────────────────────────────
q('#btn-create-room').addEventListener('click', () => {
  const name = prompt('Nom de l\'arène (laissez vide pour défaut) :') || '';
  socket.emit('room:create', { name, maxPlayers: 8 });
});

q('#btn-leave-room').addEventListener('click', leaveRoom);

q('#btn-start').addEventListener('click', () => {
  socket.emit('room:start');
});

function leaveRoom() {
  socket.emit('room:leave');
  p2p?.destroy(); p2p = null;
  myRoom = null;
  showScreen('lobby');
  q('#waiting-players').innerHTML = '';
}

// ── Game start ─────────────────────────────────────────────────────────────
function startGame(players) {
  showScreen('game');

  const canvas = q('#game-canvas');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;

  game = new SpinstormGame(canvas, me, p2p, () => {
    q('#dead-overlay').classList.remove('hidden');
  });

  game.start(players);

  q('#btn-respawn').addEventListener('click', leaveRoom, { once: true });
  q('#btn-back-lobby').addEventListener('click', leaveRoom, { once: true });
}

// ── UI helpers ─────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  q(`#screen-${id}`).classList.add('active');
}

function renderPlayerList(players) {
  const el = q('#player-list');
  el.innerHTML = '';
  players.forEach(p => addOrUpdatePlayer(p));
}

function addOrUpdatePlayer(p) {
  if (p.id === me.id) return;
  const existing = q(`#pl-${CSS.escape(p.id)}`);
  if (existing) { existing.replaceWith(buildPlayerEl(p)); return; }
  q('#player-list').appendChild(buildPlayerEl(p));
}

function buildPlayerEl(p) {
  const el = document.createElement('div');
  el.id = `pl-${p.id}`;
  el.className = 'player-item' + (friends.has(p.id) ? ' friend' : '');
  const badge = p.type === 'discord' ? '<span class="badge discord">Discord</span>' : '<span class="badge guest">Invité</span>';
  const friendBtn = friends.has(p.id)
    ? `<button class="btn-sm" disabled>★ Ami</button>`
    : `<button class="btn-sm btn-friend" data-id="${p.id}">+ Ami</button>`;
  const inRoomLabel = p.roomId ? '<span class="in-room">En jeu</span>' : '';
  el.innerHTML = `
    <img class="player-avatar" src="${p.avatar || avatarPlaceholder(p.username)}" alt="">
    <div class="player-info">
      <span class="player-name">${esc(p.username)}</span>${badge}${inRoomLabel}
    </div>
    <div class="player-actions">${friendBtn}</div>
  `;
  el.querySelector('.btn-friend')?.addEventListener('click', () => {
    socket.emit('friend:request', { targetId: p.id });
  });
  return el;
}

function removePlayer(socketId) {
  // we don't know id from socketId easily here but lobby state refresh handles it
}

function markFriend(playerId) {
  const el = q(`#pl-${CSS.escape(playerId)}`);
  if (el) { el.classList.add('friend'); el.querySelector('.btn-friend')?.replaceWith(Object.assign(document.createElement('button'), { className:'btn-sm', textContent:'★ Ami', disabled:true })); }
}

function renderRoomList(rooms) {
  q('#room-list').innerHTML = '';
  rooms.forEach(r => addOrUpdateRoom(r));
}

function addOrUpdateRoom(r) {
  let el = q(`#rm-${r.id}`);
  if (!el) { el = document.createElement('div'); el.id = `rm-${r.id}`; q('#room-list').appendChild(el); }
  el.className = 'room-item';
  const stateBadge = r.state === 'playing' ? '<span class="room-state playing">En jeu</span>' : '<span class="room-state waiting">Attente</span>';
  el.innerHTML = `
    <div class="room-info">
      <span class="room-name">${esc(r.name)}</span>
      <span class="room-count">${r.playerCount}/${r.maxPlayers}</span>
      ${stateBadge}
    </div>
    <button class="btn-join" data-id="${r.id}" ${r.state !== 'waiting' || r.playerCount >= r.maxPlayers ? 'disabled' : ''}>▶ Rejoindre</button>
  `;
  el.querySelector('.btn-join')?.addEventListener('click', () => {
    socket.emit('room:join', { roomId: r.id });
  });
}

function removeRoom(roomId) {
  q(`#rm-${roomId}`)?.remove();
}

function renderWaitingRoom(room, peers) {
  q('#room-title').textContent = room.name;
  const isHost = room.host === me.socketId;
  if (isHost) q('#btn-start').classList.remove('hidden');
  else         q('#btn-start').classList.add('hidden');

  // Myself
  const list = q('#waiting-players');
  list.innerHTML = '';
  appendWaitingPlayer({ ...me, id: me.socketId });
  peers.forEach(({ player }) => appendWaitingPlayer(player));
}

function appendWaitingPlayer(p) {
  if (q(`#wp-${p.id}`)) return;
  const el = document.createElement('div');
  el.id = `wp-${p.id}`;
  el.className = 'waiting-player';
  const isMe = p.id === me.socketId;
  el.innerHTML = `
    <img src="${p.avatar || avatarPlaceholder(p.username)}" class="waiting-avatar" alt="">
    <span class="waiting-name">${esc(p.username)}${isMe ? ' (vous)' : ''}</span>
    ${p.type === 'discord' ? '<span class="badge discord">Discord</span>' : ''}
  `;
  q('#waiting-players').appendChild(el);
}

// ── Chat ───────────────────────────────────────────────────────────────────
q('#lobby-chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const inp = q('#lobby-chat-input');
  if (inp.value.trim()) { socket.emit('chat:lobby', { msg: inp.value.trim() }); inp.value = ''; }
});

q('#room-chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const inp = q('#room-chat-input');
  if (inp.value.trim()) { socket.emit('chat:room', { msg: inp.value.trim() }); inp.value = ''; }
});

function appendChat(containerId, player, msg, t) {
  const log = q('#' + containerId);
  const el  = document.createElement('div');
  el.className = 'chat-msg';
  el.innerHTML = `<span class="chat-name">${esc(player.username)}</span> <span class="chat-text">${esc(msg)}</span>`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

// ── Toast ──────────────────────────────────────────────────────────────────
function showToast(msg, actions = []) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<p>${msg}</p>`;
  actions.forEach(a => {
    const btn = document.createElement('button');
    btn.textContent = a.label;
    btn.onclick = () => { a.action(); el.remove(); };
    el.appendChild(btn);
  });
  q('#toast-container').appendChild(el);
  if (!actions.length) setTimeout(() => el.remove(), 4000);
}

// ── Utils ──────────────────────────────────────────────────────────────────
function q(sel) { return document.querySelector(sel); }
function esc(s) { return String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }
function avatarPlaceholder(name) {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=001133&color=00ffff&bold=true&size=64`;
}
