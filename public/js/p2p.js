// WebRTC P2P Manager — full mesh, unreliable data channels for game state
export class P2PManager {
  constructor(socket, mySocketId) {
    this.socket = socket;
    this.mySocketId = mySocketId;
    this._peers = new Map();   // socketId → RTCPeerConnection
    this._channels = new Map(); // socketId → RTCDataChannel
    this._listeners = {};

    socket.on('signal', ({ from, signal }) => this._handleSignal(from, signal));
    socket.on('room:peer-left', ({ socketId }) => this._closePeer(socketId));
  }

  on(event, fn) {
    (this._listeners[event] = this._listeners[event] || []).push(fn);
  }

  _emit(event, data) {
    (this._listeners[event] || []).forEach(fn => fn(data));
  }

  async initiateTo(peerId) {
    const pc = this._createPC(peerId);
    const channel = pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 });
    this._setupChannel(channel, peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.socket.emit('signal', { to: peerId, signal: { type: 'offer', sdp: offer } });
  }

  _createPC(peerId) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });
    this._peers.set(peerId, pc);

    pc.onicecandidate = e => {
      if (e.candidate) {
        this.socket.emit('signal', { to: peerId, signal: { type: 'candidate', candidate: e.candidate } });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this._closePeer(peerId);
      }
    };

    return pc;
  }

  async _handleSignal(from, signal) {
    if (signal.type === 'offer') {
      const pc = this._createPC(from);
      pc.ondatachannel = e => this._setupChannel(e.channel, from);
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('signal', { to: from, signal: { type: 'answer', sdp: answer } });

    } else if (signal.type === 'answer') {
      const pc = this._peers.get(from);
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

    } else if (signal.type === 'candidate') {
      const pc = this._peers.get(from);
      if (pc) {
        try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch (_) {}
      }
    }
  }

  _setupChannel(channel, peerId) {
    this._channels.set(peerId, channel);
    channel.onopen = () => this._emit('peer-connected', { peerId });
    channel.onclose = () => this._closePeer(peerId);
    channel.onmessage = e => {
      try {
        this._emit('message', { from: peerId, data: JSON.parse(e.data) });
      } catch (_) {}
    };
  }

  _closePeer(peerId) {
    const pc = this._peers.get(peerId);
    if (pc) { try { pc.close(); } catch (_) {} this._peers.delete(peerId); }
    this._channels.delete(peerId);
    this._emit('peer-disconnected', { peerId });
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    this._channels.forEach(ch => {
      if (ch.readyState === 'open') try { ch.send(msg); } catch (_) {}
    });
  }

  send(peerId, data) {
    const ch = this._channels.get(peerId);
    if (ch?.readyState === 'open') try { ch.send(JSON.stringify(data)); } catch (_) {}
  }

  get peerCount() { return this._channels.size; }

  destroy() {
    this._peers.forEach((pc, id) => this._closePeer(id));
  }
}
