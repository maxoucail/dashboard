/**
 * CIPHER — Main application controller
 * Handles auth, Socket.io signaling, PeerConn lifecycle, and UI.
 */
(async () => {
  // ── State ────────────────────────────────────────────────────────────
  let myCallsign = null;
  let socket     = null;
  let myKeyPair  = null;
  let myPubB64   = null;

  const peers    = new Map(); // socketId → PeerConn
  const users    = new Map(); // socketId → { username, socketId }
  const history  = new Map(); // socketId → entry[]
  const unread   = new Map(); // socketId → number
  let   active   = null;      // socketId of open chat
  let   pending  = [];        // files queued to send

  // ── DOM refs ─────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const loginScreen   = $('login-screen');
  const mainApp       = $('main-app');
  const callsignInput = $('callsign-input');
  const loginBtn      = $('login-btn');
  const loginError    = $('login-error');
  const myCallsignEl  = $('my-callsign');
  const fpDisplay     = $('fp-display');
  const userCount     = $('user-count');
  const usersList     = $('users-list');
  const userSearch    = $('user-search');
  const noChat        = $('no-chat');
  const activeChat    = $('active-chat');
  const chatName      = $('chat-name');
  const chatStatus    = $('chat-status');
  const remoteFP      = $('remote-fp');
  const messagesEl    = $('messages');
  const msgInput      = $('msg-input');
  const sendBtn       = $('send-btn');
  const attachBtn     = $('attach-btn');
  const fileInput     = $('file-input');
  const filePreview   = $('file-preview');
  const burnBtn       = $('burn-btn');

  // ── Bootstrap: resume existing session ───────────────────────────────
  try {
    const { user } = await (await fetch('/auth/me')).json();
    if (user) await _enterApp(user.username);
  } catch (_) {}

  // ── Login ─────────────────────────────────────────────────────────────
  callsignInput.addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  });
  callsignInput.addEventListener('keydown', e => { if (e.key === 'Enter') _login(); });
  loginBtn.addEventListener('click', _login);

  async function _login() {
    const cs = callsignInput.value.trim();
    if (!cs) return;
    loginError.classList.add('hidden');
    loginBtn.disabled = true;
    loginBtn.textContent = '[ AUTHENTICATING... ]';
    try {
      const res  = await fetch('/auth/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callsign: cs }),
      });
      const data = await res.json();
      if (!res.ok) { _loginErr(data.error); return; }
      await _enterApp(data.username);
    } catch (_) { _loginErr('CONNECTION FAILED'); }
    finally     { loginBtn.disabled = false; loginBtn.textContent = '[ AUTHENTICATE ]'; }
  }

  function _loginErr(msg) {
    loginError.textContent = '! ' + msg;
    loginError.classList.remove('hidden');
  }

  async function _enterApp(username) {
    myCallsign = username;
    myKeyPair  = await Crypto.generateKeyPair();
    myPubB64   = await Crypto.exportPublicKey(myKeyPair);
    const myFP = await Crypto.fingerprint(myPubB64);
    loginScreen.classList.add('hidden');
    mainApp.classList.remove('hidden');
    myCallsignEl.textContent = myCallsign;
    fpDisplay.textContent = 'MY FP: ' + myFP;
    fpDisplay.title = 'Your ECDH-P256 public key fingerprint (SHA-256): ' + myFP;
    _connectSocket();
  }

  // ── Socket.io ─────────────────────────────────────────────────────────
  function _connectSocket() {
    socket = io({ transports: ['websocket'] });

    socket.on('users:list', list => {
      users.clear();
      list.forEach(u => users.set(u.socketId, u));
      _renderUsers();
    });

    socket.on('users:online', u => {
      users.set(u.socketId, u);
      _renderUsers();
      _sysmsg(null, `>> ${u.username} IS ONLINE`, 'ok');
    });

    socket.on('users:offline', ({ socketId, username }) => {
      users.delete(socketId);
      const p = peers.get(socketId);
      if (p) { p.close(); peers.delete(socketId); }
      if (active === socketId) _setChatStatus('disconnected');
      _renderUsers();
      _sysmsg(null, `✕ ${username} WENT OFFLINE`, 'warn');
    });

    // ── WebRTC signaling ──────────────────────────────────────────────
    socket.on('signal:offer', async ({ from, fromUsername, offer, publicKey }) => {
      let peer = peers.get(from);
      // Perfect-negotiation: impolite peer (higher socket ID) wins its own offer
      if (peer && peer.initiator && peer.pc.signalingState !== 'stable') {
        if (socket.id > from) return; // impolite: ignore their offer
        peer.close(); peers.delete(from); peer = null;
      }
      if (!peer) {
        if (!users.has(from)) users.set(from, { socketId: from, username: fromUsername });
        peer = _mkPeer(from, fromUsername, false);
        peers.set(from, peer);
        _renderUsers();
      }
      await peer.handleOffer(offer, publicKey);
      _showRemoteFP(from, publicKey);
    });

    socket.on('signal:answer', async ({ from, answer, publicKey }) => {
      const peer = peers.get(from);
      if (!peer) return;
      await peer.handleAnswer(answer, publicKey);
      _showRemoteFP(from, publicKey);
    });

    socket.on('signal:ice', async ({ from, candidate }) => {
      const peer = peers.get(from);
      if (peer) await peer.addIce(candidate);
    });
  }

  // ── Peer factory ──────────────────────────────────────────────────────
  function _mkPeer(socketId, username, initiator) {
    return new PeerConn({
      socketId, username, initiator, socket,
      keyPair: myKeyPair,
      cb: {
        onState: s => {
          _renderUsers();
          if (active === socketId) _setChatStatus(s);
          if (s === 'connected') {
            _sysmsg(socketId, '✓ SECURE CHANNEL ESTABLISHED — E2E AES-256-GCM', 'ok');
          } else if (s === 'disconnected' || s === 'failed') {
            _sysmsg(socketId, '✕ CHANNEL LOST', 'err');
          }
        },
        onText: ({ text, ts }) => {
          _addMsg(socketId, username, { kind: 'text', text, ts, mine: false });
          if (active !== socketId) { unread.set(socketId, (unread.get(socketId) || 0) + 1); _renderUsers(); _beep(); }
        },
        onFileProgress: info => _handleFileProgress(socketId, username, info),
        onFileDone:     info => _handleFileDone(socketId, username, info),
        onError: e => _sysmsg(socketId, '! DC ERROR: ' + (e.message || e), 'err'),
      },
    });
  }

  // ── Open chat ─────────────────────────────────────────────────────────
  async function _openChat(socketId) {
    const u = users.get(socketId);
    if (!u) return;
    active = socketId;
    unread.set(socketId, 0);

    noChat.classList.add('hidden');
    activeChat.classList.remove('hidden');
    chatName.textContent = u.username;

    // Render message history
    messagesEl.innerHTML = '';
    (history.get(socketId) || []).forEach(e => _renderEntry(socketId, e));
    messagesEl.scrollTop = messagesEl.scrollHeight;

    _renderUsers();

    // Initiate connection if needed
    let peer = peers.get(socketId);
    if (!peer || peer.state === 'closed' || peer.state === 'failed') {
      peer = _mkPeer(socketId, u.username, true);
      peers.set(socketId, peer);
      await peer.offer();
    }
    _setChatStatus(peer.state);
    if (peer.theirPubKey) _showRemoteFP(socketId, peer.theirPubKey);
    else remoteFP.textContent = '';

    msgInput.focus();
  }

  // ── Chat status ───────────────────────────────────────────────────────
  function _setChatStatus(state) {
    const map = {
      init:          ['◌ STANDBY',          'st-connecting'],
      offering:      ['◌ OFFERING...',       'st-connecting'],
      connected:     ['■ ENCRYPTED',         'st-online'],
      disconnected:  ['✕ DISCONNECTED',      'st-disconnected'],
      failed:        ['✕ FAILED',            'st-disconnected'],
      closed:        ['✕ CLOSED',            'st-disconnected'],
    };
    const [label, cls] = map[state] || ['◌ …', 'st-connecting'];
    chatStatus.className = cls;
    chatStatus.textContent = label;
  }

  async function _showRemoteFP(socketId, pubKeyB64) {
    if (active !== socketId) return;
    const fp = await Crypto.fingerprint(pubKeyB64);
    remoteFP.textContent = 'REMOTE FP: ' + fp;
    remoteFP.title = 'Remote ECDH public key fingerprint (SHA-256): ' + fp;
  }

  // ── Messages ──────────────────────────────────────────────────────────
  function _addMsg(socketId, username, entry) {
    const h = history.get(socketId) || [];
    h.push({ ...entry, username });
    history.set(socketId, h);
    if (active === socketId) {
      _renderEntry(socketId, entry);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function _renderEntry(socketId, e) {
    if (e.kind === 'text') {
      const d = document.createElement('div');
      d.className = `msg-row ${e.mine ? 'mine' : 'theirs'}`;
      const t = new Date(e.ts || Date.now()).toLocaleTimeString('fr-FR', { hour12: false });
      d.innerHTML = `
        <div class="msg-meta">
          <span class="enc-tag">[AES-GCM]</span>
          ${_esc(e.mine ? myCallsign : e.username)} @ ${t}
        </div>
        <div class="msg-bubble">${_esc(e.text).replace(/\n/g, '<br>')}</div>`;
      messagesEl.appendChild(d);
    }
    // file entries rendered via _handleFileDone
  }

  function _sysmsg(socketId, text, cls = '') {
    if (socketId !== null && socketId !== active) return;
    if (socketId === null && !active) return;
    const d = document.createElement('div');
    d.className = `sys-msg ${cls}`;
    d.textContent = `[${new Date().toLocaleTimeString('fr-FR', { hour12: false })}] ${text}`;
    messagesEl.appendChild(d);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ── Incoming file handling ────────────────────────────────────────────
  const _inprogress = new Map(); // id → { el, fillEl }

  function _handleFileProgress(socketId, username, info) {
    if (info.phase === 'start') {
      if (active !== socketId) return;
      const el   = _mkFileProgress(info.id, info.name, info.size);
      const fill = el.querySelector('.progress-fill');
      _inprogress.set(info.id, { el, fill });
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (info.phase === 'chunk') {
      const r = _inprogress.get(info.id);
      if (r) r.fill.style.width = info.pct + '%';
    }
  }

  function _handleFileDone(socketId, username, info) {
    _inprogress.delete(info.id);
    const entry = { kind: 'file', mine: false, username, ...info, ts: Date.now() };
    const h = history.get(socketId) || [];
    h.push(entry);
    history.set(socketId, h);
    if (active === socketId) {
      const old = document.querySelector(`[data-fid="${info.id}"]`);
      const el  = _mkFileDone(info, false);
      if (old) old.replaceWith(el); else messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      if (active !== socketId) { unread.set(socketId, (unread.get(socketId) || 0) + 1); _renderUsers(); _beep(); }
    }
    if (active !== socketId) {
      unread.set(socketId, (unread.get(socketId) || 0) + 1);
      _renderUsers();
      _beep();
    }
  }

  function _mkFileProgress(id, name, size) {
    const d = document.createElement('div');
    d.className = 'msg-row theirs';
    d.dataset.fid = id;
    d.innerHTML = `
      <div class="msg-meta"><span class="enc-tag">[AES-GCM]</span> RECEIVING FILE</div>
      <div class="file-bubble">
        <div class="file-icon-big">📁</div>
        <div class="file-info">
          <span class="file-fname">${_esc(name)}</span>
          <span class="file-fsize">${_fmtSize(size)}</span>
          <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
        </div>
      </div>`;
    return d;
  }

  function _mkFileDone({ id, name, size, mimeType, url }, mine) {
    const isImg = mimeType?.startsWith('image/');
    const d = document.createElement('div');
    d.className = `msg-row ${mine ? 'mine' : 'theirs'}`;
    d.dataset.fid = id;
    d.innerHTML = `
      <div class="msg-meta"><span class="enc-tag">[AES-GCM]</span> ${mine ? 'SENT' : 'RECEIVED'}</div>
      <div class="file-bubble">
        <div class="file-icon-big">${isImg ? '🖼' : '📁'}</div>
        <div class="file-info">
          <span class="file-fname">${_esc(name)}</span>
          <span class="file-fsize">${_fmtSize(size)}</span>
          ${isImg ? `<img src="${url}" class="img-thumb" onclick="window.open('${url}')">` : ''}
          <a href="${url}" download="${_esc(name)}" class="dl-link">[ DOWNLOAD ]</a>
        </div>
      </div>`;
    return d;
  }

  // ── Send ──────────────────────────────────────────────────────────────
  sendBtn.addEventListener('click', _send);
  msgInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _send(); } });
  msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
  });

  async function _send() {
    if (!active) return;
    const text     = msgInput.value.trim();
    const hasFiles = pending.length > 0;
    if (!text && !hasFiles) return;

    const peer = peers.get(active);
    if (!peer || peer.state !== 'connected') {
      _sysmsg(active, '! CHANNEL NOT READY — WAIT FOR CONNECTION', 'err'); return;
    }

    if (text) {
      msgInput.value = '';
      msgInput.style.height = 'auto';
      await peer.sendText(text);
      _addMsg(active, myCallsign, { kind: 'text', text, ts: Date.now(), mine: true });
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    for (const f of pending) await _sendFile(f);
    pending = [];
    _renderPending();
  }

  async function _sendFile(file) {
    const peer = peers.get(active);
    if (!peer || peer.state !== 'connected') return;

    const tempId = crypto.randomUUID();
    const progEl = _mkFileProgress(tempId, file.name, file.size);
    progEl.querySelector('.msg-row, .theirs') && (progEl.className = 'msg-row mine');
    progEl.className = 'msg-row mine';
    messagesEl.appendChild(progEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    const fill = progEl.querySelector('.progress-fill');
    const id = await peer.sendFile(file, pct => { fill.style.width = pct + '%'; });

    const url = URL.createObjectURL(file);
    const done = _mkFileDone({ id: tempId, name: file.name, size: file.size, mimeType: file.type, url }, true);
    progEl.replaceWith(done);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ── File attach ───────────────────────────────────────────────────────
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { _addPending([...fileInput.files]); fileInput.value = ''; });

  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => { e.preventDefault(); if (active) _addPending([...e.dataTransfer.files]); });

  function _addPending(files) {
    files.forEach(f => {
      if (f.size > 100 * 1024 * 1024) {
        _sysmsg(active, `! TOO LARGE: ${f.name} (MAX 100 MB)`, 'warn'); return;
      }
      pending.push(f);
    });
    _renderPending();
  }

  function _renderPending() {
    if (!pending.length) { filePreview.classList.add('hidden'); filePreview.innerHTML = ''; return; }
    filePreview.classList.remove('hidden');
    filePreview.innerHTML = pending.map((f, i) => `
      <div class="fp-chip">
        ${f.type.startsWith('image/') ? '🖼' : '📁'}
        <span>${_esc(f.name)} (${_fmtSize(f.size)})</span>
        <span class="fp-chip-rm" data-i="${i}">✕</span>
      </div>`).join('');
    filePreview.querySelectorAll('.fp-chip-rm').forEach(el => {
      el.addEventListener('click', () => { pending.splice(+el.dataset.i, 1); _renderPending(); });
    });
  }

  // ── Users list ────────────────────────────────────────────────────────
  userSearch.addEventListener('input', _renderUsers);

  function _renderUsers() {
    const q = userSearch.value.toLowerCase();
    userCount.textContent = users.size;
    const sorted = [...users.values()].sort((a, b) => {
      const sa = peers.get(a.socketId)?.state === 'connected' ? 0 : 1;
      const sb = peers.get(b.socketId)?.state === 'connected' ? 0 : 1;
      return sa - sb || a.username.localeCompare(b.username);
    });
    usersList.innerHTML = '';
    sorted.forEach(u => {
      if (q && !u.username.toLowerCase().includes(q)) return;
      const p      = peers.get(u.socketId);
      const enc    = p?.state === 'connected';
      const isAct  = u.socketId === active;
      const badge  = unread.get(u.socketId) || 0;
      const d = document.createElement('div');
      d.className = `user-item ${isAct ? 'active' : ''}`;
      d.innerHTML = `
        <div class="user-dot ${enc ? 'enc' : ''}"></div>
        <span class="user-name">${_esc(u.username)}</span>
        ${badge ? `<span class="user-badge">${badge}</span>` : ''}`;
      d.addEventListener('click', () => _openChat(u.socketId));
      usersList.appendChild(d);
    });
  }

  // ── Burn session ──────────────────────────────────────────────────────
  burnBtn.addEventListener('click', () => {
    if (burnBtn.dataset.confirm) {
      peers.forEach(p => p.close());
      fetch('/auth/logout', { method: 'POST' }).finally(() => location.reload());
    } else {
      burnBtn.textContent = '[ CONFIRM BURN? ]';
      burnBtn.dataset.confirm = '1';
      setTimeout(() => { burnBtn.textContent = '[ BURN SESSION ]'; delete burnBtn.dataset.confirm; }, 3000);
    }
  });

  // ── Utilities ─────────────────────────────────────────────────────────
  function _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function _fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }
  function _beep() {
    try {
      const ctx = new AudioContext();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.08, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      o.start(); o.stop(ctx.currentTime + 0.12);
    } catch (_) {}
  }

})();
