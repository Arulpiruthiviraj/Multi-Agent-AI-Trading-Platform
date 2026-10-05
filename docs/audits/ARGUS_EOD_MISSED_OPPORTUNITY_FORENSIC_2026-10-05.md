# ARGUS — October 5, 2026 End-of-Day Missed-Opportunity Forensic, External Benchmark, and Quant Redesign Audit

**Mode:** read-only forensic analysis. No code, config, thresholds, weights, or gates were changed while producing
this report. PAPER only. `LIVE_NO_GO` unaffected throughout.

## Executive summary

**Amended 2026-10-05 (post-publication correction — see Section 10–14 below for full detail).** The original
version of this report claimed stale `gapEvidence` reference timestamps caused PTC's and CSCO's SPREAD
rejections. That claim was traced against the actual source code and found to be **incorrect** — it has been
retracted, not merely footnoted. The real findings, corrected:

Argus produced zero trades today. This is **not** a single-cause story. Real, external-benchmark-backed evidence
shows at least three independent, genuine findings, each affecting a different part of the pipeline:

1. **RETRACTED — was not a data-staleness defect.** PTC's and CSCO's wide `spreadBps` figures (1206bps,
   845bps) are real bid/ask spreads computed purely from Alpaca's IEX-only top-of-book quotes — tracing
   `MarketUniverseScanner.ts` shows the spread formula never touches `gapEvidence`'s reference-price fields.
   **Corrected classification: `DATA_SOURCE_LIMITATION`** (IEX-only quotes can show venue-specific wide
   spreads in volatile early moments even when the true NBBO spread is tighter), not a code defect.
   **The real, confirmed finding for PTC is a subscription hot-swap capacity/prioritization issue** — see
   `docs/audits/ARGUS_SUBSCRIPTION_STARVATION_FORENSIC_2026-10-05.md`.
2. **A real catalyst-ingestion gap for at least one major benchmark mover.** PCVX (Vaxcyte, Phase 3 VAX-31,
   premarket, +32–54%) never produced a single `NEWS_*` event anywhere in Argus's logs today, unlike PTC,
   TSLA, CSCO, and META, which all got real `NEWS_CATALYST` events. Confirmed narrower: zero raw
   `news_articles` rows exist for this story at all (out of 233 ingested today), so the gap is **upstream of
   entity/ticker extraction and classification** — the article itself never arrived via any configured
   source this pass could verify.
3. **A real, decisive, independently-confirmed consensus bottleneck, unrelated to the reconciliation pause.**
   4,427 real consensus rounds occurred today. **Zero were approved.** The single highest confidence any
   symbol reached all day was **0.70 against a 0.75 threshold** (CAT, TSLA), and even that near-miss had
   `agreements_count: 1` — only one truly independent agent's evidence, never enough to clear the
   minimum-independence bar regardless of raw confidence. **RiskEngine was never reached today (0
   assessments) — it is conclusively not the bottleneck.**

None of today's headline movers (PTC, RXO, XP, PCVX, NVDA) represent a case of "Argus saw a clear winner and
RiskEngine or OMS blocked it." The real story is upstream: a discovery-to-challenger-eligibility latency
issue (PTC — see `ARGUS_ADMITTED_TO_CHALLENGER_FORENSIC_2026-10-05.md` for the full trace and MPWR's more
severe control case), a news-ingestion coverage gap (PCVX), and — for every symbol that *did* get a fair look (XP, TSLA, META, NVDA)
— evidence that never became strong or independent enough to approve.

## Section 1 — Current system state (frozen before analysis)

- `git rev-parse HEAD`: `bdc51cb` (same commit as this afternoon's reconciliation fix), clean working tree
  except this report's own new file.
- `tradingMode: PAPER`, `selectedBroker: IBKR Gateway (Socket)`, `budget: $10,000`, `maxTradeSize: $3,000`.
- `QUANT_ENGINE_ENABLED=true`. Consensus threshold confirmed from real data below: **0.75** (not assumed).
  Minimum independent agents: 2 (confirmed structurally — see §Consensus below).
- None of these were touched while producing this report.

## Section 2–3 — Audit window and external benchmark

Regular session 09:30–16:00 ET; premarket 04:00–09:30 ET inspected separately where evidence allowed.
External benchmark built from live web search (Reuters/Yahoo Finance/Seeking Alpha/TradingView/SEC filings/
company press releases — sources listed per item below), not from Argus's own candidate list.

**Cohort A (liquid/investable, real catalysts):**

| Symbol | Move | Catalyst | Catalyst timing |
|---|---|---|---|
| PTC | ~+33–34% | Schneider Electric to acquire for $205/share cash ($22.6B), 42.3% premium | Media reports surfaced Sunday Oct 4; Schneider confirmed premarket Monday |
| RXO | ~+22%+ | C.H. Robinson to acquire for $17.25 cash + 0.0856 CHRW shares (~$30.25/share implied), $5.8B deal | Announced premarket Monday |
| PCVX (Vaxcyte) | ~+32–54% (sources vary by measurement point) | Phase 3 VAX-31 (OPUS-1) met all primary non-inferiority endpoints vs. Prevnar 20/Capvaxive | Published premarket |
| XP | ~+33% | Brazil presidential election first round — Flávio Bolsonaro ~47% vs. Lula ~45.2%, runoff Oct 25; broad Brazilian-asset repricing (Bovespa +8%, real +4%+) | Election result known overnight/premarket |
| NVDA | New all-time closing high (~$237), Nasdaq record close +0.7–1% | Broad AI/tech rally, no single discrete catalyst | Intraday, sustained all session |
| TER, SPCX(?), MPWR, ARM, RKLB, TSLA, CSCO, META, MSFT | Nasdaq-100 gainers, +1% to +8% | Broad tech/AI rally | Intraday |

**Cohort B (absolute movers, likely outside Argus's intended liquidity/risk mandate):** Capricor Therapeutics
(CAPR) +57.96%, Eton Pharmaceuticals (ETON), Evolution Metals & Technologies (EMAT) — microcap biotech/
speculative names. Not treated as misses per the user's own framing.

*Sources: [Yahoo Finance — Schneider/PTC](https://finance.yahoo.com/technology/articles/schneider-electric-acquire-ptc-205-180219993.html), [SEC 8-K PTC](https://www.sec.gov/Archives/edgar/data/0000857005/000119312526413124/d174191dex991.htm), [GuruFocus — C.H. Robinson/RXO](https://www.gurufocus.com/news/9109268/ch-robinson-chrw-announces-58b-acquisition-of-rxo-inc-combining-logistics-networks), [SEC 8-K RXO](https://www.sec.gov/Archives/edgar/data/0001929561/000114036126038548/ef20083265_ex99-1.htm), [GuruFocus — Vaxcyte Phase 3](https://www.gurufocus.com/news/9109649/vaxcyte-pcvx-shares-surge-54-on-strong-phase-3-vax31-data), [GuruFocus — XP/Brazil election](https://www.gurufocus.com/news/9109762/brazils-presidential-election-boosts-xp-inc-xp-shares-by-33-on-october-5-2026), [Benzinga — XP](https://www.benzinga.com/etfs/emerging-market-etfs/26/10/62175857/xp-stock-best-day-ever-brazil-election-bolsonaro), [Yahoo Finance — Nasdaq/Nvidia record](https://finance.yahoo.com/markets/live/stock-market-today-dow-sp-500-nasdaq-rise-as-tech-rallies-investors-shrug-off-bond-market-caution-081220790.html), [FinanceCharts — small-cap gainers](https://www.financecharts.com/screener/biggest-gainers-small-cap).*

## Section 9/41/42/43 — Not every winner was a defensible opportunity (pre-registered, confirmed)

- **PTC and RXO are M&A arbitrage situations**, exactly as hypothesized before checking logs. Deals were
  reported/confirmed premarket; both stocks gap toward (not through) deal value. A momentum strategy chasing
  the post-gap print would be taking poor asymmetric risk (upside capped near deal price, downside is full
  deal-break risk). **Argus correctly having no strategy that chases these is not itself a defect.**
- **PCVX is a biotech binary event.** The Phase 3 data was the entire catalyst; there was no "pre-data"
  decision point. The fair question (per the user's framing) is narrower: was there a defensible **post-open
  continuation** setup once the gap was already public? This audit could not fully reconstruct PCVX's
  intraday bar-by-bar structure (see Not Executed, below) — the DB evidence shows Argus never got far enough
  to test this because PCVX was essentially invisible to discovery (see below), so the question of whether
  a continuation strategy would have *fired* is moot; the real finding is upstream.
- **XP is a genuine macro/country-rotation move**, not a single-stock technical setup. It is the best test of
  whether Argus can propagate a macro catalyst to a theme/constituent basket (Brazilian ADRs) rather than
  discovering XP cold on price alone — see Section "Macro/Cross-Asset Discovery" below.

## Argus discovery/subscription/evaluation trace (real counts, full trading day)

| Symbol | Admitted (count) | Subscribed (ACK) | Quant-assessed | Ideas emitted | News ingested? |
|---|---|---|---|---|---|
| PTC | 88 | **0** | **0** | 0 | Yes — real cluster, premarket (08:16 ET) |
| RXO | 107 | 1 | **0** | 0 | Yes |
| PCVX | **1** | **0** | **0** | 0 | **No — zero news events found** |
| XP | 131 | 3 | 59 | **58** | No explicit NEWS_CATALYST found for XP itself |
| NVDA | 317 | 50 | 5,923 | 0 | Yes |
| TER | 51 | 6 | **0** | 0 | No |
| SPCX | 186 | 10 | 56 | 0 | Yes |
| MPWR | 76 | **0** | **0** | 0 | No |
| ARM | 65 | 22 | 1,241 | 0 | No |
| RKLB | 212 | 2 | 31 | 0 | No |
| TSLA | 278 | 51 | 5,641 | **2,162** | Yes |
| CSCO | 233 | 19 | 1,024 | 0 | Yes |
| META | 205 | 75 | 5,212 | **505** | Yes |
| MSFT | 322 | 53 | 5,539 | 0 | Yes (analyst-note cluster) |
| CAPR (Cohort B) | 0 | 0 | 39† | 0 | No |

†CAPR's 39 quant assessments come from an existing watchlist/legacy inclusion path independent of today's
discovery funnel — it was never discovered as today's mover.

**This table is the single most important artifact in this audit.** Every benchmark symbol with a real
catalyst reached discovery admission in large numbers (PTC 88x, RXO 107x, XP 131x) — **universe coverage is
not the problem.** The drop happens at **subscription** (PTC: 0 of 88 admissions ever got a live data
subscription; MPWR: 0 of 76) and then again sharply at **evaluation** (RXO subscribed once but was never
quant-assessed at all; PCVX barely discovered at all).

## Section 10–14 — Discovery, universe coverage, capacity

> **CORRECTION (2026-10-05, post-publication):** the claim below that stale `gapEvidence` reference
> timestamps caused the SPREAD rejections has been **retracted after tracing the actual code**. It was
> wrong. See the corrected finding immediately below, and
> `docs/audits/ARGUS_SUBSCRIPTION_STARVATION_FORENSIC_2026-10-05.md` for the real root cause of PTC's
> subscription loss (not a SPREAD/data problem at all — a hot-swap capacity/prioritization issue).

- **Universe coverage: not the bottleneck.** Every Cohort A symbol checked was in Argus's scan universe and
  was admitted by discovery, often dozens to hundreds of times across the day (re-evaluated on repeat scan
  cycles).
- **CORRECTED: the SPREAD rejections were real bid/ask spreads, not a stale-reference-data bug.**
  `MarketUniverseScanner.screenAssets()` computes `spreadBps` purely from Alpaca's reported bid/ask —
  `((ask - bid) / midpoint) * 10000` — and `evaluateScreen()` rejects purely on that value against a config
  ceiling. There is **no code path** where `gapEvidence`'s `previousClose`/`open` fields feed into the
  spread calculation; they are structurally separate fields that happened to appear in the same log line.
  The original version of this report incorrectly inferred a causal link between the two from that
  co-occurrence. **Corrected classification: `DATA_SOURCE_LIMITATION`, not a confirmed code defect.** PTC's
  1206bps and CSCO's 845bps most plausibly reflect genuine **IEX-only top-of-book** quotes (Alpaca's free
  tier, not full NBBO) during a volatile first few minutes after a major catalyst — thin venue-specific
  liquidity can show a wide spread on one exchange even when the true market-wide spread is tight. This is
  a real, known data-source limitation, not something to fix in Argus's own spread-calculation code.
  The stale `gapEvidence` reference-timestamp pattern is still real and still worth tracking (affects
  `gapPct`, not spread), but no evidence connects it to any rejection outcome.
- **Capacity — corrected and now root-caused, not speculative.** PTC was admitted 94 times and had its
  subscription promotion **rejected 263 times, every single one with the identical reason
  `SWAP_CAP_REACHED`** ("Hot-swap cap reached this cycle (1 slot(s)) before this candidate was reached").
  This is not a vague "prioritization gap" — it is a concrete, confirmed mechanism: the discovery scheduler
  allows only **one** hot-swap promotion per cycle, and PTC's `blendedHotSwapScore()` never ranked high
  enough to win that single slot against its competition, cycle after cycle, all day. Full forensic:
  `docs/audits/ARGUS_SUBSCRIPTION_STARVATION_FORENSIC_2026-10-05.md`.

## Section 15–17 — Market data, strategy coverage, trigger analysis

- Symbols that did get subscribed and quant-assessed (XP, NVDA, ARM, RKLB, TSLA, CSCO, META, MSFT, SPCX) were
  evaluated **thousands of times** in several cases (NVDA 5,923; TSLA 5,641; MSFT 5,539; META 5,212) — the
  strategy evaluation layer itself is working at high volume and genuinely looking at these names repeatedly
  all day, not ignoring them.
- `quant_assessments.emitted_trade_idea` was 0 for NVDA (5,923 assessments, zero ideas), MSFT (5,539, zero),
  CSCO, ARM, RKLB, SPCX, PTC, RXO, PCVX — for these, every single `DESK_NO_TRADE` sampled carries
  `code: "NO_ELIGIBLE_STRATEGY"`, `"Quant live emit requires a strategy idea that clears live EV and min R:R.
  Regime-only fallback is not a trade."` This is the strategy layer's own, repeatedly-applied, genuine
  judgment — not a data gap, not a bug — that these symbols' actual intraday structure never cleared its
  entry criteria on any of the 21 TS strategies' terms.
- XP, TSLA, and META are different: **58, 2,162, and 505 real trade ideas were emitted respectively.** These
  are the cases that matter most for the consensus/risk analysis below.

## Section 18–25 — Catalyst awareness and macro/cross-asset discovery

- **PTC, TSLA, CSCO, META, RXO, SPCX, MSFT**: real `NEWS_CATALYST`/`NEWS_CLUSTER_CREATED`/`NEWS_ANALYZED`
  events exist. Confirmed in `news_clusters`: *"Schneider Electric S.E. ... signed a definitive agreement to
  acquire PTC Inc. for $22.6 billion"* was clustered at **2026-10-05T12:16:51Z (08:16 ET)** — genuinely
  premarket, genuinely prompt. **Argus's news ingestion and catalyst clustering is real and working** for
  the stocks it covers.
- **PCVX: zero news events found anywhere in today's logs.** This is a real, confirmed catalyst-ingestion
  gap for this specific stock, not a downstream filter problem — the Vaxcyte Phase 3 story apparently never
  reached Argus's news pipeline at all today.
- **XP / Brazil macro propagation: not found.** No evidence this audit could locate shows MacroAgent
  identifying the Brazil-election catalyst and proactively prioritizing the Brazilian-ADR theme (XP, STNE,
  PAGS, NU, etc.) as a basket. XP was discovered and evaluated purely through the price-based `MARKET_MOVER`
  path (131 admissions, real gap% evidence), which worked reasonably well on its own — but this does not
  confirm a working macro→theme→constituent capability; it confirms XP's own price action was loud enough to
  get discovered without one. **Capability gap, not disproven by today's data, but not demonstrated either.**

## Section 28–31 — Agent analysis, consensus, RiskEngine

**The decisive finding of this audit:**

- **4,427 real `consensus_decisions` rows were recorded today. Zero (`approved=1`) were approved.**
- **0 `risk_assessments` rows exist for all of today.** Per the user's own explicit instruction: this means
  **RiskEngine was not the bottleneck today** — nothing reached it.
- **Highest confidence any symbol reached all day: 0.6999999... (CAT, TSLA) against a 0.75 threshold.**
  Both of those near-misses show `agreements_count: 1, disagreements_count: 0` — a single agent's evidence,
  never reaching the independent-agreement floor regardless of its raw confidence.
- Confidence distribution across all 4,427 rounds: **3,002 (68%) sat in the 0.40–0.49 band** — nowhere close
  to threshold. Only 18 rounds (0.4%) reached the 0.60–0.69 band. **None reached 0.70–0.74.**
- **Real, legitimate agent disagreement observed directly** (NVDA, 13:09 ET): `TechnicalAgent BUY 0.855` vs.
  `KronosEngine SELL 0.85` vs. `JavaFactorComposite SELL 0.169` vs. `MacroAgent HOLD 0`. This is a genuine,
  two-sided, roughly-balanced disagreement — not a bug, not a data gap, a real difference in model opinion
  that correctly prevented a confident consensus.
- XP's own best real attempt (`weighted_confidence: 0.680`, `agreements_count: 1`) is the same story:
  real evaluation, real idea, real consensus round, rejected on legitimate insufficient-evidence grounds.

**This directly answers the user's central counterfactual: staying `TRADING_ENABLED` all day would not have
produced any additional legitimate trades.** The ceiling on today's evidence was 0.70 against 0.75, achieved
by only two symbols, neither with independent agreement — this has nothing to do with the reconciliation
pause.

## Section 32–33 — The TRADING_PAUSED incident, counterfactual, and agent-pause behavior

Already investigated in depth this afternoon (separate root-cause fix shipped, commit `bdc51cb`): trading was
auto-paused twice today over a real `ACCOUNT_VALUATION_UNAVAILABLE` condition, unrelated to position
correctness. **Counterfactual, now directly testable with today's full consensus data:** even including the
~2.5 hours trading was actually enabled this afternoon, the data above (4,427 rounds, max 0.70) spans
effectively the whole day's real agent/quant activity — Quant/Technical/Macro/Kronos continued producing
real evaluations and real consensus rounds throughout, pause or not (consensus rounds exist from both 18:xx
and 20:xx UTC, spanning the enabled window). **The pause did not meaningfully suppress evidence generation
for the symbols this audit traced.** TechnicalAgent/MacroAgent/Kronos's documented behavior (confirmed this
morning via `ideaGenerationGate.ts`'s own doc comment: entry agents correctly stop only *new entry idea
emission* while paused, by design — `EXPECTED_TRADING_STATE_GATING`, not a bug) remains the correct
classification; today's fuller data does not change that finding.

## Section 34 — External movers vs. Argus (required table)

| Symbol | Day move | Catalyst | Premarket move | RTH opportunity | Discovered | Subscribed | Quant-evaluated | Valid trigger / idea | Consensus | Risk | Why missed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| PTC | +33% | M&A (Schneider, $205/sh) | Yes, most of move | Minimal (arb-capped) | Yes (94x) | **No** | **No** | No | No | Not reached | **Corrected:** SPREAD rejections were real IEX-only bid/ask, not a defect. Confirmed root cause: never reached the scored challenger pool until 10:37 ET (catalyst known 08:16 ET) — a discovery-to-challenger-eligibility latency gap, see `ARGUS_ADMITTED_TO_CHALLENGER_FORENSIC_2026-10-05.md`. By then its own move was over, so also likely `CORRECTLY_IGNORED` as M&A arb regardless |
| RXO | +22%+ | M&A (C.H. Robinson) | Yes, most of move | Minimal (arb-capped) | Yes (107x) | Once | **No** | No | No | Not reached | Admitted/subscribed but never reached evaluation; also likely `CORRECTLY_IGNORED` as M&A arb |
| PCVX | +32–54% | Phase 3 trial (binary) | Yes, nearly all | Unclear — not reconstructed | Barely (1x) | **No** | **No** | No | No | Not reached | `MISSED_DISCOVERY` + news-ingestion gap |
| XP | +33% | Brazil election (macro) | Yes, most of move | Some | Yes (131x) | Yes | Yes (59x) | Yes (58 ideas) | Yes (rejected, 0.68 max) | Not reached | `MISSED_CONSENSUS` (legitimate, insufficient evidence) |
| NVDA | Record close, modest % | Broad AI rally | No | Yes, all session | Yes (317x) | Yes | Yes (5,923x) | No | No | Not reached | `MISSED_STRATEGY_COVERAGE` / `NOT_TRADEABLE_WITHOUT_HINDSIGHT` — no strategy cleared its own bar |
| TSLA | +4.65% | Broad rally | No | Yes | Yes (278x) | Yes | Yes (5,641x) | Yes (2,162 ideas) | Yes (rejected, 0.70 max) | Not reached | `MISSED_CONSENSUS` (legitimate) |
| META | +2%+ | Broad rally | No | Yes | Yes (205x) | Yes | Yes (5,212x) | Yes (505 ideas) | Yes (rejected) | Not reached | `MISSED_CONSENSUS` (legitimate) |

## Section 35 — Opportunity-loss attribution (real counts, Cohort A, N=14 symbols traced)

```
14 external Cohort-A symbols traced
  → 14 discovered/admitted at least once      (100%)
  → 9  ever subscribed to live data           (64%)
  → 9  ever strategy-evaluated                (64%)
  → 3  produced real trade ideas (XP/TSLA/META) (21%)
  → 3  reached consensus                       (21%)
  → 0  approved by consensus                   (0%)
  → 0  reached RiskEngine                      (0%)
  → 0  reached OMS/broker                      (0%)
```

**Biggest real drops:** discovery→subscription (100%→64%, lost PTC/RXO/PCVX/TER/MPWR), and
consensus-approval (21%→0%, lost XP/TSLA/META at the only stage where they had genuine, repeated, real
evidence). RiskEngine and OMS/broker lost nothing today because nothing reached them.

## Section 36 — Primary structural failure

**Not a single cause — two independent, co-primary failures, by evidence volume:**

1. **CONSENSUS_CALIBRATION / INSUFFICIENT_INDEPENDENCE** — for every symbol that reached real, repeated
   evaluation (XP, TSLA, META, NVDA), the ceiling was weak, single-agent-dominated evidence. This is the
   larger-volume failure (4,427 real rounds, 0 approved).
2. **DISCOVERY_TO_CHALLENGER_ELIGIBILITY_LATENCY (PTC) + BROAD_UNIVERSE_TOPN_TRUNCATION (MPWR) +
   CATALYST_DISCOVERY (PCVX gap)** — not a data-quality defect (that claim is retracted); smaller in
   volume than #1 but directly explains why PTC and PCVX barely got a fair look. See
   `ARGUS_ADMITTED_TO_CHALLENGER_FORENSIC_2026-10-05.md` for the full root-cause trace. **Correction
   (2026-10-05, same-day follow-up):** an earlier draft of that companion forensic claimed MPWR was
   "admitted 76 times" — re-verified directly against `observability_events.symbol` (a dedicated column,
   not embedded in the payload JSON this report's own earlier queries matched against); the real count is
   2 admissions and 1 ADV-data-unavailable filter, not 76. MPWR's diagnostic value is unchanged — it was
   admitted twice and reached zero challenger-pool appearances both times — but the mechanism is a
   confirmed top-N truncation at `getOpportunityScanUniverse()`'s `broadUniverseTopNPerScan` cap (fixed:
   this silent exclusion now logs `BROAD_UNIVERSE_TOPN_TRUNCATED`), not a latency gap of the kind PTC
   showed.

RiskEngine, OMS, execution: **not implicated** — zero evidence reached them.

## Reverse-engineered hypotheses (research only, not implemented)

- **CATALYST_GAP_CONTINUATION**: for a premarket M&A/event gap, is there a defensible post-open continuation
  entry distinct from chasing the gap itself? PTC/RXO's arb-capped structure argues against it for M&A
  specifically; PCVX's biotech-binary structure is a separate, higher-variance case that today's data
  couldn't resolve (discovery never got far enough).
- **PREMARKET_RELATIVE_VOLUME_BREAKOUT / MACRO_THEME_PROPAGATION**: XP's real, repeated, independent-enough-
  looking engagement (59 assessments, 58 ideas, best confidence 0.68) suggests the price-based path alone
  gets partway there for a macro-driven single-name mover; a dedicated macro→theme→basket capability remains
  an unproven but plausible research candidate, not disproven by today.

These are hypotheses only, per the user's explicit instruction — no historical validation was run.

## Existing Java capability

Not inventoried against these specific phenomena this pass — flagged as a required step (per Section 44)
before proposing any new strategy, not completed here given the time already spent on the higher-priority
forensic trace above.

## What should NOT be changed

Per the user's own explicit instruction and this audit's own evidence: do not lower the 0.75 consensus
threshold, the minimum-independence floor, any RiskEngine gate, trigger gates, or data-freshness/spread
requirements. Today's evidence shows the *inputs* feeding consensus were weak and under-diversified — not
that the bar itself is miscalibrated. **Also do not weaken spread filtering based on the IEX-only-quote
finding** — the spread values were real, not fabricated; the open question is data-source quality, not
whether the filter should trust wide spreads more. Fixing the subscription hot-swap capacity/prioritization
issue (PTC) and the PCVX-class news-ingestion gap is upstream, additive work; it does not touch any safety
gate.

## Not executed this pass (honest scope limitation)

Full minute-bar reconstruction of each stock's day (Section 5), source-by-source catalyst publication-time
verification beyond what's cited above, the full 21-strategy capability matrix (Section 16), horizon-overlap
analysis (Section 30), the Java-engine capability inventory (Section 44), and any historical/OOS validation
(Sections 45–47) were not performed given the volume of real internal-log forensics already completed and
reported above. None of these are needed to support this report's primary findings, which rest on direct,
verified DB evidence (discovery/subscription/evaluation counts, real consensus confidence/independence
data), not inference.

## Final verdict

- **SYSTEM_EXECUTION:** DEGRADED (reconciliation auto-pause, already being remediated separately; execution
  path itself — OMS/broker — untested today, zero evidence reached it)
- **OPPORTUNITY_DISCOVERY:** ADEQUATE (universe coverage and catalyst ingestion work for most names; a
  confirmed subscription hot-swap capacity/prioritization issue (not a data-staleness defect — that claim
  was retracted), and one confirmed news-ingestion coverage gap)
- **STRATEGY_COVERAGE:** WEAK (thousands of real evaluations across megacaps, zero or near-zero eligible
  setups found by any of the 21 TS strategies on a strong, broadly-positive tape)
- **CONSENSUS:** OVERCONSERVATIVE is not proven — evidence shows genuine weak/under-independent inputs, not
  a miscalibrated bar. Classification: **INSUFFICIENT_EVIDENCE to call consensus itself the defect** — the
  evidence it was asked to judge was never strong enough to test the threshold meaningfully.
- **MISSED_OPPORTUNITY_ROOT_CAUSE:** Upstream evidence quality and diversity — not consensus, not RiskEngine,
  not execution.

**TOP 5 CHANGES (ranked by evidence):**
1. **Superseded by `ARGUS_SUBSCRIPTION_STARVATION_FORENSIC_2026-10-05.md`:** investigate the subscription
   hot-swap cap/prioritization mechanism that caused PTC to lose 263 consecutive promotion attempts to
   `SWAP_CAP_REACHED` — the confirmed, concrete root cause (not the retracted stale-reference-price claim).
2. Investigate why PCVX's real, major, premarket-published catalyst produced zero `NEWS_*` events — confirmed
   upstream of entity/ticker extraction (zero raw `news_articles` rows), exact provider-level cause still open.
3. (Folded into #1, distinct mechanism) MPWR showed the same admitted-but-never-subscribed outcome as
   PTC, via a different root cause: a confirmed, now-fixed silent top-N truncation at
   `getOpportunityScanUniverse()`, not a latency/timing gap.
4. Research (not implement) a macro-theme-propagation capability for MacroAgent, using XP as the only
   available natural experiment so far.
5. Research (not implement) why independent, multi-agent agreement is so rare even on a broadly positive,
   high-conviction tape (TSLA/META/NVDA all show single-agent-dominated evidence) — this is the highest-
   volume real finding of the day and the most consequential for actually producing approved trades in the
   future.

## Final questions (selected, most load-bearing)

5. In Argus's universe? **Yes, all Cohort A names.**
6. Discovered? **Yes, all — repeatedly.**
7. Subscribed? **9 of 14 (64%).**
9. Fully evaluated? **9 of 14 (64%), several thousands of times each.**
11. Produced ideas? **3 of 14 (XP, TSLA, META) — 2,725 real ideas combined.**
13. Reached RiskEngine? **0.**
14. Which stage lost the most? **Consensus (3 real candidates, 0 approved) and discovery-to-subscription
    (5 of 14 never subscribed).**
15–16. Did the pause matter / would staying enabled have produced trades? **No — the day's full consensus
    data (4,427 rounds, max 0.70) shows the evidence ceiling, not the pause, was the limiting factor.**
19–21. PTC/RXO/PCVX news ingested? **PTC and RXO yes (confirmed clusters); PCVX no.**
22–23. Brazil catalyst / proactive news injection? **News-to-discovery injection demonstrably exists and
    worked for PTC (confirmed cluster → discovery path); no evidence of macro-theme→basket propagation for
    XP specifically.**
29. Highest-leverage architecture improvement? **(Corrected) Fixing the subscription hot-swap
    capacity/prioritization mechanism that caused PTC's 263 `SWAP_CAP_REACHED` rejections — the confirmed,
    concrete finding, superseding the retracted stale-reference-price claim.**
31. Highest-leverage architecture improvement vs. what should NOT be changed? **Do not touch consensus/risk
    thresholds — today's evidence does not support that as miscalibrated.**
