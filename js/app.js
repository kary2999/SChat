import { Mesh } from './mesh.js';
import { readClipboard, blobToBase64, VoiceRecorder, getCamera, getMicrophone, stopStream } from './media.js';
import {
  initUI, showScreen, updatePeerCount, updateChannelName,
  addSystemMessage, addTextMessage, addImageMessage, addVoiceMessage,
  addVideoTile, removeVideoTile, clearAllTiles
} from './ui.js';

const mesh = new Mesh();
let burnMode = false;
let micLive = false;
let camLive = false;
let micStream = null;
let camStream = null;
const voiceRecorder = new VoiceRecorder();
let recording = false;

document.addEventListener('DOMContentLoaded', async () => {
  initUI();
  showScreen('join-screen');

  const savedNick = localStorage.getItem('schat_nick') || '';
  const nickInput = document.getElementById('nick-input');
  if (savedNick) nickInput.value = savedNick;

  document.getElementById('join-btn').addEventListener('click', doJoin);
  document.getElementById('channel-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoin();
  });

  document.getElementById('quick-join').addEventListener('click', async () => {
    const nick = document.getElementById('nick-input').value.trim() || undefined;
    if (nick) localStorage.setItem('schat_nick', nick);
    await mesh.init(nick);
    await mesh.join('知音广场', '');
  });

  document.getElementById('msg-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  });

  document.getElementById('send-btn').addEventListener('click', sendText);
  document.getElementById('paste-btn').addEventListener('click', doPaste);
  document.getElementById('burn-btn').addEventListener('click', toggleBurn);
  document.getElementById('mic-btn').addEventListener('click', toggleMic);
  document.getElementById('cam-btn').addEventListener('click', toggleCam);
  document.getElementById('img-btn').addEventListener('click', pickImage);
  document.getElementById('voice-btn').addEventListener('click', toggleVoiceRecord);
  document.getElementById('ch-btn').addEventListener('click', showChannelModal);
  document.getElementById('leave-btn').addEventListener('click', doLeave);
  document.getElementById('expand-btn').addEventListener('click', expandWindow);

  document.getElementById('modal-cancel').addEventListener('click', hideChannelModal);
  document.getElementById('modal-join').addEventListener('click', switchChannel);

  mesh.addEventListener('peer-ready', (e) => {
    const d = e.detail;
    addSystemMessage(`${d.nickname} joined · fp:${d.fingerprint}`);
    updatePeerCount(mesh.peers.size);
  });

  mesh.addEventListener('peer-leave', (e) => {
    const id = e.detail.peerId;
    const peer = mesh.peers.get(id);
    addSystemMessage(`${peer?.nickname || id.slice(0, 8)} left`);
    removeVideoTile(id);
    updatePeerCount(mesh.peers.size);
  });

  mesh.addEventListener('message', (e) => {
    handleIncoming(e.detail);
  });

  mesh.addEventListener('track', (e) => {
    const { peerId, track, streams } = e.detail;
    const peer = mesh.peers.get(peerId);
    const label = peer?.nickname || peerId.slice(0, 8);
    if (streams && streams[0]) {
      addVideoTile(peerId, streams[0], label);
    }
  });

  mesh.addEventListener('joined', (e) => {
    showScreen('chat-screen');
    updateChannelName(e.detail.channel);
    updatePeerCount(0);
    addSystemMessage(`joined #${e.detail.channel} · waiting for peers...`);
  });
});

async function doJoin() {
  const channel = document.getElementById('channel-input').value.trim();
  const password = document.getElementById('password-input').value;
  const nick = document.getElementById('nick-input').value.trim() || undefined;

  if (!channel) return;
  if (nick) localStorage.setItem('schat_nick', nick);

  await mesh.init(nick);
  await mesh.join(channel, password);
}

function sendText() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;

  const payload = { t: 'msg', text, burn: burnMode };
  mesh.broadcast(payload);
  addTextMessage({ nick: 'you', text, isSelf: true, burn: burnMode });
  input.value = '';
}

async function doPaste() {
  const clip = await readClipboard();
  if (!clip) { addSystemMessage('clipboard empty'); return; }

  if (clip.type === 'text') {
    document.getElementById('msg-input').value = clip.data;
  } else if (clip.type === 'image') {
    const dataUrl = await blobToBase64(clip.data);
    if (!validateImageData(dataUrl)) return;
    mesh.broadcast({ t: 'img', data: dataUrl, burn: burnMode });
    addImageMessage({ nick: 'you', dataUrl, isSelf: true, burn: burnMode });
  }
}

function toggleBurn() {
  burnMode = !burnMode;
  const btn = document.getElementById('burn-btn');
  btn.classList.toggle('burn-on', burnMode);
  addSystemMessage(burnMode ? 'burn mode ON · 5s after view' : 'burn mode OFF');
}

async function toggleMic() {
  const btn = document.getElementById('mic-btn');
  if (micLive) {
    stopStream(micStream);
    micStream = null;
    mesh.setAudioStream(null);
    micLive = false;
    btn.classList.remove('live');
    addSystemMessage('mic OFF');
  } else {
    try {
      micStream = await getMicrophone();
      mesh.setAudioStream(micStream);
      micLive = true;
      btn.classList.add('live');
      addSystemMessage('mic ON · live audio');
    } catch {
      addSystemMessage('mic access denied');
    }
  }
}

async function toggleCam() {
  const btn = document.getElementById('cam-btn');
  if (camLive) {
    stopStream(camStream);
    removeVideoTile('self');
    camStream = null;
    mesh.setVideoStream(null);
    camLive = false;
    btn.classList.remove('live');
    addSystemMessage('cam OFF');
  } else {
    try {
      camStream = await getCamera();
      mesh.setVideoStream(camStream);
      addVideoTile('self', camStream, mesh.nickname, true);
      camLive = true;
      btn.classList.add('live');
      addSystemMessage('cam ON');
    } catch {
      addSystemMessage('cam access denied');
    }
  }
}

async function toggleVoiceRecord() {
  const btn = document.getElementById('voice-btn');
  if (recording) {
    const blob = await voiceRecorder.stop();
    recording = false;
    btn.classList.remove('live');
    if (blob && blob.size > 0) {
      const dataUrl = await blobToBase64(blob);
      const duration = blob.size / 4000;
      mesh.broadcast({ t: 'voice', data: dataUrl, dur: duration });
      addVoiceMessage({ nick: 'you', dataUrl, duration, isSelf: true });
    }
  } else {
    try {
      await voiceRecorder.start();
      recording = true;
      btn.classList.add('live');
      addSystemMessage('recording voice...');
    } catch {
      addSystemMessage('mic access denied');
    }
  }
}

function pickImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    const dataUrl = await blobToBase64(file);
    if (!validateImageData(dataUrl)) return;
    mesh.broadcast({ t: 'img', data: dataUrl, burn: burnMode });
    addImageMessage({ nick: 'you', dataUrl, isSelf: true, burn: burnMode });
  };
  input.click();
}

function handleIncoming(msg) {
  if (!msg || typeof msg !== 'object') return;
  const nick = sanitize(msg._nick);

  switch (msg.t) {
    case 'msg':
      if (typeof msg.text !== 'string') return;
      addTextMessage({ nick, text: msg.text.slice(0, 5000), burn: !!msg.burn });
      break;
    case 'img':
      if (typeof msg.data !== 'string' || !validateImageData(msg.data)) return;
      addImageMessage({ nick, dataUrl: msg.data, burn: !!msg.burn });
      break;
    case 'voice':
      if (typeof msg.data !== 'string' || !msg.data.startsWith('data:audio/')) return;
      addVoiceMessage({ nick, dataUrl: msg.data, duration: Number(msg.dur) || 0 });
      break;
  }
}

function validateImageData(dataUrl) {
  if (typeof dataUrl !== 'string') return false;
  if (!dataUrl.startsWith('data:image/')) return false;
  if (dataUrl.length > 5_000_000) {
    addSystemMessage('image too large (max ~3.5MB)');
    return false;
  }
  return true;
}

function sanitize(s) {
  return (s || 'anon').replace(/[<>&"'/\\]/g, '').slice(0, 20);
}

function showChannelModal() {
  document.getElementById('modal-overlay').classList.add('visible');
  document.getElementById('modal-channel').focus();
}

function hideChannelModal() {
  document.getElementById('modal-overlay').classList.remove('visible');
}

async function switchChannel() {
  const ch = document.getElementById('modal-channel').value.trim();
  const pw = document.getElementById('modal-password').value;
  if (!ch) return;
  hideChannelModal();
  clearAllTiles();
  micLive = false;
  camLive = false;
  stopStream(micStream); micStream = null;
  stopStream(camStream); camStream = null;
  document.getElementById('mic-btn').classList.remove('live');
  document.getElementById('cam-btn').classList.remove('live');
  await mesh.join(ch, pw);
}

function doLeave() {
  mesh.leave();
  clearAllTiles();
  micLive = false; camLive = false;
  stopStream(micStream); micStream = null;
  stopStream(camStream); camStream = null;
  showScreen('join-screen');
}

function expandWindow() {
  const w = 560, h = 700;
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.windows) {
    const url = chrome.runtime.getURL('popup.html?mode=expanded');
    chrome.windows.create({ url, type: 'popup', width: w, height: h });
    window.close();
  } else {
    const params = `width=${w},height=${h},menubar=no,toolbar=no,location=no,status=no`;
    window.open(location.pathname + '?mode=expanded', 'schat-expanded', params);
  }
}
