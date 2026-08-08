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
import fs from 'fs';
import path from 'path';

dotenv.config();

const IV_LENGTH = 16;
const KEY_FILE = path.join(process.cwd(), 'data', '.encryption_key');

/**
 * Resolves the AES key. Prefers ENCRYPTION_SECRET from the environment; if it's absent, a
 * random key is generated once and persisted locally so encrypted values stay decryptable
 * across restarts. Previously this fell back to scrypt("argus-local-secret-key-default"), a
 * hardcoded key baked into the source - anyone with the repo could decrypt every installation
 * that hadn't set ENCRYPTION_SECRET.
 */
function resolveKey(): Buffer {
  if (process.env.ENCRYPTION_SECRET) {
    return crypto.scryptSync(process.env.ENCRYPTION_SECRET, 'argus-salt', 32);
  }
  try {
    if (fs.existsSync(KEY_FILE)) {
      return Buffer.from(fs.readFileSync(KEY_FILE, 'utf-8').trim(), 'hex');
    }
    const generated = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, generated.toString('hex'), { mode: 0o600 });
    console.warn(`[EncryptionService] ENCRYPTION_SECRET not set. Generated and persisted a local key at ${KEY_FILE}. Set ENCRYPTION_SECRET in production so keys survive a redeploy/volume loss.`);
    return generated;
  } catch (e) {
    throw new Error(`EncryptionService: no ENCRYPTION_SECRET configured and failed to persist a local key: ${(e as Error).message}`);
  }
}

const ENCRYPTION_KEY = resolveKey();

export class EncryptionService {
  static encrypt(text: string): string {
    if (!text) return text;
    // No try/catch-and-return-plaintext here: if encryption fails, the caller needs to know,
    // not silently persist an unencrypted secret to SQLite while believing it succeeded.
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  }

  static decrypt(text: string): string {
    if (!text) return text;
    if (!text.includes(':')) return text; // Not in iv:ciphertext format - treat as already-plaintext (legacy/manual values)

    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift() as string, 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');

    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
    return decrypted.toString('utf8');
  }
}
