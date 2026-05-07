import { generateKeyPair, exportPublicKey, importPublicKey, deriveKey, encrypt, decrypt, fingerprint, randomId, channelHash } from './crypto.js';
import { TrackerClient } from './tracker.js';

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

const MAX_OFFERS = 10;

function stripLocalCandidates(sdp) {
  return sdp.split('\r\n').filter(line => {
    if (!line.startsWith('a=candidate:')) return true;
    if (line.includes(' host ')) return false;
    if (line.includes(' srflx ')) return false;
    return true;
  }).join('\r\n');
}

export class Mesh extends EventTarget {
  constructor() {
    super();
    this.peerId = null;
    this.nickname = '';
    this.keyPair = null;
    this.pubKeyBytes = null;
    this.peers = new Map();
    this._tracker = null;
    this._pendingOffers = new Map();
    this._knownPeerIds = new Set();
    this._localStreams = { audio: null, video: null };
    this.channelName = '';
  }

  async init(nickname) {
    this.nickname = nickname || 'anon-' + randomId(3);
    this.peerId = localStorage.getItem('schat_peer_id') || randomId(20);
    localStorage.setItem('schat_peer_id', this.peerId);
    this.keyPair = await generateKeyPair();
    this.pubKeyBytes = await exportPublicKey(this.keyPair);
  }

  async join(channelName, password = '') {
    this.leave();
    this.channelName = channelName;
    const hash = await channelHash(channelName, password);

    this._tracker = new TrackerClient(hash, this.peerId);
    this._tracker.addEventListener('offer', (e) => this._onOffer(e.detail));
    this._tracker.addEventListener('answer', (e) => this._onAnswer(e.detail));
    this._tracker.connect(() => this._makeOffers());
    this._emit('joined', { channel: channelName });
  }

  leave() {
    if (this._tracker) {
      this._tracker.disconnect();
      this._tracker = null;
    }
    for (const [id, peer] of this.peers) {
      this._closePeer(id);
    }
    this.peers.clear();
    this._pendingOffers.clear();
    this._knownPeerIds.clear();
    this.channelName = '';
  }

  async broadcast(payload) {
    const json = JSON.stringify(payload);
    for (const [id, peer] of this.peers) {
      if (!peer.aesKey || !peer.dc || peer.dc.readyState !== 'open') continue;
      try {
        const ct = await encrypt(peer.aesKey, json);
        peer.dc.send(ct);
      } catch {}
    }
  }

  async broadcastBinary(payload) {
    for (const [id, peer] of this.peers) {
      if (!peer.aesKey || !peer.dc || peer.dc.readyState !== 'open') continue;
      try {
        const ct = await encrypt(peer.aesKey, payload);
        peer.dc.send(ct);
      } catch {}
    }
  }

  setAudioStream(stream) {
    this._localStreams.audio = stream;
    for (const [, peer] of this.peers) {
      this._syncTracks(peer);
    }
  }

  setVideoStream(stream) {
    this._localStreams.video = stream;
    for (const [, peer] of this.peers) {
      this._syncTracks(peer);
    }
  }

  _syncTracks(peer) {
    if (!peer.pc) return;
    const senders = peer.pc.getSenders();
    const allTracks = [];
    if (this._localStreams.audio) {
      for (const t of this._localStreams.audio.getAudioTracks()) allTracks.push(t);
    }
    if (this._localStreams.video) {
      for (const t of this._localStreams.video.getTracks()) allTracks.push(t);
    }

    for (const track of allTracks) {
      const existing = senders.find(s => s.track && s.track.kind === track.kind);
      if (existing) {
        existing.replaceTrack(track);
      } else {
        const stream = track.kind === 'video' ? this._localStreams.video : this._localStreams.audio;
        if (stream) peer.pc.addTrack(track, stream);
      }
    }
  }

  async _makeOffers() {
    const offers = [];
    for (let i = 0; i < MAX_OFFERS; i++) {
      const offerId = randomId(20);
      const pc = this._createPC();
      const dc = pc.createDataChannel('schat', { ordered: true });
      this._setupDC(dc, offerId);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this._waitIce(pc);

      this._pendingOffers.set(offerId, { pc, dc });
      offers.push({
        offer_id: offerId,
        offer: { type: 'offer', sdp: stripLocalCandidates(pc.localDescription.sdp) }
      });
    }
    return offers;
  }

  async _onOffer({ peerId, offerId, sdp }) {
    if (this.peers.has(peerId) || peerId === this.peerId) return;
    if (this._knownPeerIds.has(peerId)) return;

    const pc = this._createPC();
    pc.ondatachannel = (e) => {
      this._setupDC(e.channel, null, peerId);
    };

    pc.ontrack = (e) => {
      this._emit('track', { peerId, track: e.track, streams: e.streams });
    };

    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this._waitIce(pc);

    this._tracker.sendAnswer(peerId, offerId, {
      type: 'answer',
      sdp: stripLocalCandidates(pc.localDescription.sdp)
    });

    this._knownPeerIds.add(peerId);
    this.peers.set(peerId, { pc, dc: null, aesKey: null, pubKeyBytes: null, nickname: '', fp: '' });
    this._syncTracks(this.peers.get(peerId));
  }

  async _onAnswer({ peerId, offerId, sdp }) {
    const pending = this._pendingOffers.get(offerId);
    if (!pending) return;
    this._pendingOffers.delete(offerId);

    if (this.peers.has(peerId)) {
      pending.pc.close();
      return;
    }

    const { pc, dc } = pending;
    await pc.setRemoteDescription({ type: 'answer', sdp });

    pc.ontrack = (e) => {
      this._emit('track', { peerId, track: e.track, streams: e.streams });
    };

    this._knownPeerIds.add(peerId);
    this.peers.set(peerId, { pc, dc, aesKey: null, pubKeyBytes: null, nickname: '', fp: '' });
    this._syncTracks(this.peers.get(peerId));
  }

  _createPC() {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    return pc;
  }

  _setupDC(dc, offerId, remotePeerId) {
    dc.binaryType = 'arraybuffer';

    dc.onopen = async () => {
      let pid = remotePeerId;
      if (!pid && offerId) {
        for (const [id, peer] of this.peers) {
          if (peer.dc === dc) { pid = id; break; }
        }
      }

      const keyMsg = JSON.stringify({
        t: 'key',
        pub: Array.from(this.pubKeyBytes),
        nick: this.nickname
      });
      dc.send(new TextEncoder().encode(keyMsg));

      if (pid && this.peers.has(pid)) {
        this.peers.get(pid).dc = dc;
      }
      this._emit('dc-open', { peerId: pid });
    };

    dc.onmessage = async (e) => {
      const data = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : new Uint8Array(await e.data.arrayBuffer());
      let pid = remotePeerId;
      if (!pid) {
        for (const [id, peer] of this.peers) {
          if (peer.dc === dc) { pid = id; break; }
        }
      }
      if (!pid) return;

      const peer = this.peers.get(pid);
      if (!peer) return;

      if (!peer.aesKey) {
        try {
          const text = new TextDecoder().decode(data);
          const msg = JSON.parse(text);
          if (msg.t === 'key') {
            peer.pubKeyBytes = new Uint8Array(msg.pub);
            const theirPub = await importPublicKey(peer.pubKeyBytes);
            peer.aesKey = await deriveKey(this.keyPair.privateKey, theirPub);
            peer.nickname = msg.nick || pid.slice(0, 8);
            peer.fp = await fingerprint(peer.pubKeyBytes);
            this._emit('peer-ready', {
              peerId: pid,
              nickname: peer.nickname,
              fingerprint: peer.fp
            });
          }
        } catch {}
        return;
      }

      try {
        const plain = await decrypt(peer.aesKey, data);
        const text = new TextDecoder().decode(plain);
        const msg = JSON.parse(text);
        msg._from = pid;
        msg._nick = peer.nickname;
        msg._fp = peer.fp;
        this._emit('message', msg);
      } catch {}
    };

    dc.onclose = () => {
      let pid = remotePeerId;
      if (!pid) {
        for (const [id, peer] of this.peers) {
          if (peer.dc === dc) { pid = id; break; }
        }
      }
      if (pid) {
        this._closePeer(pid);
        this._emit('peer-leave', { peerId: pid });
      }
    };
  }

  _closePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    try { peer.dc?.close(); } catch {}
    try { peer.pc?.close(); } catch {}
    this.peers.delete(id);
    this._knownPeerIds.delete(id);
  }

  _waitIce(pc) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') { resolve(); return; }
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(resolve, 5000);
    });
  }

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}
