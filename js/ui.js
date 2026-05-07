const MSG_TTL = 60_000;
const BURN_TTL = 5_000;

let feedEl = null;
let tilesEl = null;
let peerCountEl = null;
let channelNameEl = null;
let footerTtlEl = null;
let peerListEl = null;
let peerPanelEl = null;
const messageTimers = new Map();
let msgIdCounter = 0;
let _onKickHandler = null;

export function initUI() {
  feedEl = document.getElementById('feed');
  tilesEl = document.getElementById('tiles');
  peerCountEl = document.getElementById('peer-count');
  channelNameEl = document.getElementById('channel-name');
  footerTtlEl = document.getElementById('footer-ttl');
  peerListEl = document.getElementById('peer-list');
  peerPanelEl = document.getElementById('peer-panel');
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

export function setOwnerBadge(isOwner) {
  const badge = document.getElementById('owner-badge');
  if (badge) badge.style.display = isOwner ? 'inline-block' : 'none';
}

export function onKickPeer(handler) { _onKickHandler = handler; }

export function renderPeerList(peers, { selfNick, selfPeerId, isOwner }) {
  if (!peerListEl) return;
  peerListEl.innerHTML = '';

  const selfRow = document.createElement('div');
  selfRow.className = 'peer-row self';
  const selfDot = document.createElement('span'); selfDot.className = 'peer-dot online';
  const selfName = document.createElement('span'); selfName.className = 'peer-name';
  selfName.textContent = (selfNick || '我') + ' (我)';
  const selfId = document.createElement('span'); selfId.className = 'peer-id';
  selfId.textContent = selfPeerId ? selfPeerId.slice(0, 8) : '';
  selfRow.appendChild(selfDot);
  selfRow.appendChild(selfName);
  selfRow.appendChild(selfId);
  if (isOwner) {
    const tag = document.createElement('span'); tag.className = 'peer-owner';
    tag.textContent = '房主'; selfRow.appendChild(tag);
  }
  peerListEl.appendChild(selfRow);

  for (const [pid, p] of peers) {
    const row = document.createElement('div');
    row.className = 'peer-row';

    const dot = document.createElement('span');
    const ready = p.aesKey && p.dc && p.dc.readyState === 'open';
    dot.className = 'peer-dot ' + (ready ? 'online' : 'pending');
    row.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'peer-name';
    name.textContent = sanitizeName(p.nickname || pid.slice(0, 8));
    row.appendChild(name);

    const idSpan = document.createElement('span');
    idSpan.className = 'peer-id';
    idSpan.textContent = (p.fp || pid.slice(0, 8));
    row.appendChild(idSpan);

    if (p.isOwner) {
      const tag = document.createElement('span');
      tag.className = 'peer-owner';
      tag.textContent = '房主';
      row.appendChild(tag);
    }

    if (isOwner && !p.isOwner) {
      const kick = document.createElement('button');
      kick.className = 'peer-kick';
      kick.title = '踢出并封禁';
      kick.textContent = '✕';
      kick.addEventListener('click', () => {
        if (_onKickHandler) _onKickHandler(pid);
      });
      row.appendChild(kick);
    }

    peerListEl.appendChild(row);
  }
}

export function togglePeerPanel(force) {
  if (!peerPanelEl) return;
  if (typeof force === 'boolean') {
    peerPanelEl.classList.toggle('open', force);
  } else {
    peerPanelEl.classList.toggle('open');
  }
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
  who.textContent = (isSelf ? '我' : sanitizeName(nick)) + '>';
  el.appendChild(who);

  const body = document.createElement('span');
  body.className = 'body';
  el.appendChild(body);

  if (burn && !isSelf) {
    body.textContent = ' [ \u{1F525} 点击查看 · 阅后即焚 ]';
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
  who.textContent = (isSelf ? '我' : sanitizeName(nick)) + '>';
  el.appendChild(who);

  if (burn && !isSelf) {
    const body = document.createElement('span');
    body.className = 'body';
    body.textContent = ' [ \u{1F525} 点击查看图片 · 阅后即焚 ]';
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
  who.textContent = (isSelf ? '我' : sanitizeName(nick)) + '>';
  el.appendChild(who);

  const body = document.createElement('span');
  body.className = 'body';
  body.textContent = ` [ \u{1F3A4} 语音 ${duration.toFixed(1)}s ]`;
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
    span.textContent = '[无效图片]';
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
