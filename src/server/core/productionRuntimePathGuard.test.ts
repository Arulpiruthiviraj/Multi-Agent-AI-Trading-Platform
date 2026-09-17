import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { isIsolationRequiredContext, assertNotProductionRuntimePath } from './productionRuntimePathGuard';

/**
 * P1 isolation fix (2026-09-15) - see productionRuntimePathGuard.ts's own header for the real
 * incident history (enginePid.ts, 2026-08-25; sessionRecovery.ts, 2026-09-15 same day) this
 * closes. These are pure-function tests only - no filesystem access anywhere in this file, so
 * there is zero risk of these tests themselves touching a real path regardless of whether the
 * guard under test is correct.
 */
describe('isIsolationRequiredContext', () => {
  const original = { VITEST: process.env.VITEST, NODE_ENV: process.env.NODE_ENV, SYNTHETIC_SIMULATION: process.env.SYNTHETIC_SIMULATION };
  afterEach(() => {
    process.env.VITEST = original.VITEST;
    process.env.NODE_ENV = original.NODE_ENV;
    process.env.SYNTHETIC_SIMULATION = original.SYNTHETIC_SIMULATION;
  });

  it('is true right now, under the real vitest runner (VITEST=true) - proves the primary, zero-configuration signal actually fires', () => {
    // Not mocked - this is the real environment vitest itself set for this very test run.
    expect(process.env.VITEST).toBe('true');
    expect(isIsolationRequiredContext()).toBe(true);
  });

  it('is true when NODE_ENV=test even if VITEST is unset', () => {
    delete process.env.VITEST;
    process.env.NODE_ENV = 'test';
    expect(isIsolationRequiredContext()).toBe(true);
  });

  it('is true when SYNTHETIC_SIMULATION=true even if neither of the above is set', () => {
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    process.env.SYNTHETIC_SIMULATION = 'true';
    expect(isIsolationRequiredContext()).toBe(true);
  });

  it('is false when none of the three signals are set', () => {
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    delete process.env.SYNTHETIC_SIMULATION;
    expect(isIsolationRequiredContext()).toBe(false);
  });
});

describe('assertNotProductionRuntimePath', () => {
  const PROD = path.join('C:', 'WorkProjects', 'Multi-Agent-AI-Trading-Platform', 'data', '.argus_runtime_session.json');

  it('throws when the candidate resolves to the exact production path while isolation is required', () => {
    process.env.VITEST = 'true';
    expect(() => assertNotProductionRuntimePath(PROD, 'test file', PROD)).toThrow(/FATAL/);
  });

  it('throws even when the candidate is spelled differently but resolves to the same real path (relative vs absolute)', () => {
    process.env.VITEST = 'true';
    const relativeSpelling = path.join('.', 'data', '..', 'data', '.argus_runtime_session.json');
    const productionAbsolute = path.resolve('data', '.argus_runtime_session.json');
    // Only meaningful if relative resolves from the same cwd as the production path - construct
    // both from the same base to prove path.resolve() normalization, not a coincidence.
    expect(() => assertNotProductionRuntimePath(relativeSpelling, 'test file', productionAbsolute)).toThrow(/FATAL/);
  });

  it('does not throw when the candidate is a genuinely different (isolated) path', () => {
    process.env.VITEST = 'true';
    const isolated = path.join('C:', 'Temp', 'argus_test_12345', '.argus_runtime_session.json');
    expect(() => assertNotProductionRuntimePath(isolated, 'test file', PROD)).not.toThrow();
  });

  it('does not throw even for the production path itself when isolation is NOT required (defense-in-depth only fires under test/simulation conditions)', () => {
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    delete process.env.SYNTHETIC_SIMULATION;
    expect(() => assertNotProductionRuntimePath(PROD, 'test file', PROD)).not.toThrow();
    process.env.VITEST = 'true'; // restore for subsequent tests in this file
  });
});
