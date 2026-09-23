import { describe, it, expect } from 'vitest';
import { classifyServiceHealth, ECOSYSTEM_BOOT_GRACE_SECONDS } from './argus-ecosystem-status';

/**
 * CLI/control-plane startup-semantics hardening (2026-09-23). Real, reproduced bug: `./argus.sh
 * start`/`restart` reported Argus and every companion as FAILED after a fixed 90s window, even
 * though the real engine went on to become healthy seconds later - a false negative, not an
 * engine boot failure. These tests cover the operator-specified scenarios directly: API becoming
 * ready after >90s, optional-companion failure not affecting the required service's own read, and
 * the boundary behavior of the real (210s) documented boot-grace window.
 */
describe('classifyServiceHealth (argus.sh / argus-ecosystem-status.ts false-negative fix)', () => {
  it('reports READY whenever healthOk is true, regardless of port/elapsed-time inputs', () => {
    expect(classifyServiceHealth({ portOpen: false, healthOk: true, optional: false, bootElapsedSeconds: 99999 }).valueOf())
      .toBe('READY');
    expect(classifyServiceHealth({ portOpen: true, healthOk: true, optional: true }))
      .toBe('READY');
  });

  it('reports STARTING (never FAILED) when the port is open, health is not yet ok, AND a real launch is being tracked', () => {
    const result = classifyServiceHealth({ portOpen: true, healthOk: false, optional: false, bootElapsedSeconds: 5 });
    expect(result).toBe('STARTING');
  });

  it('reports DEGRADED (not STARTING) when the port is open, health is not ok, but no launch is being tracked - a bare status check has no basis to assume a fresh boot (real bug found live: long-running companions timing out on health mid-session were misreported as STARTING)', () => {
    const result = classifyServiceHealth({ portOpen: true, healthOk: false, optional: true });
    expect(result).toBe('DEGRADED');
    const requiredResult = classifyServiceHealth({ portOpen: true, healthOk: false, optional: false });
    expect(requiredResult).toBe('DEGRADED');
  });

  it('required service (Argus API) becoming ready after more than the OLD 90s window is not misreported as FAILED while still within the real boot grace period', () => {
    // The operator's own reproduced scenario: API becomes ready after >90s. At 120s elapsed (past
    // the old fixed window, still within the real 210s companion-chain budget), with no port open
    // yet (companions still loading, server.ts not yet spawned), this must read STARTING - not FAILED.
    const result = classifyServiceHealth({ portOpen: false, healthOk: false, optional: false, bootElapsedSeconds: 120 });
    expect(result).toBe('STARTING');
  });

  it('required service reports FAILED only once genuinely past the documented boot-grace window with zero positive evidence', () => {
    const result = classifyServiceHealth({
      portOpen: false, healthOk: false, optional: false,
      bootElapsedSeconds: ECOSYSTEM_BOOT_GRACE_SECONDS + 1,
    });
    expect(result).toBe('FAILED');
  });

  it('boundary: one second before the grace threshold is still STARTING; exactly at the threshold is FAILED (strict less-than, not inclusive)', () => {
    const justBefore = classifyServiceHealth({
      portOpen: false, healthOk: false, optional: false,
      bootElapsedSeconds: ECOSYSTEM_BOOT_GRACE_SECONDS - 1,
    });
    expect(justBefore).toBe('STARTING');
    const atThreshold = classifyServiceHealth({
      portOpen: false, healthOk: false, optional: false,
      bootElapsedSeconds: ECOSYSTEM_BOOT_GRACE_SECONDS,
    });
    expect(atThreshold).toBe('FAILED');
  });

  it('optional companion (e.g. Java Quant Core unavailable) reports OPTIONAL_UNAVAILABLE, never FAILED, once past the grace window', () => {
    const result = classifyServiceHealth({
      portOpen: false, healthOk: false, optional: true,
      bootElapsedSeconds: ECOSYSTEM_BOOT_GRACE_SECONDS + 1,
    });
    expect(result).toBe('OPTIONAL_UNAVAILABLE');
  });

  it('an optional companion failing does not change what a required service classification would be - independence proof', () => {
    // Same elapsed time and port/health inputs, only `optional` differs - proves the classification
    // is a pure function of its own inputs, so one service's optional-failure can never leak into
    // another service's (e.g. Argus's own) required-service verdict at the call-site level.
    const elapsed = ECOSYSTEM_BOOT_GRACE_SECONDS + 5;
    const optionalResult = classifyServiceHealth({ portOpen: false, healthOk: false, optional: true, bootElapsedSeconds: elapsed });
    const requiredResult = classifyServiceHealth({ portOpen: false, healthOk: false, optional: false, bootElapsedSeconds: elapsed });
    expect(optionalResult).toBe('OPTIONAL_UNAVAILABLE');
    expect(requiredResult).toBe('FAILED');
    expect(optionalResult).not.toBe(requiredResult);
  });

  it('undefined bootElapsedSeconds (a bare status call with no active start in flight) assumes a mature process - FAILED when unhealthy with no port open, matching pre-hardening behavior for that case', () => {
    const result = classifyServiceHealth({ portOpen: false, healthOk: false, optional: false });
    expect(result).toBe('FAILED');
  });

  it('undefined bootElapsedSeconds for an optional companion with no port open reports OPTIONAL_UNAVAILABLE, not FAILED', () => {
    const result = classifyServiceHealth({ portOpen: false, healthOk: false, optional: true });
    expect(result).toBe('OPTIONAL_UNAVAILABLE');
  });

  it('a custom graceSeconds override is respected independent of the module default', () => {
    const result = classifyServiceHealth({ portOpen: false, healthOk: false, optional: false, bootElapsedSeconds: 50, graceSeconds: 30 });
    expect(result).toBe('FAILED');
    const result2 = classifyServiceHealth({ portOpen: false, healthOk: false, optional: false, bootElapsedSeconds: 20, graceSeconds: 30 });
    expect(result2).toBe('STARTING');
  });
});
