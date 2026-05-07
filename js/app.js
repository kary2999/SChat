import { Mesh } from './mesh.js';
import { readClipboard, blobToBase64, VoiceRecorder, getCamera, getMicrophone, stopStream } from './media.js';
import {
  initUI, showScreen, updatePeerCount, updateChannelName,
  addSystemMessage, addTextMessage, addImageMessage, addVoiceMessage,
  addVideoTile, removeVideoTile, clearAllTiles,
  setOwnerBadge, renderPeerList, togglePeerPanel, onKickPeer
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

  document.getElementById('join-btn').addEventListener('click', () => doJoin(false));
  document.getElementById('create-btn')?.addEventListener('click', () => doJoin(true));
  document.getElementById('channel-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoin(false);
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
  document.getElementById('peers-btn')?.addEventListener('click', () => togglePeerPanel());
  document.getElementById('peer-panel-close')?.addEventListener('click', () => togglePeerPanel(false));

  document.getElementById('modal-cancel').addEventListener('click', hideChannelModal);
  document.getElementById('modal-join').addEventListener('click', () => switchChannel(false));
  document.getElementById('modal-create')?.addEventListener('click', () => switchChannel(true));

  onKickPeer(async (peerId) => {
    if (!confirm('确认踢出并封禁此用户？')) return;
    await mesh.kickPeer(peerId);
    addSystemMessage('已踢出用户 ' + peerId.slice(0, 8));
    refreshPeerList();
  });

  mesh.addEventListener('peer-ready', (e) => {
    const d = e.detail;
    const ownerTag = d.isOwner ? ' [房主]' : '';
    addSystemMessage(`${d.nickname}${ownerTag} 加入 · 指纹:${d.fingerprint}`);
    updatePeerCount(mesh.peers.size);
    refreshPeerList();
  });

  mesh.addEventListener('peer-leave', (e) => {
    const id = e.detail.peerId;
    const peer = mesh.peers.get(id);
    addSystemMessage(`${peer?.nickname || id.slice(0, 8)} 离开`);
    removeVideoTile(id);
    updatePeerCount(mesh.peers.size);
    refreshPeerList();
  });

  mesh.addEventListener('message', (e) => handleIncoming(e.detail));

  mesh.addEventListener('track', (e) => {
    const { peerId, streams } = e.detail;
    const peer = mesh.peers.get(peerId);
    const label = peer?.nickname || peerId.slice(0, 8);
    if (streams && streams[0]) addVideoTile(peerId, streams[0], label);
  });

  mesh.addEventListener('joined', (e) => {
    showScreen('chat-screen');
    updateChannelName(e.detail.channel);
    updatePeerCount(0);
    setOwnerBadge(e.detail.isOwner);
    addSystemMessage(`已加入 #${e.detail.channel}${e.detail.isOwner ? ' · 你是房主' : ''} · 等待节点连接...`);
    refreshPeerList();
  });

  mesh.addEventListener('peer-fail', (e) => {
    addSystemMessage(`节点 ${e.detail.peerId.slice(0, 8)} 连接失败：${e.detail.reason}`);
  });

  mesh.addEventListener('kicked', (e) => {
    addSystemMessage('你被房主踢出了');
    showScreen('join-screen');
    setTimeout(() => alert('你被房主 ' + (e.detail?.by || '') + ' 踢出并封禁'), 50);
  });
});

function refreshPeerList() {
  renderPeerList(mesh.peers, {
    selfNick: mesh.nickname,
    selfPeerId: mesh.peerId,
    isOwner: mesh.isOwner
  });
}

async function doJoin(asOwner) {
  const channel = document.getElementById('channel-input').value.trim();
  const password = document.getElementById('password-input').value;
  const nick = document.getElementById('nick-input').value.trim() || undefined;

  if (!channel) return;
  if (nick) localStorage.setItem('schat_nick', nick);

  await mesh.init(nick);
  await mesh.join(channel, password, { asOwner });
}

function sendText() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;
  const payload = { t: 'msg', text, burn: burnMode };
  mesh.broadcast(payload);
  addTextMessage({ nick: '我', text, isSelf: true, burn: burnMode });
  input.value = '';
}

async function doPaste() {
  const clip = await readClipboard();
  if (!clip) { addSystemMessage('剪贴板为空'); return; }
  if (clip.type === 'text') {
    document.getElementById('msg-input').value = clip.data;
  } else if (clip.type === 'image') {
    const dataUrl = await blobToBase64(clip.data);
    if (!validateImageData(dataUrl)) return;
    mesh.broadcast({ t: 'img', data: dataUrl, burn: burnMode });
    addImageMessage({ nick: '我', dataUrl, isSelf: true, burn: burnMode });
  }
}

function toggleBurn() {
  burnMode = !burnMode;
  const btn = document.getElementById('burn-btn');
  btn.classList.toggle('burn-on', burnMode);
  addSystemMessage(burnMode ? '阅后即焚已开启 · 查看后 5 秒销毁' : '阅后即焚已关闭');
}

async function toggleMic() {
  const btn = document.getElementById('mic-btn');
  if (micLive) {
    stopStream(micStream); micStream = null;
    mesh.setAudioStream(null);
    micLive = false;
    btn.classList.remove('live');
    addSystemMessage('麦克风已关闭');
  } else {
    try {
      micStream = await getMicrophone();
      mesh.setAudioStream(micStream);
      micLive = true;
      btn.classList.add('live');
      addSystemMessage('麦克风开启 · 实时语音直播');
    } catch { addSystemMessage('麦克风权限被拒'); }
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
    addSystemMessage('摄像头已关闭');
  } else {
    try {
      camStream = await getCamera();
      mesh.setVideoStream(camStream);
      addVideoTile('self', camStream, mesh.nickname, true);
      camLive = true;
      btn.classList.add('live');
      addSystemMessage('摄像头已开启');
    } catch { addSystemMessage('摄像头权限被拒'); }
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
      addVoiceMessage({ nick: '我', dataUrl, duration, isSelf: true });
    }
  } else {
    try {
      await voiceRecorder.start();
      recording = true;
      btn.classList.add('live');
      addSystemMessage('正在录音...');
    } catch { addSystemMessage('麦克风权限被拒'); }
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
    addImageMessage({ nick: '我', dataUrl, isSelf: true, burn: burnMode });
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
    addSystemMessage('图片过大 (上限约 3.5MB)');
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

async function switchChannel(asOwner) {
  const ch = document.getElementById('modal-channel').value.trim();
  const pw = document.getElementById('modal-password').value;
  if (!ch) return;
  hideChannelModal();
  clearAllTiles();
  micLive = false; camLive = false;
  stopStream(micStream); micStream = null;
  stopStream(camStream); camStream = null;
  document.getElementById('mic-btn').classList.remove('live');
  document.getElementById('cam-btn').classList.remove('live');
  await mesh.join(ch, pw, { asOwner });
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
  const w = 900, h = 720;
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.windows) {
    const url = chrome.runtime.getURL('popup.html?mode=expanded');
    chrome.windows.create({ url, type: 'popup', width: w, height: h });
    window.close();
  } else {
    const params = `width=${w},height=${h},menubar=no,toolbar=no,location=no,status=no`;
    window.open(location.pathname + '?mode=expanded', 'schat-expanded', params);
  }
}

setInterval(() => { if (mesh.peers.size > 0) refreshPeerList(); }, 3000);
