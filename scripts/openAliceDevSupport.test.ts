import { describe, it, expect } from 'vitest';
import { openAliceSkipReason, shouldSkipOpenAlice } from './openAliceDevSupport';

describe('shouldSkipOpenAlice', () => {
  it('starts by default (ENABLE_OPENALICE unset)', () => {
    expect(shouldSkipOpenAlice({})).toBe(false);
    expect(openAliceSkipReason({})).toBeNull();
  });

  it('skips when ARGUS_SKIP_OPENALICE=true', () => {
    expect(shouldSkipOpenAlice({ ARGUS_SKIP_OPENALICE: 'true' })).toBe(true);
    expect(openAliceSkipReason({ ARGUS_SKIP_OPENALICE: 'true' })).toMatch(/ARGUS_SKIP_OPENALICE/);
  });

  it('skips when ENABLE_OPENALICE=false even if ARGUS_SKIP_OPENALICE is unset', () => {
    expect(shouldSkipOpenAlice({ ENABLE_OPENALICE: 'false' })).toBe(true);
    expect(openAliceSkipReason({ ENABLE_OPENALICE: 'false' })).toMatch(/ENABLE_OPENALICE=false/);
  });

  it('starts when ENABLE_OPENALICE=true', () => {
    expect(shouldSkipOpenAlice({ ENABLE_OPENALICE: 'true' })).toBe(false);
  });
});
