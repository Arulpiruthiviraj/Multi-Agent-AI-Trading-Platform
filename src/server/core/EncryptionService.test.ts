import { describe, it, expect } from 'vitest';
import { EncryptionService } from './EncryptionService';

describe('EncryptionService fail-closed (Phase 20)', () => {
  it('round-trips a secret', () => {
    const cipher = EncryptionService.encrypt('alpaca-secret');
    expect(cipher).toContain(':');
    expect(cipher).not.toBe('alpaca-secret');
    expect(EncryptionService.decrypt(cipher)).toBe('alpaca-secret');
  });

  it('throws DECRYPTION_FAILED instead of returning plaintext without iv:hex', () => {
    expect(() => EncryptionService.decrypt('not-encrypted-at-all')).toThrow('DECRYPTION_FAILED');
  });

  it('throws DECRYPTION_FAILED on garbage ciphertext', () => {
    expect(() => EncryptionService.decrypt('abcd:zzzz')).toThrow('DECRYPTION_FAILED');
  });

  it('does not return the input string on decrypt failure', () => {
    const raw = 'plaintext-key';
    try {
      EncryptionService.decrypt(raw);
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.message).toBe('DECRYPTION_FAILED');
      expect(e.message).not.toBe(raw);
    }
  });
});
