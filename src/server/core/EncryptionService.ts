/**
 * ==========================================================
 * Module: EncryptionService.ts
 *
 * AES-256-CBC for broker/AI keys stored in SQLite. Fail-closed:
 * encrypt/decrypt errors throw; ciphertext that is not iv:hex is never
 * returned as if it were a successful decrypt (Phase 20).
 * ==========================================================
 */

import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.ENCRYPTION_SECRET) {
  throw new Error(
    'ENCRYPTION_SECRET is not set. Refusing to start: broker and AI provider API keys stored in ' +
    'the database must not be encrypted with a hardcoded, publicly-known key. Set ENCRYPTION_SECRET in .env.'
  );
}
const ENCRYPTION_KEY = process.env.ENCRYPTION_SECRET;
const IV_LENGTH = 16;

function scryptKey(): Buffer {
  return crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
}

export class EncryptionService {
  static encrypt(text: string): string {
    if (!text) return text;
    try {
      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv('aes-256-cbc', scryptKey(), iv);
      let encrypted = cipher.update(text);
      encrypted = Buffer.concat([encrypted, cipher.final()]);
      return iv.toString('hex') + ':' + encrypted.toString('hex');
    } catch (e) {
      console.error('Encryption failed', e);
      throw new Error('ENCRYPTION_FAILED');
    }
  }

  static decrypt(text: string): string {
    if (!text) return text;
    if (!text.includes(':')) {
      throw new Error('DECRYPTION_FAILED');
    }
    try {
      const textParts = text.split(':');
      const ivHex = textParts.shift() as string;
      const iv = Buffer.from(ivHex, 'hex');
      if (iv.length !== IV_LENGTH) {
        throw new Error('DECRYPTION_FAILED');
      }
      const encryptedText = Buffer.from(textParts.join(':'), 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', scryptKey(), iv);
      let decrypted = decipher.update(encryptedText);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      return decrypted.toString();
    } catch (e) {
      if (e instanceof Error && e.message === 'DECRYPTION_FAILED') throw e;
      console.error('Decryption failed', e);
      throw new Error('DECRYPTION_FAILED');
    }
  }
}
