// AES-256-GCM symmetric crypto for at-rest secrets.
//
// Key material is derived from the server-wide MASTER_KEY env var:
//   - if set to a 32-byte hex string (64 chars), it's used directly
//   - otherwise SHA-256(MASTER_KEY) is used (allows shorter passphrases)
//
// Encrypted blob layout: nonce(12) || ciphertext || authTag(16)
//
// All values produced by encryptValue() are self-describing — decryptValue
// derives the parts from the buffer length. Rotating MASTER_KEY requires
// re-encrypting every secret; out of scope for Phase 6 — operators
// generate a strong key once and never rotate without a migration plan.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const NONCE_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.MASTER_KEY;
  if (!raw) {
    throw new Error('MASTER_KEY is not set. Generate one with `openssl rand -hex 32`.');
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    cachedKey = Buffer.from(raw, 'hex');
  } else {
    cachedKey = createHash('sha256').update(raw, 'utf8').digest();
  }
  return cachedKey;
}

export function encryptValue(plaintext: string): Buffer {
  const key = masterKey();
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([nonce, encrypted, authTag]);
}

export function decryptValue(blob: Buffer): string {
  if (blob.length < NONCE_LEN + TAG_LEN + 1) {
    throw new Error('encrypted blob too short');
  }
  const key = masterKey();
  const nonce = blob.subarray(0, NONCE_LEN);
  const authTag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/** For tests — clear the cached derived key so a new MASTER_KEY env can take effect. */
export function _resetCryptoCacheForTests(): void {
  cachedKey = null;
}
