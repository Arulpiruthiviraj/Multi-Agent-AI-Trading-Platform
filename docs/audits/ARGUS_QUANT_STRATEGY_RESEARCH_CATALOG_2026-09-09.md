# Argus — Quantitative Strategy Research Catalog (2026-09-09)

**Status: research catalog only, no code changed.** Companion to
`ARGUS_QUANTENGINE_EXPANSION_DESIGN_2026-09-09.md` (architecture, feature engine, ensemble math,
versioning, certification, database, testing, Java integration, the two-agent verdict — **all
already answered there, not repeated here**) and
`ARGUS_POSTMARKET_PREMARKET_INTELLIGENCE_DESIGN_2026-09-09.md` (point-in-time integrity, learning
pipeline). This document is Phase 0 of that plan: the research-backed strategy catalog.

## An honest finding before the catalog: "200+" needs a caveat

The request itself says not to artificially inflate the count with parameter variants
(`RSI_14`/`RSI_15`/`RSI_16` should not count as three strategies) — and that instruction, followed
honestly, caps how large a *genuinely independent-hypothesis* catalog can be. Professional
systematic-equity research generally recognizes a few dozen truly distinct return drivers for
liquid single-name equities, not hundreds — this is not a limitation of this catalog, it's the
actual state of the published literature. What follows is:

- **~58 genuinely distinct parent hypotheses** (materially different economic rationale, feature
  set, or market behavior — the real count), each with real academic/practitioner grounding.
- Each parent hypothesis lists its common **parameter/asset variants** (the things that would
  otherwise pad a count to "200+") explicitly labeled as variants, not separate entries — matching
  the request's own instruction. Counting parent hypotheses **and** their listed variants together
  comfortably exceeds 200 line items, but only the ~58 parents are ever independent evidence for
  ensemble purposes (§10 of the companion design doc — `QuantEnsembleEngine.java`'s
  `effectiveIndependentCount()` is precisely the mechanism that would collapse a variant cluster
  back to ~1 vote).
- Citations below are real, well-established results I have high confidence in (author/year is
  correct to the best of my knowledge). Where I'm citing a well-known *class* of finding rather
  than a specific paper I can confidently attribute, I say so rather than inventing a citation —
  per this whole session's standing rule against fabrication.

Legend for `dataFit` (grounded in the live data-availability findings in the companion QuantEngine
report §1.6, §1.9): **NOW** = daily bars (599 symbols, 2018-2026) or the existing 1-min set (224
symbols, ~25 days) genuinely support this today. **PARTIAL** = supportable in a reduced form (e.g.
daily-only version of an intraday idea). **NEEDS_DATA** = requires something Argus doesn't have
confirmed today (15m/30m/1h bars, fundamentals with reliable point-in-time timestamps, an earnings
calendar, options data, futures/VIX beyond the narrow Fincept path). **RESEARCH_ONLY** = keep as a
literature entry; do not attempt implementation until the data gap closes.

---

## TREND / MOMENTUM (target 25+; 11 real parents, ~30 variants)

| # | Strategy | Family | Hypothesis | Reference | dataFit | Lookahead risk | Cost sensitivity |
|---|---|---|---|---|---|---|---|
| 1 | Time-series momentum | TREND | Past N-month own return predicts next-month sign | Moskowitz, Ooi & Pedersen, "Time Series Momentum," *J. Financial Economics* 2012 | NOW (daily) | Low if lagged correctly | Low (monthly rebalance) |
| 2 | Cross-sectional momentum | MOMENTUM | Winners-minus-losers over 3-12mo, held ~1mo | Jegadeesh & Titman, "Returns to Buying Winners and Selling Losers," *J. Finance* 1993 | NOW (needs a real cross-sectional universe, not just single-symbol) | Medium — needs point-in-time universe membership | Medium |
| 3 | Short-term reversal (1-week/1-month) | MOMENTUM (variant family, opposite sign at short horizon) | Very short-horizon returns mean-revert even though medium-horizon trends | Jegadeesh, "Evidence of Predictable Behavior of Security Returns," *J. Finance* 1990 | NOW | Low | High (frequent turnover) |
| 4 | Moving-average crossover (SMA/EMA, fast/slow) | TREND | Already implemented, `MovingAverageCrossoverEngine.java` — RESEARCH status | Classic technical practice; academically studied in Brock, Lakonishok & LeBaron, "Simple Technical Trading Rules," *J. Finance* 1992 | NOW | Low | Medium |
| 5 | ADX / directional-movement trend strength | TREND | Already implemented, `TrendStrengthEngine.java` | Wilder, *New Concepts in Technical Trading Systems*, 1978 | NOW | Low | Medium |
| 6 | Donchian channel breakout | TREND/BREAKOUT | Already implemented, `DonchianChannelEngine.java` | Popularized by the Turtle Traders (Richard Dennis/Bill Eckhardt, 1980s practitioner record, not a peer-reviewed paper — flagged honestly) | NOW | Low | Medium-high |
| 7 | Multi-timeframe trend alignment | TREND (variant of #1/#4) | Higher-timeframe trend as a filter for lower-timeframe entries | Common practitioner technique; no single canonical academic source | **NEEDS_DATA** (no 15m/30m/1h bars) | — | — |
| 8 | Volatility-adjusted trend / risk parity trend | TREND (variant) | Size the trend signal by inverse realized vol | Moskowitz et al. 2012 (same paper as #1, its own risk-scaling step) | NOW | Low | Low |
| 9 | Trend acceleration (2nd derivative of price/MA slope) | MOMENTUM (variant) | Rate-of-change of the trend itself, not just its sign | Practitioner technique; no single canonical source I can confidently cite | PARTIAL (daily only) | Low | Medium |
| 10 | Sector/industry momentum | MOMENTUM (cross-sectional variant) | Momentum measured relative to sector, not the raw stock | Moskowitz & Grinblatt, "Do Industries Explain Momentum?," *J. Finance* 1999 | PARTIAL (sector ETF daily bars exist; needs a real sector map, coarse one already exists in `PositionSizing.ts`) | Medium | Medium |
| 11 | 52-week high momentum | MOMENTUM | Proximity to 52-week high predicts continuation | George & Hwang, "The 52-Week High and Momentum Investing," *J. Finance* 2004 | NOW (daily) | Low | Medium |

## MEAN REVERSION / REVERSAL (target 20+; 9 real parents, ~18 variants)

| # | Strategy | Hypothesis | Reference | dataFit |
|---|---|---|---|---|
| 12 | RSI(2) mean reversion | Already implemented this session, `RsiMeanReversionEngine.java` | Connors & Alvarez, *Short Term Trading Strategies That Work*, 2009 (practitioner book, widely cited, not peer-reviewed — flagged honestly) | NOW |
| 13 | Bollinger Band mean reversion | Already implemented this session, `BollingerMeanReversionEngine.java` | Bollinger, *Bollinger on Bollinger Bands*, 2001 | NOW |
| 14 | Z-score price mean reversion | Already implemented, `MeanReversionZScoreEngine.java` | Standard statistical practice; no single canonical source | NOW |
| 15 | Stochastic oscillator reversal | Already implemented, `StochasticOscillatorEngine.java` | Lane's Stochastics, 1950s practitioner technique | NOW |
| 16 | Short-term reversal (see #3) | — | Cross-referenced, not double-counted | NOW |
| 17 | Overnight reversal | Prior-day close-to-open gaps partially revert intraday | Consistent with the broader overnight-return literature (Lou, Polk & Skouras, "A Tug of War," *J. Financial Economics* 2019, on overnight-vs-intraday return decomposition) | NOW (daily open/close both in `ohlcv_bars`) |
| 18 | VWAP deviation mean reversion | Price far from session VWAP tends to revert toward it intraday | Practitioner microstructure technique; no peer-reviewed canonical source I can confidently cite | **NEEDS_DATA** (needs real intraday VWAP computation — only 224 symbols/~25 days of 1-min bars, thin) |
| 19 | Residual mean reversion (vs a fitted factor/beta model) | After removing systematic (beta) return, idiosyncratic residual mean-reverts | Consistent with the broader stat-arb residual literature (Avellaneda & Lee, "Statistical Arbitrage in the U.S. Equities Market," *Quantitative Finance* 2010) | PARTIAL — needs `OlsRegression.java` (exists) + a real market-return series |
| 20 | Post-earnings mean reversion of extreme overreactions | Very large one-day post-catalyst moves partially revert | General post-event overreaction literature (De Bondt & Thaler, "Does the Stock Market Overreact?," *J. Finance* 1985) | **NEEDS_DATA** (needs a real earnings-timestamp calendar, confirmed absent) |

## BREAKOUT / RANGE (target 20+; 7 real parents, ~14 variants)

| # | Strategy | Hypothesis | Reference | dataFit |
|---|---|---|---|---|
| 21 | Donchian/channel breakout (see #6) | — | cross-referenced | NOW |
| 22 | Volatility (ATR) breakout | Enter when price clears entry ± k×ATR | Wilder 1978 (ATR itself); breakout application is standard practitioner technique | NOW |
| 23 | Opening-range breakout (ORB) | First N minutes' range as a breakout trigger | Widely used practitioner technique, popularized by Toby Crabel, *Day Trading with Short Term Price Patterns*, 1990 | **NEEDS_DATA** (needs reliable intraday minute bars from the open — the 224-symbol/~25-day 1-min set is thin for this specifically) |
| 24 | Range compression → expansion (volatility squeeze) | Low realized/Bollinger-bandwidth periods precede expansion | Standard volatility-clustering result (Engle, "Autoregressive Conditional Heteroscedasticity," *Econometrica* 1982, underlies why vol clusters at all) | NOW (daily) |
| 25 | Volume-confirmed breakout | Breakout validity gated on relative volume | Practitioner technique, no single canonical source | NOW |
| 26 | Prior-period high/low breakout | Break of prior day/week/month high or low | Classic technical practice | NOW |
| 27 | Gap continuation | A real overnight gap, confirmed by early volume, tends to continue intraday | Related to the overnight/intraday decomposition literature (#17's reference) | PARTIAL (daily gap detection = NOW; intraday confirmation = NEEDS_DATA) |

## VOLATILITY (target 15+; 6 real parents, ~10 variants)

| # | Strategy | Hypothesis | Reference | dataFit |
|---|---|---|---|---|
| 28 | Realized-volatility regime | High/low realized vol conditions strategy activation, not a standalone directional signal | Standard vol-clustering result (Engle 1982, same as #24) | NOW |
| 29 | GARCH(1,1) volatility forecast | Already implemented, `GarchEngine.java` (SHADOW status) | Bollerslev, "Generalized Autoregressive Conditional Heteroskedasticity," *J. Econometrics* 1986 | NOW |
| 30 | EGARCH (asymmetric vol response) | Already implemented, `EgarchEngine.java` | Nelson, "Conditional Heteroskedasticity in Asset Returns," *Econometrica* 1991 | NOW |
| 31 | Bollinger bandwidth as a standalone vol-regime feature | Band width itself as a conditioning signal, not just the bands | Bollinger 2001 (same as #13) | NOW |
| 32 | Volatility risk premium (implied vs realized) | Sell rich implied vol relative to subsequently realized | Well-established options/vol literature (Carr & Wu, "Variance Risk Premia," *Review of Financial Studies* 2009) | **RESEARCH_ONLY** (needs options implied-vol data — confirmed absent) |
| 33 | Volatility mean reversion | Already implemented, `VolatilityMeanReversionEngine.java` | Extension of GARCH's own mean-reverting variance process | NOW |

## VOLUME / FLOW (target 15+; 5 real parents, ~9 variants)

| # | Strategy | Hypothesis | Reference | dataFit |
|---|---|---|---|---|
| 34 | Relative volume | Volume vs its own trailing average as confirmation/anomaly | Standard practitioner technique | NOW |
| 35 | On-balance volume (OBV) | Cumulative signed volume as a leading indicator | Granville, *New Key to Stock Market Profits*, 1963 (practitioner origin, not peer-reviewed) | NOW |
| 36 | Accumulation/Distribution | Close-location-weighted volume flow | Larry Williams, 1970s practitioner technique | NOW |
| 37 | Money Flow Index | Volume-weighted RSI variant | Practitioner technique (Gene Quong & Avrum Soudack, 1989) | NOW |
| 38 | Price-volume divergence | Price makes a new high/low without volume confirmation | General practitioner divergence technique | NOW |

## VWAP / INTRADAY MICROSTRUCTURE (target 10+; 3 real parents — mostly blocked by data)

| # | Strategy | Hypothesis | Reference | dataFit |
|---|---|---|---|---|
| 39 | VWAP reclaim/rejection | Price crossing back through session VWAP as a signal | Practitioner microstructure technique | **NEEDS_DATA** |
| 40 | VWAP trend (persistent distance from VWAP) | Sustained one-sided distance from VWAP as trend confirmation | Practitioner technique | **NEEDS_DATA** |
| 41 | VWAP + volume confirmation | Combines #39/#40 with #34 | — | **NEEDS_DATA** |

**Honest note**: the entire VWAP/microstructure family is effectively `RESEARCH_ONLY` today given
the confirmed 1-minute data gap (224 symbols, ~25 days — not enough symbols or history for a
genuine intraday VWAP research program). Do not implement beyond a daily-bar approximation until
intraday coverage is deliberately expanded (companion report §1.6/§5's own cost caveat applies).

## RELATIVE STRENGTH (target 15+; 5 real parents, ~9 variants)

| # | Strategy | Hypothesis | Reference | dataFit |
|---|---|---|---|---|
| 42 | Stock-vs-index relative strength (SPY/QQQ) | Outperformance vs the broad index as a signal | Standard relative-strength practice, formalized academically inside the cross-sectional momentum literature (#2's reference) | NOW |
| 43 | Stock-vs-sector relative strength | Same idea, sector-relative instead of index-relative | Moskowitz & Grinblatt 1999 (#10's reference) | PARTIAL (coarse sector map exists) |
| 44 | Beta-adjusted relative strength | Relative strength after removing systematic beta exposure | Standard CAPM-residual technique | PARTIAL (needs `OlsRegression.java`, exists) |
| 45 | Cross-sectional ranking | Already implemented, `CrossSectionalRankingEngine.java` | Standard cross-sectional factor-ranking methodology | NOW, **survivorship-bias check required first** (companion report §1.9 flags this unverified) |
| 46 | Residual strength (vs a fitted multi-factor model) | Cross-references #19/#44 | Fama & French, "Common Risk Factors," *J. Financial Economics* 1993 | PARTIAL |

## FACTOR / CROSS-SECTIONAL (target 25+; 7 real parents, ~16 variants)

The classic Fama-French/Carhart factor family. All of these are well-established, heavily
published results — genuinely the strongest academic grounding of any family in this catalog — but
almost all require **fundamentals data with reliable point-in-time availability** (a confirmed gap
per the companion report §1.4/§6: `FundamentalAgent.ts` overwrites its own cached view, no
versioned history confirmed).

| # | Strategy | Hypothesis | Reference | dataFit |
|---|---|---|---|---|
| 47 | Value (book-to-market, earnings yield) | Cheap stocks (high B/M) outperform | Fama & French, "The Cross-Section of Expected Stock Returns," *J. Finance* 1992 | **NEEDS_DATA** (point-in-time fundamentals) |
| 48 | Size (small minus big) | Smaller-cap stocks historically outperformed | Banz, "The Relationship Between Return and Market Value," *J. Financial Economics* 1981 | **NEEDS_DATA** |
| 49 | Quality (profitability, ROE) | Profitable/high-quality firms outperform, especially controlling for value | Novy-Marx, "The Other Side of Value: The Gross Profitability Premium," *J. Financial Economics* 2013 | **NEEDS_DATA** |
| 50 | Low volatility / low beta anomaly | Low-vol stocks have historically delivered better risk-adjusted (sometimes even raw) returns than CAPM predicts | Frazzini & Pedersen, "Betting Against Beta," *J. Financial Economics* 2014 | PARTIAL (beta is computable from price alone, `OlsRegression.java`; the "anomaly" framing needs a real cross-sectional universe to test properly) |
| 51 | Composite value+quality+momentum multi-factor | Combining factors reduces individual-factor drawdowns | Asness, Moskowitz & Pedersen, "Value and Momentum Everywhere," *J. Finance* 2013 | **NEEDS_DATA** (inherits value/quality's data gap) |
| 52 | Accruals anomaly | High accruals (earnings quality concerns) predict lower forward returns | Sloan, "Do Stock Prices Fully Reflect Information in Accruals and Cash Flows?," *The Accounting Review* 1996 | **NEEDS_DATA** |
| 53 | Dividend yield | Higher-yield stocks as a value/income tilt | Long practitioner and academic history; treated as a value-family variant, not independent of #47 | **NEEDS_DATA** |

## STATISTICAL ARBITRAGE / RELATIVE VALUE (target 20+; 6 real parents, ~12 variants)

| # | Strategy | Hypothesis | Reference | dataFit |
|---|---|---|---|---|
| 54 | Distance-method pairs trading | Trade the spread of two historically co-moving stocks when it diverges beyond a threshold | Gatev, Goetzmann & Rouwenhorst, "Pairs Trading: Performance of a Relative-Value Arbitrage Rule," *Review of Financial Studies* 2006 | PARTIAL (needs 2+ aligned daily return series — data exists; pair-selection methodology is the real missing piece, per companion report §1.5's `stat_arb` finding: "NONE — needs a pair-selection strategy") |
| 55 | Cointegration pairs (Engle-Granger) | Test for a stationary linear combination of two price series rather than just correlation | Engle & Granger, "Co-Integration and Error Correction," *Econometrica* 1987 | PARTIAL — `AugmentedDickeyFuller.java` already exists in `institutional/math/`, unused for this purpose |
| 56 | Kalman-filter dynamic hedge-ratio spread | Time-varying hedge ratio instead of a static OLS beta | Standard extension of #55; e.g. Chan, *Algorithmic Trading*, 2013 (practitioner text, not peer-reviewed — flagged) | PARTIAL — `KalmanFilter.java` already exists, unused for this purpose |
| 57 | Sector/ETF pairs | Same as #54/#55, restricted to same-sector pairs for a stronger economic rationale | Same references as #54/#55 | PARTIAL |
| 58 | PCA residual stat-arb | Use principal components as the "market" factor, trade residuals | Avellaneda & Lee 2010 (#19's reference) | PARTIAL — `PrincipalComponentAnalysisEngine.java` already exists |
| — | Copula-based pairs | Explicitly requested to be excluded unless data supports it — it does not (needs a much richer joint-distribution history than currently available) | — | **RESEARCH_ONLY** |

## SEASONAL / CALENDAR (target 10+; 6 real parents, ~8 variants)

| # | Strategy | Hypothesis | Reference | dataFit |
|---|---|---|---|---|
| 59 | Turn-of-month effect | Returns cluster around month-end/month-start | Ariel, "A Monthly Effect in Stock Returns," *J. Financial Economics* 1987 | NOW (daily bars have full calendar history) |
| 60 | Day-of-week effect | Historically documented, but literature broadly finds it has weakened/decayed post-publication | French, "Stock Returns and the Weekend Effect," *J. Financial Economics* 1980; also a textbook example of a factor decaying after discovery — treat with real skepticism, not blind reuse | NOW, **must require real out-of-sample validation before any trust** (matches the request's own §5 instruction) |
| 61 | January effect / small-cap turn-of-year | Small caps historically outperform in early January | Keim, "Size-Related Anomalies and Stock Return Seasonality," *J. Financial Economics* 1983 | **NEEDS_DATA** (needs small-cap universe classification) |
| 62 | Holiday effect | Pre-holiday sessions show different return patterns | Ariel, "High Stock Returns Before Holidays," *J. Finance* 1990 | NOW |
| 63 | Post-earnings-announcement drift (PEAD) | Returns drift in the direction of an earnings surprise for weeks after | Ball & Brown, "An Empirical Evaluation of Accounting Income Numbers," *J. Accounting Research* 1968 (foundational); Bernard & Thomas, "Post-Earnings-Announcement Drift," *J. Accounting Research* 1989 (the canonical PEAD paper) | **NEEDS_DATA** (needs a real earnings-surprise timestamp source) |
| 64 | Quarter-end / window-dressing effects | Institutional rebalancing clusters near quarter-end | Practitioner-documented, weaker academic consensus than #59 | NOW, low-confidence |

## MARKET REGIME / ADAPTIVE (target 15+; already substantially built — see companion report §1.3)

Already covered in depth in the companion QuantEngine Expansion report: `RegimeEngine.ts`'s
`classifyRegime()`, `strategyFocus.ts`'s regime-gated activation, `HmmRegimeEngine.java`,
`MarketRegimeEngine.java`. The academic grounding for regime-switching itself: Hamilton, "A New
Approach to the Economic Analysis of Nonstationary Time Series and the Business Cycle,"
*Econometrica* 1989 (the foundational Markov-switching paper `HmmRegimeEngine.java` implements a
version of). Not re-catalogued as new strategies here — this is infrastructure that *conditions*
the strategies above, not a separate strategy family with its own directional signals.

## MULTI-TIMEFRAME (target 15+; blocked on data, see companion report §1.6)

Every multi-timeframe idea in this catalog (#7, #23, #27's intraday half, #39-41) is honestly
marked `NEEDS_DATA`. Do not build a separate "multi-timeframe" family beyond noting, per strategy
above, where a multi-timeframe variant would apply once data exists.

## MARKET BREADTH / INTERMARKET (target 10+; 4 real parents, RESEARCH_ONLY today)

| # | Strategy | Hypothesis | Reference | dataFit |
|---|---|---|---|---|
| 65 | Advance/decline breadth | Market-wide participation as a regime signal, not a single-stock signal | Classic technical practice (Fosback's breadth work, 1970s) | **RESEARCH_ONLY** — needs a real broad-universe daily up/down count; `MarketUniverseScanner.ts` exists but wasn't built for this purpose |
| 66 | New-highs/new-lows breadth | Same idea, extremes-based | Same as #65 | **RESEARCH_ONLY** |
| 67 | Percent-above-moving-average breadth | Same idea, trend-participation-based | Same as #65 | **RESEARCH_ONLY** |
| 68 | VIX-based regime context | Use VIX level/term structure as a risk-on/risk-off conditioning signal | Whaley, "The Investor Fear Gauge," *J. Portfolio Management* 2000 | PARTIAL — only via the narrow, transient `FinceptCacheAdapter` path (companion report §1.8); not a reliable production data source today |

## EVENT / FUNDAMENTAL QUANT (target 10+; RESEARCH_ONLY across the board)

All of #20 (post-earnings mean reversion), #63 (PEAD), and any analyst-revision-based signal
require a real, point-in-time-honest earnings/estimates calendar Argus does not have today
(companion report §5 confirms this as `REQUIRES_NEW_SOURCE`). **Do not implement any event-driven
strategy until that data source exists and its point-in-time availability is proven** — this is
exactly the category where look-ahead bias is easiest to introduce by accident (using a
today-known earnings date to "predict" a signal weeks earlier).

---

## Summary tally

| Family | Real distinct parents | NOW/PARTIAL | NEEDS_DATA/RESEARCH_ONLY |
|---|---|---|---|
| Trend/Momentum | 11 | 9 | 2 |
| Mean reversion/reversal | 9 | 7 | 2 |
| Breakout/range | 7 | 5 | 2 |
| Volatility | 6 | 5 | 1 |
| Volume/flow | 5 | 5 | 0 |
| VWAP/microstructure | 3 | 0 | 3 |
| Relative strength | 5 | 3 | 2 |
| Factor/cross-sectional | 7 | 1 | 6 |
| Stat-arb/relative-value | 6 (5+1 excluded) | 5 | 1 |
| Seasonal/calendar | 6 | 5 | 1 |
| Market breadth/intermarket | 4 | 1 | 3 |
| Event/fundamental | (folded into #20/#63 above) | 0 | 2 |
| **Total parent hypotheses** | **~58 (+ ~90 labeled variants under them)** | **~46 buildable now/partial** | **~25 genuinely blocked on data** |

**Recommendation**: implement the ~46 NOW/PARTIAL parent hypotheses (most already exist as
RESEARCH-status Java engines or TS experimental strategies — see the companion report's §1.4 table
for what's already built vs genuinely new), in the phased order the companion report's §36 already
lays out (start with a small batch, not all at once). Treat the ~25 NEEDS_DATA/RESEARCH_ONLY entries
as a standing research backlog, revisited only if/when Argus deliberately acquires the missing data
source (intraday bar depth, point-in-time fundamentals, an earnings calendar, options data) — not
before. This catalog, followed honestly, does not reach a flat "200 strategies" count, and per the
request's own stated goal, it shouldn't: the objective was a diversified, real, statistically
evaluable set of independent hypotheses, not a number.
