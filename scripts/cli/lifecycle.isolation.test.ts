// LABEL: ISOLATED CLI LIFECYCLE CERTIFICATION (2026-10-15). Runs the REAL CLI entry as a child process against a FakeEngine on an ephemeral port with an isolated pid file.
// Never touches the real engine (port 3000 is refused), its SQLite file, or any broker.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { FakeEngine } from './testing/fakeEngine';
import { makeSandbox, runCli, closedPort, type Sandbox } from './testing/cliRunner';

const decoys: ChildProcess[] = [];
/** A live process whose command line contains "argus-engine", so stop's PID-reuse guard accepts it as an Argus engine. */
function spawnDecoyEngine(): ChildProcess {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', '--', 'argus-engine.ts'], { stdio: 'ignore', windowsHide: true });
  decoys.push(c);
  return c;
}
const DEAD_PID = 2_147_000_000;

const engines: FakeEngine[] = []; const sandboxes: Sandbox[] = [];
async function fake(opts: ConstructorParameters<typeof FakeEngine>[0] = {}): Promise<FakeEngine> { const e = new FakeEngine(opts); await e.start(); engines.push(e); return e; }
function sandbox(url: string, env: NodeJS.ProcessEnv = {}): Sandbox { const s = makeSandbox(url, env); sandboxes.push(s); return s; }
const parse = (s: string): any => { const i = s.indexOf('{'); if (i < 0) return null; try { return JSON.parse(s.slice(i)); } catch { return null; } };

afterEach(async () => {
  for (const d of decoys.splice(0)) { try { d.kill(); } catch { /* gone */ } }
  for (const e of engines.splice(0)) await e.close();
  for (const s of sandboxes.splice(0)) s.cleanup();
});

describe('stop', () => {
  it('is idempotent when nothing is running and no pid file exists (exit 0, ENGINE_NOT_RUNNING)', async () => {
    const sb = sandbox(`http://127.0.0.1:${await closedPort()}`); // nothing listens
    const a = await runCli(sb, ['stop']); const b = await runCli(sb, ['stop']);
    for (const r of [a, b]) { expect(r.code).toBe(0); const j = parse(r.stdout); expect(j?.ok).toBe(true); expect(j?.code).toBe('ENGINE_NOT_RUNNING'); }
  }, 60_000);

  it('a stale pid file (dead pid) with nothing running is cleared and reported as stopped, never as an alive process', async () => {
    const sb = sandbox(`http://127.0.0.1:${await closedPort()}`); sb.writePid(DEAD_PID);
    const r = await runCli(sb, ['stop']); const j = parse(r.stdout);
    expect(r.code).toBe(0); expect(j?.ok).toBe(true); expect(j?.code).toBe('ENGINE_NOT_RUNNING');
    expect(String(j?.message)).not.toMatch(/alive/i); expect(sb.readPid()).toBeNull();
  }, 60_000);

  it('REGRESSION: an engine that is answering /health but has NO pid file is still stopped (previously reported "No engine PID file" and left it running)', async () => {
    const eng = await fake(); const sb = sandbox(eng.url);
    const r = await runCli(sb, ['stop']); const j = parse(r.stdout);
    expect({ engineStillRunning: eng.listening, shutdownRequests: eng.count('POST', '/api/v1/system/shutdown'), cliOutput: j?.message }).toEqual({ engineStillRunning: false, shutdownRequests: 1, cliOutput: j?.message });
    expect(r.code).toBe(0); expect(j?.ok).toBe(true); expect(j?.code).toBe('ENGINE_STOPPED');
  }, 60_000);

  it('REGRESSION: a stale (dead) pid file does not stop the CLI from shutting down the engine that is actually answering', async () => {
    const eng = await fake(); const sb = sandbox(eng.url); sb.writePid(DEAD_PID);
    const r = await runCli(sb, ['stop']); const j = parse(r.stdout);
    expect(j?.code).toBe('ENGINE_STOPPED'); expect(eng.listening).toBe(false); expect(sb.readPid()).toBeNull();
  }, 60_000);

  it('graceful stop of a tracked engine confirms /health stopped answering and clears the pid file', async () => {
    const eng = await fake(); const sb = sandbox(eng.url); const d = spawnDecoyEngine(); sb.writePid(d.pid!);
    const r = await runCli(sb, ['stop']); const j = parse(r.stdout);
    expect(r.code).toBe(0); expect(j?.ok).toBe(true); expect(j?.code).toBe('ENGINE_STOPPED'); expect(j?.graceful).toBe(true);
    expect(eng.listening).toBe(false); expect(sb.readPid()).toBeNull();
  }, 60_000);

  it('REGRESSION: a shutdown the engine ignores is NOT reported as success: exit 2, STOP_TIMEOUT_STILL_ANSWERING, pid file retained', async () => {
    const eng = await fake({ shutdown: 'ignore' }); const sb = sandbox(eng.url, { ARGUS_CLI_STOP_TIMEOUT_MS: '2500' }); const d = spawnDecoyEngine(); sb.writePid(d.pid!);
    const r = await runCli(sb, ['stop']); const j = parse(r.stdout);
    expect(r.code).toBe(2); expect(j?.ok).toBe(false); expect(j?.code).toBe('STOP_TIMEOUT_STILL_ANSWERING');
    expect(eng.listening).toBe(true); expect(sb.readPid()).toBe(d.pid);
  }, 60_000);
});

describe('resume / pause', () => {
  it('REGRESSION: a refused resume exits non-zero, names the server reason with a RESUME_REFUSED code, and trading stays paused', async () => {
    const eng = await fake({ tradingState: 'TRADING_PAUSED', resumeRefusal: 'RECONCILIATION_MISMATCH: broker and ledger disagree' }); const sb = sandbox(eng.url);
    const r = await runCli(sb, ['resume', '--reason=test']);
    expect(r.code).not.toBe(0); expect(r.stderr + r.stdout).toMatch(/RESUME_REFUSED/); expect(r.stderr + r.stdout).toMatch(/RECONCILIATION_MISMATCH/);
    expect(eng.tradingState).toBe('TRADING_PAUSED');
  }, 60_000);

  it('resume against an unreachable engine fails with ENGINE_UNREACHABLE and exit 1 (no false success)', async () => {
    const sb = sandbox(`http://127.0.0.1:${await closedPort()}`); const r = await runCli(sb, ['resume', '--reason=test']);
    expect(r.code).toBe(1); expect(r.stderr + r.stdout).toMatch(/ENGINE_UNREACHABLE/);
  }, 60_000);

  it('resume and pause are idempotent against an engine already in the requested state', async () => {
    const eng = await fake({ tradingState: 'TRADING_ENABLED' }); const sb = sandbox(eng.url);
    expect((await runCli(sb, ['resume', '--reason=again'])).code).toBe(0);
    expect((await runCli(sb, ['pause', '--reason=p1'])).code).toBe(0);
    expect((await runCli(sb, ['pause', '--reason=p2'])).code).toBe(0); expect(eng.tradingState).toBe('TRADING_PAUSED');
  }, 90_000);
});

describe('status', () => {
  it('reports the true state of a running engine (exit 0)', async () => {
    const eng = await fake({ tradingState: 'TRADING_PAUSED' }); const sb = sandbox(eng.url);
    const r = await runCli(sb, ['status']); expect(r.code).toBe(0); expect(r.stdout).toMatch(/TRADING_PAUSED/);
  }, 60_000);

  it('REGRESSION: against an unreachable engine reports a STOPPED lifecycle state with exit 1 (not an opaque transport error)', async () => {
    const sb = sandbox(`http://127.0.0.1:${await closedPort()}`); const r = await runCli(sb, ['status']);
    expect(r.code).toBe(1); const text = r.stdout + r.stderr; expect(text).toMatch(/ENGINE_UNREACHABLE/); expect(text).toMatch(/STOPPED/);
  }, 60_000);
});

describe('start (guards that run before any spawn)', () => {
  it('refuses to spawn a second engine when something already answers the API but no pid file exists (exit 1, code ENGINE_ALREADY_RUNNING_UNTRACKED)', async () => {
    const eng = await fake(); const sb = sandbox(eng.url);
    const r = await runCli(sb, ['start', '--no-watchdog']); const j = parse(r.stdout);
    expect(r.code).toBe(1); expect(j?.ok).toBe(false); expect(j?.code).toBe('ENGINE_ALREADY_RUNNING_UNTRACKED'); expect(j?.pid).toBe(eng.pid);
  }, 60_000);

  it('is idempotent when a tracked live engine already exists (exit 0, ENGINE_ALREADY_RUNNING, nothing spawned)', async () => {
    const eng = await fake(); const sb = sandbox(eng.url); const d = spawnDecoyEngine(); sb.writePid(d.pid!);
    const r = await runCli(sb, ['start', '--no-watchdog']); const j = parse(r.stdout);
    expect(r.code).toBe(0); expect(j?.ok).toBe(true); expect(j?.code).toBe('ENGINE_ALREADY_RUNNING'); expect(j?.pid).toBe(d.pid);
  }, 60_000);
});
