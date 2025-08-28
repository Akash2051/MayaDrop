let appKey = null;
let currentSalt = null;

export function hasAppKey() { return !!appKey; }
export function getSalt() { return currentSalt; }
export function setSalt(saltArr) { currentSalt = new Uint8Array(saltArr); }

export async function setPassphrase(pass, saltArr) {
  if (!pass) { appKey = null; return; }
  const enc = new TextEncoder();
  const salt = saltArr ? new Uint8Array(saltArr) : (currentSalt || (currentSalt = crypto.getRandomValues(new Uint8Array(16))));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  appKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptChunk(plainU8) {
  if (!appKey) return { cipher: plainU8, iv: null };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, appKey, plainU8);
  return { cipher: new Uint8Array(cipherBuf), iv };
}

export async function decryptChunk(cipherU8, iv) {
  if (!appKey) return cipherU8;
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, appKey, cipherU8);
  return new Uint8Array(plain);
}
