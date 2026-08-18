/**
 * Allowlisted remote job dispatcher — spawn with array args only, single-job lock, timeout kill.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { eventBus } from '../core/EventBus';
import { eventName } from '../core/eventNames';
import { getAllowedJob, listAllowedJobIds, type AllowedOperationJob } from '../config/allowedOperations';
import { appendRemoteOpOutput } from './ServerLogBuffer';

export type RemoteOpStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted' | 'timeout';

export interface RemoteOpState {
  jobId: string | null;
  status: RemoteOpStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  signal: string | null;
  stdoutLines: string[];
  stderrLines: string[];
  description: string | null;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] },
) => ChildProcessWithoutNullStreams;

const SIGKILL_GRACE_MS = 5000;

let activeChild: ChildProcessWithoutNullStreams | null = null;
let activeJobId: string | null = null;
let killTimer: NodeJS.Timeout | null = null;
let timeoutTimer: NodeJS.Timeout | null = null;
let abortRequested = false;
let timeoutTriggered = false;
let spawnImpl: SpawnFn = spawn as SpawnFn;

const state: RemoteOpState = {
  jobId: null,
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  exitCode: null,
  signal: null,
  stdoutLines: [],
  stderrLines: [],
  description: null,
};

function clearTimers(): void {
  if (killTimer) {
    clearTimeout(killTimer);
    killTimer = null;
  }
  if (timeoutTimer) {
    clearTimeout(timeoutTimer);
    timeoutTimer = null;
  }
}

function resetState(): void {
  state.jobId = null;
  state.status = 'idle';
  state.startedAt = null;
  state.finishedAt = null;
  state.durationMs = null;
  state.exitCode = null;
  state.signal = null;
  state.stdoutLines = [];
  state.stderrLines = [];
  state.description = null;
  activeChild = null;
  activeJobId = null;
  abortRequested = false;
  timeoutTriggered = false;
  clearTimers();
}

function emitStatus(): void {
  eventBus.emit(eventName('REMOTE_OP_STATUS'), {
    jobId: state.jobId,
    status: state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    durationMs: state.durationMs,
    exitCode: state.exitCode,
    signal: state.signal,
    description: state.description,
  });
}

function pushLine(stream: 'stdout' | 'stderr', line: string): void {
  const bucket = stream === 'stdout' ? state.stdoutLines : state.stderrLines;
  bucket.push(line);
  while (bucket.length > 500) bucket.shift();
  if (state.jobId) appendRemoteOpOutput(state.jobId, stream, line);
}

function wireStream(child: ChildProcessWithoutNullStreams, stream: 'stdout' | 'stderr'): void {
  let pending = '';
  child[stream].on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? '';
    for (const line of parts) {
      if (line.length > 0) pushLine(stream, line);
    }
  });
  child[stream].on('end', () => {
    if (pending.trim().length > 0) pushLine(stream, pending);
  });
}

function finish(status: RemoteOpStatus, exitCode: number | null, signal: string | null): void {
  const finishedAt = new Date().toISOString();
  state.status = status;
  state.finishedAt = finishedAt;
  state.exitCode = exitCode;
  state.signal = signal;
  if (state.startedAt) {
    state.durationMs = Date.parse(finishedAt) - Date.parse(state.startedAt);
  }
  activeChild = null;
  activeJobId = null;
  clearTimers();
  emitStatus();
}

function scheduleTimeout(job: AllowedOperationJob): void {
  clearTimers();
  timeoutTimer = setTimeout(() => {
    if (!activeChild || activeChild.killed) return;
    timeoutTriggered = true;
    activeChild.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (!activeChild || activeChild.killed) return;
      activeChild.kill('SIGKILL');
    }, SIGKILL_GRACE_MS);
  }, job.timeoutMs);
}

export function setRemoteOpSpawnForTests(fn: SpawnFn | null): void {
  spawnImpl = fn ?? (spawn as SpawnFn);
}

export function getRemoteOpState(): RemoteOpState {
  return { ...state, stdoutLines: [...state.stdoutLines], stderrLines: [...state.stderrLines] };
}

export function listRemoteOpJobs(): Array<{ jobId: string; description: string; timeoutMs: number }> {
  return listAllowedJobIds().map((jobId) => {
    const job = getAllowedJob(jobId)!;
    return { jobId, description: job.description, timeoutMs: job.timeoutMs };
  });
}

export function isRemoteOpRunning(): boolean {
  return state.status === 'running';
}

export async function executeRemoteOp(jobId: string): Promise<{ ok: true; jobId: string } | { ok: false; error: string; status?: number }> {
  const job = getAllowedJob(jobId);
  if (!job) {
    return { ok: false, error: `Unknown jobId: ${jobId}`, status: 400 };
  }
  if (isRemoteOpRunning()) {
    return { ok: false, error: `Job already running: ${activeJobId}`, status: 409 };
  }

  resetState();
  state.jobId = jobId;
  state.status = 'running';
  state.startedAt = new Date().toISOString();
  state.description = job.description;
  activeJobId = jobId;
  emitStatus();

  const child = spawnImpl(job.command, [...job.args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChild = child;
  wireStream(child, 'stdout');
  wireStream(child, 'stderr');
  scheduleTimeout(job);

  child.on('error', (err) => {
    pushLine('stderr', `[RemoteOperationsService] spawn error: ${err.message}`);
    finish('failed', null, null);
  });

  child.on('close', (code, signal) => {
    let status: RemoteOpStatus = 'completed';
    if (timeoutTriggered) {
      status = 'timeout';
    } else if (abortRequested) {
      status = 'aborted';
    } else if (code !== 0) {
      status = 'failed';
    }
    finish(status, code, signal);
  });

  return { ok: true, jobId };
}

export function abortRemoteOp(): { ok: true; aborted: boolean } | { ok: false; error: string } {
  if (!isRemoteOpRunning() || !activeChild) {
    return { ok: false, error: 'No remote job is running' };
  }
  abortRequested = true;
  activeChild.kill('SIGTERM');
  killTimer = setTimeout(() => {
    if (activeChild && !activeChild.killed) activeChild.kill('SIGKILL');
  }, SIGKILL_GRACE_MS);
  return { ok: true, aborted: true };
}

export function resetRemoteOpServiceForTests(): void {
  if (activeChild && !activeChild.killed) {
    try {
      activeChild.kill('SIGKILL');
    } catch {
      /* best effort */
    }
  }
  resetState();
  spawnImpl = spawn as SpawnFn;
}
