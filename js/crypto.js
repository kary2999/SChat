export async function generateKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  );
}

export async function exportPublicKey(keyPair) {
  const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return new Uint8Array(raw);
}

export async function importPublicKey(rawBytes) {
  return crypto.subtle.importKey(
    'raw',
    rawBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

export async function deriveKey(myPrivateKey, theirPublicKey) {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPublicKey },
    myPrivateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = typeof plaintext === 'string'
    ? new TextEncoder().encode(plaintext)
    : plaintext;
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return out;
}

export async function decrypt(key, buf) {
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
}

export async function fingerprint(pubKeyBytes) {
  const hash = await crypto.subtle.digest('SHA-256', pubKeyBytes);
  return Array.from(new Uint8Array(hash).slice(0, 4))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function randomId(bytes = 20) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function channelHash(name, password = '') {
  const raw = new TextEncoder().encode(name + ':' + password);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return Array.from(new Uint8Array(hash).slice(0, 20))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
