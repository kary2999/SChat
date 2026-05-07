const MSG_TTL = 60_000;
const BURN_TTL = 5_000;

let feedEl = null;
let tilesEl = null;
let peerCountEl = null;
let channelNameEl = null;
let footerTtlEl = null;
const messageTimers = new Map();
let msgIdCounter = 0;

export function initUI() {
  feedEl = document.getElementById('feed');
  tilesEl = document.getElementById('tiles');
  peerCountEl = document.getElementById('peer-count');
  channelNameEl = document.getElementById('channel-name');
  footerTtlEl = document.getElementById('footer-ttl');
}

export function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) {
    s.classList.toggle('active', s.id === id);
  }
}

export function updatePeerCount(n) {
  if (peerCountEl) peerCountEl.textContent = n;
}

export function updateChannelName(name) {
  if (channelNameEl) channelNameEl.textContent = name;
}

export function addSystemMessage(text) {
  const id = 'msg-' + (++msgIdCounter);
  const el = document.createElement('div');
  el.className = 'msg-line sys';
  el.id = id;

  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = '[' + timeStr() + ']';
  el.appendChild(ts);

  const body = document.createElement('span');
  body.className = 'body';
  body.textContent = ' ' + text;
  el.appendChild(body);

  feedEl.appendChild(el);
  scrollFeed();
  scheduleRemove(id, MSG_TTL);
}

export function addTextMessage({ nick, text, isSelf = false, burn = false }) {
  const id = 'msg-' + (++msgIdCounter);
  const el = document.createElement('div');
  el.className = 'msg-line' + (isSelf ? ' self' : '') + (burn ? ' burn' : '');
  el.id = id;

  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = timeStr();
  el.appendChild(ts);

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = (isSelf ? 'you' : sanitizeName(nick)) + '>';
  el.appendChild(who);

  const body = document.createElement('span');
  body.className = 'body';
  el.appendChild(body);

  if (burn && !isSelf) {
    body.textContent = ' [ \u{1F525} tap to read ]';
    body.dataset.realText = text;
    body.addEventListener('click', () => {
      body.textContent = ' ' + text;
      el.classList.add('revealed');
      scheduleRemove(id, BURN_TTL);
    }, { once: true });
    addTtlBar(el, MSG_TTL);
  } else {
    body.textContent = ' ' + text;
    addTtlBar(el, burn ? BURN_TTL : MSG_TTL);
    scheduleRemove(id, burn ? BURN_TTL : MSG_TTL);
  }

  feedEl.appendChild(el);
  scrollFeed();
  if (!burn || isSelf) scheduleRemove(id, burn ? BURN_TTL : MSG_TTL);
}

export function addImageMessage({ nick, dataUrl, isSelf = false, burn = false }) {
  const id = 'msg-' + (++msgIdCounter);
  const el = document.createElement('div');
  el.className = 'msg-line' + (isSelf ? ' self' : '') + (burn ? ' burn' : '');
  el.id = id;

  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = timeStr();
  el.appendChild(ts);

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = (isSelf ? 'you' : sanitizeName(nick)) + '>';
  el.appendChild(who);

  if (burn && !isSelf) {
    const body = document.createElement('span');
    body.className = 'body';
    body.textContent = ' [ \u{1F525} tap to view image ]';
    el.appendChild(body);
    body.addEventListener('click', () => {
      body.remove();
      const img = createSafeImage(dataUrl);
      el.appendChild(img);
      el.classList.add('revealed');
      scheduleRemove(id, BURN_TTL);
    }, { once: true });
    addTtlBar(el, MSG_TTL);
  } else {
    const img = createSafeImage(dataUrl);
    el.appendChild(document.createTextNode(' '));
    el.appendChild(img);
    addTtlBar(el, burn ? BURN_TTL : MSG_TTL);
  }

  feedEl.appendChild(el);
  scrollFeed();
  if (!burn || isSelf) scheduleRemove(id, burn ? BURN_TTL : MSG_TTL);
}

export function addVoiceMessage({ nick, dataUrl, duration, isSelf = false }) {
  const id = 'msg-' + (++msgIdCounter);
  const el = document.createElement('div');
  el.className = 'msg-line voice' + (isSelf ? ' self' : '');
  el.id = id;

  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = timeStr();
  el.appendChild(ts);

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = (isSelf ? 'you' : sanitizeName(nick)) + '>';
  el.appendChild(who);

  const body = document.createElement('span');
  body.className = 'body';
  body.textContent = ` [ \u{1F3A4} ${duration.toFixed(1)}s voice ]`;
  el.appendChild(body);

  const bar = document.createElement('span');
  bar.className = 'voice-bar';
  for (let i = 0; i < 5; i++) bar.appendChild(document.createElement('i'));
  el.appendChild(bar);

  const audio = document.createElement('audio');
  audio.src = dataUrl;
  body.style.cursor = 'pointer';
  body.addEventListener('click', () => {
    audio.currentTime = 0;
    audio.play();
  });

  addTtlBar(el, MSG_TTL);
  feedEl.appendChild(el);
  scrollFeed();
  scheduleRemove(id, MSG_TTL);
}

function createSafeImage(dataUrl) {
  if (!dataUrl.startsWith('data:image/')) {
    const span = document.createElement('span');
    span.textContent = '[invalid image]';
    return span;
  }
  const img = document.createElement('img');
  img.className = 'msg-img';
  img.src = dataUrl;
  img.alt = 'image';
  return img;
}

function addTtlBar(parent, duration) {
  const bar = document.createElement('div');
  bar.className = 'ttl-bar';
  bar.style.animationDuration = duration + 'ms';
  parent.appendChild(bar);
}

function scheduleRemove(id, ms) {
  if (messageTimers.has(id)) clearTimeout(messageTimers.get(id));
  messageTimers.set(id, setTimeout(() => {
    const el = document.getElementById(id);
    if (el) {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.5s';
      setTimeout(() => el.remove(), 500);
    }
    messageTimers.delete(id);
  }, ms));
}

function scrollFeed() {
  if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
}

function timeStr() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function sanitizeName(name) {
  return (name || 'anon').replace(/[<>&"'/]/g, '').slice(0, 20);
}

/* ======= VIDEO TILES ======= */

const videoTiles = new Map();

export function addVideoTile(peerId, stream, label, isSelf = false) {
  tilesEl.classList.add('visible');
  if (videoTiles.has(peerId)) removeVideoTile(peerId);

  const tile = document.createElement('div');
  tile.className = 'tile' + (isSelf ? ' self' : '');
  tile.id = 'tile-' + peerId;

  const video = document.createElement('video');
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isSelf;
  tile.appendChild(video);

  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = sanitizeName(label);
  tile.appendChild(tag);

  if (!isSelf) {
    const rec = document.createElement('span');
    rec.className = 'rec-dot';
    tile.appendChild(rec);
  }

  tilesEl.appendChild(tile);
  videoTiles.set(peerId, tile);
}

export function removeVideoTile(peerId) {
  const tile = videoTiles.get(peerId);
  if (tile) {
    const vid = tile.querySelector('video');
    if (vid) vid.srcObject = null;
    tile.remove();
    videoTiles.delete(peerId);
  }
  if (videoTiles.size === 0) tilesEl.classList.remove('visible');
}

export function clearAllTiles() {
  for (const [id] of videoTiles) removeVideoTile(id);
}
