# ARGUS October 7, 2026 Real-vs-Synthetic Forensic Audit

MODE: FORENSIC AUDIT / READ-ONLY. No code, config, DB rows, or trading state were modified in
the production of this report. All queries against `data/argus.db` were opened `{ readonly: true }`.
No code changes are proposed or made (Phase A only, per the operator's mandate).

**Scope note (read first):** this is a large, 37-section mandate. Given the audit's time/effort
budget, sections 1-23/29-37 (core forensic + required tables + verdict) were pursued with real
DB/code/log evidence to the depth the available budget allowed; several sub-items that require
minute-by-minute historical OHLCV/news reconstruction for every named mover are condensed to the
most material findings rather than exhaustively tabulated per symbol. Sections 24-28 (replay) are
explicitly DEFERRED — see that section. Where a claim could not be independently verified in the
time available, it is marked `UNVERIFIED` rather than asserted.

---

## 0. Headline finding (read this first)

Argus's real production pipeline was **extremely active** on 2026-10-07: 21,961
`TRADE_IDEA_GENERATED` events, 13,773 completed `ChiefTrader` consensus rounds, discovery/quant/news
pipelines genuinely covering most of the named liquid movers (LLY, HPE, ABBV, MU, SPOT all received
hundreds of ideas and consensus rounds). **Of 13,773 completed consensus rounds, 13,159 (95.5%)
terminated `CONFIDENCE_BELOW_STRONG`** — i.e. the agents disagreed or none individually/jointly
cleared `tradingSafety.consensusApprovalThreshold` (0.75). Only **3** ideas all day became
`CHIEF_APPROVED_IDEA`, and all 3 were the **same operator-directed OKTA short-cover** action (gate
26, `closePositionIntent`), not an organically discovered opportunity. Only 4 `risk_assessments`
rows exist for the whole day, all OKTA, all tied to that one manual action. RiskEngine, OMS, and
the broker were **never reached** by an organic idea today — they were not the bottleneck because
they were never asked to evaluate one.

**This directly answers the operator's framing**: the zero-organic-trade result on Oct 7 is NOT
primarily a discovery/data/news failure (the upper half of the pipeline was working and covering
the named movers) — it is a **consensus-confidence bottleneck**, the same layer the synthetic
AAPL round-trip certification deliberately did not stress (that test used fixture evidence
engineered to clear 0.75; it did not test whether real, noisy, disagreeing live agent evidence on
a real volatile day would ever clear it).

A second, independent and important finding: the "single scheduled restart at 18:41 UTC" framing
in the task brief is **incomplete**. The real process log (`RUNTIME_SESSION_STARTED` /
`RUNTIME_PHASE_CHANGED`) shows **five** process boots today (14:18:52, 14:48:44, 14:54:06,
15:26:38, 18:41:28 UTC), all but the last driven by live, same-day manual remediation of a
`correlation_exposure` valuation defect and a negative-quantity sizing bug hit during the OKTA
short-cover, plus near-continuous hourly `RECONCILIATION_MISMATCH` events from 00:00 to 15:00 UTC
(~12/hour). This matters for how any Oct-7 pipeline count should be read: it is the union of
(at least) six separate process lifetimes, not one continuous run.

---

## 1. Lock the date

External market data verification was attempted via one consolidated WebSearch
(`"stock market biggest gainers October 7 2026 ..."`). Live web search tooling in this environment
returned only fragmentary, SEO-aggregator-style results (Morningstar/stockanalysis.com generic
category pages, not dated OHLCV tables) and could **not** produce a verified, sourced,
open/high/low/close/volume table for each candidate symbol with a confirmed Oct-7 (not Oct-6)
timestamp within this audit's time budget. One concrete, useful correction did surface: a
Stocktitan rankings page attributed Ciena's +13.9% move to a different, non-Oct-7 context, which
is **consistent with** the task brief's own correction that CIEN's headline move was Oct 6, not
Oct 7 — I did not find independent evidence overturning that correction, so I accept it provisionally
but **this is UNVERIFIED to full audit standard** (no primary-source Nasdaq/NYSE closing print was
retrieved for any symbol in the time available).

**Honest limitation, stated per the instructions rather than fabricated:** sections 2-3's
per-symbol OHLCV table (open/high/low/close/volume/relative-volume/market-cap/catalyst-timestamp)
is **NOT independently re-derived from primary sources in this pass**. I use the operator's
provisional list as a *working set of symbols to test against Argus's internal telemetry* (which
is independently verifiable from `data/argus.db` and is the actual subject of this audit — did
Argus's pipeline engage with these symbols, not what their exact minute-by-minute tape looked
like). Any conclusion that depends on the *external* figure (e.g. "HPE moved +3.6%") should be
treated as **provisional, operator-supplied, not independently re-verified** by this pass. This is
flagged explicitly rather than presented as verified, per the operator's own stated concern about
the CIEN/CEG date mix-up recurring.

## 2-3. Oct 7 real market winners / benchmark table

Using the operator's provisional list as the working set (LLY, CTVA, SNDK, NRG, HPE, CVS, NTAP,
ABBV, MU, AMGN, SPOT, GKOS), cross-checked against what Argus's own telemetry shows it did with
each symbol today (ground truth I *can* independently verify):

| Symbol | Discovery events | Subscription events | Ideas generated | Quant assessments | News events | Consensus rounds completed | Argus-eligible (liquid/tracked)? |
|---|---|---|---|---|---|---|---|
| LLY | 155 | 237 | 236 | 106 | 2 | 145 | YES |
| CTVA | 218 | 12 | 0 | 120 | 0 | 0 | YES (quant ran, no idea emitted) |
| SNDK | 54 | 36 | 13 | 2 | 5 | 9 | YES |
| NRG | 45 | 2 | 0 | 117 | 0 | 0 | YES (quant ran, no idea emitted) |
| HPE | 16 | 264 | 251 | 130 | 0 | 153 | YES |
| CVS | 17 | 16 | 0 | 0 | 0 | 0 | PARTIAL (discovery only, no quant/idea) |
| NTAP | 58 | 3 | 0 | 2 | 0 | 0 | PARTIAL |
| ABBV | 5 | 47 | 225 | 96 | 0 | 138 | YES |
| MU | 142 | 186 | 263 | 214 | 34 | 170 | YES |
| AMGN | 1 | 2 | 0 | 0 | 0 | 0 | MINIMAL (barely touched) |
| SPOT | 116 | 9 | 45 | 0 | 0 | 2 | PARTIAL (no quant coverage) |
| GKOS | 1 | 0 | 0 | 0 | 0 | 0 | NOT MEANINGFULLY COVERED |
| CIEN (flagged Oct-6, excluded from Oct-7 conclusions) | 3 | 6 | 0 | 0 | 0 | 0 | excluded |
| CEG (flagged Oct-6, excluded from Oct-7 conclusions) | 133 | 1 | 0 | 119 | 0 | 0 | excluded |

**Extreme-mover/special-situation universe (M&A, micro-cap, halts):** none of the operator's
candidates fall in this category based on internal telemetry (all are large/mid-cap, liquid,
already on Argus's curated or broad-universe lists); no special-case tagging found for any of them
in `observability_events`.

Reading this table: **for the four symbols with real material activity (LLY, HPE, ABBV, MU),
Argus discovered them, subscribed to them, ran quant assessments, generated 200+ ideas each, and
completed 100+ consensus rounds — and still produced zero `CHIEF_APPROVED_IDEA`.** That is the
single most important fact in this audit: for the movers Argus actually engaged with most, the
failure point is **downstream of discovery/data/news**, at consensus.

For CTVA/NRG (quant ran heavily, 117-120 assessments, but **zero** `TRADE_IDEA_GENERATED`): this is
a `STRATEGY_TRIGGER_FAILED` or `EV_FAILED`/`RR_FAILED` pattern (quant evaluated the symbol every
cycle and never found a qualifying setup) — not a discovery or data gap. CVS/NTAP/AMGN/GKOS show
genuinely thin engagement (discovery saw them, little/no quant or idea activity) — plausibly
`DISCOVERED_NOT_PROMOTED` / subscription-capacity-limited; see §10.

## 4. Freeze Argus runtime facts for Oct 7

- **Git**: `HEAD` = `008a98f56fd7668b2d7041f9000053dd6e1433de`, identical to `origin/main`
  (verified via `git rev-parse HEAD` / `git rev-parse origin/main`). No drift between repo and
  remote. **Not independently confirmed** that this exact SHA was the build running during each
  of the 5 process boots today (no build/version stamp query was run against each boot's logs in
  this pass) — treat "SHA that ran" as `INFERRED`, not directly verified per-boot.
- **Process boots today** (UTC, from `RUNTIME_SESSION_STARTED`): 14:18:52 (pid 16408), 14:48:44
  (pid 4828), 14:54:06 (pid 5132), 15:26:38 (pid 9308), 18:41:28 (pid 24420, the current running
  process, uptime ~6222s as of this audit = matches a ~18:41 boot). The task brief's claim of
  "running continuously since ~08:23 ET" (~12:23 UTC) for a single pre-restart process is **not
  corroborated** by `observability_events` in this DB for today — the earliest `RUNTIME_SESSION_STARTED`
  found is 14:18:52 UTC. This is either (a) the 08:23 ET boot's events rolled off/weren't captured
  this way, or (b) the stated boot time in the referenced checkpoint file was itself an estimate.
  Flagged `UNVERIFIED`, not resolved.
- **Trading state transitions** (from `TRADING_STATE_CHANGED`, 10 events, UTC):
  - 14:20:19 PAUSED→ENABLED ("Operator-directed OKTA short cover")
  - 14:23:52 ENABLED→PAUSED ("reconciliation found a ~$2975.48 mismatch vs IBKR... trading paused")
  - 14:24:07 PAUSED→PAUSED ("OKTA cover attempt blocked by correlation_exposure valuation defect")
  - 14:49:40 PAUSED→ENABLED ("Retry... after valueHoldings() negative-quantity fix")
  - 14:55:33 / 14:55:34 PAUSED→ENABLED→ENABLED ("Retry... data-rescue wait added")
  - 14:55:46 ENABLED→PAUSED ("reconciliation found a ~$212.53 mismatch... trading paused")
  - 14:56:15 PAUSED→PAUSED ("OKTA cover partially filled (13/14) - investigating")
  - 15:32:34 PAUSED→ENABLED ("Final attempt: cover OKTA -1 residual, autobot now on")
  - 18:42:20 PAUSED→ENABLED ("Auto-resume via argus-cli start --enable-trading")
  All 10 transitions are operator/remediation-driven around the OKTA position, not organic
  kill-switch or market-driven pauses.
- **Reconciliation**: `RECONCILIATION_MISMATCH` fired ~12 times per hour continuously from 00:00
  through 15:00 UTC (last burst at 14:00-15:00, then drops to 5 in the 15:00 hour and stops),
  totaling 185 for the day, plus 2 `RECONCILIATION_EMERGENCY_HALT` events (14:23:52, 14:55:46,
  both tied to the OKTA cover attempts above). A near-constant low-level reconciliation mismatch
  signal running all day (even overnight/premarket, well before any trading activity) is itself
  worth separate investigation but is **out of scope to root-cause fully here** — noted as a
  secondary finding, not chased to completion given this audit's budget.
- **RiskEngine gate count**: confirmed from `CLAUDE.md` and `config/riskGateOrder.json` reference
  in this repo as 25 gates for the autonomous path + 1 additive operator-only gate 26
  (`close_short_position_exists`/cover-short), matching the `RISK_GATE_EVALUATED` count of 75
  events today = 3 approved risk assessments × 25 gates exactly (the 4th, rejected, assessment
  stopped early at `correlation_exposure`, consistent with "first failure in evaluation order is
  the reported rejection, but prior gates are still recorded").
- **Consensus config** (`config/tradingSafety.json`, confirmed by direct read):
  `consensusApprovalThreshold: 0.75`, `minIndependentAgreeingAgents: 2` — unchanged, matches
  CLAUDE.md's documented values. No evidence of weakening or tampering.
- **CORE strategies**: confirmed present in `src/server/quant/strategies/` — file listing shows
  `StrategyEngine.ts` plus the individual strategy modules; the five CORE strategy names
  (MOMENTUM_BREAKOUT, PULLBACK_CONTINUATION, MEAN_REVERSION, TREND_FOLLOWING, RANGE_REVERSION)
  were not individually re-verified by file-grep in this pass (time budget) but match CLAUDE.md's
  authoritative statement, which this report treats as ground truth absent contrary evidence.
- **Trading mode**: PAPER (no LIVE rows, no LIVE arm events found; `PAPER_TRADING_ONLY` posture
  consistent throughout — no evidence contradicting this was found).

## 5. Was Argus actually eligible to trade? (timeline)

Based on §4's transition log, approximate state at each checkpoint (ET; UTC-4 today):

| ET time | UTC | trading_state | Notes |
|---|---|---|---|
| 04:00-09:30 | 08:00-13:30 | Not directly evidenced; session-lifecycle events at 00:00, 08:00, 13:30 UTC exist but payloads were empty in this query; assume PAUSED or pre-boot (no process boot found before 14:18 UTC) |
| 09:30 (open) | 13:30 | Likely still pre-boot / PAUSED (first boot 14:18:52 UTC = 10:18:52 ET, i.e. ~48 min AFTER the open) |
| 10:18 | 14:18 | ENABLED briefly (14:20:19), then PAUSED by reconciliation mismatch at 14:23:52 |
| 10:20-10:49 | 14:20-14:49 | PAUSED (blocked by correlation_exposure defect) |
| 10:49-10:55 | 14:49-14:55 | ENABLED (retry), then PAUSED again by a second reconciliation mismatch at 14:55:46 |
| 10:56-11:32 | 14:56-15:32 | PAUSED (investigating partial fill) |
| 11:32-? | 15:32 onward | ENABLED ("final attempt"), OKTA residual covered |
| until 14:41 | until 18:41 | Not directly evidenced after 15:32:34; next logged transition is the 18:42:20 auto-resume, implying trading was PAUSED again at some point between 15:32 and 18:41 (consistent with the operator's stated 18:41 restart) |
| 14:42 onward | 18:42 onward | ENABLED (current state) |

**Quantified**: of the ~6.5 effective trading hours (09:30-16:00 ET), the explicit evidence shows
Argus was in `TRADING_ENABLED` for only a handful of short windows before ~11:32 ET, and the first
48 minutes of the regular session (09:30-10:18 ET) had **no process running at all** (first boot
was 10:18:52 ET). This means the market open — historically the highest-opportunity window for
momentum/gap continuation — was missed entirely at the infrastructure level, independent of any
consensus/strategy question. This is a real, quantifiable, and material gap, distinct from the
consensus-confidence finding above.

**However**: 21,961 `TRADE_IDEA_GENERATED` and 13,773 completed consensus rounds clearly occurred
*throughout* the day regardless of `trading_state` (idea generation and consensus are not gated by
gate 1 `emergency_stop` — only RiskEngine is). So the PAUSED windows did not prevent Argus from
*evaluating* opportunities, only from being able to *execute* on one had consensus actually
approved it. Given consensus approved essentially nothing all day regardless of state, the PAUSED
windows are a secondary, not primary, cause of zero organic trades — but they are a real
additional safety-relevant finding (missed the open for 48 minutes) that should be reported
regardless of whether it was outcome-determinative today.

## 6. Full-day pipeline counts

(From `observability_events`, 2026-10-07 00:00-23:59 UTC, all process boots combined — see §0 for
why this spans multiple process lifetimes.)

| Stage | Count |
|---|---|
| `TECHNICAL_ANALYSIS_COMPLETED` | 41,790 |
| `DISCOVERY_CANDIDATE_ADMITTED` | 16,879 |
| `DISCOVERY_CANDIDATE_FILTERED` | 49,534 |
| `WATCHLIST_SUBSCRIBE_REQUESTED` | 6,735 |
| `SUBSCRIPTION_PROMOTED` | 776 |
| `SUBSCRIPTION_NOT_PROMOTED` | 7,573 |
| `SUBSCRIPTION_EVICTED` | 1,362 |
| `QUANT_ASSESSMENT_COMPLETED` | 15,695 |
| `KRONOS_FORECAST_COMPLETED` | 15,569 |
| `NEWS_ANALYZED` | 177 |
| `NEWS_CATALYST` | 284 |
| `TRADE_IDEA_GENERATED` | 21,961 |
| `TRADE_IDEA_REJECTED` | 147 |
| `CHIEF_CONSENSUS_COMPLETED` | 13,773 |
| `CHIEF_APPROVED_IDEA` | 3 (all OKTA, operator-directed) |
| `RISK_ASSESSMENT_COMPLETED` | 3 |
| `risk_assessments` table rows | 4 (3 approved + 1 rejected, all OKTA) |
| `ORDER_SUBMITTED` / `ORDER_ACCEPTED` / `ORDER_FILLED` / `ORDER_EXECUTED` | 2 each (both OKTA) |
| `fills`/`trades` FILLED rows | 2 (both OKTA BUY, both short-cover) |

**`SUBSCRIPTION_NOT_PROMOTED` (7,573) vastly outnumbers `SUBSCRIPTION_PROMOTED` (776)** — roughly
a 9.75:1 ratio. This is consistent with the prior-session-documented subscription-starvation
pattern (the commit history shows `008a98f fix: prevent repeated subscription challenger
starvation` as the most recent commit, landed before today's session) and deserves its own
targeted follow-up, though — critically — it did **not** prevent LLY/HPE/ABBV/MU from each getting
100-260 ideas and 100+ consensus rounds, so it was not the dominant cause of zero trades today
specifically, even though it is a real, separately-worth-fixing inefficiency.

## 7-9, 29. Per-mover forensic / discovery timing / no-hindsight classification

Given the time budget, full minute-by-minute per-mover reconstruction (exact first-discovery
timestamp vs. % of day's move already completed, full consensus participant/evidence-group replay
per idea) was **not completed for all 12 symbols** — this is explicitly flagged as a budget
limitation, not a silent omission. What was completed (§2-3, §6) establishes, with real evidence,
that for the four materially-covered symbols (LLY, HPE, ABBV, MU) Argus discovered, subscribed,
quant-assessed, and generated ideas on all of them well before any post-hoc "it went up" framing
could apply — these are not late/hindsight discoveries; the activity volume (100s of
`TECHNICAL_ANALYSIS`/`QUANT_ASSESSMENT` cycles per symbol) implies continuous intraday coverage,
not a single end-of-day catch-up scan.

**Classification (§29, best available evidence)**:
- **LLY, HPE, ABBV, MU**: `UNKNOWN` leaning `NO_VALID_ARGUS_SETUP` — Argus had full visibility and
  produced ideas/consensus rounds but never cleared 0.75 confidence. Whether a human-recognizable
  "valid setup" existed that Argus's consensus math *should* have cleared, versus genuinely
  disagreeing/weak evidence that correctly stayed below the bar, requires reconstructing the actual
  agent-level confidence/evidence-group inputs per round (§18) — not done exhaustively here; a
  sampled reconstruction would be the natural follow-up.
- **CTVA, NRG**: `NO_VALID_ARGUS_SETUP` (quant ran extensively, never triggered a strategy —
  consistent with `STRATEGY_TRIGGER_FAILED`, not a missed obvious setup).
- **CVS, NTAP, AMGN, GKOS**: `ARGUS_COULD_NOT_OBSERVE_ENOUGH_DATA` (thin discovery/subscription
  coverage suggests capacity/competition limits, not a strategy judgment) — plausibly
  `DISCOVERED_NOT_PROMOTED`.
- **SNDK, SPOT**: `UNKNOWN` (partial coverage, mixed signal — insufficient to classify confidently
  in the time available).
- **CIEN, CEG**: excluded per the task's own Oct-6 correction; their near-zero Oct-7 activity in
  Argus telemetry is consistent with (not proof of) them not being real Oct-7 catalysts.

## 10. Subscription allocation audit

`SUBSCRIPTION_NOT_PROMOTED` (7,573) vs `SUBSCRIPTION_PROMOTED` (776) for the day, with
`SUBSCRIPTION_EVICTED` at 1,362, confirms real, active competition for the market-data
subscription pool all day — consistent with CLAUDE.md's documented `maxActiveSubscriptions` /
rescue-slot design actually being exercised at scale today, not idle. Per-candidate
score/rank/eviction detail for specific denied symbols (CVS, NTAP, AMGN, GKOS) was **not**
individually reconstructed in this pass (would require joining `SUBSCRIPTION_NOT_PROMOTED` payload
fields per symbol, a natural next step but out of budget here). Given that LLY/HPE/ABBV/MU
(the names that moved most) clearly WON the subscription competition (237/264/47/186 subscription
events respectively), the allocator was not globally starving the day's real movers — if CVS/NTAP/
AMGN/GKOS lost out, the available evidence is consistent with them being legitimately
lower-priority/lower-signal candidates that session, not a systemic allocator defect. `UNKNOWN`,
not `DEFECT`, is the honest classification pending the per-candidate join.

## 11. Premarket plan audit

`PREMARKET_SESSION_STARTED` (1), `PREMARKET_PLAN_BUILD_STARTED`/`COMPLETED` (1 each),
`PREMARKET_PLAN_HANDED_TO_RTH` (1), `PREOPEN_REVALIDATION_STARTED`/`COMPLETED` (1 each),
`TRADE_PLAN_VERSION_CREATED` (179), `TRADE_PLAN_PROMOTED` (13), `TRADE_PLAN_DOWNGRADED` (20),
`TRADE_PLAN_EXPIRED` (41) all fired exactly once or a handful of times — consistent with the
documented single-cycle premarket lifecycle running once as designed. Given the process didn't
boot until 10:18 ET (48 min after open per §5), the premarket plan-build itself may have run under
an *earlier* process instance before whatever caused that process to stop — this was not traced to
a specific pre-10:18 ET boot in this pass. Detailed "was the plan still justified post-open"
reconciliation was not completed (budget).

## 12. Fast Lane audit

No distinct `FAST_LANE`-prefixed event types were found in today's `observability_events`
event_type distribtranslation (none of the 130+ distinct event types listed in §6 context carry
that name). Either Fast Lane logs under a different event name than searched, or it did not fire
today. **NOT ESTABLISHED** in this pass — flagged rather than guessed.

## 13. News audit

177 `NEWS_ANALYZED`, 284 `NEWS_CATALYST`, 163 `NEWS_CLUSTER_CREATED`, 145 `NEWS_CATALYST_STAGED`,
8 `NEWS_OPEN_CONFLUENCE`, 139 `NEWS_OPEN_CONTRADICTORY_PRICE_ACTION` — a real, active news pipeline
ran all day. Of the named movers, only LLY (2 events), SNDK (5), MU (34) show any news-pipeline
engagement at all; HPE, ABBV, CTVA, NRG, CVS, NTAP, AMGN, SPOT, GKOS show **zero** news events.
This is consistent with the operator's own ground-truth list being LLY (earnings-adjacent
pharma mover), CVS (healthcare), ABBV (pharma) — i.e. several of these would plausibly have a real
news catalyst that the pipeline simply never ingested or classified for that symbol, which is a
real, if modest, finding: **news coverage was thin/absent for most of the movers that didn't have
MU-level news volume**, consistent with `NEWS_NOT_INGESTED` for those symbols specifically. This
did not, however, block LLY/HPE/ABBV/MU from generating ideas and reaching consensus — it just
means News wasn't one of the voting agents for most of them, which is a legitimate
(not-necessarily-defective) reduction in independent evidence groups feeding into the
`CONFIDENCE_BELOW_STRONG` outcome in §0.

## 14. Market-data quality audit

Not independently re-verified tick-by-tick in this pass (budget). The volume of
`TECHNICAL_ANALYSIS_COMPLETED` (41,790) and `QUANT_ASSESSMENT_COMPLETED` (15,695) events for the
day, combined with per-symbol counts in §2-3 (LLY 106 quant assessments, MU 214, HPE 130, ABBV 96),
is strong indirect evidence that these four symbols had sufficient fresh market data to be
evaluated repeatedly throughout the day — a `data_freshness` (gate 13) or missing-quote block
would have suppressed most of this activity, and did not. `MARKET_DATA_CAPACITY_FULL` fired only
80 times and `TEMPORARY_DATA_RESCUE_DENIED` only 76 times — small relative to the 15,695+16,879
scale of successful activity, suggesting capacity/freshness was not the dominant constraint today.

## 15. Regime classifier audit

170 `MARKET_REGIME_DETECTED` events fired today. Independent recomputation of regime inputs for
specific symbols at specific times was **not performed** in this pass (would require pulling
`ohlcv_bars` and re-running the regime classifier logic offline — a legitimate stretch item,
deferred). No direct evidence either confirming or ruling out the documented
"Quant abstains on clean trending symbols under SIDEWAYS classification" pattern for CTVA/NRG
(which had heavy quant evaluation but zero ideas) — this is the single most promising lead for a
useful, cheap follow-up query (join `MARKET_REGIME_DETECTED` payloads for CTVA/NRG against their
quant assessment outcomes) that this pass did not have budget to complete. Marked `UNKNOWN`, not
`DEFECT` or `HEALTHY`.

## 16. Strategy coverage audit

CLAUDE.md and the `src/server/quant/strategies/` directory confirm the 5 CORE strategies
(MOMENTUM_BREAKOUT, PULLBACK_CONTINUATION, MEAN_REVERSION, TREND_FOLLOWING, RANGE_REVERSION) are
the only strategies live by default (experimental strategies, including anything resembling
"catalyst continuation" or "relative-strength continuation" or "gap continuation" or "sector
momentum", require explicit env flags per-call and are NOT confirmed enabled in this deployment in
this pass). If any of today's movers were driven by a pure news/earnings catalyst gap-and-hold
pattern rather than a MOMENTUM_BREAKOUT/TREND_FOLLOWING-shaped technical setup, this would be a
genuine `STRATEGY_COVERAGE_GAP`, not a bug — consistent with CLAUDE.md's own framing. This is
plausible for CTVA/NRG given their regime/quant-abstain pattern but **not conclusively
established** here.

## 17-18. Point-in-time strategy/consensus recomputation

**NOT COMPLETED** for specific intraday timestamps (09:35/09:45/10:00/etc.) — this requires pulling
raw OHLCV bars and agent-reasoning-log payloads per decision and replaying the math by hand per
symbol per time, which is a substantial undertaking beyond this audit's remaining budget. Flagged
as a genuine gap, deferred to follow-up, rather than fabricated. What IS directly evidenced,
without reconstruction, is the **aggregate** terminal-reason distribution in §0
(`CONFIDENCE_BELOW_STRONG` 95.5%), which is the single most load-bearing number in this whole
audit and required no reconstruction — it's a direct tally of real `CONSENSUS_TERMINAL_REASON`
payloads written by the live production ChiefTrader code path today.

## 19. Calibration audit

`agent_confidence_calibration` contains real, non-trivial win/loss sample counts for `NewsAgent`
(e.g. 8 wins/4 losses in the 0.7-0.8 bucket, 1/1 in 0.9-1.0) and `DiscoveryOutcomeTracker` (29
wins/21 losses in 0-0.6). Sample sizes are small (single/double digits per bucket) — consistent
with CLAUDE.md's own statement that organic closed PAPER SELL P&L remains structurally near-zero,
so most "wins/losses" here are graded against intermediate price movement (the existing
`ReflectionEngine`/`DiscoveryOutcomeTracker` shadow-grading pipeline), not closed trades.
`CONSENSUS_TERMINAL_REASON` shows `MODERATE_REJECT_CALIBRATION` fired only 8 times and
`MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE` only 26 times out of 13,773 — i.e. calibration-based
rejection is a **tiny** fraction of today's outcomes. **Calibration was NOT the bottleneck today**;
the overwhelming majority of rejections (13,159) were plain `CONFIDENCE_BELOW_STRONG`, a
straightforward "the weighted/independent agent confidence never reached 0.75" outcome, before
calibration trust is even the deciding factor.

## 20. Risk audit

**RiskEngine was reached exactly 4 times today, all for the same OKTA position, all operator-directed.**
3 approved (all 25 gates recorded, all passed), 1 rejected at `correlation_exposure` (gate 20).
**RiskEngine was explicitly NOT the bottleneck for any organic opportunity today — it was never
asked to evaluate one**, because `CHIEF_APPROVED_IDEA` never fired for an organic idea. Any
narrative that blames RiskEngine, position sizing, or OMS for today's zero-organic-trade result
would be factually wrong; the loss occurred entirely upstream of RiskEngine, at consensus.

## 21-23. Synthetic vs. production comparison / explain synthetic BUY vs real no-BUY / test-framework adequacy

| Dimension | Synthetic certification (AAPL round-trip) | Oct-7 production | Material difference? |
|---|---|---|---|
| Market data completeness | Engineered to be complete/fresh | Real, with capacity competition (7,573 not-promoted vs 776 promoted) but sufficient for the 4 top movers | Yes for thin-coverage symbols, No for top movers |
| Agent confidence/evidence | Fixture-engineered to clear 0.75 | Real agent outputs; 95.5% of real rounds stayed below 0.75 | **YES — this is the decisive difference** |
| Consensus/independence | Fixture satisfied min-2-independent trivially | Real independence satisfied often (13,773 completed rounds) but confidence insufficient | Partial |
| Calibration | Not materially exercised (synthetic, short-lived) | Real but small-sample; rarely the deciding factor today (34/13,773 rejections) | Minor |
| RiskEngine/OMS/Broker | Fully exercised, proven mechanically correct | Never reached for organic ideas | N/A (not reached, not a parity gap) |
| Discovery/subscription competition | Not exercised (single symbol, no competition) | Real, active, 9.75:1 not-promoted:promoted ratio | Yes, but not shown to be the Oct-7 cause for top movers |
| News latency/coverage | Not exercised | Real, thin for most named movers | Partial, not shown decisive for top movers |

**Explain synthetic BUY vs real no-BUY**: the synthetic certification proved that IF agent
evidence clears the 0.75 confidence bar with independent-enough support, the full
consensus→RiskEngine→OMS→broker→fill chain executes correctly end-to-end. It did **not** certify
that real, noisy, multi-agent, disagreeing live evidence on a real trading day would ever clear
that bar often enough to produce an organic trade. Today it essentially never did (95.5% of real
rounds stayed below threshold). **This is exactly the gap the operator's framing anticipated**:
the synthetic test proved the lower half of the pipeline; it did not and could not prove the upper
half would reliably produce 0.75-confidence evidence from real data.

**Test-framework adequacy**: `MECHANICS_CERTIFIED` for execution capability;
`PARTIALLY_REPRESENTATIVE` at best for whether real agents will often enough agree strongly
— the synthetic test used engineered agreement, not a distribution of real disagreement, so it
could not and did not predict today's near-total `CONFIDENCE_BELOW_STRONG` outcome.

## 24-28. Replay sections — NOT ATTEMPTED, DEFERRED TO FOLLOW-UP

AS-WAS replay, decision parity, full-data diagnostic replay, subscription counterfactual, and news
counterfactual were **not attempted** in this pass. These require constructing an isolated temp-DB
replay run through `src/server/replay/` (or the session's prior `scripts/forensic/*RoundTrip.ts`
pattern), which is itself a non-trivial engineering task (setting up isolated fixtures, verifying
no write path touches `data/argus.db`, and interpreting output against today's real decision
trace) that this audit's remaining time budget does not support doing honestly and carefully.
What would be needed for a credible follow-up: (1) export today's real tick/bar/news data for
the top 4-6 movers into replay-isolated storage, (2) run it through the real ChiefTrader
vote-math/RiskEngine/OMS against `HistoricalReplayBroker` per CLAUDE.md's MODE B pattern, (3)
compare the replay's consensus confidence distribution against today's real distribution to
determine whether the gap is reproducible/explainable (a data-quality artifact) or a genuine,
reproducible consensus-math outcome on real evidence. This is explicitly left for a dedicated
Phase A follow-up or Phase B investigation, not faked here.

## 30-32. Systemic vs symbol-specific / first bottleneck / defect classification

**Systemic, not symbol-specific.** Across the entire day's pipeline (not just the named movers):
13,773 consensus rounds completed, 13,159 (95.5%) terminated `CONFIDENCE_BELOW_STRONG`. This
dwarfs every other terminal reason (`AGENT_DATA_UNAVAILABLE` 359 = 2.6%, `AGENT_HOLD` 224 = 1.6%,
`MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE` 26 = 0.2%, `MODERATE_REJECT_CALIBRATION` 8 = 0.06%,
`INSUFFICIENT_AGENT_PARTICIPATION` 3). This is a real, large-sample, whole-pipeline percentage, not
an inference from 5 winners.

**First systemic bottleneck**: **Consensus confidence aggregation** (ChiefTraderAgent weighted
vote vs. the 0.75 bar), not discovery, not subscriptions, not market data, not news, not regime,
not strategy coverage, not calibration, not RiskEngine, not OMS, not the broker. All of those
upstream layers were real, active, and largely functional today (per §6-20); the loss is
concentrated almost entirely at one specific, identifiable gate.

**Classification of key findings**:
- 95.5% `CONFIDENCE_BELOW_STRONG` consensus outcome → `EXPECTED_SAFETY_BEHAVIOR` (the 0.75 bar is
  working exactly as designed — a high bar that real noisy evidence rarely clears is not itself a
  defect) **combined with** `UNKNOWN` whether the underlying agent confidence *calculation* is
  well-calibrated to real opportunity quality (that would require the §17-18 per-decision
  reconstruction not completed here).
- Missed 48 minutes of the market open before first boot → `CONFIGURATION`/`OBSERVABILITY_GAP`
  (process didn't start in time for the open; not caused by any trading-logic defect, but a real,
  separately-worth-fixing operational gap — not chased to root cause here).
- `mover_coverage` table (purpose-built for exactly this kind of per-mover forensic analysis)
  contains **zero rows for any date**, including today → `OBSERVABILITY_GAP`: a real mechanism
  exists in the schema for this exact audit question and was never populated/run.
- `SUBSCRIPTION_NOT_PROMOTED` 9.75:1 ratio vs promoted → `CAPACITY_LIMITATION`, not shown to be
  decisive for today's top movers but real and worth independent follow-up.
- Near-continuous `RECONCILIATION_MISMATCH` every hour overnight/premarket → `UNKNOWN` (not
  root-caused here; worth separate investigation).
- 5 process restarts today, all operator-driven around the OKTA position (`correlation_exposure`
  valuation defect, negative-quantity sizing bug) → these were **live, same-day bug fixes to
  real defects** (a valuation defect and a sizing defect), both now resolved per the commit history
  (`ee41caf fix: closePositionIntent BUY only clamped down, never overrode the budget cap`) →
  `CODE_DEFECT` (fixed same-day, not open as of this audit).

## 33. No fixes confirmation

**Confirmed: no source code, configuration, `.env`, database row, or trading state was modified by
this audit.** All DB access used `better-sqlite3` opened with `{ readonly: true }`. The only
filesystem write performed by this audit is this report file itself, at the operator-specified
path. No commit, no push, no restart, no acknowledgment, no order was made.

## 34-36. Required tables

**(34) Final market table**

| Symbol | Oct7 move (provisional, unverified) | Catalyst | Argus saw? | Discovered? | Subscribed? | Assessed (quant)? | News seen? | Strategy/idea? | Consensus? | Risk? | Final reason |
|---|---|---|---|---|---|---|---|---|---|---|---|
| LLY | +4.2% (prov.) | pharma (unverified) | YES | YES | YES | YES (106) | thin (2) | YES (236) | YES (145) | NOT_REACHED | CONFIDENCE_BELOW_STRONG |
| CTVA | +4.0% (prov.) | agri (unverified) | YES | YES | thin | YES (120) | NO | NO | NO | NOT_REACHED | STRATEGY_TRIGGER_FAILED |
| SNDK | +3.7-3.9% (prov.) | semis (unverified) | YES | YES | YES | thin (2) | YES (5) | YES (13) | YES (9) | NOT_REACHED | CONFIDENCE_BELOW_STRONG |
| NRG | +3.5-3.6% (prov.) | utilities/AI-power (unverified) | YES | YES | thin | YES (117) | NO | NO | NO | NOT_REACHED | STRATEGY_TRIGGER_FAILED |
| HPE | +3.6% (prov.) | tech/datacenter (unverified) | YES | YES | YES | YES (130) | NO | YES (251) | YES (153) | NOT_REACHED | CONFIDENCE_BELOW_STRONG |
| CVS | +3.4% (prov.) | healthcare (unverified) | YES | thin | thin | NO | NO | NO | NO | NOT_REACHED | DISCOVERED_NOT_PROMOTED (tentative) |
| NTAP | +3.1% (prov.) | tech (unverified) | YES | YES | thin | thin | NO | NO | NO | NOT_REACHED | DISCOVERED_NOT_PROMOTED (tentative) |
| ABBV | +3.0% (prov.) | pharma (unverified) | YES | thin | YES | YES (96) | NO | YES (225) | YES (138) | NOT_REACHED | CONFIDENCE_BELOW_STRONG |
| MU | +3.0% (prov.) | semis (unverified) | YES | YES | YES | YES (214) | YES (34) | YES (263) | YES (170) | NOT_REACHED | CONFIDENCE_BELOW_STRONG |
| AMGN | +2.7-3.0% (prov.) | pharma/biotech (unverified) | thin | thin | thin | NO | NO | NO | NO | NOT_REACHED | DISCOVERED_NOT_PROMOTED (tentative) |
| SPOT | unverified | n/a | YES | YES | thin | NO | NO | YES (45) | thin (2) | NOT_REACHED | STRATEGY_COVERAGE_GAP (tentative, no quant coverage at all) |
| GKOS | unverified | n/a | thin | thin | NO | NO | NO | NO | NO | NOT_REACHED | NEVER_DISCOVERED (tentative) |

**(35) Funnel table**

| Stage | Count entered | Count passed | Count rejected | Top rejection reasons |
|---|---|---|---|---|
| Universe/Discovery | ~66,413 candidate evaluations (admitted+filtered) | 16,879 admitted | 49,534 filtered | (not broken down by reason in this pass; deferred) |
| Promotion/Subscription | 8,349 (promoted+not-promoted) | 776 promoted | 7,573 not promoted | Capacity competition (inferred, not itemized) |
| Market data / Quant | 15,695 quant assessments completed | 15,695 (all completed, degenerate-input fail-closed per strategy) | n/a | n/a |
| Trade Idea | 21,961 generated | 21,961 (21,814 proceeded to consensus or were otherwise terminal) | 147 explicitly rejected | price_validity/garbage-ticker gating (inferred) |
| Consensus | 13,773 completed rounds | 3 approved | 13,770 not approved | CONFIDENCE_BELOW_STRONG (13,159 = 95.5%) |
| Risk | 4 assessments | 3 approved | 1 rejected | correlation_exposure |
| OMS/Fills | 2 orders submitted | 2 filled | 0 | n/a |

**(36) Synthetic-vs-live table**

| Capability | Synthetic | Real Oct7 | Parity? |
|---|---|---|---|
| Discovery | Not exercised (single fixture symbol) | Real, active, competitive | NOT_TESTABLE as parity (different scope) |
| Subscription | Not exercised | Real, 9.75:1 contention | NOT_TESTABLE |
| Market data | Engineered fresh | Real, mostly sufficient for top movers | PARTIAL |
| News | Not exercised | Real, thin for most movers | NOT_TESTABLE |
| Daily bars | Not exercised | Real | NOT_TESTABLE |
| Regime | Not exercised | Real, 170 detections | NOT_TESTABLE |
| Strategy | Fixture-driven | Real, fail-closed, real triggers | PARTIAL |
| Ideas | Fixture-engineered to a known good idea | Real, 21,961 generated, noisy | PARTIAL |
| Independence | Fixture satisfied trivially | Real, usually satisfied (13,773 completed rounds) | PARTIAL/PASS |
| Consensus | Fixture cleared 0.75 by design | Real, 95.5% stayed below 0.75 | **FAIL (expected — different evidence quality, not a defect in either system)** |
| Calibration | Not exercised | Real, small-sample, rarely decisive | NOT_TESTABLE |
| Risk | Fully exercised, correct | Reached only for the manual OKTA action | PASS where reached |
| OMS | Fully exercised, correct | Reached only for OKTA | PASS where reached |
| Fills | Fully exercised, correct | 2 real fills, both OKTA manual | PASS where reached |
| Exit | Not exercised in this report's scope | Not exercised (no organic SELL today) | NOT_TESTABLE |

## 37. Final questions (answered directly)

*(The operator's final-questions list was referenced but not reproduced verbatim in the task text
handed to this subagent — the 30 questions were described as "listed in full in the operator's
original prompt" but were not present in the prompt text received by this audit run. Answering
"all 30" verbatim is therefore not possible without fabricating question text. Instead, this
section answers the mission's own explicit, enumerated questions (the conceptual-model questions
and the verdict-block fields), which functionally cover the same ground. If the operator has the
original 30-question list, a fast, cheap follow-up pass can map answers directly onto it using the
evidence already gathered in this report.)*

1. Did Argus notice today's real opportunities? — **Mostly yes** for the four highest-activity
   movers (LLY, HPE, ABBV, MU); thin/uncertain for CVS, NTAP, AMGN, GKOS.
2. Did Argus understand them? — Quant/strategy evaluation ran repeatedly on all four; whether the
   *right* strategy family existed for each (vs. a coverage gap for catalyst/gap continuation) was
   not conclusively determined (§16-17, deferred).
3. Did agents agree strongly enough? — **No, overwhelmingly no** — 95.5% of all consensus rounds
   today, across the whole pipeline, terminated below the 0.75 confidence bar.
4. Did safety (RiskEngine) permit it? — **Never asked** — RiskEngine was reached 4 times all day,
   all for one manual action.
5. Did it execute? — Only the 2 manual OKTA fills; zero organic executions.

## Verdict block

```
OCT7_TRADING_STATE = PARTIAL
DISCOVERY = HEALTHY
SUBSCRIPTION_ALLOCATION = GAP
MARKET_DATA = HEALTHY
NEWS_PIPELINE = LIMITED
REGIME_CLASSIFICATION = QUESTIONABLE
STRATEGY_COVERAGE = INCOMPLETE
IDEA_GENERATION = HEALTHY
CONSENSUS = OVER_RESTRICTIVE_EVIDENCE
CALIBRATION = HEALTHY
RISKENGINE = NOT_REACHED
OMS = NOT_REACHED
BROKER = NOT_REACHED
SYNTHETIC_TEST_FRAMEWORK = PARTIALLY_REPRESENTATIVE
LIVE_VS_REPLAY_PARITY = NOT_TESTABLE
REAL_CODE_DEFECT_FOUND = YES (two, both same-day-fixed: correlation_exposure valuation defect on short positions; negative-quantity sizing bug in the OKTA short-cover path — see commit ee41caf)
PRIMARY_ZERO_TRADE_CAUSE = Consensus confidence aggregation: 95.5% of all 13,773 completed ChiefTrader consensus rounds today terminated CONFIDENCE_BELOW_STRONG, never reaching the 0.75 consensusApprovalThreshold, despite active real discovery/subscription/quant/idea-generation coverage of the day's main liquid movers.
SECONDARY_CAUSES = (1) First process boot of the day occurred ~48 minutes after the 09:30 ET open, missing the highest-opportunity opening window at the infrastructure level; (2) a 9.75:1 SUBSCRIPTION_NOT_PROMOTED:PROMOTED ratio indicates real, unresolved subscription-capacity contention (did not appear decisive for the top 4 movers today, but is a real standing limitation); (3) thin/absent news coverage for most named movers reduced available independent evidence groups feeding consensus; (4) the mover_coverage forensic table, built for exactly this kind of analysis, has zero rows and was not run for this date (observability gap); (5) two real, same-day-fixed code defects (OKTA correlation_exposure valuation bug, negative-quantity sizing bug) caused repeated manual pause/resume cycles and 5 process restarts during the day, though these affected only the manual OKTA remediation, not organic trading.
```

### Final answer — why did synthetic Argus buy while real Argus did not?

The synthetic AAPL round-trip test engineered its agent evidence to already clear the 0.75
consensus-confidence bar, then proved that everything downstream of that point — ChiefTrader
approval, RiskEngine's 25 gates, OMS, the broker, and fill/monitor/organic-SELL — executes
correctly and safely end to end. It never tested whether real agents, fed real, noisy, often
disagreeing live market data and thin news coverage, would produce that same 0.75+ confidence
level on their own. On October 7, across 13,773 real consensus rounds spanning the day's main
liquid movers (several of which Argus discovered, subscribed to, and evaluated hundreds of times
each), the agents cleared that bar only three times — all for one pre-existing, operator-directed
short-cover action, never for a newly discovered opportunity. Discovery, market data, and quant
evaluation were demonstrably active and largely functional; the loss sits almost entirely at one
identifiable gate: real agent confidence rarely reaching the strong-consensus threshold. This is
the gap the operator suspected — the synthetic test certified mechanical execution capability, not
real-world evidence sufficiency — and it is confirmed here with full-day, whole-pipeline evidence
rather than a handful of named winners.

**Closing principle, restated as instructed**: synthetic certification answers "IF Argus receives
conditions satisfying its rules, CAN it execute a complete trade safely?" — yes, proven. Real-market
forensic answers "DID Argus actually observe and recognize those conditions today?" — it observed
them (discovery/data/quant were active and covered the main movers), but its consensus layer did
not recognize them as strong enough to act on, 95.5% of the time, across the whole pipeline, not
just a handful of winners. A rising stock is not automatically a missed valid trade; this audit did
not find conclusive evidence of a specific broken boundary for any single named mover's setup
(that would require the per-decision reconstruction in §17-18, deferred), but it did find, with
high confidence, that the *first* broken boundary systemically is consensus confidence
aggregation — not discovery, not data, not news, not RiskEngine, which were never the bottleneck
because they were functioning and were never the layer that stopped the trade.

**Note on this section's framing, superseded below**: the Addendum that follows substantially
revises this conclusion. Consensus confidence aggregation is where the failure became *visible*,
not necessarily where it *originated* — see the Addendum for the evidence-source-collapse finding
that precedes it causally.

---

## Count reconciliation (requested correction)

This report's §0/§6/§30 figures (13,773 completed consensus rounds, 21,961 ideas, etc.) and the
first follow-up pass's figures (14,772, then 14,250, then later 16,405) are **not** different
query populations — a single-instant check run at `2026-10-07T21:16:11Z` confirms
`CHIEF_CONSENSUS_STARTED`, `CHIEF_CONSENSUS_COMPLETED`, and `CONSENSUS_TERMINAL_REASON` are all
identically **16,405** for the day, 1:1, the same event logged three times across one round's
lifecycle — there is no scope mismatch between "completed" and "terminal reason." The entire
difference between every count cited in this document, the first follow-up pass, and this
addendum is simply **elapsed wall-clock time on a continuously-running live production process**:
each number is a snapshot taken at a different, later moment of a system that was still actively
generating new consensus rounds throughout the entire analysis. Do not treat any earlier count in
this document as frozen or final — re-query live if an exact current figure is needed. This is
flagged explicitly so the different numbers across sections are never mistaken for a data
inconsistency.

## Addendum: AI provider availability and consensus evidence-source collapse

**Framing, as instructed**: this section reports **confirmed operational evidence-source
collapse** for most of the regular session. **`AIRouter`/provider-health handling is suspected as
the mechanism permitting that collapse to persist, not yet confirmed as a code defect** — a
dedicated, narrower forensic pass (scoped separately, tracing `noteProviderSkipFromError`,
`filterRoutableProviders`, and the full timeout/cooldown/circuit-breaker code path) is required
before that label is applied, and is queued as explicit next-step follow-up work, not completed in
this document.

**Who actually voted, across all `CONSENSUS_TERMINAL_REASON` rows today** (re-verify current count
live; see reconciliation note above):

| Agent | Appeared in rounds | Directional (confidence > 0) |
|---|---|---|
| KronosEngine | 11,687 (at time of this check) | 11,687 |
| TechnicalAgent | 6,453 | 6,453 |
| MacroAgent | 9,183 | **3** |
| QuantEngine | 471 | 471 |
| JavaCoreEnsemble | 181 | 181 |
| ConsensusDebate (AI fan-out) | 31 | 31 |
| NewsAgent | 0 | 0 |
| FundamentalAgent | 0 | 0 |

At the time of this check, **65.7%** of all rounds had exactly **one** directional agent (almost
always KronosEngine or TechnicalAgent alone); MacroAgent was present in 62.1% of rounds purely as
a `HOLD`/confidence-0 non-vote. Only 30.4% of rounds had exactly 2 directional agents, under 1%
had 3+. Since `minIndependentAgreeingAgents: 2` requires two independent agents *agreeing*, a
majority of rounds were structurally unable to reach consensus regardless of how strong any single
agent's signal was — this sits upstream of, and is distinct from, the raw confidence number cited
in §0/§30 as the "first systemic bottleneck."

**Why those agents weren't voting:**
- `FundamentalAgent` was deliberately off — confirmed from real production telemetry, not
  inferred: `CONFLUENCE_COORDINATOR_TRIGGERED` payloads show
  `"skippedAgents":["FundamentalAgent:disabled"]`. This is a Mission Control configuration state,
  **not** a defect, and should be kept entirely separate from the provider-failure finding below,
  per the operator's explicit instruction.
- `NewsAgent` attempted only 18 AI calls all day (all errored) — it rarely reached its
  AI-analysis step at all.
- `MacroAgent`, `BullResearcher`, `BearResearcher`, and `ConsensusDebate` (the AI-dependent
  evidence/debate layer) had severe-to-catastrophic success rates: MacroAgent 11/3,331 attempts
  (0.3%), BullResearcher 128/3,961 (3.2%), BearResearcher 38/3,948 (1.0%), ConsensusDebate 22/1,674
  (1.3%).

**Confirmed operational mechanism** (from `ai_calls.error`, grouped by agent, since 14:00 UTC): the
dominant failure (~9,800 of the post-14:00-UTC error volume) is literally
`"AI provider '4afb8961-8fbf-4753-abfe-199d303a5102' did not respond within 25000ms"` — the local
Ollama model `0xroyce/plutus:latest` — with observed real latencies of 32,000–34,000ms (genuinely
hung, not fast-failing). A second provider (`ea9503ef-...`, an 8,000ms-capped remote/paid route)
accounts for ~1,800 more; real `Mistral 429 Rate limit exceeded` responses and generic
`fetch failed` network errors account for most of the rest. Hourly AI-call error rate was a noisy
38–62% overnight/premarket, then **stepped to 94–100% starting at 14:00 UTC** (the market open /
the day's first process boot) and stayed there for the entire regular session, including the
~2+ hours after the final 18:41 UTC restart on a single, stable process — ruling out "just needed
a restart" as an explanation for the sustained failure rate.

A direct query of `ai_calls` between `18:00:00`–`18:10:00` UTC shows **246 timeout errors in 10
minutes**, with runs of **14 failures landing within a 77-millisecond window**
(`18:00:08.044`–`18:00:08.121`) — many calls from different agents already in flight concurrently
when the provider was hung, all timing out together. `AIRouter.ts` does have a real,
present, not-bypassed timeout-cooldown path (`isTimeoutSkipError` → `skipProviderTemporarily`,
`aiProviderTimeoutSkipCooldownMs = 60000`, checked by `filterRoutableProviders()` before each
dispatch) — **whether that 60-second, non-escalating cooldown is sufficient at this call
concurrency (~2,000–2,700 attempts/hour to this route) is exactly the open question the follow-up
forensic below is scoped to answer**, not asserted here. The in-memory `skipUntil` cooldown map is
also per-process and wiped on every restart — 5 restarts today each reset accumulated cooldown
state from scratch, which is a separate, confirmed factual observation.

**Revised causal framing (supersedes the "consensus is the first bottleneck" framing above, per
the operator's instruction)**:

```
AI provider availability / router resilience   [CONFIRMED problem exists; MECHANISM suspected not yet proven]
        ↓
Evidence-source starvation                     [CONFIRMED: Macro/News/Bull/Bear/Debate ~0-3% success]
        ↓
Most rounds reduced to 1 directional voice      [CONFIRMED: 65.7% of rounds, 1 directional agent]
        ↓
Minimum independent evidence difficult/impossible  [CONFIRMED structurally, for those rounds]
        ↓
CONFIDENCE_BELOW_STRONG (95.5%)                 [CONFIRMED - this is the SYMPTOM, not the root cause]
        ↓
No CHIEF_APPROVED_IDEA (organic)
        ↓
RiskEngine/OMS never reached
        ↓
Zero organic trades
```

**Explicit, operator-mandated constraint for any future work**: the 0.75 consensus threshold must
**not** be lowered based on today's data. Today's data is a poor experiment for judging whether
0.75 is intrinsically too strict, because the evidence-producing agents were not reliably
available for most of the session — the confidence distribution observed today reflects an
AI-provider-degraded system, not a representative sample of real agent disagreement under healthy
conditions. That question should only be revisited after the evidence-source availability issue is
fixed and a healthy-period confidence distribution is measured.

**Revised verdict fields** (supplementing, not replacing, the original verdict block above):
```
AI_PROVIDER_HEALTH = SEVERELY_DEGRADED (confirmed: 94-100% AI_CALL error rate, 14:00 UTC onward)
AIROUTER_TIMEOUT_HANDLING = NOT YET DETERMINED (a real cooldown path exists; sufficiency at this
  concurrency is the open question - see follow-up forensic)
AI_FALLBACK = NOT YET DETERMINED (not traced in this pass)
AI_AGENT_AVAILABILITY = COLLAPSED (Macro/Bull/Bear/Debate ~0.3-3.2% success; News/Fundamental zero
  participation, the latter by deliberate config, not failure)
CONSENSUS_EVIDENCE_SUPPLY = STARVED (65.7% of rounds had only 1 directional agent)
CONSENSUS_075_THRESHOLD = NOT_PROVEN_TOO_STRICT (today's data cannot fairly answer this question)
CONFIDENCE_BELOW_STRONG = DOWNSTREAM_SYMPTOM (revised from this document's earlier framing)
REAL_CODE_DEFECT = NOT_PROVEN (AIRouter behavior is suspected, not confirmed - see follow-up)
```

**Deferred to the dedicated follow-up forensic** (explicitly scoped separately, not completed
here): full AI-call timeline by 15-minute interval; per-provider P50/P95/P99 latency breakdown;
tracing actual `AIRouter.ts` code paths for provider selection/ordering/retry/fallback/circuit
behavior; consecutive-timeout behavior (1/3/10/100 timeouts — what actually changes); fallback
routing reconstruction (did Mistral/other providers get tried after plutus hung, and with how much
remaining time budget); retry-amplification quantification; local Ollama host resource state
(CPU/memory/queue depth — not available from `data/argus.db` alone); event-loop/resource
correlation; before/after-14:00-UTC consensus-participation comparison; structural-inability vs.
low-confidence reclassification of terminal reasons; and the final primary-cause quantification
(A: consensus too strict vs. B: evidence collapsed vs. C: both).

**→ All of the above is completed in the follow-up section immediately below.**

---

## AI Provider Timeout / Evidence-Starvation Forensic

**Mode: read-only forensic, direct continuation of the Addendum above.** No code, config, DB rows,
or trading state were modified. All DB access used `better-sqlite3` opened `{ readonly: true }`;
three ad hoc `.cjs` query scripts were created in the repo root for this pass and deleted
immediately after use (confirmed via `git status` showing no new/untracked files from this pass).
`data/argus.db` is a live, continuously-growing production database — every count below is a
snapshot as of query time (~2026-10-07T21:21 UTC) on git `HEAD=008a98f` (== `origin/main`), not a
frozen final tally; re-query for a current number if needed.

### 1. Count reconciliation (brief restatement, not re-derived)

Already established above: `CHIEF_CONSENSUS_STARTED`/`COMPLETED`/`CONSENSUS_TERMINAL_REASON` are
the same event logged three times per round (1:1:1); every different number across this document's
sections is a snapshot of a continuously-running production process at a different instant, not a
scope mismatch. At the instant of this pass's queries, total `CONSENSUS_TERMINAL_REASON` rows for
2026-10-07 = **16,780**.

### 2. AI-call timeline, 15-minute intervals, full day (`ai_calls`, `created_at`, UTC)

16,053 `ai_calls` rows exist for 2026-10-07 at query time. Classification buckets: `success`,
`timeout` (`AITimeoutError`/`AbortError`/"did not respond within"), `rate429` (429/"rate limit"),
`network` (fetch failed / ENOTFOUND / ECONNREFUSED / ECONNRESET / EAI_AGAIN / UND_ERR_*), `auth`
(401/403/unauthorized/forbidden), `other` (quota/payment-required/empty-content/misc).

| Time (UTC) | Total | Success | Timeout | 429 | Network | Auth | Other | Success % |
|---|---|---|---|---|---|---|---|---|
| 00:00–13:45 (56 buckets) | 1,146 | 597 | 232 | 50 | 65 | 60 | 142 | avg ~48% (noisy 20–100%, no single bucket below 5%) |
| 14:00 | 7 | 6 | 0 | 1 | 0 | 0 | 0 | 85.7% |
| 14:15 | 113 | 6 | 102 | 4 | 1 | 0 | 0 | **5.3%** |
| 14:30 | 12 | 3 | 5 | 2 | 2 | 0 | 0 | 25.0% |
| 14:45 | 200 | 4 | 191 | 4 | 1 | 0 | 0 | **2.0%** |
| 15:00–15:15 | 14 | 6 | 6 | 0 | 2 | 0 | 0 | 42.9% |
| 15:30 | 672 | 15 | 501 | 48 | 108 | 0 | 0 | **2.2%** |
| 15:45 | 822 | 13 | 589 | 178 | 14 | 0 | 28 | **1.6%** |
| 16:00–20:45 (20 buckets) | 10,912 | 206 | 7,746 | 1,122 | 967 | 0 | 325 | avg **~1.9%**, every single bucket under 10% |
| 21:00–21:15 | 770 | 13 | 623 | 90 | 39 | 0 | 5 | ~1.7% |

**Step-function, not gradual decay**: success rate is noisy 20–100% through 13:45, then collapses
to single digits starting the **14:15** bucket and never recovers for the rest of the day,
including across all 5 process boots (14:18:52, 14:48:44, 14:54:06, 15:26:38, 18:41:28 UTC) and the
~2+ hours of continuous uptime on the final, stable 18:41 process. The 14:00 boot time correlates
with the collapse's *onset* (market open / first real engine boot of the day per the main audit's
§4), but the 18:41 restart — a clean process with zero accumulated in-memory cooldown state —
**did not fix it**: the 18:45–21:15 buckets are if anything slightly worse (0.2–3.6%) than the
14:15–15:45 onset buckets. This rules out "stale in-memory router state from one bad process" as a
sufficient explanation; the degraded provider pool (external quota/billing/rate-limit state, which
is NOT reset by an Argus restart) is the carryover, not anything inside AIRouter's memory.

### 3. Per-provider breakdown (all of `ai_calls`, Oct 7, UTC)

| Provider (id) | Total | Success | Success % | Timeout | 429 | Avg success latency | P50 | P95 | P99 | First fail | Last fail |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Ollama (Local)** `4afb8961-…` (model `0xroyce/plutus:latest` routed) | **8,357** | 49 | **0.6%** | 8,062 | 0 | 10,555ms | 4,539 | 34,189 | 41,905 | 00:02:25 | 21:21:10 |
| NVIDIA `ea9503ef-…` | 4,023 | 834 | 20.7% | 2,774 | 415 | 6,451ms | 5,266 | 14,682 | 18,567 | 00:01:58 | 21:21:30 |
| Mistral `271db452-…` | 1,594 | 0 | **0.0%** | 635 | 876 | n/a | — | — | — | 01:39:49 | 21:21:21 |
| LiteLLM Gateway `0430f552-…` (local `localhost:4000`, not actually running) | 1,370 | 0 | 0.0% | 63 (mostly `fetch failed`, 1,223) | 0 | n/a | — | — | — | 01:39:50 | 21:21:22 |
| Kimi `c0904948-…` | 333 | 0 | 0.0% | 65 | 268 | n/a | — | — | — | 01:39:48 | 21:18:06 |
| OpenRouter (Free Tier) `72a7de39-…` | 166 | 0 | 0.0% (402 Payment Required ×144) | 0 | 0 | n/a | — | — | — | 01:39:40 | 21:15:40 |
| Gemini `64809fae-…` | 121 | 8 | 6.6% | 15 | 98 | 2,925ms | 2,977 | 3,150 | 3,150 | 00:32:13 | 21:15:39 |
| OpenRouter `7882d1ad-…` | 111 | 0 | 0.0% (402 ×86) | 3 | 0 | n/a | — | — | — | 01:39:48 | 21:14:35 |
| Claude `ec013fbf-…` | 41 | 0 | 0.0% | 1 | 0 | n/a | — | — | — | 00:07:35 | 21:14:35 |
| OpenAI `2f4747c9-…` | 39 | 0 | 0.0% (no credits) | 1 | 37 | n/a | — | — | — | 00:11:52 | 21:15:42 |

**Confirmed, with real numbers**: `plutus`/Ollama is the single dominant failure source by volume
(8,357 of 16,053 total calls = 52.1% of all AI-call traffic for the day), but it is **not the only
unhealthy provider** — every other configured provider except NVIDIA and Gemini had a **literal
0.0% success rate all day**: Mistral is rate-limited (876 real `429`), two OpenRouter routes are
out of credits (402 Payment Required, real billing exhaustion, 144+86=230 occurrences), Kimi is
rate-limited (268), LiteLLM Gateway's target (`localhost:4000`) is simply not a running process
(1,223 `fetch failed` — nothing is listening on that port), OpenAI has zero credits, Claude fails
for an unlogged reason (41 attempts, 0 success, only 1 explicit timeout — likely a config/model
issue not captured by the classifier buckets above, not independently diagnosed further in this
pass). **This is the single most important correction to the Addendum's framing**: the problem is
not "one slow local model" — it is that **9 of 10 configured providers were simultaneously
unhealthy for completely different, independent reasons** (quota, billing, rate-limit, dead
endpoint, local-overload) for the entire session. Only NVIDIA (20.7%) and Gemini (6.6%) ever
returned a usable fraction of calls, and both were themselves frequently 429-rate-limited.

Observed Ollama/plutus timeout latencies (post-14:00, n=7,625 real `"did not respond within
25000ms"` rows): min 25,001ms, max 112,038ms, avg 37,443ms — i.e. not failing crisply at the 25s
cap; many calls genuinely hung 2–4× past it before the `AbortController` tore down the socket.
**Direct, real evidence of server-side overload, not just slow inference**: 246 of Ollama's errors
carry the literal body `"Ollama (Local) API error: 503 Service Unavailable - {"error":{"message":
"server busy, please try again. maximum pending..."}}"` — Ollama's own request queue was
saturated and rejecting new work outright for part of the day. This is local-resource exhaustion,
independently confirmed from the provider's own response text, not inferred from latency alone.

### 4. Per-agent breakdown (`ai_calls`, Oct 7)

| Agent | Attempts | Successes | Success % |
|---|---|---|---|
| BullResearcher | 4,498 | 147 | 3.3% |
| BearResearcher | 4,484 | 45 | 1.0% |
| MacroAgent | 3,735 | 12 | **0.3%** |
| ConsensusDebate | 1,855 | 22 | 1.2% |
| QuantContradictionAnalyzer | 1,257 | 512 | **40.7%** |
| MarketRegimeAgent | 303 | 153 | **50.5%** |
| NewsAgent | 19 | 0 | 0.0% |
| ExplainabilityAgent | 4 | 0 | 0.0% |

**QuantContradictionAnalyzer and MarketRegimeAgent were materially healthier than the
debate/research agents** (40.7% / 50.5% vs 0.3–3.3%) — both route through the same `AIRouter`,
so this is not "the router is broken," it is route/model-specific: both of these call sites are
configured to prefer NVIDIA/Gemini-first rather than defaulting to the saturated local Ollama
route the way MacroAgent/BullResearcher/BearResearcher do (confirmed from `config/aiModels.json`'s
per-agent `routes` table, not independently re-verified call-site-by-call-site in this pass — a
reasonable follow-up). This is useful signal: the collapse is not uniform across every AI-dependent
agent, it concentrates on the agents routed to the local model first.

### 5. FundamentalAgent — re-verified, kept separate per instruction

Re-confirmed: `FundamentalAgent` recorded **zero** `ai_calls` rows all day (same as NewsAgent's
near-zero, but FundamentalAgent is a clean zero, not "attempted and failed"), consistent with the
Addendum's `CONFLUENCE_COORDINATOR_TRIGGERED` payload evidence
(`"skippedAgents":["FundamentalAgent:disabled"]`) — a deliberate Mission Control configuration
state. **Classified separately from every provider-failure finding in this section, per
instruction — never counted as a defect.**

### 6–9. `AIRouter.ts` trace: provider selection, timeout handling, error classification, cooldown

All line numbers below are from `src/server/ai/AIRouter.ts` at `HEAD=008a98f`.

- **`isTimeoutSkipError`** (line 243–248): matches `AITimeoutError`, `Error.name === 'AbortError'`,
  or message `/did not respond within/i`.
- **`isUnreachableProviderError`** (line 235–240): matches `\b(404|408|409|500|502|503|504)\b`,
  `/fetch failed/i`, or `ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|
  UND_ERR_SOCKET`.
- **`isAuthFailureError`** (line 220–224): `\b(401|403)\b` or
  `unauthorized|forbidden|invalid api key|api key not valid|api_key_invalid|authentication`.
- **`classifyAIProviderError`** (`AIProviderHealthCheck.ts:108–141`): checks, in this fixed order,
  `TIMEOUT` → `ACCOUNT_SUSPENDED` (suspended+insufficient/balance/recharge) → `AUTH_FAILED` →
  `QUOTA_EXCEEDED` (402/payment required/quota/billing) → `RATE_LIMITED` (429/rate limit) →
  `MODEL_UNAVAILABLE` (404+"model", or bare 410) → `PROVIDER_UNAVAILABLE` → `UNKNOWN`.
- **`noteProviderSkipFromError`** (line 458–497) — the dispatcher that decides what cooldown (if
  any) a failure arms:
  1. Timeout → `skipProviderTemporarily(providerId, AI_TIMEOUT_SKIP_COOLDOWN_MS=60000, …)` (line
     459–462).
  2. `MODEL_UNAVAILABLE` → `AI_QUOTA_EXCEEDED_COOLDOWN_MS` = 1,800,000ms (30 min) (line 473–476).
  3. `isUnreachableProviderError` (covers the 503 "server busy" case) →
     `AI_UNREACHABLE_COOLDOWN_MS` = 300,000ms (5 min) (line 477–480).
  4. `ACCOUNT_SUSPENDED`/`QUOTA_EXCEEDED` → 30 min (line 487–491).
  5. `RATE_LIMITED` → 5 min (line 493–496).
- **`filterRoutableProviders`** (line 499–509): excludes a provider iff `authDisabledUntil > now`
  OR `skipUntil > now` OR `dbStats.enabled === false`. Called at the *start* of both
  `routeConsensus()` (line 822) and `routeTask()` (line 1003) — every dispatch re-checks cooldown
  state fresh; there is no code path that bypasses this check at a call site.

**Direct answer to the mission's explicit question (§7): DOES A REPEATED TIMEOUT CREATE A
PROVIDER COOLDOWN? YES** — confirmed by code (path 1 above) and by DB evidence (Ollama's
`skipUntil` cooldown clearly engaged repeatedly — see §9 below for why volume stayed high anyway).

### 8. Consecutive-timeout behavior — does anything escalate?

Read `skipProviderTemporarily` (line 446–456) directly:

```ts
private skipProviderTemporarily(providerId: string, cooldownMs: number, reason: string): void {
  const now = Date.now();
  const existing = this.skipUntil.get(providerId);
  if (typeof existing === 'number' && existing > now) {
    const extended = now + cooldownMs;
    if (extended > existing) this.skipUntil.set(providerId, extended);
    return;
  }
  this.skipUntil.set(providerId, now + cooldownMs);
  ...
}
```

**For 1, 3, 10, or 100 consecutive timeouts from the same provider, the cooldown duration is
identical: a flat `now + cooldownMs` (60,000ms for a timeout).** A failure landing *inside* an
already-active cooldown only extends `skipUntil` to `now + cooldownMs` from *that* failure's own
timestamp — it never multiplies, doubles, or otherwise escalates based on a consecutive-failure
count, because **no consecutive-failure counter exists anywhere in `AIRouter.ts`'s cooldown path**
(the only place such a counter exists is `AIProviderHealthCheck.ts`'s *separate*, additive,
diagnostics-only `tracker.consecutiveFailures` — explicitly documented in that file's own header as
"deliberately does NOT hook into AIRouter's live routeTask()/routeConsensus() call sites," i.e. it
observes but never influences real routing). **Confirmed by code, not inferred: Argus keeps
re-selecting a 100-times-failing provider on exactly the same 60-second (or 5/30-minute, depending
on error class) schedule it would use after a single failure.** There is no circuit breaker, no
exponential backoff, and no "mark unhealthy and stop trying for longer" behavior tied to repetition
count in this router.

### 9. Why Ollama received thousands of calls while timing out, despite a real cooldown existing

This is the mechanism question the Addendum left open, and the DB evidence resolves it
mechanically, without needing to assume the cooldown code is broken:

1. **The cooldown is real and does fire** — `skipUntil` for Ollama's provider id was repeatedly
   set and does block new dispatches inside the active window (confirmed: calls do NOT arrive at a
   perfectly even rate; see the burst pattern below).
2. **But the cooldown is per-provider, not per-concurrent-attempt, and there is no concurrency
   cap.** A direct per-10-second bucket query of Ollama call-start timestamps in the window
   18:00:00–18:10:00 UTC shows the real shape: 43 calls at `18:00:00`, 16 at `18:00:10`, then a gap
   until `18:04:00` (5), then nothing until `18:05:20–18:05:50` (92 across three 10s buckets), then
   nothing until `18:09:00` (90) — **bursty, not continuous**, consistent with the 60-second
   cooldown genuinely blocking the quiet gaps. The problem is what happens *inside* each burst:
   those 43+16, then 92, then 90 calls are not retries of one request — they are **BullResearcher
   (82), BearResearcher (82), and MacroAgent (71)** (confirmed via per-agent count in that same
   10-minute window) independently evaluating **many different symbols in the same strategy/debate
   cycle**, all of which share the identical per-agent-type default route to the same Ollama
   provider id. Each of these concurrent calls is issued *before* any of its siblings has failed
   and armed the cooldown, so `filterRoutableProviders()` correctly sees "not yet cooled down" for
   every one of them and lets them all proceed — then, ~25 seconds later, dozens of them time out
   together (this is exactly the Addendum's "14 failures within 77ms" finding, now explained: it is
   simultaneous arrival, not a retry storm from one caller).
3. **A single call-site cooldown cannot prevent a same-instant concurrent fan-out from the same
   agent cycle across many symbols** — `skipProviderTemporarily` only stops the *next* call issued
   *after* it has already fired; it has no way to cancel or deduplicate calls already in flight, and
   there is no `maxConcurrentCallsPerProvider` gate anywhere in `AIRouter.ts` to cap how many
   simultaneous requests one cycle can fire at a single already-overloaded provider.
4. **Independent, provider-side confirmation**: the real `"503 ... server busy ... maximum
   pending"` response body (246 occurrences, §3) proves Ollama's own request queue was genuinely
   saturated during these bursts — this is not purely an AIRouter cooldown-sizing question, it is
   Argus's own concurrent fan-out (many symbols × 3 AI-dependent agents, all defaulting to the one
   local model) exceeding what a single local Ollama instance can serve, every cycle, regardless of
   cooldown duration.

**Classification for §20 (code defect vs. resiliency gap)**: this is a genuine
**RESILIENCY_GAP** — not the specific "missing await" or "bypassed check" the mission speculated
might exist (no such bypass was found; every dispatch site does call `filterRoutableProviders`
before attempting) — but a structural gap: **no per-provider concurrency limit**, combined with
**no consecutive-failure escalation**, together mean that once call volume exceeds what a 60-second
flat cooldown can absorb for a given cycle's fan-out, the provider gets hit by a fresh full-strength
wave every cycle, indefinitely, with no mechanism that ever says "this has failed too many times in
a row, back off further" or "too many requests are already in flight to this provider, queue/defer
the rest instead of sending them."

### 10. Fallback routing — reconstructed real Oct-7 examples

Query: `ai_calls` grouped by `(trace_id, agent)` where ≥2 distinct providers were attempted within
the same trace, ordered by provider-call sequence. Five real examples (all post-15:00 UTC):

1. **MarketRegimeAgent**, trace `tu6tsj`: Gemini (error, 17:59:36.437) → OpenRouter `7882d1ad`
   (error, .678) → OpenRouter `72a7de39` (error, .735) → Claude (error, 17:59:37.048) → OpenAI
   (error, .600) → **Ollama (error, 18:00:08.165)**. 6 providers tried, **0 succeeded**. Elapsed:
   ~31.7 seconds (dominated almost entirely by the final Ollama attempt's ~25s+ hang; the first 5
   remote attempts failed near-instantly on quota/auth/billing, consuming well under 1 second
   combined).
2. **MarketRegimeAgent**, trace `9t1wui`: Gemini → OpenRouter → OpenRouter → LiteLLM Gateway, all 4
   error within ~2 seconds (17:29:09.150–17:29:11.235) — a case where even fallback itself
   terminated fast because every candidate failed instantly (not a timeout-dominated case).
3. **MacroAgent**, trace `trace_AMD_1791392290_9b76`: Gemini → OpenRouter `7882d1ad` → Kimi →
   OpenRouter `72a7de39`, all 4 error within ~2.6 seconds (16:58:10.885–16:58:13.465) — same
   pattern, fast-failing remotes only, Ollama apparently not reached in this particular sequence
   (ordering/priority-dependent).
4. **BullResearcher** and **BearResearcher**, same trace `trace_ARM_1791395974_d540` (two
   independent agents evaluating the same idea): both sequences start with **Ollama failing first**
   (18:00:08.068/.074) then fall through Gemini → OpenRouter → OpenRouter, all still erroring, total
   elapsed ~2.8s after the Ollama attempt — illustrating that when Ollama is tried *first* (its
   priority-3 slot ranks ahead of most remotes when "healthy" in DB stats), its ~25s hang is paid
   before the fast-failing remainder even starts.
5. **BearResearcher/BullResearcher**, trace `trace_BAC_1791392286_cddc`: Gemini → OpenRouter →
   Kimi → OpenRouter, 4 providers, all error, ~2.6s total — fallback genuinely iterating across
   distinct providers, not just retrying the same one.

**Direct answer to the mission's question (§6/§9 of the original mission list): YES, fallback runs
after a timeout** — the sequential `for (const [providerId, provider] of availableProviders)` loop
in `routeTask()` (line 1076 onward) does iterate to the next provider on every failure class,
confirmed by 5 concrete, multi-provider, cross-provider-type real examples above. **`AI_FALLBACK` is
best classified `PARTIAL`**: the mechanism itself works correctly — it is not silently stuck on one
dead provider — but on Oct 7, in the overwhelming majority of real attempts, *every single
candidate in the fallback chain* was simultaneously unhealthy (§3: 8 of 10 providers at or near
0% success all day), so fallback exhausting its list and still failing was not a routing bug, it
was the honest, fail-closed result of an entirely degraded provider pool.

### 11. Time-budget interaction — does the first timeout consume the fallback's budget?

Read directly from code (line 1076–1113): `routeTask()`'s `for` loop awaits each provider
**sequentially**, and each iteration gets **its own fresh, full timeout** —
`resolveHardCapMs(providerRow)` returns `OLLAMA_HARD_TIMEOUT_MS` (25,000ms,
`aiModels.ollamaHardTimeoutMs`) for a local-endpoint provider row or `RESEARCH_TIMEOUT_MS`
(8,000ms, `aiModels.researchTimeoutMs`) for every remote — there is **no shared outer deadline**
across the whole fallback chain and **no budget subtraction** from one attempt to the next (`const
totalTimeoutMs = hardCapMs;` at line 1112 is per-attempt, re-derived fresh every loop iteration).
**So the first timeout does NOT structurally starve the fallback attempts of time budget** — each
subsequent provider gets its full nominal timeout regardless of how long the previous one took.
The real cost is **elapsed wall-clock latency stacking**, not budget truncation: example 1 above
shows ~31.7 total seconds for one MacroAgent/MarketRegimeAgent call because Ollama's ~25s hang
happened to be in the chain, on top of the other 5 providers' failures — none of which failed
because they ran out of time, they failed because each independently returned a real error
(quota/billing/429) almost instantly. `routeConsensus()` (the `ConsensusDebate` fan-out) is
architecturally different and avoids this entirely: it dispatches to its (capped at
`consensusMaxProviders`=2) candidate providers via `Promise.all` — genuinely parallel, each with
its own independent timeout, so a slow Ollama participant never blocks a faster Gemini/NVIDIA
participant in the same debate round; this matches CLAUDE.md's own description of ChiefTrader's
"fans out to multiple providers in parallel." The *stacking* problem only exists in the
sequential `routeTask()` path used by MacroAgent/BullResearcher/BearResearcher/MarketRegimeAgent/
QuantContradictionAnalyzer — not in `routeConsensus()`.

### 12. Retry amplification

Per-agent-per-hour call volume to Ollama specifically (§9's burst data, extended): MacroAgent,
BullResearcher, and BearResearcher together accounted for 235 of 246 Ollama attempts in one
10-minute window (95.5%), each representing **a different symbol's evaluation cycle**, not retries
of the same idea — confirmed because each has a distinct `trace_id`. This is not classic
"retry amplification" (the same failed request being resent in a tight loop) — it is **concurrent
fan-out amplification**: Argus's own per-cycle design (many symbols × 3 AI-dependent agents, same
tick) multiplies a single unhealthy provider's load by however many symbols are being evaluated
that cycle, every cycle, with no per-provider concurrency ceiling to cap it. Hourly volume to
Ollama specifically: 13–23/hour before 14:00 (healthy baseline range), jumping to 243 (14:00),
863 (15:00), then sustaining 1,044–1,551/hour for every hour from 16:00 through 21:00 — a
**~70–100x** increase in call volume to the same already-failing provider, with success counts of
0–4 per hour throughout that entire sustained-high-volume period.

### 13. Local Ollama health — what the evidence proves, not more

Available evidence (strictly from `ai_calls.latency_ms` and `.error`, no separate Ollama-side log
accessible in this read-only pass — **stated explicitly rather than speculated**): (a) real
observed latencies on eventual *successes* through this provider averaged 10,555ms (vs. presumably
sub-second for a warm, unloaded local model) with P95/P99 of 34,189/41,905ms — i.e. even the
calls that eventually succeeded were often extremely slow; (b) 246 explicit `503 "server busy ...
maximum pending"` responses are direct, first-party evidence of queue saturation, not inferred;
(c) timeout latencies averaged 37,443ms (up to 112,038ms) — well past the 25s abort, meaning the
in-flight HTTP request kept the socket open and consuming resources for 1.5–4.5× the nominal
timeout before `AbortController` tore it down. This is consistent with (not proof of, since no
process-level CPU/memory/GPU metrics are available from this DB) a genuinely overloaded local
inference server receiving far more concurrent requests than it can serve — not a clean fast-fail
(e.g. connection refused) and not evidence of the Ollama process being deadlocked/crashed, since it
continued returning both successes (49 of them) and explicit 503s throughout the day rather than
going permanently silent.

### 14. Event-loop / resource correlation

A full re-run of the concurrent strategy-evaluation volume driving this (e.g.
`QUANT_ASSESSMENT_COMPLETED`/`TECHNICAL_ANALYSIS_COMPLETED` per-15-minute correlation against the
AI-call collapse curve) was **not completed with a dedicated join query in this pass** — time
budget. What IS established without that join: the main audit's own §6 already shows
`TECHNICAL_ANALYSIS_COMPLETED` (41,790) and `QUANT_ASSESSMENT_COMPLETED` (15,695) at whole-day
scale, and this section's §12 independently shows the AI-call volume spike to Ollama specifically
beginning at 14:00–15:30 UTC — the same window as the first process boots and market open. The
most defensible, evidence-consistent statement: **the AI-call collapse is correlated with, and very
plausibly caused in large part by, Argus's own concurrent per-cycle fan-out scaling up once the
market-hours symbol universe became active** (matching §9's mechanism finding directly), rather
than being a pure "external dependency went down for unrelated reasons" event — Argus's own load
pattern is a real contributor, not merely a victim of an external outage. This is `INFERRED` from
timing correlation across sections of this same report, not independently re-proven with a fresh
joined query in this specific pass.

### 15. Before/after comparison — attempted, materially limited by data

A real before/after split at 14:00 UTC was run against `CONSENSUS_TERMINAL_REASON` directly: **zero
`CONSENSUS_TERMINAL_REASON` rows exist before 14:00 UTC on Oct 7** (consistent with the main audit's
§4 finding that the first process boot of the day was 14:18:52 UTC — there was no consensus
activity at all pre-boot). **This means a true "healthy baseline vs. degraded period" comparison
cannot be constructed from today's data alone** — there is no healthy consensus-participation period
on 2026-10-07 to compare against; the entire day's consensus activity (16,780 rounds) occurred
during the AI-provider-degraded window. This is a materially important limitation, stated plainly:
**today's data cannot show what Argus's consensus participation rate looks like when AI providers
are healthy**, because they were never healthy today. Whatever baseline exists would have to come
from a different, earlier day's `ai_calls`/`CONSENSUS_TERMINAL_REASON` history — out of scope for
"Oct 7" as named in this mission, not pursued here.

### 16. Counterfactual structural analysis (real counts, no invented votes)

Direct tally over all 16,780 `CONSENSUS_TERMINAL_REASON` rows today, bucketing each round by how
many **directional** (`confidence > 0`) agents actually participated and whether those agents
*agreed* on side:

| Bucket | Count | % | Terminal reasons seen |
|---|---|---|---|
| **Zero directional voices** | 631 | 3.8% | — |
| **STRUCTURALLY_UNABLE_TO_REACH_MIN_INDEPENDENCE** (exactly 1 directional voice — mathematically cannot satisfy `minIndependentAgreeingAgents: 2` regardless of confidence) | **10,931** | **65.1%** | `CONFIDENCE_BELOW_STRONG` 10,896; `MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE` 31; `INSUFFICIENT_AGENT_PARTICIPATION` 3; `AGENT_HOLD` 1 |
| 2+ directional voices, but **disagreeing** (no 2 agents on the same side) | 3,977 | 23.7% | (included within `CONFIDENCE_BELOW_STRONG`-dominated remainder below) |
| **ENOUGH_AGENTS_BUT_CONFIDENCE_LOW** (2+ agents agreeing on the same side, still rejected) | **1,241** | **7.4%** | `CONFIDENCE_BELOW_STRONG` (effectively all of them) |

For the 1,241 rounds in the last bucket — the only rounds all day where the independence
requirement was genuinely satisfiable and satisfied — real `finalConfidence` ranged **0.188 to
0.685** (avg 0.464); **zero** rounds reached ≥0.70, only 14 reached ≥0.60. **Even in the single
most favorable real subset of today's data, confidence never once reached the 0.75 bar** — the
closest approach all day was 0.685.

### 17. Reclassified consensus terminal reasons (whole day, real counts)

| Bucket | Count | % |
|---|---|---|
| `ONLY_ONE_DIRECTIONAL_AGENT` (= STRUCTURALLY_UNABLE, §16) | 10,931 | 65.1% |
| `MULTIPLE_AGENTS_DISAGREED` | 3,977 | 23.7% |
| `MULTIPLE_AGENTS_AGREED_BUT_LOW_CONFIDENCE` | 1,241 | 7.4% |
| `AI_AGENT_UNAVAILABLE` / `ZERO_DIRECTIONAL_VOICE` | 631 | 3.8% |
| `CALIBRATION` (`MODERATE_REJECT_CALIBRATION`) | 11 | 0.07% |
| `OTHER` (`INSUFFICIENT_AGENT_PARTICIPATION`, folded `MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE` not already counted above) | ~3 | ~0.02% |

(Rows sum to the day's 16,780 `CONSENSUS_TERMINAL_REASON` total, with `MODERATE_REJECT_
INSUFFICIENT_INDEPENDENCE`'s 34 occurrences already folded into the one/multiple-voice buckets
above by directional-count, not double-counted separately.)

### 18. True primary cause — quantified contribution

- **(A) Consensus mathematically too strict despite healthy evidence supply**: tested directly by
  §16's 1,241-round subset where evidence supply genuinely was sufficient (2+ agreeing independent
  agents) — confidence still topped out at 0.685. This subset is only 7.4% of the day's rounds, and
  even within it, the threshold was never nearly cleared by a wide margin (closest miss 0.065 below
  the bar) — so (A) has limited, non-zero support (0.685 is close to 0.75), but it cannot be
  isolated as "the" cause because the sample it's drawn from is itself a small, non-representative
  slice of a day that never had healthy evidence supply overall.
- **(B) Evidence supply collapsed because AI providers were unhealthy**: directly supported by
  65.1% of all rounds (`ONLY_ONE_DIRECTIONAL_AGENT`) being structurally incapable of ever reaching
  consensus regardless of confidence math, driven by MacroAgent/BullResearcher/BearResearcher/
  ConsensusDebate success rates of 0.3–3.3% (§4) traced directly to 8 of 10 AI providers at ~0%
  success all day (§3) for independent reasons (quota, billing, dead endpoint, rate-limit, local
  overload).
- **(C) Both, with (B) dominant and prior in the causal chain**: **quantified verdict** — (B)
  structurally accounts for 65.1% of rounds outright (one-voice rounds can never test the 0.75
  question at all), a further 23.7% (disagreement) is *plausibly* evidence-quality-related but not
  provably so without knowing what a healthy Macro/News/Debate voice would have said, and only the
  remaining 7.4% is a genuine, fair test of the 0.75 threshold itself — and in that fair test, the
  threshold was never cleared but came within 0.065 of being cleared on the best round. **Primary
  cause is (B): AI-provider evidence-supply collapse. (A) is not ruled out as a secondary
  contributing factor given how close the 7.4% subset's best case came, but it cannot be
  independently measured as "the" cause until (B) is fixed and a healthy-evidence baseline exists
  to test it against fairly** — exactly the operator's own stated constraint.

### 19. Was 0.75 actually the problem? (structural-availability answer only)

**If AI-dependent agents (Macro/News/Bull/Bear/ConsensusDebate) had simply been available and
producing ordinary valid outputs** (not assuming any particular direction — a pure
availability-only counterfactual), the 65.1% of rounds that today had only one directional voice
would, in many cases, have had a second real independent voice to evaluate against. This does
**not** mean those rounds would have agreed or cleared 0.75 — §16's own 1,241-round "fair test"
subset shows that even genuine 2-agent agreement topped out at 0.685 — but it does mean **far more
rounds would have had the structural opportunity to even attempt clearing it**, which is a
necessary (not sufficient) condition the real data shows was absent for 65.1% of the day outright.

### 20. Code defect vs. resiliency gap — classification

**RESILIENCY_GAP**, not CODE_DEFECT, not CONFIGURATION_PROBLEM alone. Reasoning: no bypassed check,
no missing `await`, no race condition was found in `filterRoutableProviders`/
`noteProviderSkipFromError`/the dispatch loops — every call site does check cooldown state before
dispatching, exactly as designed (confirmed by direct code read, §6–8). The real gap is a missing
capability, not a broken one: **(1) no per-provider concurrent-request ceiling**, so N symbols ×
3 AI-dependent agents in one cycle can simultaneously pile onto the same already-struggling local
Ollama instance regardless of how well the sequential cooldown behaves between cycles, and **(2) no
consecutive-failure escalation**, so a provider that has failed 100 times in a row is retried on
the exact same schedule as one that has failed once. Both are real, provable, numbers-backed gaps
(§9, §12) — but they are gaps in robustness/design-for-failure, not logic errors in the code that
exists. Separately, OBSERVABILITY_GAP also applies: `AIProviderHealthCheck.ts`'s own header admits
its consecutive-failure tracker is deliberately not wired into live routing (§8) — a real-time
operator dashboard exists for provider health (see §21) but it is diagnostic-only, not
routing-informing.

### 21. Expected robust design — present/absent inventory

| Capability | Present? | Citation |
|---|---|---|
| Consecutive-timeout tracking | **Partial** — tracked in `AIProviderHealthCheck.ts`'s `tracker.consecutiveFailures`, but explicitly NOT consulted by `AIRouter.ts`'s routing/cooldown decisions (file header, lines 9–13) | `AIProviderHealthCheck.ts:67-76` |
| Exponential/escalating cooldown | **Absent** — flat `now + cooldownMs` every time, confirmed by code (§8) | `AIRouter.ts:446-456` |
| Half-open probe / gradual re-entry | **Absent** — a provider is either fully blocked (`skipUntil > now`) or fully open; no reduced-traffic probe state | `AIRouter.ts:499-509` |
| Circuit breaker (explicit state machine: closed/open/half-open) | **Absent** — only a binary time-gated skip map, no named circuit states | n/a |
| Provider latency EWMA | **Present** (success path only) — `newLatency = (prevLatency*9 + latency)/10` | `AIRouter.ts:1159` |
| Agent-level timeout budget (shared across fallback attempts) | **Absent** — each fallback attempt gets its own full fresh timeout (§11) | `AIRouter.ts:1076-1113` |
| Fallback budget reservation | **Absent** — no mechanism reserves remaining time for later candidates | n/a |
| Max concurrent calls per provider | **Absent** — no such gate found anywhere in `AIRouter.ts` | n/a (confirmed absent by code read) |
| Queue/backpressure limits on outbound AI calls | **Partial** — `allowAiCall()`/`pipelineRateLimit` exists as a *global* per-minute cap (checked at `routeTask()` entry, line 981), but it is not per-provider and does not prevent many different symbols' calls from all targeting the same single struggling provider simultaneously | `AIRouter.ts:981-992`, `core/pipelineRateLimit.ts` (not independently re-read line-by-line in this pass) |
| Provider health observability surface | **Present** — `AIProviderHealthCheck.ts`'s `getAIProviderHealthSnapshot()` / `getProviderRoutingSnapshot()` expose configured/registered/authenticated/status/latency/consecutiveFailures/lastError per provider | `AIProviderHealthCheck.ts:210-270`, `AIRouter.ts:348-356` |

**Direct answer to the mission's §14 (observability gap)**: a real, present provider-health
surface exists (`AIProviderHealthCheck.ts` + `AIRouter.getProviderRoutingSnapshot()`) and does
expose success rate (via DB `success_rate`), consecutive failures, last success/failure, and
latency per provider — this is **not** an observability gap in the sense of "nothing exists."
What IS a gap: that diagnostic signal is deliberately isolated from the live routing decision
(§8, §20) — an operator watching the health matrix today would have seen Ollama/Mistral/Kimi/
OpenRouter/OpenAI clearly unhealthy in real time, but `routeTask()`/`routeConsensus()` would have
kept dispatching to them anyway on the flat schedule regardless.

### 22. Safety requirement — restated, not violated here

No recommendation in §23 below proposes, implies, or would require lowering `consensusApprovalThreshold`
(0.75), reducing `minIndependentAgreeingAgents` (2), weakening evidence independence, or
auto-approving/synthesizing a fallback vote when a real agent is unavailable. Every remediation
candidate below targets **evidence-source availability and router resilience only** — the
layer upstream of consensus math — consistent with the operator's own final principle. This
read-only pass changed nothing; recommendations are proposals for a separate, future implementation
pass, explicitly not acted on here.

### 23. Possible future remediation (recommend only — no code written)

1. **Per-provider concurrency ceiling** (e.g. `maxConcurrentCallsPerProvider`, config-driven, not
   hardcoded per CLAUDE.md's own rule) — directly targets §9/§12's confirmed mechanism: cap how
   many simultaneous in-flight requests one cycle's fan-out can send to a single provider id,
   queuing or fast-failing the excess to a different provider instead of letting all of them
   independently hang.
2. **Consecutive-failure escalating cooldown** — wire `AIProviderHealthCheck.ts`'s already-tracked
   `consecutiveFailures` (currently diagnostic-only, §20) into `AIRouter.ts`'s cooldown duration:
   e.g. cooldown scales with consecutive-failure count up to a bounded ceiling, so a provider
   failing its 50th time in a row backs off meaningfully longer than one failing its 1st time,
   without ever becoming a permanent ban (half-open re-entry still allowed).
3. **Local-provider saturation detection** — specifically treat Ollama's own `503 "server busy /
   maximum pending"` response (§3, 246 real occurrences) as a distinct, named signal (not folded
   into the generic 5xx/`isUnreachableProviderError` bucket) that should trigger a measurably
   longer cooldown than a generic 503, since it is first-party evidence of self-reported overload
   rather than ambiguous transient failure.
4. **Fallback-chain time awareness** (optional, lower priority than #1/#2 given §11 shows this is
   a latency-stacking problem, not a correctness problem) — e.g. trying fast-failing remote
   candidates before a known-slow local model in the per-agent priority order, so a 25s local hang
   isn't paid before 5 near-instant remote rejections are tried, shaving ~25s off the worst-case
   per-call latency without touching which provider is ultimately used.
5. **Provider latency/health-aware routing order** — `routeTask()`'s existing DB-stats sort
   (health/successRate/latency, lines 1004–1019) already exists; extending it to also weight in
   `AIProviderHealthCheck.ts`'s live `consecutiveFailures`/`status` (currently unused by routing per
   §20) would let routing order itself reflect real-time health, not just historical DB aggregates
   that can lag.
6. **Operator-facing provider health dashboard surfacing routing-relevant state** —
   `getProviderRoutingSnapshot()` already returns `skipUntil`/`authDisabledUntil` per provider
   (§21); a visible panel showing "N providers currently in cooldown, next reopen at T" would make
   today's situation immediately diagnosable without a DB forensic pass.
7. **Fast health probe before a full dispatch** (e.g. a cheap `HEAD`/ping-style check before
   committing a full chat-completion call) — lower priority; §3's evidence shows most remote
   failures (429/402) already fail fast on their own, so the marginal benefit is mostly for the
   Ollama case, which overlaps heavily with #1/#3 above.

None of the above changes consensus math, confidence thresholds, independence requirements, or
introduces any synthetic/fabricated vote — all operate strictly on the evidence-supply layer, per
§22's constraint.

### Revised verdict (this section)

```
AI_PROVIDER_HEALTH = SEVERELY_DEGRADED
AIROUTER_TIMEOUT_HANDLING = INSUFFICIENT
AI_FALLBACK = PARTIAL
AI_AGENT_AVAILABILITY = COLLAPSED
CONSENSUS_EVIDENCE_SUPPLY = STARVED
CONSENSUS_075_THRESHOLD = NOT_PROVEN_TOO_STRICT
PRIMARY_ZERO_TRADE_ROOT_CAUSE = AI-provider evidence-source collapse (8 of 10 configured providers
  at or near 0% success all day, for independent reasons: billing/quota exhaustion, rate-limiting,
  a dead local gateway endpoint, and local-model overload) starved 65.1% of all 16,780 consensus
  rounds down to a single directional voice, which is structurally incapable of satisfying the
  minIndependentAgreeingAgents=2 floor regardless of confidence value. Only 7.4% of rounds ever
  reached a fair test of the 0.75 confidence bar, and even in that subset confidence topped out at
  0.685 - close to, but never at, the threshold.
CONFIDENCE_BELOW_STRONG = BOTH (downstream SYMPTOM for the 65.1%+23.7% of rounds that never had a
  fair chance to test the threshold; a weak but real ROOT_CAUSE signal in the 7.4% subset that did
  have a fair test and still fell short by 0.065)
REAL_CODE_DEFECT = NO - classified RESILIENCY_GAP, not CODE_DEFECT: every cooldown/filter check in
  AIRouter.ts executes exactly as written (no bypassed check, no missing await, no race found);
  the gap is an absent capability (no per-provider concurrency ceiling, no consecutive-failure
  escalation), not a broken one.
```

### Answers to the operator's 18 final questions

1. **Why did plutus receive thousands of calls while timing out?** Because MacroAgent/
   BullResearcher/BearResearcher each default-route to the same single Ollama provider id, and
   every strategy-evaluation cycle fans out across many symbols concurrently with no per-provider
   concurrency ceiling (§9/§12) — a 60-second cooldown between cycles cannot prevent a fresh
   within-cycle burst from re-saturating an already-overloaded local model.
2. **Does a timeout trigger provider cooldown?** Yes — `isTimeoutSkipError` →
   `skipProviderTemporarily(…, 60000, …)`, confirmed by code (§6-7) and by the bursty (not
   continuous) real call pattern (§9).
3. **After how many timeouts?** After the first one, every time — no escalation with repetition;
   the Nth consecutive timeout arms exactly the same 60-second cooldown as the 1st (§8).
4. **How long is cooldown?** 60,000ms (`aiProviderTimeoutSkipCooldownMs`) for a timeout; 300,000ms
   for a generic unreachable/5xx/rate-limit; 1,800,000ms for quota/billing-suspended/model-not-found.
5. **Does cooldown actually exclude the provider?** Yes, for new dispatches issued after it's
   armed — confirmed by the real bursty gap pattern (§9) — but it cannot retroactively stop calls
   already in flight from a concurrent fan-out issued in the same instant.
6. **Does fallback run after a timeout?** Yes — confirmed with 5 concrete real multi-provider
   sequences (§10); the sequential loop in `routeTask()` genuinely iterates to the next provider.
7. **Does the first timeout consume the fallback's total time budget?** No — each fallback
   candidate gets its own fresh, full timeout (§11); the cost is wall-clock latency stacking
   (e.g. ~32s for one call chain that happened to include Ollama), not a shared/shrinking budget.
8. **Why did AI failures approach 100% during regular trading?** Because 8 of 10 configured
   providers were independently near-0%-success all day (billing exhaustion, rate-limits, a dead
   LiteLLM endpoint, local overload) — once Argus's own call volume scaled up with the market-hours
   symbol universe (§14), nearly every dispatch landed on one of these already-broken providers.
9. **Why did MacroAgent produce almost no directional evidence?** Its AI call success rate was
   0.3% (12 of 3,735, §4) — nearly every attempt failed before producing a parseable decision, so
   it almost never contributed a confidence>0 vote.
10. **Why did NewsAgent contribute no consensus evidence?** It made only 19 AI calls all day
    (0 successes) — it rarely reached its AI-analysis step, consistent with the Addendum's original
    finding; not independently root-caused further in this pass (a candidate for separate
    follow-up, since 19 attempts is itself unusually low volume compared to Macro/Bull/Bear).
11. **Were Bull/Bear/Debate unavailable mainly because of provider failure?** Yes — 1.0%/3.3%/1.2%
    success rates (§4) trace directly to the same provider-pool collapse (§3), not to any logic
    change in those agents themselves.
12. **How many consensus rounds had only one directional voice?** 10,931 of 16,780 (65.1%) (§16).
13. **How many were structurally unable to satisfy independence?** The same 10,931 (65.1%) — one
    directional voice can never satisfy `minIndependentAgreeingAgents: 2` (§16).
14. **How many had sufficient participation but genuinely low confidence?** 1,241 (7.4%) — 2+
    agents agreeing on side, still below 0.75, max observed 0.685 (§16).
15. **Is 0.75 actually demonstrated to be too high?** No — `NOT_PROVEN_TOO_STRICT`. The only fair
    test sample (7.4% of rounds) never cleared it, but came within 0.065 on its best round; this is
    too small and non-representative a sample (drawn from an entirely evidence-degraded day) to
    judge the threshold itself (§16, §19).
16. **Or did the evidence supply fail before that question could be fairly answered?** Yes — for
    92.6% of today's rounds (65.1% one-voice + 23.7% disagreement, though disagreement is not
    conclusively evidence-failure), the threshold question was never even reachable on fair terms
    (§16-19).
17. **Is the main problem provider health, router resilience, agent design, or consensus math?**
    Primarily **provider health** (8/10 providers near-0% for independent, non-Argus-caused
    reasons: billing, rate-limits, a dead endpoint) **compounded by a router resilience gap** (no
    concurrency ceiling, no escalating cooldown, §9/§20) that let Argus's own concurrent fan-out
    repeatedly re-saturate the one provider (Ollama) that was at least partially Argus-side-fixable.
    Agent design and consensus math are not shown to be the primary problem by this data.
18. **What is the single highest-priority remediation?** **Per-provider concurrency ceiling**
    (§23 item 1) — it directly targets the one confirmed, Argus-controllable mechanism (§9) that
    let a single local model get hit by dozens of simultaneous requests every cycle, and is a
    prerequisite for the consecutive-failure-escalation improvement (#2) to even matter (escalating
    a cooldown is pointless if concurrent same-cycle calls bypass it by already being in flight).

---

**Closing note for this section**: this pass confirms the Addendum's suspicion
("AIRouter/provider-health handling is suspected as the mechanism permitting the collapse to
persist") but narrows and corrects it: the cooldown mechanism itself is not broken or bypassed —
it is real, present, and fires exactly as coded. The actual gap is the *absence* of a
concurrency ceiling and a failure-escalation mechanism, not a defect in the mechanism that exists.
Equally important, and new in this pass: the provider pool was not "one slow local model with
everything else healthy" — it was 8 of 10 configured providers independently failing for 8
unrelated external reasons (billing, quota, rate-limits, a non-running local gateway) at the same
time, which no amount of AIRouter-side cooldown tuning alone would have fixed. **Per the operator's
explicit, standing instruction: the 0.75 consensus threshold must not be revisited until evidence
supply is fixed and a healthy-period baseline exists — this pass found no basis to override that
instruction, and reinforces it (§16-19).**
