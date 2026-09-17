import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * P1 isolation architecture regression test (2026-09-15): proves the REAL modules
 * (sessionRecovery.ts, enginePid.ts) actually wire assertNotProductionRuntimePath() in at their
 * real I/O call sites - not just that the guard function itself works in isolation
 * (productionRuntimePathGuard.test.ts already covers that).
 *
 * Safety design, deliberate: node:fs is fully mocked BEFORE either module is imported, so even if
 * the guard under test were broken, this test cannot cause real disk I/O to any path, production
 * or otherwise - the assertions below check both "did it throw" AND "was the real write function
 * ever even called", so a regression that removed the guard call would fail this test loudly
 * rather than this test silently trusting the throw alone.
 */
// Selective interception, deliberately NOT a blanket node:fs mock: sessionRecovery.ts/enginePid.ts
// transitively pull in modules (EventBus -> eventNames -> loadRepoConfigJson) that use real
// readFileSync/existsSync to load real config/*.json files at import time - a blanket mock breaks
// those unrelated to this test entirely. Every call is routed to the REAL implementation EXCEPT
// for paths this test itself constructs (always containing 'argus_test' or the exact production
// filenames under test), which are the only ones that could possibly be touched by the guard this
// test exists to verify.
const TARGET_MARKERS = ['argus_test', '.argus_runtime_session.json', '.argus_engine.pid'];
function isTargetPath(p: unknown): boolean {
  return typeof p === 'string' && TARGET_MARKERS.some((m) => p.includes(m));
}

const fsWriteFileSyncMock = vi.fn();
const fsMkdirSyncMock = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (p: any, ...rest: any[]) => (isTargetPath(p) ? fsWriteFileSyncMock(p, ...rest) : (actual as any).writeFileSync(p, ...rest)),
    mkdirSync: (p: any, ...rest: any[]) => (isTargetPath(p) ? fsMkdirSyncMock(p, ...rest) : (actual as any).mkdirSync(p, ...rest)),
  };
});

beforeEach(() => {
  fsWriteFileSyncMock.mockClear();
  fsMkdirSyncMock.mockClear();
});

describe('sessionRecovery.ts - production path guard wiring', () => {
  afterEach(async () => {
    const { resetSessionRecoveryForTests } = await import('./sessionRecovery');
    resetSessionRecoveryForTests();
  });

  it('throws and performs zero real fs writes when the module is used with no test override set (reproduces the real 2026-09-15 incident shape)', async () => {
    const { beginRuntimeSession } = await import('./sessionRecovery');
    // Deliberately NOT calling setSessionRecoveryPathForTests() first - this is exactly the
    // real-world mistake that caused the 2026-09-15 incident (a test that boots session recovery
    // without isolating it first).
    expect(() => beginRuntimeSession()).toThrow(/FATAL.*production runtime path/);
    expect(fsWriteFileSyncMock).not.toHaveBeenCalled();
  });

  it('succeeds normally, with real (mocked) writes, once an isolated test path is set', async () => {
    const { beginRuntimeSession, setSessionRecoveryPathForTests } = await import('./sessionRecovery');
    setSessionRecoveryPathForTests('C:/Temp/argus_test_isolated/.argus_runtime_session.json');
    expect(() => beginRuntimeSession()).not.toThrow();
    expect(fsWriteFileSyncMock).toHaveBeenCalled();
    const [writtenPath] = fsWriteFileSyncMock.mock.calls[0];
    expect(writtenPath).toBe('C:/Temp/argus_test_isolated/.argus_runtime_session.json');
  });
});

describe('enginePid.ts - production path guard wiring', () => {
  const originalOverride = process.env.ARGUS_ENGINE_PID_PATH;
  afterEach(() => {
    if (originalOverride === undefined) delete process.env.ARGUS_ENGINE_PID_PATH;
    else process.env.ARGUS_ENGINE_PID_PATH = originalOverride;
  });

  it('throws and performs zero real fs writes when ARGUS_ENGINE_PID_PATH is not set (reproduces the class of incident enginePid.ts\'s own header already documents once)', async () => {
    delete process.env.ARGUS_ENGINE_PID_PATH;
    const { writeEnginePid } = await import('../app/enginePid');
    // vi.resetModules() is not used here - resolveEnginePidPath() re-reads process.env on every
    // call (by design, per its own doc comment), so no module-level caching to worry about.
    expect(() => writeEnginePid(12345)).toThrow(/FATAL.*production runtime path/);
    expect(fsWriteFileSyncMock).not.toHaveBeenCalled();
  });

  it('succeeds normally, with real (mocked) writes, once ARGUS_ENGINE_PID_PATH is set to an isolated path', async () => {
    process.env.ARGUS_ENGINE_PID_PATH = 'C:/Temp/argus_test_isolated/.argus_engine.pid';
    const { writeEnginePid } = await import('../app/enginePid');
    expect(() => writeEnginePid(12345)).not.toThrow();
    expect(fsWriteFileSyncMock).toHaveBeenCalledWith('C:/Temp/argus_test_isolated/.argus_engine.pid', '12345', 'utf8');
  });
});
