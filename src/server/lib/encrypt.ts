import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { agentConfig } from '../agent.config';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const PBKDF2_ITERATIONS = 100_000;
const KEY_LEN = 32; // 256 bits

function getKey(): Buffer {
  const hex = agentConfig.encryptionKey;
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Derive a per-user encryption key using PBKDF2.
 * Key = PBKDF2(supabaseUserId, ENCRYPTION_SALT, 100k iterations, sha512)
 */
function deriveUserKey(supabaseUserId: string): Buffer {
  const salt = agentConfig.encryptionSalt;
  if (!salt) {
    throw new Error('ENCRYPTION_SALT must be set for per-user encryption');
  }
  return pbkdf2Sync(supabaseUserId, salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha512');
}

function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptWithKey(encoded: string, key: Buffer): string {
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
}

/** Encrypt with the shared server key (legacy). */
export function encrypt(plaintext: string): string {
  return encryptWithKey(plaintext, getKey());
}

/** Decrypt with the shared server key (legacy). */
export function decrypt(encoded: string): string {
  return decryptWithKey(encoded, getKey());
}

/** Encrypt with a per-user derived key. */
export function encryptForUser(plaintext: string, supabaseUserId: string): string {
  return encryptWithKey(plaintext, deriveUserKey(supabaseUserId));
}

/** Decrypt with a per-user derived key. */
export function decryptForUser(encoded: string, supabaseUserId: string): string {
  return decryptWithKey(encoded, deriveUserKey(supabaseUserId));
}

/**
 * Try to decrypt with per-user key first; fall back to shared key (legacy migration).
 * Returns the plaintext and whether it was legacy-encrypted.
 */
export function decryptWithFallback(
  encoded: string,
  supabaseUserId: string
): { plaintext: string; wasLegacy: boolean } {
  // Try per-user key first
  try {
    const plaintext = decryptForUser(encoded, supabaseUserId);
    return { plaintext, wasLegacy: false };
  } catch {
    // Fall back to shared key (legacy)
  }

  const plaintext = decrypt(encoded);
  return { plaintext, wasLegacy: true };
}
