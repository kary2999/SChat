import { generateKeyPair, exportPublicKey, importPublicKey, deriveKey, encrypt, decrypt, fingerprint, randomId, channelHash } from './crypto.js';
import { TrackerClient } from './tracker.js';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: [
        'turn:relay1.expressturn.com:3478',
        'turn:relay1.expressturn.com:3480'
      ],
      username: 'efPN3HM65DA9PSWLQE',
      credential: 'kQH5JRZqCQRWKkNH'
    }
  ],
  iceCandidatePoolSize: 4
};

const MAX_OFFERS = 5;
const OFFER_CACHE_MS = 5000;
const PENDING_OFFER_TTL = 90_000;
const log = (...a) => console.log('[mesh]', ...a);

// Modern browsers (Chrome 75+, Firefox, Safari) already anonymize host
// candidates by replacing the LAN IP with an mDNS .local hostname that's
// only resolvable on the local link. Stripping host candidates was breaking
// same-network connectivity (LAN, same-machine, NAT hairpin scenarios)
// without adding any real privacy benefit. So we now pass SDP through
// untouched and rely on the browser's built-in mDNS anonymization.
function stripLocalCandidates(sdp) { return sdp; }

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
    // Test override: allow ?testId=xxx in URL to force a specific peerId.
    // Used for E2E tests where two iframes in the same top-level window
    // share sessionStorage and would otherwise collide on peerId.
    const urlTestId = new URLSearchParams(location.search).get('testId');
    this.nickname = nickname || 'anon-' + randomId(3);
    if (urlTestId) {
      this.peerId = urlTestId;
    } else {
      this.peerId = sessionStorage.getItem('schat_peer_id') || randomId(20);
      sessionStorage.setItem('schat_peer_id', this.peerId);
    }
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
    // Image messages can exceed the WebRTC data-channel single-message limit
    // (~256KB). Split them into chunks the receiver reassembles.
    if ((payload.t === 'img' || payload.t === 'voice')
        && typeof payload.data === 'string' && payload.data.length > 60_000) {
      return this._broadcastChunked(payload);
    }
    const json = JSON.stringify(payload);
    for (const [, peer] of this.peers) {
      if (!peer.aesKey || !peer.dc || peer.dc.readyState !== 'open') continue;
      try {
        const ct = await encrypt(peer.aesKey, json);
        peer.dc.send(ct);
      } catch (e) { log('broadcast send failed:', e.message); }
    }
  }

  async _broadcastChunked(payload) {
    const CHUNK = 60_000; // 60KB plain-text chunks (≈ <90KB ciphertext, well under 256KB)
    const id = randomId(8);
    const data = payload.data;
    const total = Math.ceil(data.length / CHUNK);
    const meta = { ...payload, data: undefined };
    delete meta.data;
    log('chunked send id=', id, 'parts=', total);
    for (const [, peer] of this.peers) {
      if (!peer.aesKey || !peer.dc || peer.dc.readyState !== 'open') continue;
      try {
        for (let i = 0; i < total; i++) {
          const part = data.slice(i * CHUNK, (i + 1) * CHUNK);
          const chunkMsg = { t: 'imgchunk', id, i, total, meta, part };
          const ct = await encrypt(peer.aesKey, JSON.stringify(chunkMsg));
          peer.dc.send(ct);
          // Yield occasionally to avoid blocking the DC send buffer
          if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
        }
      } catch (e) { log('chunk broadcast failed:', e.message); }
    }
  }

  _absorbChunk(pid, msg) {
    if (!this._chunkBuffers) this._chunkBuffers = new Map();
    const key = pid + ':' + msg.id;
    let buf = this._chunkBuffers.get(key);
    if (!buf) {
      buf = { parts: new Array(msg.total), got: 0, meta: msg.meta };
      this._chunkBuffers.set(key, buf);
    }
    if (!buf.parts[msg.i]) {
      buf.parts[msg.i] = msg.part;
      buf.got++;
    }
    if (buf.got === msg.total) {
      this._chunkBuffers.delete(key);
      const data = buf.parts.join('');
      const reassembled = { ...buf.meta, data, _from: pid };
      const peer = this.peers.get(pid);
      if (peer) {
        reassembled._nick = peer.nickname;
        reassembled._fp = peer.fp;
        reassembled._fromOwner = peer.isOwner;
      }
      this._emit('message', reassembled);
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
    this._setupRenegotiation(pc, peerId);

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
    this._setupRenegotiation(pc, peerId);

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

  // Perfect-negotiation pattern over the encrypted data channel.
  // Either side adding a track triggers `negotiationneeded` → we craft an
  // offer and ship it inside the secure DC. Glare resolved by polite/impolite
  // (lower peerId = polite, rolls back its own offer on collision).
  _setupRenegotiation(pc, peerId) {
    pc.onnegotiationneeded = async () => {
      const peer = this.peers.get(peerId);
      if (!peer || !peer.aesKey) return; // wait until the DC handshake done
      if (peer._makingOffer) return;
      peer._makingOffer = true;
      try {
        await pc.setLocalDescription();
        await this._waitIce(pc);
        const sdp = stripLocalCandidates(pc.localDescription.sdp);
        await this._sendSecure(peer, { t: 'reneg-offer', sdp });
        log('reneg → sent offer to', peerId.slice(0, 8));
      } catch (e) {
        log('reneg offer failed:', e.message);
      } finally {
        peer._makingOffer = false;
      }
    };
  }

  async _sendSecure(peer, payload) {
    if (!peer || !peer.aesKey || !peer.dc || peer.dc.readyState !== 'open') return;
    const ct = await encrypt(peer.aesKey, JSON.stringify(payload));
    peer.dc.send(ct);
  }

  async _handleRenegOffer(peer, peerId, sdp) {
    const pc = peer.pc;
    if (!pc) return;
    const isPolite = this.peerId < peerId;
    const collision = peer._makingOffer || pc.signalingState !== 'stable';
    if (!isPolite && collision) {
      log('reneg ← ignoring offer (impolite collision) from', peerId.slice(0, 8));
      return;
    }
    try {
      if (collision) {
        await Promise.all([
          pc.setLocalDescription({ type: 'rollback' }),
          pc.setRemoteDescription({ type: 'offer', sdp })
        ]);
      } else {
        await pc.setRemoteDescription({ type: 'offer', sdp });
      }
      await pc.setLocalDescription();
      await this._waitIce(pc);
      const answerSdp = stripLocalCandidates(pc.localDescription.sdp);
      await this._sendSecure(peer, { t: 'reneg-answer', sdp: answerSdp });
      log('reneg → sent answer to', peerId.slice(0, 8));
    } catch (e) {
      log('reneg answer failed:', e.message);
    }
  }

  async _handleRenegAnswer(peer, peerId, sdp) {
    const pc = peer.pc;
    if (!pc) return;
    if (pc.signalingState === 'stable') return;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp });
      log('reneg ← applied answer from', peerId.slice(0, 8));
    } catch (e) {
      log('reneg apply answer failed:', e.message);
    }
  }

  _setupDC(dc, offerId, remotePeerId) {
    dc.binaryType = 'arraybuffer';

    const sendKey = (pid) => {
      if (dc.readyState !== 'open') return false;
      const keyMsg = JSON.stringify({
        t: 'key',
        pub: Array.from(this.pubKeyBytes),
        nick: this.nickname,
        peerId: this.peerId,
        owner: this.isOwner
      });
      try {
        dc.send(new TextEncoder().encode(keyMsg));
        log('sent key →', pid?.slice(0, 8));
        return true;
      } catch (err) {
        log('send key FAILED →', pid?.slice(0, 8), err.message);
        return false;
      }
    };

    dc.onopen = async () => {
      let pid = remotePeerId;
      if (!pid) {
        for (const [id, peer] of this.peers) {
          if (peer.dc === dc) { pid = id; break; }
        }
      }
      log('dc OPEN', pid?.slice(0, 8) || offerId?.slice(0, 8));
      if (pid && this.peers.has(pid)) {
        this.peers.get(pid).dc = dc;
      }
      // First send happens after the next microtask — fixes Safari race where
      // dc.onopen fires but the channel is not yet truly ready to send.
      await Promise.resolve();
      sendKey(pid);

      // Resend the key periodically for up to 15s in case the first packet
      // is lost or the peer's catch{} has dropped a malformed parse silently.
      let attempts = 0;
      const retryTimer = setInterval(() => {
        attempts++;
        const peer = pid ? this.peers.get(pid) : null;
        if (!peer || peer.aesKey || dc.readyState !== 'open' || attempts > 10) {
          clearInterval(retryTimer);
          return;
        }
        sendKey(pid);
      }, 1500);

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
        let text;
        try { text = new TextDecoder().decode(data); }
        catch (e) { log('key handshake: utf-8 decode failed', e.message); return; }

        let msg;
        try { msg = JSON.parse(text); }
        catch (e) { log('key handshake: JSON parse failed', e.message, 'text=', text.slice(0, 60)); return; }

        if (msg.t !== 'key') { log('key handshake: unexpected msg type', msg.t); return; }

        try {
          peer.pubKeyBytes = new Uint8Array(msg.pub);
          const theirPub = await importPublicKey(peer.pubKeyBytes);
          peer.aesKey = await deriveKey(this.keyPair.privateKey, theirPub);
          peer.nickname = msg.nick || pid.slice(0, 8);
          peer.fp = await fingerprint(peer.pubKeyBytes);
          peer.isOwner = !!msg.owner;
          // Single-owner enforcement: if both ends claim owner, the lower
          // fingerprint wins; we self-demote here so UI is consistent.
          if (peer.isOwner && this.isOwner) {
            if (peer.fp < this.pubFp) {
              log('demoting self — peer', pid.slice(0, 8), 'has lower fp');
              this.isOwner = false;
              sessionStorage.removeItem(ownerKey(this.channelName));
              this.ownerFp = peer.fp;
              this._emit('owner-changed', { isOwner: false });
            } else {
              peer.isOwner = false;
            }
          } else if (peer.isOwner && !this.ownerFp) {
            this.ownerFp = peer.fp;
          }
          log('key exchanged ✓', pid.slice(0, 8), 'nick=', peer.nickname);
          this._emit('peer-ready', {
            peerId: pid,
            nickname: peer.nickname,
            fingerprint: peer.fp,
            isOwner: peer.isOwner
          });
        } catch (e) {
          log('key handshake: import/derive failed', e.message);
        }
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

        if (msg.t === 'reneg-offer') {
          await this._handleRenegOffer(peer, pid, msg.sdp);
          return;
        }
        if (msg.t === 'reneg-answer') {
          await this._handleRenegAnswer(peer, pid, msg.sdp);
          return;
        }
        if (msg.t === 'imgchunk') {
          this._absorbChunk(pid, msg);
          return;
        }
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
      // Only emit leave if peer is still in our table; if _closePeer was
      // already called manually (eg. during glare replacement) the entry
      // was removed and we should NOT fire a phantom peer-leave.
      if (pid && this.peers.has(pid)) {
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
