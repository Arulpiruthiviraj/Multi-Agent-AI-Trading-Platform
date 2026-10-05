# Argus Quant Research Roadmap — v0.1 (2026-10-05)

**Status:** Initial pass. Built from the completed literature survey (momentum, reversal, value, stat-arb, validation science) + full Argus inventory audit. A background research agent is deepening Phases 2-4 (open-source systems, portfolio construction, microstructure) — this roadmap will be revised when it reports.

Epistemic discipline: every entry is a hypothesis until tested. Rankings reflect evidence quality × Argus feasibility, not enthusiasm.

## TOP 10 immediate research projects

1. **Walk-forward validation of the 3 wired momentum strategies** — the paper votes now exist; the question is whether they survive costs OOS. Highest value because the infrastructure is already built.
2. **Transaction-cost model calibration** — spreads + slippage + borrow costs per venue. Every backtest result is fiction without this.
3. **Parameter robustness surfaces** for VolScaledMtfMomentum (20/60d) and TsMomentum12M (252/21d) — stable regions, not point optima.
4. **Strategy correlation analysis** — are the 3 momentum votes orthogonal or 3 versions of the same trade? (Phase 17.)
5. **Deflated Sharpe / multiple-testing correction** on all existing backtest claims (Lopez de Prado) — how many of Argus's 150 engines survive?
6. **Regime-conditional performance** — momentum in bull/bear/chop/high-vol; wire HmmRegimeEngine outputs into the vote confidence.
7. **Benchmark ladder** — every strategy vs SPY buy-and-hold, equal-weight universe, and simple SMA baseline (Phase 16).
8. **Meta-labeling** (Lopez de Prado) — keep the momentum entry signals, ML only the sizing/exit decision. Lower overfitting surface than end-to-end ML.
9. **Portfolio construction layer** — risk parity / HRP / inverse-vol across strategy votes (Phase 20). Currently position sizing is per-trade, not portfolio-aware.
10. **Knowledge-base completion** — finish research cards for the top 5 candidates; record rejections (XSMOM, short-term reversal already recorded).

## TOP 25 candidate strategy families (by evidence × feasibility)

**Tier 1 — implement/validate now:**
1. Time-series momentum (12-1) — IMPLEMENTED, wired to paper 2026-10-05
2. Vol-scaled multi-timeframe momentum — IMPLEMENTED, wired 2026-10-05
3. Multi-factor momentum — EXISTS, wired 2026-10-05
4. Pairs/stat-arb (Engle-Granger/ADF) — EXISTS (InstitutionalStatArb), blocked on short-selling + pair universe

**Tier 2 — research deeply:**
5. Dual Momentum / GEM (ETF rotation — needs portfolio-allocation module, not per-symbol)
6. Residual momentum (factor-neutralized)
7. Overnight reversal (needs intraday bars — data question)
8. Volatility targeting overlays (exists as sizing; test as signal conditioner)
9. Earnings momentum / PEAD (needs earnings calendar data)
10. Low-volatility anomaly (Fama-French adjacent; needs point-in-time fundamentals for value leg)

**Tier 3 — interesting, lower priority:**
11-15. Carry, quality, profitability, investment factors (all need fundamentals)
16. Sector-neutral mean reversion (needs sector mapping)
17. Kalman-filter hedge ratios (improvement to existing stat-arb)
18. Johansen cointegration (basket stat-arb)
19. HAR-RV volatility forecasting (better vol estimates for scaling)
20. Meta-labeling (ML on top of rule-based entries)

**Tier 4 — rejected or not appropriate (recorded):**
21. Cross-sectional momentum — REJECTED (needs shorting + breadth)
22. Short-term reversal — REJECTED (bid-ask bounce, cost-fragile)
23. Avellaneda-Stoikov market making — NOT APPROPRIATE (needs L2/latency)
24. Intraday microstructure alphas — NOT APPROPRIATE at daily-bar frequency
25. Pure price-prediction ML (LSTM/transformers on OHLCV) — REJECTED until it beats Tier 1 baselines (Phase 16)

## TOP 50 quantitative concepts (condensed — full entries go in knowledge-base/)

**Momentum:** time-series, cross-sectional, absolute/relative, dual, residual, earnings, acceleration, vol-adjusted. **Mean reversion:** z-score, Bollinger, OU process + half-life, residual, sector-neutral, overnight. **Stat arb:** Engle-Granger, Johansen, ADF, Kalman hedge ratios, PCA, cointegration vs correlation. **Factors:** beta, size, value, momentum, profitability, investment, quality, low-vol, carry. **Volatility:** EWMA, GARCH, HAR-RV, Parkinson/Garman-Klass/Rogers-Satchell/Yang-Zhang, vol targeting, vol regimes. **Regimes:** HMM, Markov-switching, change-point detection, breadth regimes. **ML:** regularized linear, trees/forests, GBM, meta-labeling, stacking — always vs simple baselines. **Portfolio:** equal/inverse-vol, min-variance, mean-variance, risk parity, HRP, Black-Litterman, Kelly/fractional, shrinkage. **Risk:** VaR/ES, drawdown, Sortino, exposure limits, kill switches — mapped to signal vs sizing vs portfolio vs execution layers. **Execution:** TWAP/VWAP, implementation shortfall, market impact. **Validation:** walk-forward, purged CV, embargo, DSR, PSR, parameter surfaces, benchmarks.

## TOP 20 infrastructure capabilities (ranked)

1. Walk-forward engine with purged CV + embargo (exists in Python — port discipline to Java)
2. Transaction-cost model (MISSING_HIGH)
3. Strategy correlation / diversification analyzer (MISSING_HIGH)
4. Deflated Sharpe / multiple-testing toolkit (MISSING_HIGH)
5. Experiment registry (MISSING_MEDIUM)
6. Feature registry (EXISTS_INCOMPLETE — features scattered)
7. Model registry with versioning (MISSING_MEDIUM)
8. Portfolio construction engine — risk parity/HRP (MISSING_HIGH)
9. Performance attribution (strategy × regime × factor) (MISSING_MEDIUM)
10. Alpha decay monitor (MISSING_MEDIUM)
11. Parameter robustness surface tooling (MISSING_MEDIUM)
12. Benchmark ladder runner (MISSING_MEDIUM)
13. Knowledge base (CREATED 2026-10-05 — this program)
14. Research cards (CREATED 2026-10-05)
15. Strategy promotion state machine (EXISTS_INCOMPLETE — lifecycle documented, not enforced in code)
16. Data lineage / reproducibility manifests (EXISTS_INCOMPLETE)
17. Monte Carlo engine (EXISTS — check coverage)
18. Slippage model (MISSING_HIGH — part of #2)
19. Research sandbox (paper) — EXISTS_GOOD (the vote wiring)
20. Continuous research agent loop (DESIGNED 2026-10-05 — charter; automation pending)

## Next review

When the background survey (open-source systems, portfolio construction, microstructure) reports, promote its A-class findings into Tier 1/2 and revise this file to v0.2.

---

# Roadmap v0.2 — Phases 2–4 broad survey (2026-10-05)

**Source:** knowledge-base entries `oss-*`, `portfolio-*`, `execution-*`, `microstructure-daily-bars`, `validation-cpcv`, `sizing-kelly` + 5 research cards, all dated 2026-10-05.
**How v0.2 relates to v0.1:** the v0.1 TOP 20 infrastructure list stands; this section promotes the A-class survey findings into it, adds A/B/C/D/E classifications (missing in v0.1), and records the explicit rejections. No v0.1 item is removed — several are sharpened (notes inline).

## TOP 10 infrastructure / capability recommendations (ranked, classified)

### 1. [A] Purged + embargoed cross-validation (CPCV) as the mandatory research splitter
Sharpens v0.1 #1 and #4. Argus owns PBO, DSR, and walk-forward checks — but no purged/embargoed CV primitive, so any K-fold-style evaluation leaks through label overlap and return autocorrelation. With 150+ strategies in inventory, unpurged selection *will* promote lucky noise; PBO/DSR correct for trial count while purging corrects for trial contamination, and neither substitutes for the other. Implement the splitter in the Python research env first (mandatory for every sweep and model selection), feed CPCV-generated OOS paths into the existing PBO computation, and port to Java when the Java backtester needs it. Pure validation hygiene: it can only remove false positives, never invent edge — which is exactly why it ranks first. (See `knowledge-base/entries/validation-cpcv.md`.)

### 2. [A] Ledoit–Wolf covariance shrinkage as the default covariance supplier in Java
New vs v0.1 (was implicit inside "portfolio construction engine"). Every Argus optimizer currently eats raw sample covariance — the textbook estimation-error-maximization setup. Linear shrinkage is ~40 lines of Java, analytic (no parameters to fit), distribution-free, and strictly improves every downstream consumer (Markowitz, HRP, risk parity, VaR) under quadratic loss. Implement in `quant-core-java` `institutional/math/`, wire as the default supplier, validate by comparing out-of-sample portfolio variance vs raw covariance on Argus's own data. Highest-ROI numerical change in the portfolio layer. (See `knowledge-base/entries/portfolio-covariance-shrinkage.md`.)

### 3. [A] Implementation-shortfall accounting on the paper path (measurement only)
Sharpens v0.1 #2. Argus models slippage in backtest but has no arrival-price benchmark on the paper path: no explicit-vs-implicit cost decomposition, no per-strategy cost ledger. Stamping `arrivalPrice`/`arrivalTs` at `TRADE_IDEA_GENERATED` and reconciling against fills is pure measurement — zero order-path change, zero safety implications — and produces the total-cost numbers that the DSR-with-costs gate and synthesis certification currently assume. A strategy with gross Sharpe 1.0 and 0.4 of shortfall drag is a 0.6 strategy; today Argus cannot tell its strategies apart on this dimension. (See `knowledge-base/entries/execution-implementation-shortfall.md`.)

### 4. [A] Hierarchical Risk Parity as the default multi-position allocator
Promotes v0.1 #9 from "research" to specified. HRP (López de Prado 2016) allocates via correlation-tree clustering with no matrix inversion, no expected-return estimates, and no optimizer convergence failures — the three properties that make Markowitz unusable in an automated pipeline. Deterministic, fast, degrades gracefully to inverse-volatility weighting for small books. Implement clean-room in Java from the paper (PyPortfolioOpt's MIT implementation as spec reference only), keep mean-variance as the alternative, horse-race both plus 1/N on Argus's paper-trade history. Layering note: HRP allocates across positions; it never generates signals. (See `knowledge-base/entries/portfolio-hrp.md`.)

### 5. [B] Black–Litterman view-blending — gated on view calibration
Not in v0.1; correctly absent until now. BL is the principled interface between Argus's multi-agent view generation and portfolio weights: equilibrium-implied returns blended with explicit-confidence views, collapsing to the market portfolio when views are absent. Classified B, not A, for one reason: Argus's view confidences are currently uncalibrated (the `0.35 + 4×return` precedent), and BL would launder uncalibrated opinions through respectable math. Implement only after some view source demonstrates calibrated, OOS-validated confidence; the most promising first application is regime/timing views from the HMM engine. (See `knowledge-base/entries/portfolio-black-litterman.md`.)

### 6. [B] Fractional Kelly sizing in Java — as a cap, never a lever
Not in v0.1. The Kelly math exists in TS research code (explicitly `usedByRiskEngine: false`) but is not in Java and not fed by validated edge statistics — and organic closed paper P&L is 0, so any Kelly fraction today would be computed on assumptions. Migrate to Java when sizing is next touched (engine authority), keep unwired, and set the promotion precondition now: per-strategy OOS win-rate/payoff statistics clearing `MIN_SAMPLE_SIZE_FOR_KELLY`, then half-Kelly or less as a *cap* on risk-based sizing. Kelly on phantom edge is leverage with footnotes. (See `knowledge-base/entries/sizing-kelly.md`.)

### 7. [B] LEAN-inspired backtest-realism checklist, enforced by tests
New vs v0.1. Don't vendor LEAN (C# stack vs Java authority; second order path). Adopt its checklist: corporate-action safety (detection exists — extend to adjustment), fill-timing discipline (SAME_BAR_CLOSE / NEXT_BAR_OPEN-for-promotion — already policy, now write it down), borrow-cost hooks for future shorting, delisting/survivorship handling, and a walk-forward documentation page with lookahead warnings beside the WFO scripts. Converts tribal knowledge into enforced invariants. (See `knowledge-base/entries/oss-lean.md`.)

### 8. [C] Keep `arch` / statsmodels as research-side verification tools
Refines v0.1's implicit "Python research" posture. Argus reimplements GARCH/OLS/ARIMA natively in Java — the production half of these libraries is redundant. Their research value is as independent second opinions (reproduce a Java inference result in statsmodels before claiming significance; use `arch`'s SPA/StepM/MCS bootstrap suite as reference for a future Java multiple-testing procedure answering "which of my 150 strategies are real" — the one question DSR/PBO leave open). Python research env only; never in the decision path; reimplement adopted procedures from the primary papers, don't copy code. (See `knowledge-base/entries/oss-arch.md`, `oss-statsmodels.md`.)

### 9. [C] Qlib's point-in-time discipline — adopt the rule, not the platform
New vs v0.1 (extends #16 data lineage). Qlib (MIT) is not adoptable as a platform (second data layer/feature engine/backtester = second system of record, forbidden). Its transferable idea is structural: every non-OHLCV feature carries the timestamp at which it was *knowable*. Adopt knowledge-timestamping when fundamentals/earnings data enter the pipeline — the PEAD and quality research cards both depend on it — plus rolling retrain schedules with frozen artifacts for any ML model. Until then, OHLCV bar timestamps suffice. (See `knowledge-base/entries/oss-qlib.md`.)

### 10. [D/E] Explicit rejections — do not revisit without new evidence
- **[D] NautilusTrader as a dependency** (LGPL-3.0 copyleft burden + Rust/Python stack vs Java authority + zero payoff: L2 order-book replay is precision without purpose at daily-bar market-order granularity). Study its actor/message design; never vendor it. (See `knowledge-base/entries/oss-nautilustrader.md`.)
- **[D] vectorbt as anything beyond triage-grade research** (next-bar simplified fills; Commons Clause is not OSI-approved — fine for internal research, never for a commercial/hosted offering). Keep the existing capability probe; add a parity harness before any sweep result influences promotion. (See `knowledge-base/entries/oss-vectorbt.md`.)
- **[D] PyPortfolioOpt as a production dependency** (dependency bit-rot risk + Python in the decision path). Math reference for HRP/Black-Litterman only; reimplement in Java. (See `knowledge-base/entries/oss-pypfoliopt.md`.)
- **[E] Any strategy-selection or parameter-sweep workflow without purging/embargo and trial-count accounting.** Unpurged CV and unadjusted sweep-Sharpes are not "simpler methods" — they are statistically flawed instruments that manufacture false discoveries. The only E on the list because it is the only item that actively destroys capital through false confidence.

## Negative results registered this survey (do not re-litigate)

- L2/intraday microstructure apparatus (order-book imbalance, queue models, Kyle lambda): **REJECT** at daily-bar frequency — holding-period variance dwarfs L2 effects by ~2 orders of magnitude. Keep only the daily-bar subset: Corwin–Schultz spread estimator + Amihud illiquidity ratio (both computable from daily OHLCV; feed `Slippage.ts` and the discovery liquidity screen). (`microstructure-daily-bars.md`)
- Full Kelly and levered risk parity: **REJECT** as targets (no leverage mandate, no validated edge statistics). Approved forms: fractional-Kelly-as-cap, ERC risk-budgeting.
- VWAP execution: **sequenced, not rejected** — after TWAP + shortfall measurement exist and intraday volume profiles prove stable.
- Importing any OSS engine as a dependency (LEAN, NautilusTrader, Qlib, vectorbt-beyond-triage, PyPortfolioOpt): **REJECT** on stack/license/second-system-of-record grounds. Ideas yes; code no; GPL-family licenses never.
- v0.1 Tier 4 stands as written (XSMOM, short-term reversal, Avellaneda–Stoikov, intraday microstructure alphas, pure price-prediction ML).

## Research queue update (from the 5 Phase-4 cards)

| Priority | Card | Status |
|---|---|---|
| 1 | `research-cards/risk-managed-momentum.md` (Barroso–Santa-Clara vol scaling) | Thin Java overlay on the already-wired TSMOM strategies; directly addresses momentum-crash failure mode |
| 2 | `research-cards/pead.md` | Largest evidence-per-novelty gap; **gated on a data spike** (point-in-time earnings feed via AlphaVantage — unverified) |
| 3 | `research-cards/52-week-high.md` | `FiftyTwoWeekHighMomentumEngine.java` exists and idle — pure activation via the vote-service pattern |
| 4 | `research-cards/residual-momentum.md` | `ResidualReturnEngine.residualMomentum` exists; test the FF3→single-factor simplification explicitly |
| 5 | `research-cards/quality-long-only.md` | `SmartBetaFactorEngine` math exists; shares PEAD's fundamentals data-spike dependency |

## Suggested sequencing (v0.2)

1. Validation hygiene first: CPCV splitter (Rec 1) + trial-count discipline on all sweeps (Rec 10E).
2. Measurement before optimization: implementation-shortfall accounting (Rec 3) + Corwin–Schultz/Amihud features (microstructure entry).
3. Portfolio robustness: shrinkage (Rec 2) → HRP (Rec 4) → vol targeting + risk budgets (companion entries).
4. Strategy activation: the 5 research cards in priority order, each through the full charter lifecycle.
5. View-dependent methods (Black–Litterman, Kelly-as-cap) unlock only after calibrated views / validated edge statistics exist.

## v0.3 — Web research synthesis (2026-10-05)

Three new knowledge-base entries from today's targeted web research. None contradict v0.1/v0.2; all refine sequencing.

### New entries
- `ml-meta-labeling.md` — **the #1 ML project for Argus.** ML predicts *whether a signal works* (classification on "was this trade profitable after costs"), never direction from scratch. S-curve bet sizing: size = 2·N((p−0.5)/√(p(1−p))) − 1. Keeps Java strategies as primary generators; ML only sizes. Gated on paper-trading outcomes flowing (labels need real fills).
- `data-sec-edgar.md` — **cheapest high-value data upgrade: $0.** SEC EDGAR JSON API (10 req/s, public domain): Form 4 (insider buys, 2-day lag), 8-K Item 2.02 (earnings, 4-day lag), 13F (45-day lag). Unlocks the PEAD card's timing half; consensus estimates still need a vendor. Phase 1: Form 4 scraper.
- `architecture-bayesian-confluence.md` — decision framing upgrade: posterior P(edge>0 | signals, regime) net of expected costs, not binary checklists. Concrete steps: calibrate agent confidences against paper outcomes → subtract expected cost in ChiefTrader → regime-conditional priors from HMM.

### Sequencing update (v0.3)
The v0.2 sequence stands. Insertions:
- After shortfall measurement (step 2): Form 4 EDGAR scraper — it is pure data plumbing (TS acceptable), zero vendor cost, and feeds both a new signal family and the PEAD timing gate.
- After validation hygiene (step 1): begin collecting the labeled outcome dataset meta-labeling needs — every paper trade logged with features at entry. The ML comes later; the *labels* must start now.
- Bayesian confluence is a background architecture track, not a project: each of its 3 steps is independently testable and none require a rewrite.
