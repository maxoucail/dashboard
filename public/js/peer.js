/**
 * CIPHER — WebRTC DataChannel peer with end-to-end AES-256-GCM encryption.
 *
 * Key exchange flow:
 *   Initiator  →  signal:offer  + own ECDH pubkey  →  Responder
 *   Responder  →  signal:answer + own ECDH pubkey  →  Initiator
 *   Both derive identical AES-256-GCM key via ECDH + HKDF.
 *   The signaling server relays these payloads opaquely.
 *
 * All messages/files are encrypted before being written to the DataChannel.
 */
class PeerConn {
  /**
   * @param {object} opts
   * @param {string}  opts.socketId      remote socket ID
   * @param {string}  opts.username      remote callsign
   * @param {boolean} opts.initiator     true if we start the offer
   * @param {object}  opts.socket        Socket.io socket
   * @param {CryptoKeyPair} opts.keyPair own ECDH key pair
   * @param {object}  opts.cb            { onState, onText, onFileProgress, onFileDone, onError }
   */
  constructor({ socketId, username, initiator, socket, keyPair, cb }) {
    this.socketId  = socketId;
    this.username  = username;
    this.initiator = initiator;
    this.socket    = socket;
    this.keyPair   = keyPair;
    this.cb        = cb;

    this.aesKey      = null;  // derived after handshake
    this.theirPubKey = null;  // b64 ECDH public key of remote

    this.state = 'init';
    this._dc   = null;
    this._q    = [];          // outgoing queue before DC is open
    this._inFiles = new Map();// fileId → { meta, chunks[], received }

    this._buildPC();
  }

  // ── RTCPeerConnection setup ────────────────────────────────────────────
  _buildPC() {
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
      ],
    });

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.emit('signal:ice', { to: this.socketId, candidate });
    };

    this.pc.onconnectionstatechange = () => {
      this.state = this.pc.connectionState;
      this.cb.onState(this.state);
    };

    if (this.initiator) {
      this._dc = this.pc.createDataChannel('cipher', { ordered: true });
      this._setupDC(this._dc);
    } else {
      this.pc.ondatachannel = ({ channel }) => {
        this._dc = channel;
        this._setupDC(channel);
      };
    }
  }

  _setupDC(dc) {
    dc.onopen = () => {
      this.state = 'connected';
      this.cb.onState('connected');
      this._q.forEach(m => dc.send(m));
      this._q = [];
    };
    dc.onclose   = () => { this.state = 'disconnected'; this.cb.onState('disconnected'); };
    dc.onerror   = e  => this.cb.onError(e);
    dc.onmessage = ({ data }) => this._recv(data).catch(e => console.error('[CIPHER] recv err', e));
  }

  // ── Receive & decrypt ──────────────────────────────────────────────────
  async _recv(raw) {
    const msg = JSON.parse(raw);

    if (msg.t === 'text') {
      const buf  = await Crypto.decrypt(this.aesKey, msg.iv, msg.ct);
      const text = new TextDecoder().decode(buf);
      this.cb.onText({ text, ts: msg.ts });

    } else if (msg.t === 'file-start') {
      const buf  = await Crypto.decrypt(this.aesKey, msg.iv, msg.ct);
      const meta = JSON.parse(new TextDecoder().decode(buf));
      this._inFiles.set(msg.id, { ...meta, chunks: new Array(meta.total), received: 0 });
      this.cb.onFileProgress({ id: msg.id, name: meta.name, size: meta.size, type: meta.type, pct: 0, phase: 'start' });

    } else if (msg.t === 'file-chunk') {
      const f = this._inFiles.get(msg.id);
      if (!f) return;
      const buf = await Crypto.decrypt(this.aesKey, msg.iv, msg.ct);
      f.chunks[msg.i] = new Uint8Array(buf);
      f.received++;
      const pct = Math.round((f.received / f.total) * 100);
      this.cb.onFileProgress({ id: msg.id, pct, phase: 'chunk' });

      if (f.received === f.total) {
        let len = 0;
        for (let i = 0; i < f.total; i++) len += f.chunks[i].length;
        const full = new Uint8Array(len);
        let off = 0;
        for (let i = 0; i < f.total; i++) { full.set(f.chunks[i], off); off += f.chunks[i].length; }
        const url = URL.createObjectURL(new Blob([full], { type: f.type }));
        this._inFiles.delete(msg.id);
        this.cb.onFileDone({ id: msg.id, name: f.name, size: f.size, mimeType: f.type, url });
      }
    }
  }

  // ── Signaling ──────────────────────────────────────────────────────────
  async offer() {
    const sdp    = await this.pc.createOffer();
    await this.pc.setLocalDescription(sdp);
    const pubKey = await Crypto.exportPublicKey(this.keyPair);
    this.socket.emit('signal:offer', { to: this.socketId, offer: sdp, publicKey: pubKey });
    this.state = 'offering';
    this.cb.onState('offering');
  }

  async handleOffer(sdp, theirPubKeyB64) {
    this.theirPubKey = theirPubKeyB64;
    const theirKey   = await Crypto.importPublicKey(theirPubKeyB64);
    this.aesKey      = await Crypto.deriveSharedKey(this.keyPair.privateKey, theirKey);
    await this.pc.setRemoteDescription(sdp);
    const ans    = await this.pc.createAnswer();
    await this.pc.setLocalDescription(ans);
    const pubKey = await Crypto.exportPublicKey(this.keyPair);
    this.socket.emit('signal:answer', { to: this.socketId, answer: ans, publicKey: pubKey });
  }

  async handleAnswer(sdp, theirPubKeyB64) {
    this.theirPubKey = theirPubKeyB64;
    const theirKey   = await Crypto.importPublicKey(theirPubKeyB64);
    this.aesKey      = await Crypto.deriveSharedKey(this.keyPair.privateKey, theirKey);
    await this.pc.setRemoteDescription(sdp);
  }

  async addIce(candidate) {
    try { await this.pc.addIceCandidate(candidate); } catch (_) {}
  }

  // ── Send text ──────────────────────────────────────────────────────────
  async sendText(text) {
    const { iv, ct } = await Crypto.encrypt(this.aesKey, text);
    this._send(JSON.stringify({ t: 'text', iv, ct, ts: Date.now() }));
  }

  // ── Send file ──────────────────────────────────────────────────────────
  async sendFile(file, onProgress) {
    const CHUNK = 16384; // 16 KB
    const id    = crypto.randomUUID();
    const buf   = await file.arrayBuffer();
    const total = Math.ceil(buf.byteLength / CHUNK) || 1;

    // Metadata packet
    const metaStr = JSON.stringify({ name: file.name, size: file.size, type: file.type, total });
    const encMeta = await Crypto.encrypt(this.aesKey, metaStr);
    this._send(JSON.stringify({ t: 'file-start', id, iv: encMeta.iv, ct: encMeta.ct }));

    // Chunk packets
    for (let i = 0; i < total; i++) {
      const chunk = new Uint8Array(buf, i * CHUNK, Math.min(CHUNK, buf.byteLength - i * CHUNK));
      const enc   = await Crypto.encrypt(this.aesKey, chunk);
      this._send(JSON.stringify({ t: 'file-chunk', id, i, total, iv: enc.iv, ct: enc.ct }));
      if (onProgress) onProgress(Math.round(((i + 1) / total) * 100));
      // Yield every 8 chunks to avoid blocking the event loop
      if (i % 8 === 7) await new Promise(r => setTimeout(r, 0));
    }
    return id;
  }

  // ── Internal helpers ───────────────────────────────────────────────────
  _send(data) {
    if (this._dc?.readyState === 'open') {
      this._dc.send(data);
    } else {
      this._q.push(data);
    }
  }

  close() {
    try { this._dc?.close(); } catch (_) {}
    try { this.pc.close();   } catch (_) {}
    this.state = 'closed';
  }
}
