import { describe, expect, it, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ENGINE_PID_PATH,
  claimEnginePid,
  clearEnginePid,
  isEngineProcessRunning,
  isPidAlive,
  readEnginePid,
  reconcileEnginePidFile,
  writeEnginePid,
} from './enginePid';

describe('enginePid', () => {
  afterEach(() => {
    clearEnginePid();
  });

  it('isPidAlive detects this process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('stale PID file is cleared by reconcileEnginePidFile', () => {
    mkdirSync(dirname(ENGINE_PID_PATH), { recursive: true });
    writeFileSync(ENGINE_PID_PATH, '99999999', 'utf8');
    const result = reconcileEnginePidFile();
    expect(result.running).toBe(false);
    expect(result.staleCleared).toBe(true);
    expect(readEnginePid()).toBeNull();
  });

  it('claimEnginePid records this process', () => {
    claimEnginePid();
    expect(isEngineProcessRunning()).toBe(true);
    expect(readEnginePid()).toBe(process.pid);
  });

  it('claimEnginePid throws when another live pid holds the file', () => {
    writeEnginePid(process.pid);
    expect(() => claimEnginePid(process.pid + 1)).toThrow(/already running/);
  });
});
