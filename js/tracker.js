const TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.files.fm:7073/announce',
  'wss://tracker.novage.com.ua'
];

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

  _connectOne(url, makeOffers) {
    if (this._closed) return;
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

    ws.onclose = (e) => {
      log('disconnected from', url, e.code);
      if (this._closed) return;
      setTimeout(() => this._connectOne(url, makeOffers), 5000);
    };
    ws.onerror = () => { log('ws error', url); };

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
