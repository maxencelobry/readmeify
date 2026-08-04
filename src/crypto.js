import { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let key = null;

/** Loads and validates ENCRYPTION_KEY. Called once at boot so a bad key fails fast. */
export function initCrypto(base64Key) {
  const buf = Buffer.from(String(base64Key || ''), 'base64');
  if (buf.length !== 32) {
    throw new Error(
      'ENCRYPTION_KEY must be 32 bytes, base64 encoded. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  key = buf;
}

/** Encrypts a UTF-8 string. Returns base64 of iv | tag | ciphertext. */
export function encrypt(plaintext) {
  if (!key) throw new Error('crypto not initialised');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

/** Reverses encrypt(). Throws if the payload was tampered with or the key changed. */
export function decrypt(payload) {
  if (!key) throw new Error('crypto not initialised');
  const buf = Buffer.from(String(payload), 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('ciphertext too short');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString(
    'utf8',
  );
}

/** Constant-time string compare, for OAuth state values. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}
