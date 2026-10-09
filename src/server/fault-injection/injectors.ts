/**
 * DETERMINISTIC FAULT INJECTORS — test-only.
 * =============================================================================
 * LABEL: FAULT_INJECTION / SYNTHETIC_SEEDED / NON_ORGANIC / CERTIFICATION_FIXTURE_ONLY
 *
 * A registry of deterministic, gate-checked fault injectors for the chaos
 * matrix. Every factory calls `assertFaultInjectionEnabled()` FIRST — without
 * ARGUS_FAULT_INJECTION=1 the factory throws FaultInjectionGateError before
 * touching anything.
 *
 * Design rules (repo AGENTS.md § Engineering standard):
 *  - Injectors control the ENVIRONMENT, never the DECISION. They make a
 *    provider slow/down, the DB slow/locked, market data stale/frozen/rolled
 *    back, a socket die, a backup hang, a worker die, a queue flood, AI
 *    unavailable, or a broker reject — they never force a strategy signal, a
 *    Chief/Risk approval, or a fill. The assertions then check that the REAL
 *    production code fails closed, bounds its queues, trips its breakers, and
 *    keeps the validated-quant path independent of AI.
 *  - Injectors mutate shared state ONLY through a FaultInjectionScope, which
 *    records a restoration for every patch. `disarmAll()` runs them in
 *    reverse order so no test can leak a fault into a later test.
 *  - Deterministic: no random timing. Latencies are fixed sleeps; scripts are
 *    explicit event sequences.
 *
 * Injector inventory (see the chaos matrix tests for the combinations):
 *   PROVIDER: timeout | http-402 | http-429 | http-503 | network-down | flaky-script
 *   DB:       slow-query | locked (SQLITE_BUSY xN then recover)
 *   MARKET:   stale quote | frozen quote | rollback quote (older after newer)
 *   SOCKET:   deterministic close/open script with generation invalidation
 *   BACKUP:   hanging worker (never completes)
 *   BROKER:   out-of-session clock (HistoricalReplayBroker REJECTED path)
 *   WORKER:   crashing child through the production tracked-spawn path
 *   AI:       unavailable (network-down provider + governor fail-closed)
 */
import { assertFaultInjectionEnabled } from './FaultInjectionGate';
import { startHeartbeat, type Heartbeat } from './heartbeat';
// Type-only: erased at compile time, no runtime dependency on the service.
import type { BackupWorkerFactory, BackupWorkerLike } from '../services/DbBackupService';

export type Restoration = () => void;

/**
 * A fault-injection session. Create one per test, `disarmAll()` in a finally/
 * afterEach. Creating the scope itself is gate-checked.
 */
export class FaultInjectionScope {
  private restorations: Restoration[] = [];
  private armed = true;

  /** Register a cleanup to run (LIFO) on disarmAll(). */
  onDisarm(fn: Restoration): void {
    if (!this.armed) throw new Error('[FaultInjectionScope] scope already disarmed');
    this.restorations.push(fn);
  }

  /** Run every registered restoration exactly once, in reverse arm order. */
  disarmAll(): void {
    if (!this.armed) return;
    this.armed = false;
    let firstError: unknown = null;
    while (this.restorations.length > 0) {
      const fn = this.restorations.pop()!;
      try {
        fn();
      } catch (e) {
        firstError = firstError ?? e;
      }
    }
    if (firstError) throw firstError;
  }

  get restorationCount(): number {
    return this.restorations.length;
  }
}

export function createFaultInjectionScope(): FaultInjectionScope {
  assertFaultInjectionEnabled('createFaultInjectionScope');
  return new FaultInjectionScope();
}

// ---------------------------------------------------------------------------
// PROVIDER injectors — fakes shaped like the sibling-owned JevProviderHandle
// (isConfigured()/decide()), injected via the governor's own
// __setJevProviderForTests seam. The governor under test is 100% real.
// ---------------------------------------------------------------------------

export interface FakeJevProvider {
  isConfigured(): boolean;
  decide(req: {
    state: unknown;
    questions: unknown;
    model?: string;
    schemaVersion?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<never>;
  /** Observability the tests assert on. */
  invocations: number;
  abortedSignals: number;
  lastTimeoutMs: number | null;
}

function baseFakeJevProvider(
  behavior: (req: { signal?: AbortSignal; timeoutMs?: number }, rec: FakeJevProvider) => Promise<never>,
): FakeJevProvider {
  const rec = {
    isConfigured: () => true,
    invocations: 0,
    abortedSignals: 0,
    lastTimeoutMs: null as number | null,
    async decide(req: { signal?: AbortSignal; timeoutMs?: number }): Promise<never> {
      assertFaultInjectionEnabled('FakeJevProvider.decide');
      rec.invocations++;
      rec.lastTimeoutMs = req.timeoutMs ?? null;
      if (req.signal?.aborted) rec.abortedSignals++;
      else
        req.signal?.addEventListener('abort', () => rec.abortedSignals++, { once: true });
      return behavior(req, rec);
    },
  };
  return rec;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Provider timeout: decide() throws a typed TIMEOUT JevError immediately
 * (fast, deterministic — the real wall-clock timeout path, where the
 * governor's own abort timer fires, is covered once in the NIGHTLY suite).
 */
export function makeTimeoutJevProvider(): FakeJevProvider {
  assertFaultInjectionEnabled('makeTimeoutJevProvider');
  return baseFakeJevProvider(async () => {
    const { JevError } = await import('../ai/JevDecisionProvider');
    throw new JevError('TIMEOUT', 'synthetic provider timeout (FAULT_INJECTION)');
  });
}

/**
 * Provider that hangs forever: decide() never resolves until the governor's
 * own abort signal fires (used by the NIGHTLY real-timeout test). Records
 * whether the abort signal arrived.
 */
export function makeHangingJevProvider(): FakeJevProvider {
  assertFaultInjectionEnabled('makeHangingJevProvider');
  return baseFakeJevProvider(
    (req) =>
      new Promise<never>((_resolve, reject) => {
        if (req.signal?.aborted) {
          reject(new Error('aborted-before-hang'));
          return;
        }
        req.signal?.addEventListener(
          'abort',
          () => reject(new Error('governor-abort-fired')),
          { once: true },
        );
        // Never resolves otherwise — the governor's timeoutMs timer must kill it.
      }),
  );
}

/**
 * Provider HTTP errors: 402 -> BILLING (non-retryable, circuit), 429 ->
 * RATE_LIMIT (retryable), 503 -> SERVER (retryable). The status->kind mapping
 * mirrors the production JevDecisionProvider's own classification contract.
 */
export function makeHttpErrorJevProvider(status: 402 | 429 | 503): FakeJevProvider {
  assertFaultInjectionEnabled('makeHttpErrorJevProvider');
  const kind = status === 402 ? 'BILLING' : status === 429 ? 'RATE_LIMIT' : 'SERVER';
  return baseFakeJevProvider(async () => {
    const { JevError } = await import('../ai/JevDecisionProvider');
    throw new JevError(kind as 'BILLING' | 'RATE_LIMIT' | 'SERVER', `synthetic HTTP ${status} (FAULT_INJECTION)`, {
      status,
    });
  });
}

/** Provider network-down: NETWORK JevError (retryable), like a dead socket/DNS. */
export function makeDownJevProvider(): FakeJevProvider {
  assertFaultInjectionEnabled('makeDownJevProvider');
  return baseFakeJevProvider(async () => {
    const { JevError } = await import('../ai/JevDecisionProvider');
    throw new JevError('NETWORK', 'synthetic network down (FAULT_INJECTION)');
  });
}

export type FlakyStep = 'ok' | 'timeout' | 'http-429' | 'http-503' | 'down';

/**
 * Flaky provider: plays a deterministic per-call script, then repeats the
 * last step. Lets the chaos matrix model "provider degrades mid-session".
 */
export function makeFlakyJevProvider(script: FlakyStep[]): FakeJevProvider {
  assertFaultInjectionEnabled('makeFlakyJevProvider');
  if (script.length === 0) throw new Error('[makeFlakyJevProvider] script must be non-empty');
  const stepFor = (i: number): FlakyStep => script[Math.min(i, script.length - 1)];
  return baseFakeJevProvider(async (_req, rec) => {
    const { JevError } = await import('../ai/JevDecisionProvider');
    const step = stepFor(rec.invocations - 1);
    switch (step) {
      case 'ok':
        return { decision: 'SYNTHETIC_OK' } as unknown as never;
      case 'timeout':
        throw new JevError('TIMEOUT', 'synthetic flaky timeout (FAULT_INJECTION)');
      case 'http-429':
        throw new JevError('RATE_LIMIT', 'synthetic flaky 429 (FAULT_INJECTION)', { status: 429 });
      case 'http-503':
        throw new JevError('SERVER', 'synthetic flaky 503 (FAULT_INJECTION)', { status: 503 });
      case 'down':
        throw new JevError('NETWORK', 'synthetic flaky down (FAULT_INJECTION)');
    }
  });
}

// ---------------------------------------------------------------------------
// DB injectors — patch the better-sqlite3 singleton's `prepare` on the
// exported object (own-property override; prototype untouched), restored on
// disarm. Only affects the process-local handle the test imported.
// ---------------------------------------------------------------------------

/**
 * Every prepare() blocks the calling thread for at least delayMs before
 * returning the real statement: models a saturated disk / slow query.
 * better-sqlite3 is fully synchronous, so the block is synchronous too
 * (Atomics.wait on a shared futex — deterministic, no spin). Callers that
 * assume non-blocking behavior stall boundedly and then proceed; the test
 * asserts the stall is bounded and the heartbeat resumes.
 */
export function injectDbSlowQuery(db: any, delayMs: number, scope: FaultInjectionScope): void {
  assertFaultInjectionEnabled('injectDbSlowQuery');
  const original = db.prepare.bind(db);
  const futex = new Int32Array(new SharedArrayBuffer(4));
  (db as Record<string, unknown>).prepare = function (...args: unknown[]) {
    assertFaultInjectionEnabled('injectDbSlowQuery.prepare');
    Atomics.wait(futex, 0, 0, delayMs);
    return original(...(args as []));
  };
  scope.onDisarm(() => {
    delete (db as Record<string, unknown>).prepare;
  });
}

/**
 * SQLITE_BUSY injector: the next `failCount` prepare() calls throw a
 * SQLITE_BUSY-coded error (like a second writer holding the lock), then the
 * patch removes itself. Tests prove callers fail closed or retry — never
 * silently swallow, never half-write.
 */
export function injectDbLocked(db: any, failCount: number, scope: FaultInjectionScope): { remaining: () => number } {
  assertFaultInjectionEnabled('injectDbLocked');
  let remaining = failCount;
  const original = db.prepare.bind(db);
  (db as Record<string, unknown>).prepare = function (...args: unknown[]) {
    assertFaultInjectionEnabled('injectDbLocked.prepare');
    if (remaining > 0) {
      remaining--;
      const err = new Error('database is locked') as Error & { code: string };
      err.code = 'SQLITE_BUSY';
      throw err;
    }
    return original(...(args as []));
  };
  scope.onDisarm(() => {
    delete (db as Record<string, unknown>).prepare;
  });
  return { remaining: () => remaining };
}

// ---------------------------------------------------------------------------
// MARKET-DATA injectors — drive the REAL MarketDataWorker public surface
// (cacheObservedQuote / getLatestPriceAgeMs). The monotonicity guard and the
// staleness semantics under test are production code.
// ---------------------------------------------------------------------------

/** Quote observed ageMs ago: models a feed that went quiet (stale). */
export function feedStaleQuote(worker: any, symbol: string, ageMs: number, price = 100): void {
  assertFaultInjectionEnabled('feedStaleQuote');
  worker.cacheObservedQuote(symbol, price, Date.now() - ageMs);
}

/** Same price re-cached N times: models a frozen feed (age keeps growing). */
export function feedFrozenQuote(worker: any, symbol: string, ticks: number, price = 100): void {
  assertFaultInjectionEnabled('feedFrozenQuote');
  for (let i = 0; i < ticks; i++) worker.cacheObservedQuote(symbol, price, Date.now() - i);
}

/**
 * Rollback: a NEWER quote followed by an OLDER one. The production
 * monotonicity guard must ignore the older write (fail-safe: only ever
 * ignores a write, never invents one) — the cached price stays the newer one.
 */
export function feedRollbackQuote(
  worker: any,
  symbol: string,
): { newerPrice: number; olderPrice: number } {
  assertFaultInjectionEnabled('feedRollbackQuote');
  const newerPrice = 105;
  const olderPrice = 95;
  const now = Date.now();
  worker.cacheObservedQuote(symbol, newerPrice, now);
  worker.cacheObservedQuote(symbol, olderPrice, now - 60_000);
  return { newerPrice, olderPrice };
}

// ---------------------------------------------------------------------------
// SOCKET injector — deterministic close/open script with generation
// invalidation, mirroring the production reconnect-generation pattern
// (IbkrSocketSession): handlers bound to an old generation must be dropped.
// ---------------------------------------------------------------------------

export type SocketEvent = 'open' | 'close:ECONNRESET' | 'close:TIMEOUT' | 'message';

export class SimulatedFaultySocket {
  private generation = 0;
  private state: 'OPEN' | 'CONNECTING' | 'CLOSED' = 'CLOSED';
  private readonly script: SocketEvent[];
  private step = 0;
  /** Messages delivered while OPEN, tagged with the generation that sent them. */
  readonly delivered: Array<{ generation: number; payload: unknown }> = [];
  /** Messages dropped because they arrived on a stale generation. */
  readonly droppedStale: Array<{ generation: number; payload: unknown }> = [];

  constructor(script: SocketEvent[]) {
    assertFaultInjectionEnabled('SimulatedFaultySocket');
    this.script = [...script];
  }

  /** Advance one scripted event; returns false when the script is exhausted. */
  next(): boolean {
    assertFaultInjectionEnabled('SimulatedFaultySocket.next');
    const ev = this.script[this.step++];
    if (ev === undefined) return false;
    if (ev === 'open') {
      this.generation++;
      this.state = 'OPEN';
    } else if (ev.startsWith('close')) {
      this.state = 'CLOSED';
    }
    return true;
  }

  /**
   * Send a message bound to a generation (the generation the sender observed
   * when it queued the message). Messages from a stale generation are dropped
   * and counted — the reconnect-generation invalidation contract.
   */
  send(payload: unknown, senderGeneration: number): void {
    assertFaultInjectionEnabled('SimulatedFaultySocket.send');
    if (this.state !== 'OPEN' || senderGeneration !== this.generation) {
      this.droppedStale.push({ generation: senderGeneration, payload });
      return;
    }
    this.delivered.push({ generation: senderGeneration, payload });
  }

  get currentGeneration(): number {
    return this.generation;
  }
  get connectionState(): string {
    return this.state;
  }
}

// ---------------------------------------------------------------------------
// BACKUP injector — a worker that never completes, exercising the hang path
// through the REAL DbBackupService (createWorker seam).
// ---------------------------------------------------------------------------

/** A backup worker factory whose worker never posts 'complete' (hang). */
export function hangingBackupWorkerFactory(): {
  createWorker: BackupWorkerFactory;
  terminated: () => boolean;
} {
  assertFaultInjectionEnabled('hangingBackupWorkerFactory');
  let terminated = false;
  const createWorker: BackupWorkerFactory = (_source, _options) => {
    const worker: BackupWorkerLike = {
      on(_event: 'message' | 'error' | 'exit', _fn: (...a: unknown[]) => void) {
        return worker;
      },
      terminate: async () => {
        terminated = true;
        return 0;
      },
    };
    return worker;
  };
  return { createWorker, terminated: () => terminated };
}

// ---------------------------------------------------------------------------
// BROKER injector — HistoricalReplayBroker rejects every order when its clock
// sits outside a fill-allowed session (real production REJECTED path). The
// injector just parks the clock out-of-session; the rejection logic is
// untouched production code.
// ---------------------------------------------------------------------------

/** A clockMs (midnight ET) at which sessionAllowsFills() is false. */
export function outOfSessionClockMs(): number {
  assertFaultInjectionEnabled('outOfSessionClockMs');
  // 2024-01-02 00:30 America/New_York — firmly outside any fill session.
  return Date.UTC(2024, 0, 2, 5, 30, 0);
}

// ---------------------------------------------------------------------------
// WORKER-DEATH injector — crash a real child through the production
// tracked-spawn path (__spawnModelChildForTests). The child dies on its own;
// the test asserts the manager reaps it (no leak, no zombie).
// ---------------------------------------------------------------------------

export async function spawnCrashingChild(label: string): Promise<{
  trackedCount: () => number;
  waitForReap: (timeoutMs?: number) => Promise<boolean>;
}> {
  assertFaultInjectionEnabled('spawnCrashingChild');
  const mod = await import('../ai/ModelRuntimeManager');
  const spawnTracked = mod.__spawnModelChildForTests as (
    command: string,
    args: string[],
    label: string,
    extraOpts?: Record<string, unknown>,
  ) => { on: (ev: string, fn: () => void) => void } | null;
  const trackedCount = mod.__trackedModelChildCountForTests as () => number;
  const child = spawnTracked(process.execPath, ['-e', 'process.exit(1)'], label, { shell: false });
  if (!child) throw new Error('[spawnCrashingChild] spawn refused by the production cap');
  return {
    trackedCount,
    waitForReap: async (timeoutMs = 5000) => {
      const start = Date.now();
      for (;;) {
        if (trackedCount() === 0) return true;
        if (Date.now() - start >= timeoutMs) return trackedCount() === 0;
        await sleep(50);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// AI-UNAVAILABLE — convenience: arm a network-down provider on the governor
// through its own test seam, scoped. Fails closed: request() returns FAILED,
// never throws, never fails over to generative.
// ---------------------------------------------------------------------------

export function armAiUnavailable(
  governor: {
    __setJevProviderForTests: (p: unknown) => void;
    resetForTests: () => void;
  },
  scope: FaultInjectionScope,
): FakeJevProvider {
  assertFaultInjectionEnabled('armAiUnavailable');
  const provider = makeDownJevProvider();
  governor.resetForTests();
  governor.__setJevProviderForTests(provider);
  scope.onDisarm(() => {
    governor.__setJevProviderForTests(null);
    governor.resetForTests();
  });
  return provider;
}

export { startHeartbeat };
export type { Heartbeat };
