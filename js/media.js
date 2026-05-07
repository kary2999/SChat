export async function getCamera() {
  return navigator.mediaDevices.getUserMedia({ video: true, audio: true });
}

export async function getMicrophone() {
  return navigator.mediaDevices.getUserMedia({ audio: true });
}

export function stopStream(stream) {
  if (!stream) return;
  for (const t of stream.getTracks()) t.stop();
}

export async function readClipboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes('image/png')) {
        const blob = await item.getType('image/png');
        return { type: 'image', data: blob, mime: 'image/png' };
      }
      if (item.types.includes('image/jpeg')) {
        const blob = await item.getType('image/jpeg');
        return { type: 'image', data: blob, mime: 'image/jpeg' };
      }
    }
    const text = await navigator.clipboard.readText();
    if (text) return { type: 'text', data: text };
  } catch {
    try {
      const text = await navigator.clipboard.readText();
      if (text) return { type: 'text', data: text };
    } catch {}
  }
  return null;
}

export function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

export function base64ToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export class VoiceRecorder {
  constructor() {
    this._recorder = null;
    this._chunks = [];
    this._stream = null;
  }

  async start() {
    this._stream = await getMicrophone();
    this._chunks = [];
    this._recorder = new MediaRecorder(this._stream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm'
    });
    this._recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this._chunks.push(e.data);
    };
    this._recorder.start(100);
  }

  async stop() {
    return new Promise((resolve) => {
      if (!this._recorder || this._recorder.state === 'inactive') {
        resolve(null);
        return;
      }
      this._recorder.onstop = () => {
        const blob = new Blob(this._chunks, { type: this._recorder.mimeType });
        stopStream(this._stream);
        this._stream = null;
        resolve(blob);
      };
      this._recorder.stop();
    });
  }
}
