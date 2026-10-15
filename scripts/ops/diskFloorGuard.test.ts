import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildPauseCommand, guardTick, parsePauseVerification, runPauseCommand, safeReason,
  type GuardDeps, type GuardState, type PauseOutcome,
} from './diskFloorGuard';

/** Stub "CLI": records its argv as JSON into a file and prints the engine's pause response. */
function makeStubCli(dir: string, tradingState: string): { script: string; argvFile: string } {
  const argvFile = path.join(dir, 'argv.json');
  const script = path.join(dir, 'stubCli.cjs');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nconsole.log('npm notice noise');\nconsole.log(JSON.stringify({status:'ok',tradingState:${JSON.stringify(tradingState)},pauseKind:'ENTRIES_ONLY'}));\n`);
  return { script, argvFile };
}

function deps(over: Partial<GuardDeps> & { free: number[]; outcomes: PauseOutcome[] }): { d: GuardDeps; logs: string[]; pauseCalls: string[] } {
  const logs: string[] = []; const pauseCalls: string[] = []; let i = 0; let o = 0;
  const d: GuardDeps = {
    readFreeGb: () => over.free[Math.min(i++, over.free.length - 1)],
    runPause: async (reason) => { pauseCalls.push(reason); return over.outcomes[Math.min(o++, over.outcomes.length - 1)]; },
    log: (l) => logs.push(l), now: () => 0, ...over,
  };
  return { d, logs, pauseCalls };
}
const fresh: GuardState = { paused: false, consecutivePauseFailures: 0 };

describe('disk floor guard - incident 2026-10-15 15:31 ET (detected, but the response never executed)', () => {
  it('REPRODUCES the original defect: a shell-interpolated reason containing "<" is parsed as redirection and the CLI never gets its argument', () => {
    if (process.platform !== 'win32') return; // the incident is cmd.exe-specific
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-legacy-'));
    try {
      const { script, argvFile } = makeStubCli(dir, 'TRADING_PAUSED');
      const legacyReason = 'AUTO_disk_floor_10.4GB_below_<15GB'; // exact shape of the failing production string
      let threw = false;
      try {
        execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `node "${script}" pause --reason=${legacyReason}`], { stdio: 'pipe', timeout: 20000 });
      } catch { threw = true; } // cmd tries to read from a file named "15GB"
      const argv = fs.existsSync(argvFile) ? JSON.parse(fs.readFileSync(argvFile, 'utf8')) as string[] : null;
      // Old behaviour: the command failed / argument was mangled, so the pause was NOT issued with the intended reason.
      expect(threw || !argv || !argv.includes(`--reason=${legacyReason}`)).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('FIXED: the real invocation path delivers a hostile reason to the CLI byte-for-byte (no shell)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-fixed-'));
    try {
      const { script, argvFile } = makeStubCli(dir, 'TRADING_PAUSED');
      const hostile = 'x<15GB>&|^%PATH%"quoted" $(rm) `id`';
      const out = await runPauseCommand({ file: process.execPath, args: [script, 'pause', `--reason=${hostile}`], cwd: dir });
      expect(out).toMatchObject({ ok: true, verified: true });
      expect(JSON.parse(fs.readFileSync(argvFile, 'utf8'))).toEqual(['pause', `--reason=${hostile}`]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('reason strings contain no shell metacharacters, whatever the numbers are', () => {
    for (const [gb, floor] of [[10.44, 15], [0, 15], [-1, 15], [1e9, 15.5], [Number.NaN, 15]] as const) {
      expect(safeReason(gb, floor)).toMatch(/^[A-Za-z0-9_.-]+$/);
    }
  });

  it('production command is node+tsx+argv with no shell, no cmd.exe, no npm wrapper', () => {
    const c = buildPauseCommand('C:/repo', 'AUTO_x');
    expect(c.file).toBe(process.execPath);
    expect(c.args).toEqual(['--env-file-if-exists=.env', '--use-system-ca', '--import', 'tsx', path.join('scripts', 'argus-cli.ts'), 'pause', '--reason=AUTO_x']);
    const src = fs.readFileSync(path.resolve(__dirname, 'diskFloorGuard.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/shell:\s*true|cmd\.exe|ComSpec|execSync\(|exec\(/);
  });

  it('exit code 0 is NOT enough: an engine that does not report TRADING_PAUSED is a FAILED pause, retried next sample', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-unverified-'));
    try {
      const { script } = makeStubCli(dir, 'TRADING_ENABLED');
      const out = await runPauseCommand({ file: process.execPath, args: [script, 'pause'], cwd: dir });
      expect(out).toMatchObject({ ok: true, verified: false });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    const { d, logs, pauseCalls } = deps({ free: [10, 10], outcomes: [{ ok: true, verified: false, detail: 'tradingState=TRADING_ENABLED' }, { ok: true, verified: true, detail: 'tradingState=TRADING_PAUSED' }] });
    let s = await guardTick(fresh, 15, d);
    expect(s).toEqual({ paused: false, consecutivePauseFailures: 1 });
    expect(logs.some((l) => l.includes('PAUSE_FAILED') && l.includes('UNVERIFIED'))).toBe(true);
    s = await guardTick(s, 15, d);
    expect(s).toEqual({ paused: true, consecutivePauseFailures: 0 });
    expect(pauseCalls).toHaveLength(2);
  });

  it('CLI crash / timeout is reported as its own FAILED event and does not stop the guard', async () => {
    const out = await runPauseCommand({ file: process.execPath, args: ['-e', 'process.exit(3)'], cwd: process.cwd() });
    expect(out.ok).toBe(false);
    const { d, logs } = deps({ free: [9], outcomes: [out] });
    const s = await guardTick(fresh, 15, d);
    expect(s.paused).toBe(false);
    expect(s.consecutivePauseFailures).toBe(1);
    expect(logs.some((l) => l.includes('PAUSE_FAILED') && l.includes('ERROR'))).toBe(true);
  });

  it('is idempotent while paused, and re-arms after recovery so a second breach pauses again', async () => {
    const ok: PauseOutcome = { ok: true, verified: true, detail: 'tradingState=TRADING_PAUSED' };
    const { d, pauseCalls } = deps({ free: [10, 10, 10, 20, 9], outcomes: [ok] });
    let s = await guardTick(fresh, 15, d);       // breach -> pause
    s = await guardTick(s, 15, d);               // still breached -> no second pause
    s = await guardTick(s, 15, d);
    expect(pauseCalls).toHaveLength(1);
    s = await guardTick(s, 15, d);               // recovered
    expect(s.paused).toBe(false);
    s = await guardTick(s, 15, d);               // new breach
    expect(pauseCalls).toHaveLength(2);
    expect(s.paused).toBe(true);
  });

  it('never pauses at or above the floor, and a sampling error is logged without throwing', async () => {
    const { d, pauseCalls } = deps({ free: [15, 40], outcomes: [{ ok: true, verified: true, detail: '' }] });
    await guardTick(fresh, 15, d); await guardTick(fresh, 15, d);
    expect(pauseCalls).toHaveLength(0);
    const logs: string[] = [];
    const s = await guardTick(fresh, 15, { ...d, readFreeGb: () => { throw new Error('statfs boom'); }, log: (l) => logs.push(l) });
    expect(s).toEqual(fresh);
    expect(logs[0]).toContain('SAMPLE_ERROR');
  });

  it('parsePauseVerification tolerates npm banner noise and rejects garbage', () => {
    expect(parsePauseVerification('npm notice run x\n{\n "status":"ok",\n "tradingState":"TRADING_PAUSED"\n}\n').verified).toBe(true);
    expect(parsePauseVerification('no json here').verified).toBe(false);
    expect(parsePauseVerification('{bad json}').verified).toBe(false);
  });
});
