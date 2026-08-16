/**
 * Spawns allowlisted Python research jobs. Never executes user-supplied Python.
 * Never imports BrokerManager. VectorBT cannot place orders from this process.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { researchSafety } from '../config/researchSafety';

export type VectorBTCapabilityState =
  | 'AVAILABLE'
  | 'AVAILABLE_WITHOUT_RUST'
  | 'AVAILABLE_WITH_RUST'
  | 'UNAVAILABLE'
  | 'FAILED';

export interface VectorBTStatus {
  vectorbt: {
    installed: boolean;
    version: string | null;
    rustBackend: { available: boolean; enabled: boolean; version: string | null };
    state: VectorBTCapabilityState;
    pythonVersion: string | null;
    rustAccelerationUnavailable?: boolean;
  };
  execution: 'research_only';
  canPlaceOrders: false;
}

const FORBIDDEN_KEYS = ['code', 'python', 'script', 'eval', 'exec', 'broker', 'placeOrder', 'submitOrder'];

export function assertAllowlistedJob(job: string): void {
  if (!researchSafety.allowlistedJobs.includes(job)) {
    throw new Error(`Job not allowlisted: ${job}`);
  }
}

function cliPath(): string {
  const p = join(process.cwd(), 'python', 'argus_research', 'cli.py');
  if (!existsSync(p)) throw new Error('python/argus_research/cli.py missing');
  return p;
}

export async function runResearchCli(payload: Record<string, unknown>, timeoutMs = researchSafety.pythonTimeoutMs): Promise<unknown> {
  if (process.env.VITEST === 'true' && process.env.ARGUS_TEST_ALLOW_VECTORBT !== 'true') {
    return {
      ok: false,
      engineUsed: 'unavailable',
      error: 'VectorBT CLI skipped in Vitest (set ARGUS_TEST_ALLOW_VECTORBT=true to probe).',
      vectorbt: { installed: false, version: null, rustBackend: { available: false, enabled: false, version: null }, state: 'UNAVAILABLE' },
    };
  }
  const job = String(payload.job ?? '');
  assertAllowlistedJob(job);
  for (const k of Object.keys(payload)) {
    if (FORBIDDEN_KEYS.includes(k)) throw new Error('Arbitrary Python execution is not allowed');
  }
  const py = process.env.ARGUS_PYTHON || 'python';
  return new Promise((resolve, reject) => {
    const child = spawn(py, [cliPath()], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('research python timeout'));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => {
      clearTimeout(t);
      resolve({
        ok: false,
        error: err.message,
        vectorbt: { installed: false, version: null, rustBackend: { available: false, enabled: false, version: null }, state: 'UNAVAILABLE', pythonVersion: null },
      });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({
          ok: false,
          error: stderr.slice(0, 400) || `research cli empty stdout code=${code}`,
          vectorbt: { installed: false, version: null, rustBackend: { available: false, enabled: false, version: null }, state: 'UNAVAILABLE' },
          pythonVersion: null,
        });
        return;
      }
      try {
        resolve(JSON.parse(trimmed));
      } catch {
        resolve({
          ok: false,
          error: `research cli parse failed code=${code} stderr=${stderr.slice(0, 200)}`,
          vectorbt: { installed: false, version: null, rustBackend: { available: false, enabled: false, version: null }, state: 'UNAVAILABLE' },
        });
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export async function getVectorBTStatus(): Promise<VectorBTStatus> {
  const unavailable = (state: VectorBTCapabilityState = 'UNAVAILABLE'): VectorBTStatus => ({
    vectorbt: {
      installed: false,
      version: null,
      rustBackend: { available: false, enabled: false, version: null },
      state,
      pythonVersion: null,
      rustAccelerationUnavailable: true,
    },
    execution: 'research_only',
    canPlaceOrders: false,
  });

  if (process.env.VITEST === 'true' && process.env.ARGUS_TEST_ALLOW_VECTORBT !== 'true') {
    return unavailable();
  }

  try {
    const raw = await runResearchCli({ job: 'capability' }) as any;
    const installed = !!raw?.vectorbt?.installed;
    const rustAvail = !!raw?.vectorbt?.rustBackend?.available;
    const rustEnabled = !!raw?.vectorbt?.rustBackend?.enabled;
    let state: VectorBTCapabilityState = 'UNAVAILABLE';
    if (raw?.ok === false && !installed) state = 'UNAVAILABLE';
    else if (installed && rustAvail) state = 'AVAILABLE_WITH_RUST';
    else if (installed) state = 'AVAILABLE_WITHOUT_RUST';
    else state = 'UNAVAILABLE';
    if (raw?.state === 'FAILED') state = 'FAILED';
    return {
      vectorbt: {
        installed,
        version: raw?.vectorbt?.version ?? null,
        rustBackend: {
          available: rustAvail,
          enabled: rustEnabled && rustAvail,
          version: raw?.vectorbt?.rustBackend?.version ?? null,
        },
        state,
        pythonVersion: raw?.pythonVersion ?? null,
        rustAccelerationUnavailable: installed && !rustAvail,
      },
      execution: 'research_only',
      canPlaceOrders: false,
    };
  } catch (e: any) {
    return {
      vectorbt: {
        installed: false,
        version: null,
        rustBackend: { available: false, enabled: false, version: null },
        state: 'UNAVAILABLE',
        pythonVersion: null,
        rustAccelerationUnavailable: true,
      },
      execution: 'research_only',
      canPlaceOrders: false,
    };
  }
}

export function compareEngines(a: { tradeCount: number; netPnl: number }, b: { tradeCount: number; netPnl: number }, tol = researchSafety.crossEnginePnlTolerance): { status: 'PASS' | 'ENGINE_MISMATCH'; maxDifference: number } {
  const maxDifference = Math.max(Math.abs(a.netPnl - b.netPnl), Math.abs(a.tradeCount - b.tradeCount));
  if (a.tradeCount !== b.tradeCount) return { status: 'ENGINE_MISMATCH', maxDifference };
  if (Math.abs(a.netPnl - b.netPnl) > tol) return { status: 'ENGINE_MISMATCH', maxDifference };
  return { status: 'PASS', maxDifference };
}
