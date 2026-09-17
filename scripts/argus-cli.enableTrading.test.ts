import { describe, it, expect } from 'vitest';
import { parseFlags, resumeReasonFromArgv } from './argus-cli';

/**
 * `start --enable-trading` (2026-09-15): lets the normal `argus-cli start` chain the same
 * operator-resume path `argus-cli resume` already uses, in one step, for the common "start
 * today's session and enable trading" flow. These are the two pure argument-parsing helpers that
 * decide (a) whether the flag was passed and (b) what reason string to record - the actual
 * resumeTrading() HTTP call reuses the exact same /api/v1/system/resume route `resume` always
 * used, so its own safety behavior is unchanged and not re-tested here (see resumeTrading()'s own
 * doc comment in argus-cli.ts).
 */
describe('parseFlags - enableTrading', () => {
  it('is false when --enable-trading is not passed', () => {
    expect(parseFlags(['--prod']).enableTrading).toBe(false);
    expect(parseFlags([]).enableTrading).toBe(false);
  });

  it('is true when --enable-trading is passed, independent of other flags', () => {
    expect(parseFlags(['--enable-trading']).enableTrading).toBe(true);
    expect(parseFlags(['--prod', '--enable-trading']).enableTrading).toBe(true);
    expect(parseFlags(['--enable-trading', '--dev']).enableTrading).toBe(true);
  });

  it('does not imply --enable-trading from --prod/--dev/--headless', () => {
    const flags = parseFlags(['--prod', '--dev', '--headless']);
    expect(flags.enableTrading).toBe(false);
  });
});

describe('resumeReasonFromArgv', () => {
  it('returns the fallback when no --reason= is present', () => {
    expect(resumeReasonFromArgv(['--enable-trading'], 'fallback reason')).toBe('fallback reason');
    expect(resumeReasonFromArgv([], 'fallback reason')).toBe('fallback reason');
  });

  it('extracts the reason text after --reason=', () => {
    expect(resumeReasonFromArgv(['--reason=Market open 2026-09-16'], 'fallback')).toBe('Market open 2026-09-16');
  });

  it('takes the first --reason= if somehow passed more than once', () => {
    expect(resumeReasonFromArgv(['--reason=first', '--reason=second'], 'fallback')).toBe('first');
  });
});
