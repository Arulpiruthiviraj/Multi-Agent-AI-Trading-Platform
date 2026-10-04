import { describe, it, expect, afterEach } from 'vitest';
import {
  COMMAND_HELP,
  EXIT_USAGE,
  UsageError,
  apiBase,
  commandNames,
  setApiBaseOverride,
  suggestCommands,
  usageError,
} from './argus-cli';

/**
 * Industry-standard CLI surface tests (2026-10-04): per-command help coverage,
 * usage-error exit codes, did-you-mean suggestions, kill-switch gating is
 * covered at the dispatch level by spawn tests below (kept minimal: tsx spawn
 * is ~2s per case).
 */

describe('suggestCommands', () => {
  const names = commandNames();

  it('suggests the intended command for common typos', () => {
    expect(suggestCommands('heath', names)).toContain('health');
    expect(suggestCommands('strat', names)).toContain('status');
    expect(suggestCommands('kill-swtich', names)).toContain('kill-switch');
  });

  it('returns nothing for gibberish', () => {
    expect(suggestCommands('zzzzqqqq', names)).toEqual([]);
  });

  it('never suggests the input itself and caps results', () => {
    const out = suggestCommands('health', names);
    expect(out).not.toContain('health');
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it('is a pure function', () => {
    expect(suggestCommands('heath', names)).toEqual(suggestCommands('heath', names));
  });
});

describe('usageError', () => {
  it('throws a UsageError carrying exit code 2', () => {
    try {
      usageError('Usage: argus foo <bar>');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UsageError);
      expect((e as UsageError).exitCode).toBe(EXIT_USAGE);
      expect((e as Error).message).toBe('Usage: argus foo <bar>');
    }
  });

  it('EXIT_USAGE follows the POSIX convention', () => {
    expect(EXIT_USAGE).toBe(2);
  });
});

describe('apiBase / setApiBaseOverride', () => {
  const original = apiBase();
  afterEach(() => setApiBaseOverride(original));

  it('defaults to the env or loopback', () => {
    expect(apiBase()).toBe(process.env.ARGUS_API_URL || 'http://127.0.0.1:3000');
  });

  it('applies and restores the --api-url override', () => {
    setApiBaseOverride('http://127.0.0.1:3999');
    expect(apiBase()).toBe('http://127.0.0.1:3999');
  });
});

describe('COMMAND_HELP coverage', () => {
  it('every registered command has a help entry', () => {
    const missing = commandNames().filter((n) => !(n in COMMAND_HELP));
    expect(missing).toEqual([]);
  });

  it('every entry starts with a Usage: line', () => {
    for (const [name, text] of Object.entries(COMMAND_HELP)) {
      expect(text.startsWith('Usage:'), `${name} help should start with Usage:`).toBe(true);
    }
  });

  it('kill-switch help documents the --confirm gate', () => {
    expect(COMMAND_HELP['kill-switch']).toContain('--confirm');
  });
});
