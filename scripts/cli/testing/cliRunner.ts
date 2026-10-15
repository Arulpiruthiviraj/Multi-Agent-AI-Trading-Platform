/**
 * Runs the REAL CLI entry (scripts/argus-cli.ts) as a child process against a FakeEngine, in an isolated working directory with an isolated pid file.
 * Safety: refuses to run against port 3000 and always sets ARGUS_ENGINE_PID_PATH to a temp path, so a test can never signal or clear the real engine.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

export interface CliResult { code: number | null; stdout: string; stderr: string; ms: number }
export interface Sandbox { dir: string; pidPath: string; apiUrl: string; env: NodeJS.ProcessEnv; cleanup(): void; writePid(pid: number): void; readPid(): number | null }

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

export function makeSandbox(apiUrl: string, extraEnv: NodeJS.ProcessEnv = {}): Sandbox {
  if (/:3000(\/|$)/.test(apiUrl)) throw new Error('cliRunner refuses to target port 3000 (the real engine)');
  const dir = mkdtempSync(join(tmpdir(), 'argus_cli_lifecycle_'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  const pidPath = join(dir, 'data', '.argus_engine.pid');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ARGUS_API_URL: apiUrl,
    ARGUS_ENGINE_PID_PATH: pidPath,
    ARGUS_CLI_SESSION_FILE: join(dir, 'cli_session'),
    ARGUS_CLI_FETCH_TIMEOUT_MS: '4000',
    NO_COLOR: '1',
    ...extraEnv,
  };
  return {
    dir, pidPath, apiUrl, env,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
    writePid: (pid) => writeFileSync(pidPath, String(pid), 'utf8'),
    readPid: () => (existsSync(pidPath) ? Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10) || null : null),
  };
}

export function runCli(sb: Sandbox, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  const started = Date.now();
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, ['--use-system-ca', '--import', 'tsx', join(REPO_ROOT, 'scripts', 'argus-cli.ts'), ...args], { cwd: REPO_ROOT, env: sb.env, windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => { child.kill(); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolveP({ code, stdout, stderr, ms: Date.now() - started }); });
  });
}

/** A loopback port that is guaranteed closed right now (bind an ephemeral port, then release it): a genuine ECONNREFUSED, unlike port 1 which behaves differently on Windows. */
export async function closedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}
