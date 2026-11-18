import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const key = config.SRI_PORTAL_ENCRYPTION_KEY;
  if (!key) throw new Error('SRI_PORTAL_ENCRYPTION_KEY no configurado');
  // key should be 32 bytes hex or base64
  if (key.length === 64) return Buffer.from(key, 'hex');
  return Buffer.from(key, 'base64');
}

export function encrypt(plain: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(encB64: string): string {
  const key = getKey();
  const buf = Buffer.from(encB64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}
