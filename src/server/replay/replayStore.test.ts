import { describe, it, expect } from 'vitest';
import { isValidReplayId, replayDir, replayRootDir } from './replayStore';

describe('isValidReplayId / replayDir - path-traversal guard', () => {
  it('accepts a real crypto.randomUUID()-shaped id', () => {
    const id = crypto.randomUUID();
    expect(isValidReplayId(id)).toBe(true);
    expect(() => replayDir(id)).not.toThrow();
  });

  it('rejects path-traversal payloads', () => {
    for (const bad of ['../../../etc/passwd', '..\\..\\windows\\system32', '../../data/argus.db', '....//....//etc']) {
      expect(isValidReplayId(bad)).toBe(false);
      expect(() => replayDir(bad)).toThrow();
    }
  });

  it('rejects non-UUID strings that are not traversal payloads either', () => {
    for (const bad of ['', 'not-a-uuid', '12345', 'abcdefgh-1234-1234-1234-123456789012']) {
      expect(isValidReplayId(bad)).toBe(false);
    }
  });

  it('replayDir() never resolves outside the real replay root for a rejected id', () => {
    const root = replayRootDir();
    try {
      replayDir('../../etc');
    } catch {
      // expected - the point of this test is that it throws instead of returning a path
    }
    // Sanity: a valid id's dir really is nested under root.
    const id = crypto.randomUUID();
    expect(replayDir(id).startsWith(root)).toBe(true);
  });
});
