// All encryption happens here, in the browser (Web Crypto). The server only ever sees ciphertext.
// Shared with the self-check (test.js) and `node server.js set-password`, so client and server derive identically.
export const CHUNK = 4 * 1024 * 1024; // plaintext bytes per encrypted chunk: bounds memory for big files on phones
export const TAG = 16; // AES-GCM tag added to every chunk
export const ITERATIONS = 600000; // PBKDF2-SHA256, OWASP 2023 recommendation

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();

export const b64enc = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export const b64dec = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

// password -> PBKDF2 master -> two independent HKDF outputs:
//   key:   AES-256-GCM, non-extractable, never leaves the device
//   token: sent to the server as the login; the server stores only its SHA-256 and can't derive the key from it
export async function deriveKeys(password, saltB64) {
  const pw = await subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveBits']);
  const master = await subtle.deriveBits({ name: 'PBKDF2', salt: b64dec(saltB64), iterations: ITERATIONS, hash: 'SHA-256' }, pw, 256);
  const hkdf = await subtle.importKey('raw', master, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const info = (label) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode(label) });
  const key = await subtle.deriveKey(info('family-files enc'), hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const token = hex(await subtle.deriveBits(info('family-files auth'), hkdf, 256));
  return { key, token };
}

export const chunkCount = (size) => Math.max(1, Math.ceil(size / CHUNK));

// Chunk i of file `id`: IV = 8-byte random per-file prefix + 32-bit chunk counter (never reused under one key).
// AAD = file id + "is last chunk", so the server can't reorder chunks, swap them between files, or cut a file short.
function chunkParams(prefix, id, i, last) {
  const iv = new Uint8Array(12);
  iv.set(prefix);
  new DataView(iv.buffer).setUint32(8, i);
  return { name: 'AES-GCM', iv, additionalData: utf8.encode(`${id}:${last ? 1 : 0}`) };
}
export const encryptChunk = (key, prefix, id, i, last, data) => subtle.encrypt(chunkParams(prefix, id, i, last), key, data);
export const decryptChunk = (key, prefix, id, i, last, data) => subtle.decrypt(chunkParams(prefix, id, i, last), key, data);

// File name, size, type and chunk prefix, encrypted as one blob bound to the file id.
export async function encryptMeta(key, id, meta) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(`${id}:meta`) }, key, utf8.encode(JSON.stringify(meta)));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return b64enc(out);
}
export async function decryptMeta(key, id, blob) {
  const b = b64dec(blob);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), additionalData: utf8.encode(`${id}:meta`) }, key, b.slice(12));
  return JSON.parse(new TextDecoder().decode(pt));
}
