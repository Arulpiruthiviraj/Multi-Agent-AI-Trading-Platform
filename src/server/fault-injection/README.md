# Fault-Injection Framework + Chaos Matrix

**Test-only. Never production.** Every file in this directory is labeled
`FAULT_INJECTION`. See `FaultInjectionGate.ts` for the structural guarantee.

## The gate

Everything is gated behind the explicit opt-in env var:

```
ARGUS_FAULT_INJECTION=1
```

- No production entry point (`server.ts`, `scripts/argus-engine.ts`,
  `scripts/start-headless*.ts`, watchdog, CLI) sets it. Absence is the default.
- Every injector factory calls `assertFaultInjectionEnabled()` **first** and
  throws `FaultInjectionGateError` before touching anything.
- `FaultInjectionGate.test.ts` machine-checks the gate:
  1. With the flag absent, every factory (sync and async) throws.
  2. Only the exact value `"1"` opens the gate (no truthy lookalikes).
  3. **Static scan**: no production file (anything outside this directory and
     outside `*.test.ts`) imports from `fault-injection/` or reads the flag.
  4. The flag string appears only in this directory's code and in
     `package.json` test scripts.

## Injectors (`injectors.ts`)

Deterministic, environment-only faults — never a forced decision:

| Domain   | Injectors |
|----------|-----------|
| Provider | timeout, HTTP 402 / 429 / 503, network-down, flaky script (deterministic per-call outcomes) |
| DB       | slow query (synchronous bounded stall), locked (`SQLITE_BUSY` × N, then recovery) |
| Market   | stale quote, frozen quote, rollback quote (older-after-newer, ignored by the production monotonicity guard) |
| Socket   | deterministic close/open script with reconnect-generation invalidation |
| Backup   | hanging worker (never completes) |
| Broker   | out-of-session clock (real `HistoricalReplayBroker` REJECTED path), volume-capped partial fills |
| Worker   | crashing child through the production tracked-spawn path |
| AI       | unavailable (network-down provider armed on the real governor) |

`createFaultInjectionScope()` records a restoration for every shared-state
patch; `disarmAll()` runs them in reverse order so faults never leak between
tests. `heartbeat.ts` provides the event-loop/memory heartbeat every scenario
asserts against (ticks > 0, max gap bounded, heap delta bounded).

## Suites and tiers

| File | Tier | Contents |
|------|------|----------|
| `FaultInjectionGate.test.ts` | PRE-MARKET | gate proof + static scans |
| `InjectorIsolation.test.ts` | PRE-MARKET | each injector vs its real production module |
| `ChaosMatrix.test.ts` | PRE-MARKET | 6 fast combinations (C1–C6) |
| `nightly/ChaosMatrixHeavy.test.ts` | NIGHTLY | extreme volume, news-burst memory pressure, real wall-clock timeout |

Every chaos scenario asserts the same five properties: (a) bounded queues /
no unbounded growth, (b) circuit breakers engage, (c) validated-quant path
unaffected where the architecture requires it, (d) heartbeat healthy,
(e) fail-closed behavior.

## Running

```bash
npm run test:faultinjection          # PRE-MARKET: gate + isolation + matrix (fast)
npm run test:faultinjection:nightly  # NIGHTLY: heavy combinations
```

Both scripts export `ARGUS_FAULT_INJECTION=1`. Running vitest directly without
the flag fails every fault-injection test at the gate — that is the proof
working as designed.

## Safety contract

- PAPER ONLY. Injectors never touch LIVE paths; they are structurally
  unreachable without the test flag.
- No threshold or gate is lowered (0.75 AI consensus, EV/R:R, RiskEngine).
- No lifecycle rows are promoted or seeded outside temp-DB test fixtures.
- No bypass of ChiefTrader, RiskEngine, PositionSizing, OMS, BrokerManager.
- No strategy formula changes. Fail closed everywhere.
