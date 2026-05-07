const TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev'
];
const MAX_RECONNECT = 3;

const REANNOUNCE_MS = 30_000;
const log = (...a) => console.log('[tracker]', ...a);

export class TrackerClient extends EventTarget {
  constructor(infoHash, peerId) {
    super();
    this.infoHash = infoHash;
    this.peerId = peerId;
    this._sockets = [];
    this._timers = [];
    this._closed = false;
  }

  connect(makeOffers) {
    for (const url of TRACKERS) {
      this._connectOne(url, makeOffers);
    }
  }

  _connectOne(url, makeOffers, attempt = 0) {
    if (this._closed) return;
    if (attempt >= MAX_RECONNECT) {
      log('giving up on', url, 'after', attempt, 'attempts');
      return;
    }
    let ws;
    try { ws = new WebSocket(url); } catch (e) { log('ws create failed', url, e); return; }

    ws._url = url;

    ws.onopen = async () => {
      log('connected to', url);
      const offers = await makeOffers();
      log('announcing with', offers.length, 'offers');
      this._send(ws, {
        action: 'announce',
        info_hash: this.infoHash,
        peer_id: this.peerId,
        numwant: 10,
        uploaded: 0,
        downloaded: 0,
        left: 1,
        event: 'started',
        offers
      });
      const timer = setInterval(async () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const reoffers = await makeOffers();
        log('re-announcing with', reoffers.length, 'offers');
        this._send(ws, {
          action: 'announce',
          info_hash: this.infoHash,
          peer_id: this.peerId,
          numwant: 10,
          uploaded: 0,
          downloaded: 0,
          left: 1,
          offers: reoffers
        });
      }, REANNOUNCE_MS);
      this._timers.push(timer);
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.peer_id === this.peerId) return;

      if (msg.info_hash && msg.info_hash !== this.infoHash) return;

      if (msg.offer) {
        log('got offer from', msg.peer_id?.slice(0, 8));
        this.dispatchEvent(new CustomEvent('offer', {
          detail: {
            peerId: msg.peer_id,
            offerId: msg.offer_id,
            sdp: msg.offer
          }
        }));
      } else if (msg.answer) {
        log('got answer from', msg.peer_id?.slice(0, 8));
        this.dispatchEvent(new CustomEvent('answer', {
          detail: {
            peerId: msg.peer_id,
            offerId: msg.offer_id,
            sdp: msg.answer
          }
        }));
      } else {
        log('tracker msg', Object.keys(msg).join(','));
      }
    };

    ws._opened = false;
    ws.addEventListener('open', () => { ws._opened = true; }, { once: true });

    ws.onclose = (e) => {
      log('disconnected from', url, e.code);
      if (this._closed) return;
      // If the socket never even opened, treat as fatal after MAX_RECONNECT;
      // a successful open resets the attempt counter so an established
      // connection that drops can keep retrying without quota.
      const next = ws._opened ? 0 : attempt + 1;
      const delay = ws._opened ? 5000 : 8000 * (attempt + 1);
      setTimeout(() => this._connectOne(url, makeOffers, next), delay);
    };
    ws.onerror = () => { /* swallow — onclose follows and handles retry */ };

    this._sockets.push(ws);
  }

  sendAnswer(toPeerId, offerId, sdp) {
    log('sending answer to', toPeerId?.slice(0, 8));
    const msg = {
      action: 'announce',
      info_hash: this.infoHash,
      peer_id: this.peerId,
      to_peer_id: toPeerId,
      offer_id: offerId,
      answer: sdp
    };
    for (const ws of this._sockets) {
      this._send(ws, msg);
    }
  }

  _send(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  disconnect() {
    this._closed = true;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    for (const ws of this._sockets) {
      try { ws.close(); } catch {}
    }
    this._sockets = [];
  }
}
