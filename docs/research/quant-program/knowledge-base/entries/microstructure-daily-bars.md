---
kind: concept
family: microstructure
status: RESEARCHED
argus_status: EXISTS_INCOMPLETE
argus_refs:
  - src/server/engines/backtest/Slippage.ts
  - src/server/services/MarketUniverseScanner.ts
sources:
  - { title: "Market Microstructure Theory", authors: "Maureen O'Hara", year: 1995, url: "", license: "book (Blackwell, 1995)" }
  - { title: "A Simple Implicit Measure of the Effective Bid-Ask Spread in an Efficient Market", authors: "Richard Roll", year: 1984, url: "", url: "https://doi.org/10.1111/j.1540-6261.1984.tb03897.x", license: "academic (Journal of Finance)" }
  - { title: "A Simple Way to Estimate Bid-Ask Spreads from Daily High and Low Prices", authors: "Shane Corwin, Paul Schultz", year: 2012, url: "", url: "https://doi.org/10.1111/j.1540-6261.2012.01729.x", license: "academic (Journal of Finance 67(2))" }
  - { title: "Illiquidity and Stock Returns", authors: "Yakov Amihud", year: 2002, url: "https://doi.org/10.1016/S1386-4181(01)00024-6", license: "academic" }
evidence_quality: 80
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- RESEARCH FINDING: Market microstructure studies how trading mechanisms (spreads, depth, order flow, asymmetric information) determine prices. Most of its machinery — order-book imbalance, queue position, Kyle's lambda estimation, tick-level adverse selection — requires intraday/L2 data and sub-minute horizons.
- VERIFIED FACT: Argus trades daily bars with next-bar market orders held for days to weeks. At this frequency, the holding-period return variance (percent-scale daily ranges) dwarfs L2 effects (basis-point-scale queue dynamics) by roughly two orders of magnitude.
- INFERENCE: The following microstructure concepts are **not relevant** at Argus's frequency, with reasons: (a) order-book imbalance/queue position — Argus never posts limit orders into the book; (b) tick-level bid-ask bounce — washes out over multi-day holds (Roll 1984 bounce is a ~1-tick phenomenon); (c) latency/arbitrage races — no co-located competition at daily bars; (d) market-maker inventory models — Argus is a liquidity *taker* in tiny size; (e) Kyle (1985) lambda — needs intraday order-flow regression, unidentifiable from daily bars.
- RESEARCH FINDING: The microstructure concepts that **do** survive to daily frequency: (a) effective spread estimation from daily bars — Roll (1984): `spread = 2√(−cov(Δp_t, Δp_{t−1}))`; Corwin–Schultz (2012): spread from daily high-low ranges, no intraday data needed; (b) the Amihud (2002) illiquidity ratio `ILLIQ = mean(|r_t| / DollarVolume_t)` — a daily-bar price-impact proxy with strong empirical support; (c) overnight vs intraday return decomposition (close-to-open vs open-to-close carry different information — relevant to execution timing, e.g. avoid trading the open auction noise).
- VERIFIED FACT: Argus's discovery funnel already screens on spread and dollar volume (`MarketUniverseScanner` liquidity screen) — the *liquidity* half of microstructure is present; the *measurement* half (estimated effective spread per symbol, Amihud ratio as a feature) is not.

## Mathematics
Roll (1984): `s = 2·√(−Cov(Δp_t, Δp_{t−1}))` (defined only when the autocovariance is negative). Corwin–Schultz (2012): from `β = E[Σ_{j=0}^{1} (ln(H_{t+j}/L_{t+j}))²]`, `γ = (ln(H_t/L_t))²`: `α = (√(2β) − √(β))/(3 − 2√2) − √(γ/(3 − 2√2))`, `S = 2(e^α − 1)/(1 + e^α)` — a spread estimate from two days of high-low data. Amihud: `ILLIQ_{i,y} = (1/D)Σ_t |r_{i,t}| / DVOL_{i,t}`.

## Economic rationale
Spreads compensate liquidity providers for order-processing, inventory risk, and adverse selection (Glosten–Milgrom/Stoll decomposition). For a small liquidity taker, the spread is a near-fixed tax per round trip — the dominant friction at Argus's size, larger than any plausible market impact. Measuring it per symbol (rather than assuming a flat slippage) is the cheapest realism upgrade available.

## Argus mapping
EXISTS_INCOMPLETE. Liquidity screens exist; per-symbol *estimated* effective spread (Corwin–Schultz, computable from the daily bars Argus already stores) and Amihud ratios do not. Natural homes: Corwin–Schultz spread → `Slippage.ts` input (replace flat assumptions) and the discovery liquidity screen; Amihud → Java feature pipeline as a liquidity feature and a position-size throttle. All in Java per the engine authority. Layer: data/features → execution.

## Failure modes
(1) Roll's estimator fails (positive autocovariance) in trending markets — Corwin–Schultz is the robust default. (2) Spread estimates are backward-looking; regime changes (earnings, halts) need the existing freshness/volatility guards, not finer spread math. (3) Precision theater: estimating the spread to 0.1bp while the signal edge is unknown to ±200bp.

## Verdict
PROMOTE the daily-bar subset (Corwin–Schultz spread estimator + Amihud ratio) to specified → implemented in Java. Explicitly REJECT the L2/intraday apparatus as out of scope at daily-bar frequency — record this so future sessions don't re-litigate it.
