/**
 * ==========================================================
 * Module:
 * EncryptionService.ts
 *
 * Purpose:
 * Core implementation and logic for the EncryptionService.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for EncryptionService
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// Broker and AI provider API keys stored in the DB are encrypted with this key. Without a real
// ENCRYPTION_SECRET, every Argus install would otherwise fall back to the same hardcoded literal
// key - making any DB dump trivially decryptable. Fail loudly instead of silently using it.
if (!process.env.ENCRYPTION_SECRET) {
  throw new Error(
    'ENCRYPTION_SECRET is not set. Refusing to start: broker and AI provider API keys stored in ' +
    'the database must not be encrypted with a hardcoded, publicly-known key. Set ENCRYPTION_SECRET in .env.'
  );
}
const ENCRYPTION_KEY = process.env.ENCRYPTION_SECRET;
const IV_LENGTH = 16;

export class EncryptionService {
  static encrypt(text: string): string {
    if (!text) return text;
    try {
      const iv = crypto.randomBytes(IV_LENGTH);
      let key: string | Buffer = ENCRYPTION_KEY;
      if (typeof key === 'string') {
        key = crypto.scryptSync(key, 'salt', 32);
      }
      
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      let encrypted = cipher.update(text);
      encrypted = Buffer.concat([encrypted, cipher.final()]);
      return iv.toString('hex') + ':' + encrypted.toString('hex');
    } catch (e) {
      console.error("Encryption failed", e);
      return text;
    }
  }

  static decrypt(text: string): string {
    if (!text) return text;
    try {
      if (!text.includes(':')) return text; // Probably not encrypted
      
      const textParts = text.split(':');
      const iv = Buffer.from(textParts.shift() as string, 'hex');
      const encryptedText = Buffer.from(textParts.join(':'), 'hex');
      
      let key: string | Buffer = ENCRYPTION_KEY;
      if (typeof key === 'string') {
        key = crypto.scryptSync(key, 'salt', 32);
      }
      
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(encryptedText);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      return decrypted.toString();
    } catch (e) {
      console.error("Decryption failed", e);
      return text;
    }
  }
}
