import { generateKeyPair, exportPublicKey, importPublicKey, deriveKey, encrypt, decrypt, fingerprint, randomId, channelHash } from './crypto.js';
import { TrackerClient } from './tracker.js';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 4
};

const MAX_OFFERS = 5;
const OFFER_CACHE_MS = 5000;
const PENDING_OFFER_TTL = 90_000;
const log = (...a) => console.log('[mesh]', ...a);

function stripLocalCandidates(sdp) {
  return sdp.split('\r\n').filter(line => {
    if (!line.startsWith('a=candidate:')) return true;
    if (line.includes(' host ')) return false;
    return true;
  }).join('\r\n');
}

function banKey(channelName) { return 'schat_ban_' + channelName; }
function ownerKey(channelName) { return 'schat_owner_' + channelName; }

export class Mesh extends EventTarget {
  constructor() {
    super();
    this.peerId = null;
    this.nickname = '';
    this.keyPair = null;
    this.pubKeyBytes = null;
    this.pubFp = '';
    this.peers = new Map();
    this._tracker = null;
    this._pendingOffers = new Map();
    this._localStreams = { audio: null, video: null };
    this.channelName = '';
    this.isOwner = false;
    this.ownerFp = '';
    this._banList = new Set();
    this._cachedOffers = null;
    this._cachedOffersAt = 0;
    this._cleanupTimer = null;
  }

  async init(nickname) {
    this.nickname = nickname || 'anon-' + randomId(3);
    // peerId is per-tab/session so the same browser can open multiple windows.
    // Persistent identity is the ECDH public-key fingerprint, not peerId.
    this.peerId = sessionStorage.getItem('schat_peer_id') || randomId(20);
    sessionStorage.setItem('schat_peer_id', this.peerId);
    this.keyPair = await generateKeyPair();
    this.pubKeyBytes = await exportPublicKey(this.keyPair);
    this.pubFp = await fingerprint(this.pubKeyBytes);
  }

  async join(channelName, password = '', { asOwner = false } = {}) {
    this.leave();
    this.channelName = channelName;

    this._loadBanList();
    // Owner flag is per-tab session — opening a 2nd window in the same browser
    // for testing must NOT auto-promote that window to owner.
    if (asOwner) {
      sessionStorage.setItem(ownerKey(channelName), '1');
    }
    this.isOwner = sessionStorage.getItem(ownerKey(channelName)) === '1';
    this.ownerFp = this.isOwner ? this.pubFp : '';

    const hash = await channelHash(channelName, password);
    log('joining', channelName, 'hash', hash.slice(0, 12), 'owner?', this.isOwner);

    this._tracker = new TrackerClient(hash, this.peerId);
    this._tracker.addEventListener('offer', (e) => this._onOffer(e.detail));
    this._tracker.addEventListener('answer', (e) => this._onAnswer(e.detail));
    this._tracker.connect(() => this._makeOffers());

    this._cleanupTimer = setInterval(() => this._cleanupPending(), 30_000);
    this._emit('joined', { channel: channelName, isOwner: this.isOwner });
  }

  leave() {
    if (this._tracker) {
      this._tracker.disconnect();
      this._tracker = null;
    }
    if (this._cleanupTimer) { clearInterval(this._cleanupTimer); this._cleanupTimer = null; }

    for (const [id] of this.peers) this._closePeer(id);
    this.peers.clear();
    for (const [, p] of this._pendingOffers) {
      try { p.pc.close(); } catch {}
    }
    this._pendingOffers.clear();
    this._cachedOffers = null;
    this._cachedOffersAt = 0;
    this.channelName = '';
    this.isOwner = false;
    this.ownerFp = '';
    this._banList = new Set();
  }

  _loadBanList() {
    try {
      const raw = localStorage.getItem(banKey(this.channelName));
      this._banList = new Set(raw ? JSON.parse(raw) : []);
    } catch { this._banList = new Set(); }
  }
  _saveBanList() {
    try {
      localStorage.setItem(banKey(this.channelName), JSON.stringify([...this._banList]));
    } catch {}
  }
  isBanned(peerId) { return this._banList.has(peerId); }

  async kickPeer(peerId, { ban = true, broadcast = true } = {}) {
    if (!this.isOwner) return;
    if (ban) {
      this._banList.add(peerId);
      this._saveBanList();
    }
    if (broadcast) {
      await this.broadcast({ t: 'ban', target: peerId, _owner: this.pubFp, _ban: ban });
    }
    this._closePeer(peerId);
    this._emit('peer-leave', { peerId });
  }

  unban(peerId) {
    this._banList.delete(peerId);
    this._saveBanList();
  }

  async broadcast(payload) {
    const json = JSON.stringify(payload);
    for (const [, peer] of this.peers) {
      if (!peer.aesKey || !peer.dc || peer.dc.readyState !== 'open') continue;
      try {
        const ct = await encrypt(peer.aesKey, json);
        peer.dc.send(ct);
      } catch {}
    }
  }

  setAudioStream(stream) {
    this._localStreams.audio = stream;
    for (const [, peer] of this.peers) this._syncTracks(peer);
  }
  setVideoStream(stream) {
    this._localStreams.video = stream;
    for (const [, peer] of this.peers) this._syncTracks(peer);
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
    const now = Date.now();
    if (this._cachedOffers && (now - this._cachedOffersAt < OFFER_CACHE_MS)) {
      log('returning cached offers (', this._cachedOffers.length, ')');
      return this._cachedOffers;
    }
    log('creating', MAX_OFFERS, 'offers...');
    const offers = [];
    for (let i = 0; i < MAX_OFFERS; i++) {
      const offerId = randomId(20);
      const pc = this._createPC();
      const dc = pc.createDataChannel('schat', { ordered: true });
      this._setupDC(dc, offerId);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this._waitIce(pc);

      const sdp = stripLocalCandidates(pc.localDescription.sdp);
      this._pendingOffers.set(offerId, { pc, dc, createdAt: Date.now() });
      offers.push({
        offer_id: offerId,
        offer: { type: 'offer', sdp }
      });
    }
    this._cachedOffers = offers;
    this._cachedOffersAt = now;
    log('created & cached', offers.length, 'offers');
    return offers;
  }

  _cleanupPending() {
    const cutoff = Date.now() - PENDING_OFFER_TTL;
    for (const [id, p] of this._pendingOffers) {
      if (p.createdAt < cutoff) {
        try { p.pc.close(); } catch {}
        this._pendingOffers.delete(id);
      }
    }
  }

  _peerReady(peerId) {
    const p = this.peers.get(peerId);
    return p && p.aesKey && p.dc && p.dc.readyState === 'open';
  }

  _shouldAnswer(peerId) { return this.peerId < peerId; }
  _shouldOffer(peerId) { return this.peerId > peerId; }

  async _onOffer({ peerId, offerId, sdp }) {
    if (peerId === this.peerId) return;
    if (this.isBanned(peerId)) { log('ignoring banned peer offer', peerId.slice(0, 8)); return; }
    if (this._peerReady(peerId)) return;

    if (!this._shouldAnswer(peerId)) {
      return;
    }

    if (this.peers.has(peerId)) {
      const existing = this.peers.get(peerId);
      if (existing.role === 'answerer' && existing._answering) {
        return;
      }
      log('replacing prior path to', peerId.slice(0, 8));
      this._closePeer(peerId);
    }

    log('answering offer from', peerId.slice(0, 8));
    const pc = this._createPC();
    pc.ondatachannel = (e) => this._setupDC(e.channel, null, peerId);
    pc.ontrack = (e) => this._emit('track', { peerId, track: e.track, streams: e.streams });
    pc.onconnectionstatechange = () => {
      log('pc(answerer)', pc.connectionState, peerId.slice(0, 8));
      this._emit('peer-state', { peerId, state: pc.connectionState });
      if (pc.connectionState === 'failed') {
        this._emit('peer-fail', { peerId, reason: 'ICE 协商失败 — 可能 NAT 太严格' });
      }
    };
    pc.oniceconnectionstatechange = () => log('ice(answerer)', pc.iceConnectionState, peerId.slice(0, 8));

    this.peers.set(peerId, {
      pc, dc: null, aesKey: null, pubKeyBytes: null,
      nickname: '', fp: '', role: 'answerer', _answering: true, isOwner: false
    });
    this._syncTracks(this.peers.get(peerId));

    try {
      const offerDesc = typeof sdp === 'string' ? { type: 'offer', sdp } : sdp;
      await pc.setRemoteDescription(offerDesc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this._waitIce(pc);
      const answerSdp = stripLocalCandidates(pc.localDescription.sdp);
      this._tracker.sendAnswer(peerId, offerId, { type: 'answer', sdp: answerSdp });
      log('sent answer to', peerId.slice(0, 8));
    } catch (e) {
      log('_onOffer error:', e.message);
      this._closePeer(peerId);
    }
  }

  async _onAnswer({ peerId, offerId, sdp }) {
    const pending = this._pendingOffers.get(offerId);
    if (!pending) return;
    this._pendingOffers.delete(offerId);

    if (peerId === this.peerId) { try { pending.pc.close(); } catch {} return; }
    if (this.isBanned(peerId)) { try { pending.pc.close(); } catch {} return; }

    if (!this._shouldOffer(peerId)) {
      log('role mismatch; we are answerer for', peerId.slice(0, 8), '— dropping incoming answer');
      try { pending.pc.close(); } catch {}
      return;
    }

    if (this._peerReady(peerId)) {
      try { pending.pc.close(); } catch {}
      return;
    }

    if (this.peers.has(peerId)) {
      const existing = this.peers.get(peerId);
      if (existing.role === 'offerer') {
        try { pending.pc.close(); } catch {}
        return;
      }
      this._closePeer(peerId);
    }

    log('processing answer from', peerId.slice(0, 8));
    const { pc, dc } = pending;
    pc.ontrack = (e) => this._emit('track', { peerId, track: e.track, streams: e.streams });
    pc.onconnectionstatechange = () => {
      log('pc(offerer)', pc.connectionState, peerId.slice(0, 8));
      this._emit('peer-state', { peerId, state: pc.connectionState });
      if (pc.connectionState === 'failed') {
        this._emit('peer-fail', { peerId, reason: 'ICE 协商失败 — 可能 NAT 太严格' });
      }
    };
    pc.oniceconnectionstatechange = () => log('ice(offerer)', pc.iceConnectionState, peerId.slice(0, 8));

    this.peers.set(peerId, {
      pc, dc, aesKey: null, pubKeyBytes: null,
      nickname: '', fp: '', role: 'offerer', isOwner: false
    });
    this._syncTracks(this.peers.get(peerId));

    try {
      const answerDesc = typeof sdp === 'string' ? { type: 'answer', sdp } : sdp;
      await pc.setRemoteDescription(answerDesc);
    } catch (e) {
      log('_onAnswer error:', e.message);
      this._closePeer(peerId);
    }
  }

  _createPC() { return new RTCPeerConnection(RTC_CONFIG); }

  _setupDC(dc, offerId, remotePeerId) {
    dc.binaryType = 'arraybuffer';

    dc.onopen = async () => {
      let pid = remotePeerId;
      if (!pid) {
        for (const [id, peer] of this.peers) {
          if (peer.dc === dc) { pid = id; break; }
        }
      }
      log('dc OPEN', pid?.slice(0, 8) || offerId?.slice(0, 8));

      const keyMsg = JSON.stringify({
        t: 'key',
        pub: Array.from(this.pubKeyBytes),
        nick: this.nickname,
        peerId: this.peerId,
        owner: this.isOwner
      });
      try { dc.send(new TextEncoder().encode(keyMsg)); } catch {}

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
            peer.isOwner = !!msg.owner;
            if (peer.isOwner && !this.ownerFp) this.ownerFp = peer.fp;
            this._emit('peer-ready', {
              peerId: pid,
              nickname: peer.nickname,
              fingerprint: peer.fp,
              isOwner: peer.isOwner
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
        msg._fromOwner = peer.isOwner;

        if (msg.t === 'ban') {
          if (peer.isOwner && peer.fp === this.ownerFp) {
            const target = msg.target;
            if (msg._ban !== false) {
              this._banList.add(target);
              this._saveBanList();
            } else {
              this._banList.delete(target);
              this._saveBanList();
            }
            if (target === this.peerId) {
              this._emit('kicked', { by: peer.nickname });
              this.leave();
              return;
            }
            if (this.peers.has(target)) {
              this._closePeer(target);
              this._emit('peer-leave', { peerId: target });
            }
            return;
          }
          return;
        }
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
      // 8s — enough time for TURN candidates to be gathered on slow mobile networks
      setTimeout(resolve, 8000);
    });
  }

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}
