# Argus zero-trade forensic audit — 2026-09-18

**Paper readiness: NOT READY.** No engine restart, order, fill, trading enablement, threshold change, or RiskEngine/OMS modification was performed. Chronos was restored independently using cached models. Source fixes are built but are not deployed into a running engine.

## Evidence window and reproducibility

The supplied counters are reproducible, but belong to the **September 17 exchange day**, not September 18. A read-only query of `data/argus.db` reproduces every supplied event counter at **2026-09-18T00:01:19.430Z** (September 17, 20:01 EDT). This cutoff is the 1,119th consensus start plus one second, not an invented current runtime snapshot. The database subsequently recorded another 33 rounds.

Read-only extractors: `agent_workspace/zero_trade_probe.cjs` and `agent_workspace/zero_trade_summary.cjs`. Detailed output, including every missing-price event ID, trace ID, symbol, timestamp, preceding discovery/subscription/error/agent records, and explicitly unknown fields: `agent_workspace/zero_trade_summary.json`. Exchange-day window: `[2026-09-17T04:00:00Z, 2026-09-18T04:00:00Z)`. No September 18 production event-trace rows were present when queried. Queries do not import application bootstrap or write to the production database.

`./argus help` was executed using Git Bash's absolute path; subsequent commands used the actual Node CLI to which the shell delegates. The current API on port 3000 refuses connections, including outside the sandbox. Recorded engine PID **26096** and watchdog PID **16060** were absent. `watchdog-status` returned `running:false, pid:null`. Last engine session marker: started `2026-09-17T10:54:58.790Z`, heartbeat `2026-09-18T01:28:36.133Z`, `cleanShutdown:false`. We did not cause or diagnose the process exit from this marker alone.

## Funnel

| Measure | Reproduced supplied snapshot | Complete persisted Sept 17 window |
|---|---:|---:|
| Discovery admissions (events) | 3,033 | 3,503 |
| Distinct admitted symbols | 436 | 436 |
| Missing-price rejection events | 143 | 187 |
| Distinct symbols with missing-price rejections | 38 | 39 |
| Ideas generated | 1,460 | 1,493 |
| Ideas rejected | 143 | 187 |
| Consensus rounds started/completed | 1,119 / 1,119 | 1,152 / 1,152 |
| Approvals | 0 | 0 |
| Risk evaluations / approvals | 0 / 0 | 0 / 0 |
| Orders / fills | 0 / 0 | 0 / 0 |
| Reconciliation-match events | 163 | 180 |

Admission events are not unique candidates or trade ideas. The production risk, trades and fills tables contain no rows in this window. Thus there is no execution-stage rejection to attribute to RiskEngine or OMS. IBKR **market-data** failures are upstream evidence and must not be confused with order rejection.

## Consensus rejection breakdown

| Persisted terminal code | Supplied snapshot | Full window |
|---|---:|---:|
| CONFIDENCE_BELOW_STRONG | 749 | 749 |
| AGENT_DATA_UNAVAILABLE | 169 | 192 |
| AGENT_HOLD | 135 | 135 |
| MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE | 66 | 76 |
| Total | 1,119 | 1,152 |

The 6,620 `DESK_NO_TRADE` events are not 6,620 terminal rounds. The structured `CONSENSUS_TERMINAL_REASON` records provide the one-per-completed-round distribution above.

At the supplied cutoff: 3 rounds had zero participating evidence entries, 574 had one, and 542 had two or more (355 two, 172 three, 15 four). Fifteen rounds contained opposing BUY/SELL entries. **749 rounds had at least one `SUFFICIENT_CALIBRATION_DATA` entry. No final confidence reached 0.75; maximum was approximately 0.70.** This directly supports confidence as the largest recorded terminal bottleneck; missing data alone does not explain all zero approvals.

The persisted `independentAgentCount` histogram is 0:304, 1:515, 2:285, 3:15. Source inspection shows this field counts distinct non-debate agent names in `result.agreements`, **not a complete persisted correlation-adjusted independence calculation**. All 300 rounds with this field >=2 contain BUY evidence; none contains SELL evidence. These are not certified independent BUY votes. Exact effective-independence distributions cannot be reconstructed from that field. We did not count correlated strategies as independent or replace calibrated confidence with raw strength.

No round contains Kronos evidence. This is evidence absence, not a count of rounds that required Chronos. AI-unavailability and Chronos-unavailability causal counts per round are not separately persisted in every terminal payload and are not inferred from their absence. Existing moderate-tier terminal codes were observed; no tier settings were changed.

## Missing-price breakdown

All 143 supplied-snapshot rejections came from **MacroAgent**. The report's former `Candidate Symbols Missing Price` incorrectly repeated the event count. It now deduplicates symbol names, while retaining the separate rejection-event count.

Trace-exact operational breakdown:

| Evidence | Count |
|---|---:|
| Matching rescue grant, followed by no usable fresh price | 124 |
| No matching persisted rescue lifecycle record | 19 |
| Matching rescue denial | 0 |
| Total | 143 |

Preceding broker-error context for these same events: **139 code 10089**, **3 code 200**, **1 code 10197**. These are nearest preceding same-symbol errors within the exchange day, not proof that each error remained active at rejection. They must not be relabeled as 143 conclusively proven broker-rejected subscriptions. No evidence supports declaring any particular historical line accepted, quote never received, or quote stale solely from these joins.

Symbols (rejection-event counts): SPY 7, QQQ 6, NVDA 14, AAPL 11, GLD 6, XLE 5, MSFT 9, TSLA 12, IWM 12, AXP 1, FDX 1, XOM 3, AAL 1, AMZN 1, AMD 12, META 9, XLK 3, SOXL 2, TQQQ 3, ARM 1, INTC 1, HD 1, COST 1, ABBV 1, ORCL 1, SQ 1, GOOG 2, RIOT 1, HPE 1, XLF 2, SMH 2, SQQQ 3, MRK 1, BRK.B 2, UNH 1, GOOGL 1, AVGO 1, JPM 1.

Historical first/last quote timestamps, per-rejection active-line state, price source, freshness, asset class and discovery rank were not all persisted. They are explicitly null in the extract, not guessed from ticker names or today's source. Preceding Technical/Quant evaluations are shown where present; same-symbol history does not establish candidate-specific evaluation. `FRESH_PRICE_WAIT_OUTCOME` now records trace-linked outcome, backend, cached price, quote age/time, allocation state and broker error. It cannot backfill missing history.

## Technical engine and streaming ownership

There were **2,849 TECHNICAL_ANALYSIS_STARTED and 2,849 COMPLETED events**. Last completion: **2026-09-17T21:03:22.269Z**, GLD. TechnicalAgent was therefore executing earlier, not continuously dead. The readiness reporter derives health from heartbeat age and marks an armed agent with stale heartbeat FAILED. An enabled toggle only expresses configuration. No historical full health snapshot supplies last successful tick, consecutive failures, last exception or event-loop stall at the supplied cutoff. Worker death versus no usable ticks cannot be conclusively separated after shutdown. The health reporter was not changed to turn green.

A concrete data-path defect was reproduced and fixed: `setBrokerQuoteContext()` changed the backend/cap to IBKR without retiring the Alpaca socket or transferring existing allocated symbols. `start()` could still open Alpaca under IBKR ownership. Alpaca's symbol-limit recovery operated on the shared active set and called `unsubscribe()` through the **current IBKR bridge**, repeatedly purging non-core IBKR lines.

Persisted evidence: 374 disconnect events (187 pairs associated with symbol-limit recovery), 187 market-data-gap events, and 9,967 IBKR market-data errors: 9,642 code 10089 (additional API market-data subscription required), 241 code 200 (contract resolution), 84 code 10197 (competing session). This establishes competing data paths and repeated resets; it does not quantify how many lost quotes each reset caused.

The fix retires the old socket/reconnect timer, cancels old IBKR subscriptions when leaving that backend, transfers existing allocation through the selected backend, and prevents Alpaca start/reconnect/recovery under IBKR ownership. Existing caps, duplicate checks, dynamic dwell, scoring, rescue bounds and broker pacing are retained. New tests prove old socket errors cannot purge IBKR lines. Source-side subscription membership still is not broker acknowledgment.

The 90-line setting belongs to IBKR; Alpaca limit recovery retained ten core symbols. Increasing the per-cycle 20-request limit would not fix that conflict or missing entitlements. Existing bounded allocator machinery was retained; no cap was increased.

## Broad-universe deployment verification

Full-window requests: BROAD_UNIVERSE_TOPUP **8,271**; CAMPAIGN_WATCHLIST_BOOST **4,380**; SNAPSHOT_HOT_SWAP **964**; SEED_UNIVERSE_EXPANSION **490**; CAMPAIGN_OPENING_SURGE **8**. Total **14,113**. Persisted payloads retain reason/source; momentumScore remains present when supplied. The broad-discovery-to-subscription and whitelist fixes were therefore running, not merely present in source. A request is not accepted streaming coverage.

## AI failover

At the reproduced cutoff: **75 successes / 1,588 calls = 4.7%**. `Consensus Provider Availability: YES` means only `healthyProviderCount > 0` from a minimal provider health probe. It does not certify prompt latency, normalized consensus evidence, calibrated confidence, or two independent agents.

| Provider | Full-window successful / failed calls | Recorded failure evidence |
|---|---:|---|
| Gemini | 14 / 64 | Quota exhausted |
| OpenRouter Free | 0 / 51 | Insufficient credits |
| LiteLLM Gateway | 0 / 281 | Fetch failures / timeout |
| Ollama | 69 / 644 | 643 outer 25-second timeouts, one abort |
| OpenAI | 0 / 43 | No credits / timeout |
| Claude | 0 / 40 | Quota/billing failure / timeout |
| Kimi | 0 / 72 | Suspended for insufficient balance / timeout |
| OpenRouter | 0 / 66 | Insufficient credits |
| Mistral | 0 / 302 | Rate limit / timeout |
| NVIDIA | 0 / 73 | Model endpoint returned 410, retired model |

Ollama **did service ConsensusDebate**: four success rows and three errors. Its other successes were 65 MarketRegimeAgent calls. MacroAgent had 87 Ollama errors and no success. Thus local routing exists but a healthy minimal probe substantially overstates usable task capacity. AIRouter uses configured local routes and fallbacks, bounded abortable invocation, rejects empty responses and tries other eligible providers; downstream validation remains fail-closed. The evidence does not establish a missing-Ollama-failover bug. No fake HOLD/BUY/SELL confidence was substituted. Current Ollama `/api/tags` responded 200; external provider statuses above are persisted session evidence, not fresh paid probes.

## Kronos / Chronos

Latest startup log ends with repeated `ModuleNotFoundError: No module named 'truststore'`; port 8008 initially refused connections. `requirements-ai.txt` already declares truststore. The system Python now has truststore, torch, chronos and transformers; the repository venv still lacks truststore. The launcher selects system `python`, so no dependency installation or interpreter change was necessary in this audit.

Started only the companion with `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`. Cached `amazon/chronos-t5-mini` and `ProsusAI/finbert` loaded on CPU. `/health` returned 200, `status:ok`, both model names; listening PID **26632**. Subsequent isolated outage-scenario output contains real Chronos inference on synthetic bars. This restores the local service, not proof that the stopped production engine has reconnected. Chronos was not made mandatory.

## Gap data quality

Largest admitted absolute gap found in this window was SDGR **0.2415940224** (price 29.91). Historical discovery payloads omit original open, previous close, reference timestamps and corporate-action state. These historical gaps cannot be certified valid or corrupt from persisted ratios alone.

The existing 20x open/previous-close ratio rule was an arbitrary magnitude-based substitute for provenance. Replaced it with finite positive reference checks, source-bar timestamp ordering/current exchange date, and open-within-source-session-high/low validation. Large returns are retained; no split adjustment is invented. Previous close and corporate-action state (UNKNOWN) are preserved for audit. `gapPct` remains the existing **intraday return from the daily-bar open**, not a newly claimed overnight gap or independently verified regular-session opening auction. Invalid/missing provenance quarantines the gap only; it does not discard an otherwise liquid candidate. Null gaps never create discovery shadow predictions. Regression coverage includes that real persistence path.

## Validation and deployment

Targeted suite: **163 passed across 7 files** before the added outage-generator test. Typecheck passed. Production frontend/server build passed, with the existing large-chunk warning. Full-suite and final scenario outcomes are recorded in the completion appendix below.

No engine was started or resumed: current broker positions/reconciliation cannot be verified through the unavailable API, and the watchdog is absent. TCP port 4002 is listening (PID 19800), which is not proof of a reconciled paper session. `LIVE_NO_GO` itself is expected and is not the readiness failure. New runtime behavior remains unverified until a controlled paper restart with current reconciliation, no open positions/mismatch, and one watchdog is possible.

Remaining concrete blockers: engine/watchdog stopped; current paper broker reconciliation unavailable; market-data entitlements/contract/competing-session errors; AI quota/billing/model and local task-timeout failures; no demonstrated legitimate production consensus approval; incomplete historical quote/health telemetry; synthetic certification does not establish complete execution readiness or live-market alpha.

## Files changed

- `src/server/services/MarketDataWorker.ts` and `.test.ts`
- `src/server/core/tradingSessionReport.ts` and `.test.ts`
- `src/server/core/waitForFreshMarketData.ts` and `.test.ts`
- `src/server/continuous/discoveryGapEvidence.ts`
- `src/server/continuous/MarketUniverseScanner.ts`, `.test.ts`, `.gapPctValidation.test.ts`
- `src/server/observability/discoveryCandidateLedger.ts`
- `src/server/replay/synthetic/SyntheticScenario.ts` and `SyntheticMarketDataEngine.test.ts`
- Read-only extractors and JSON evidence in `agent_workspace/zero_trade_*`
- This report

Pre-existing deletion of `.argus_dev.pid` was left untouched. RiskEngine, OMS, consensus thresholds and production calibration records were not edited.

## Synthetic execution status

Seed **12345**, speed **60**, isolated child-process databases, real SyntheticSessionEngine/Argus agents/RiskEngine/OMS/HistoricalReplayBroker. Synthetic calibration seeding was disclosed by the existing mandatory Test B launcher and confined to its isolated database; no production calibration was seeded.

| Scenario | Implemented | Executed this audit | Passed | Certified |
|---|---|---|---|---|
| QUIET_OPEN | Yes | Yes, twice, 90 simulated minutes | Existing gate PASS; zero fills, NO_CONSENSUS | Limited no-trade gate result only |
| VALIDATED_CONVERGENCE_CONTROL | Yes | Yes, twice, 240 simulated minutes | No; blocked at CONSENSUS, no trade | No |
| DATA_INTERRUPTION | Added | Yes, 90 simulated minutes, five symbols | Process completed; generator assertions covered by tests | No end-to-end outage safety certification |
| EXTREME_NOISE | Yes | Not separately executed | Not established | No claim |
| TRENDING_BULL_GAP_AND_GO | Yes | Not separately executed | Not established | No claim |
| TRENDING_BEAR | Yes | Not separately executed | Not established | No claim |
| SIDEWAYS | Yes | Not separately executed | Not established | No claim |
| HIGH_VOLATILITY_OPEN | Yes | Not separately executed | Not established | No claim |
| NEWS_SHOCK | Yes | Not separately executed | Not established | No claim |
| CERTIFIED_BULLISH_ENTRY_EXIT | Yes | Not separately executed | Not established | Name is not certification |

Final mandatory certification remained **OVERALL FAIL after Chronos recovery**. DATA_INTERRUPTION removes ten bars per symbol at minutes 30–39 rather than interpolating or refreshing stale prices; generated bars resume at minute 40. Actual run: 33.7 seconds, RSS 286.3→287.7 MB, heap 68.2→71.4 MB, event-loop p95 225.97 ms, p99 258.21 ms. Its successful process exit does not prove no stale orders during the gap.

Existing certification limitations found in source: the quiet branch returns PASS unconditionally; the lifecycle gate equates nonzero realized P&L with a closed position and does not itself certify partial-fill reconciliation. Therefore these reports do not certify the requested complete execution lifecycle, even when an existing gate says PASS. No synthetic result is evidence of live-market alpha. Broader scenario execution and stronger lifecycle assertions remain separate, concrete certification work.
