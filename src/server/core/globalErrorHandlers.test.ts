import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const emitSpy = vi.fn();
vi.mock('./EventBus', () => ({ eventBus: { emit: emitSpy } }));
vi.mock('./eventNames', () => ({ EVENTS: { SYSTEM_ANOMALY: 'SYSTEM_ANOMALY' } }));

describe('globalErrorHandlers', () => {
  let tmpLogDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    emitSpy.mockClear();
    tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-crash-'));
    process.env.ARGUS_CRASH_LOG_PATH = path.join(tmpLogDir, 'crash.log');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.resetModules();
  });

  afterEach(() => {
    exitSpy.mockRestore();
    delete process.env.ARGUS_CRASH_LOG_PATH;
    fs.rmSync(tmpLogDir, { recursive: true, force: true });
  });

  it('logs unhandledRejection to crash.log and does not exit for non-fatal errors', async () => {
    const { handleUnhandledRejection } = await import('./globalErrorHandlers');
    const logPath = process.env.ARGUS_CRASH_LOG_PATH!;
    handleUnhandledRejection(new Error('synthetic rejection for test'));

    expect(fs.existsSync(logPath)).toBe(true);
    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('unhandledRejection');
    expect(log).toContain('synthetic rejection for test');
    expect(emitSpy).toHaveBeenCalledWith('SYSTEM_ANOMALY', expect.objectContaining({
      kind: 'unhandledRejection',
      fatal: false,
    }));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits only on fatal memory or DB corruption errors', async () => {
    const { handleUncaughtException, isFatalProcessError } = await import('./globalErrorHandlers');
    expect(isFatalProcessError(new Error('JavaScript heap out of memory'))).toBe(true);
    expect(isFatalProcessError(new Error('SQLITE_CORRUPT: database disk image is malformed'))).toBe(true);
    expect(isFatalProcessError(new Error('routine timeout'))).toBe(false);

    handleUncaughtException(new Error('SQLITE_CORRUPT: database disk image is malformed'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('installGlobalErrorHandlers registers both process listeners once', async () => {
    const onSpy = vi.spyOn(process, 'on');
    const { installGlobalErrorHandlers } = await import('./globalErrorHandlers');
    installGlobalErrorHandlers();
    installGlobalErrorHandlers();
    expect(onSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    onSpy.mockRestore();
  });

  it('survives console.error itself throwing (the exact 2026-08-26 incident) by falling back to a raw fd write, and never re-throws', async () => {
    const { handleUncaughtException } = await import('./globalErrorHandlers');
    const logPath = process.env.ARGUS_CRASH_LOG_PATH!;
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('UNKNOWN: unknown error, write');
    });
    const writeSyncSpy = vi.spyOn(fs, 'writeSync').mockImplementation(() => 0);
    try {
      expect(() => handleUncaughtException(new Error('synthetic error while console.error is broken'))).not.toThrow();
      // The durable sink (crash.log) must still have received the error even though the
      // console path failed.
      expect(fs.existsSync(logPath)).toBe(true);
      expect(fs.readFileSync(logPath, 'utf8')).toContain('synthetic error while console.error is broken');
      // The emergency raw-fd fallback must have been used in place of the broken console.error.
      expect(writeSyncSpy).toHaveBeenCalledWith(2, expect.stringContaining('emergency path'));
    } finally {
      consoleSpy.mockRestore();
      writeSyncSpy.mockRestore();
    }
  });

  it('storm circuit breaker exits cleanly after repeated process-level errors in a short window, instead of an unbounded cascade', async () => {
    const { handleUncaughtException } = await import('./globalErrorHandlers');
    for (let i = 0; i < 4; i++) {
      handleUncaughtException(new Error(`storm error ${i}`));
    }
    expect(exitSpy).not.toHaveBeenCalled();
    handleUncaughtException(new Error('storm error 5 - tips the breaker'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
