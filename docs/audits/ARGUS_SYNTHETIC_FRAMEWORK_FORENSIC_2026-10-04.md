# Argus Synthetic Framework — Forensic Audit (2026-10-04)

**Scope:** the synthetic testing framework itself, not the trading code. Read-only audit at
`feb0939` (docs) / working tree; two independent sub-audits: (A) synthetic-framework inventory,
test-double fidelity, certify-path reachability; (B) 21 recent real defects mapped to synthetic
blind spots. No files modified by the auditors. Full `sim:market-open --certify` was launched
separately — see its own log.

**One-line verdict:** the framework is honest but partial. Component-level regression tests cover
most recent defect mechanisms well; the full-spine certification path is real but benign by
construction, manual-only (never CI), and has zero coverage of the incident class that actually
cost money (OKTA double-sell via stale broker state).

## 1. What the synthetic framework actually is (inventory)

| Component | Path | Real path or shortcut |
|---|---|---|
| Scenario definitions (10) | `src/server/replay/synthetic/SyntheticScenario.ts` | Seeded-PRNG data generator; real shape, synthetic content |
| Session engine | `src/server/replay/synthetic/SyntheticSessionEngine.ts` | **Real production path**: `bootArgusCore()` → real EventBus → real TechnicalAgent → real ChiefTrader → real RiskEngine → real OMS → HistoricalReplayBroker → ledger. Honest limitations in its header: consensus debounce + RiskEngine mutex run on real wall-clock, Fundamental/Macro/News/Discovery workers forced off |
| Certification gate | `src/server/replay/synthetic/CertificationGate.ts` | Pure function over the real pipeline timeline + broker state; no decision injection |
| Timeline invariants | `src/server/replay/synthetic/TimelineInvariants.ts` | Causal-order checks: RISK_BYPASS, PHANTOM_FILL, CONSENSUS_BYPASS, ORDER_DURING_OUTAGE |
| CLI launcher | `scripts/sim/marketOpen.ts` + `marketOpenChild.ts` | `--certify` runs Test A + Test B in isolated children; `--seeds=N` multi-seed |
| Doubles | `HistoricalReplayBroker.ts`, `InternalPaperBroker.ts`, `brokers/testing/FaultInjectingBroker.ts` | All SIMPLIFIED (see §3) |

**Counts (corrected):** 10 scenarios declared and implemented; **only 2 execute under `--certify`**
(Test A `QUIET_OPEN`, Test B `VALIDATED_CONVERGENCE_CONTROL`). The other 8 are manual
`--scenario=` runs with no certification assertions. **Zero vitest tests execute a full
`SyntheticSessionEngine.run()`** — the full-spine proof is manual CLI only.
`CertificationGate.test.ts` uses hand-built fixture timelines, not engine output. 49 unit cases
across 6 synthetic test files — **not 77** (the "77/77" figure conflates a separate crypto
fixture set; do not cite it as synthetic evidence).

**Corrections to prior claims:** no `strategyParityHarness` file exists and no trigger-gate
bypass was found in current code — `strategySelectionReplay.ts` goes through `bestStrategyIdea()`,
which requires `triggerMet === true` (`StrategyEngine.ts:224-230`). The delta's bypass claim is
not reproducible at this tip.

## 2. Honest certification levels

- **Test A / Test B via `--certify`: L3 in design, L2 in practice.** Full-spine execution with
  adversarial causal invariants — but manual-only, never CI, so CI-green says nothing about it.
- **8 non-certify scenarios: L1.** Implemented, manually runnable, assertion-free.
- **CertificationGate unit tests: L2.** Fixture-based; they test the gate, not the pipeline.
- **No L4/L5 anywhere.** No CHIEF_APPROVED_IDEA injection, no prebuilt Risk/OMS proposals, no
  direct trade inserts, no fake fills in the certify path (verified) — but also no adversarial
  broker behavior in that path.

## 3. Test-double fidelity — all SIMPLIFIED_TEST_DOUBLE

**HistoricalReplayBroker:** fills synchronously inside `placeOrder()` — no ACK delay/loss, no
fill-before-ACK, no duplicate fills; positions derived from its own fills so **always
self-consistent (stale positions impossible)**; `disconnect()` is an empty no-op; no unknown
submit outcome; no cancel/fill race; no restart handling. Partial fills exist but always resolve
cleanly.

**FaultInjectingBroker:** seeded rejection rate, simplified partial fills, disconnect-after-N,
latency injection. Cannot model duplicate/stale/out-of-order position callbacks,
fill-before-ACK, unknown outcome, cancel/fill race, or restart mid-order. **Not wired into the
certify path** — used only in `brokerResilience.monteCarlo.test.ts`.

**InternalPaperBroker:** fills on `tick()`; "long only for simplicity."

## 4. Defect → blind-spot mapping (21 defects)

Component-level coverage is genuinely strong. 16 of 21 defects have a YES (test reproduces the
exact mechanism), including: OKTA double-sell golden replay
(`OrderManagement.positionEvidence.test.ts:39` — BUY 14 → SELL 14 → stale +14 injected →
second SELL rejected, `placeOrder` never called), close reservation, P&L attribution,
kill-switch submit race, STOP→MARKET, frozen bars, market-hours fail-open, triggerless emission
(`triggerGate.test.ts:266` phantom-99 → null; all 21 strategies assert triggerMet=false),
VWAP contract, degenerate inputs (20 mutations × 21 strategies), IBKR hang, buying-power TOCTOU,
PortfolioMonitor isolation, opening-range anchoring, capacity starvation, WFO/DSR gates.

**The 5 that matter (NO / PARTIALLY):**

1. **Budget/profile mismatch — NO coverage.** Nothing asserts resolved trading budget equals the
   intended allocation profile. The $2K-vs-$100K class has zero tripwire. (Monday hard gate.)
2. **Orders-endpoint hangs — NO coverage.** Only CLI import-hygiene test exists; no deadline
   assertions on any endpoint.
3. **Restart order duplication — PARTIALLY.** Boot forces TRADING_PAUSED after unclean death, but
   no test seeds a persisted PENDING order row and asserts boot never re-submits it.
4. **Consensus-layer trigger gating — PARTIALLY.** Phantom-99-vs-genuine-70 ranking is tested
   with fake strategy names at `bestStrategyIdea` level only; `ChiefTraderAgent` /
   `ConfluenceCoordinator` have zero triggerMet assertions.
5. **Watchdog enable-trading — PARTIALLY.** Watchdog pause path tested; "watchdog can never
   enable trading" unasserted.

**Critical nuance (where the two sub-audits diverge and both are right):** unit-level tests DO
cover the OKTA mechanism, stale snapshots, duplicate fills at the socket layer, and the trigger
gate — but the **full-spine certify path exercises none of it**, because its broker double is
benign by construction. Component tests prove the guards; nothing proves the guards engage on
the real path under adversarial conditions.

## 5. False-confidence risks (top 5)

1. **Certification never runs in CI.** The strongest test in the repo is the one that never runs
   automatically.
2. **Test A passes whether or not a trade happens** (`CertificationGate.ts:186-195`). A quiet
   scenario that unexpectedly trades is still PASS.
3. **`POSITION_OPENED` is inferred, not verified** (`fills > 0` ⇒ opened). The gate never reads
   `broker.positions()`.
4. **Test B seeds synthetic calibration history by default** (`marketOpen.ts:105-112`) — the
   headline certification number does not measure the organic system unless `--no-seed-calibration`.
5. **No independent P&L oracle** — `realizedPnl` is read from the broker under test; production
   accounting is never cross-checked.

## 6. Direct answers (24 questions, condensed)

Stale broker injection in certify? **No.** Out-of-order callbacks? **No.** Partial fill +
cancel race? **No.** Restart at order lifecycle boundaries? **No.** Unknown submit outcome?
**No.** Triggerless-99 detection? **Partial** (unit yes, spine no). Frozen daily bar? **No.**
Market-hours fail-open? **No** (unit fail-closed tests exist). Budget/config mismatch? **Was: No
at audit time; post-audit 2026-10-04 fix added the readiness-gate `capitalProfile` node asserting
`settings.budget` == `ARGUS_EXPECTED_BUDGET` (see §7).**
Consensus pollution? **Partial.** Capacity starvation? **No** (unit fairness test exists).
Independent P&L? **No.** Synthetic-data contamination of PAPER? **Partial** (two real
incidents fixed per-path, not structurally). Real-network leak into synthetic? **Partial**
(same). Every critical test reaches the real component? **No** — CertificationGate tests use
fixtures. Tests that only prove a mock? **CertificationGate.test.ts** (gate logic, not pipeline).
Release-blocking? **None are wired as release gates** — certification is advisory CLI output.
Mutation-tested? **No.** Full spine genuinely certified? **No — L2/L3, never CI, benign broker.**
Remaining untested classes: stale/out-of-order/duplicate broker state in-spine, restart races,
unknown outcomes, budget mismatch, endpoint hangs, consensus-layer trigger pollution.
Would I trust it to find a serious defect before PAPER? **For ordering/invariant violations:
yes. For the defect classes that actually occurred: no.**

## 7. What was fixed in this pass (2026-10-04)

- **NEW:** capital-profile consistency in the pre-market readiness gate — `TradingReadinessGate`
  gained a `capitalProfile` node asserting `settings.budget` (RiskEngine gate 23's own source —
  the exact value that authorizes BUY notionals) equals the operator-declared
  `ARGUS_EXPECTED_BUDGET` env var; any mismatch fails `tradingReady` with an explicit
  `BUDGET_MISMATCH` reason instead of silently trading on the wrong number. Missing/non-positive
  budget fails closed; unset intent is `notApplicable` (cannot verify, still passing). Pure
  observability — no threshold, gate, or order-path change. 6 new tests in
  `TradingReadinessGate.test.ts` (23/23 green); `ARGUS_EXPECTED_BUDGET` documented in
  `.env.example`. (Closes blind spot #1 above; directly serves the Monday hard gate.)
- Prior test-debt remediation (5 files): triggerMet-era replay fixtures, 2 BrokerManager
  execution-gate opt-ins, OMS reentrancy import hoist (real 5s-timeout root cause), plus a
  `tsc` fix in the PortfolioMonitor isolation test.

## 8. Remaining work (phased, not started)

- **Phase B:** wire `FaultInjectingBroker` (extended: stale/duplicate/out-of-order callbacks,
  unknown outcomes, cancel/fill race) into the certify path; add OKTA_DOUBLE_SELL as a
  release-blocking golden replay scenario in-spine.
- **Phase C:** deterministic virtual-clock event scheduler (consensus debounce + RiskEngine
  mutex currently run on wall-clock).
- **Phase D:** endpoint-deadline tests; restart-with-PENDING-order boot test; watchdog
  never-enables-trading assertion; consensus-layer triggerMet test with real strategies.
- **Phase E:** independent P&L oracle; `POSITION_OPENED` verified via `broker.positions()`;
  `--no-seed-calibration` as the default certification mode.
- **Phase F:** CI integration — at minimum Test A/B on `--seeds=3` as a required check; nightly
  property/mutation sweeps (Tier 4).
- **Phase G:** Java parity on a toolchain host (unverifiable here — no mvn/java/javac).

**Final principle (unchanged):** do not make synthetic testing prove Argus is healthy. Make it
try to prove Argus is broken. Today's framework tries at the component level and largely
succeeds there; at the spine level it is still sparring with a cooperative partner.
