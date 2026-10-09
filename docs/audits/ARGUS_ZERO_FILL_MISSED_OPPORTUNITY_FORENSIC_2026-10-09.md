# Argus zero-fill / missed-opportunity forensic — October 9, 2026

## Scope and answer

Audit window: 2026-10-09T13:30:00.000Z inclusive to 2026-10-09T16:11:30.110Z exclusive (09:30:00–12:11:30 America/New_York). This is a partial intraday audit, not a closing-session report. Database queries were explicitly read-only, bounded and indexed; extraction coverage for every listed event type was complete. The running engine, environment, trading state and database were not changed during this mission.

**IS_ZERO_FILL_AN_EXECUTION_PROBLEM: NO for the observed window.** There were zero Chief approvals, zero risk-assessment events, zero submitted-order events, zero trade ledger rows and zero fill ledger rows. There is no submitted order whose limit price, broker rejection, cancellation or fill quality explains this result. This does not certify execution against future organic orders.

**Primary observed barrier:** upstream decision evidence and strategy authorization. Most completed consensus rounds ended below strong confidence; most also lacked enough independent evidence. These overlap and must not be added together. Discovery allocation and quantitative coverage are separate opportunity-loss mechanisms for individual names; their economic impact is unproven.

## Provenance and limits

- Active repository at audit: ea62053; deployed trading code/build f3ec4d2. The engine was restarted under the previous owner-authorized mission at 11:58:09.695 ET. This window spans both processes. Repairs cannot retroactively restore redacted historical payloads.
- Sources: persisted observability_events, quant_assessments, ohlcv_bars, trades, fills and trade_plans in data/argus.db; current deployed source; earlier read-only quant-readiness/resource endpoint responses. No external market-wide ranking was obtained.
- The sample is the 15 highest positive first recorded discovery returns among admitted names in the observed universe, five near-zero-return admitted controls, and five filtered headline examples. It is NOT an independently verified list of the market’s top 15 liquid common stocks. It includes ETFs/leveraged products. Control selection is descriptive, not a matched experiment or proof of failed setups.
- Discovery return is price versus the same-session open, sourced from ALPACA_IEX_SNAPSHOT. It is not previous-close gap or a full-day return. IEX dollar volume is venue-specific; null RVOL is unavailable evidence. Reported snapshot spread is not proof of independently fresh executable bid/ask.
- First logged discovery is not necessarily first awareness: RBLX, SNAP, SNOW and UBER had earlier subscription promotions. The table preserves both observations rather than inventing discovery timing.
- No IBKR_MARKET_DATA_ACKNOWLEDGED events were found. This is an acknowledgment-telemetry gap, not proof of zero ticks or zero provider quotes. Promotion/request does not prove acknowledgment, continued subscription or freshness.
- Existing cached bars lack an available-at timestamp. Quant assessments omit the complete input StrategyContext; persisted QuantEvidence carries aggregate scores, not all input bars/quotes/features. Exact independent point-in-time recomputation and a captureable-profit estimate are therefore NOT CERTIFIED. Current cached bars must not be treated as inputs known to the engine at the earlier decision.

## Session funnel

Counts are events unless explicitly labeled ledger rows; they are not a single one-to-one cohort. Multiple agents, cycles, promotions and decisions can concern the same symbol.

| Stage | Count |
|---|---:|
| DISCOVERY_CANDIDATE_ADMITTED | 727 |
| DISCOVERY_CANDIDATE_FILTERED | 4338 |
| SUBSCRIPTION_PROMOTED | 209 |
| SUBSCRIPTION_NOT_PROMOTED | 2005 |
| WATCHLIST_SUBSCRIBE_REQUESTED | 915 |
| IBKR_MARKET_DATA_ACKNOWLEDGED | 0 |
| QUANT_ASSESSMENT_COMPLETED | 371 |
| QUANT_EVIDENCE_PRODUCED | 280 |
| TRADE_IDEA_GENERATED | 10349 |
| STRATEGY_AUTHORIZATION_CHECKED | 51 |
| CHIEF_DECISION_POLICY_SELECTED | 51 |
| QUANT_POLICY_APPROVED | 0 |
| QUANT_POLICY_REJECTED | 0 |
| CHIEF_CONSENSUS_STARTED | 7708 |
| CHIEF_APPROVED_IDEA | 0 |
| CONSENSUS_TERMINAL_REASON | 7708 |
| RISK_ASSESSMENT_COMPLETED | 0 |
| ORDER_SUBMITTED | 0 |
| FILL_RECORDED | 0 |
| Distinct symbols in discovery records | 543 |
| Trade ledger rows | 0 |
| Fill ledger rows | 0 |

Idea producers: TechnicalAgent: 2483; MacroAgent: 3160; KronosEngine: 4655; QuantEngine: 31; JavaCoreEnsemble: 20.

| Terminal reason | Rounds |
|---|---:|
| CONFIDENCE_BELOW_STRONG | 7403 |
| AGENT_DATA_UNAVAILABLE | 151 |
| AGENT_HOLD | 140 |
| MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE | 13 |
| MODERATE_REJECT_CALIBRATION | 1 |

7253/7708 rounds reported fewer independent groups than required; 7404 rounds included at least one participating agent whose confidence was below raw signal strength. Group counts: {"0":291,"1":6962,"2":455}. These are associations, not proof that changing calibration or independence would produce a valid trade.

## Per-symbol opportunity table

P/R = promotion events / subscription-request events. ACK and point-in-time freshness remain UNKNOWN for every row. A zero quant assessment does not mean every other agent ignored the symbol. Chief decisions and risk/order counts are per-symbol event observations, not trace-matched causal chains.

| Symbol / sample | Observed return | First discovery ET | P/R | Quant assessments | Ideas / Chief rounds | First demonstrated boundary or limit | Risk / orders / fills |
|---|---:|---|---|---:|---|---|---|
| MRNA / MOVER | 8.09% | 10:27:41 | 4/4 | 0 | 22/13 | No Quant assessment; other-agent consensus rejected | 0 / 0 / 0 |
| RBLX / MOVER | 6.33% | 10:58:28 | 5/5 | 1 | 85/69 | Chief did not approve; strategy/authorization detail below | 0 / 0 / 0 |
| PCVX / MOVER | 5.06% | 10:58:28 | 0/0 | 0 | 0/0 | Not promoted: SWAP_CAP_REACHED | 0 / 0 / 0 |
| SNAP / MOVER | 4.45% | 10:58:28 | 6/6 | 4 | 90/70 | Chief did not approve; strategy/authorization detail below | 0 / 0 / 0 |
| CRCL / MOVER | 3.28% | 11:14:34 | 1/1 | 0 | 0/0 | Promoted/requested, no Quant assessment observed | 0 / 0 / 0 |
| MRK / MOVER | 2.96% | 10:12:28 | 2/3 | 5 | 129/91 | Chief did not approve; strategy/authorization detail below | 0 / 0 / 0 |
| TSLG / MOVER | 2.90% | 10:58:28 | 0/0 | 0 | 0/0 | Not promoted: SWAP_CAP_REACHED | 0 / 0 / 0 |
| CF / MOVER | 2.68% | 10:58:28 | 0/0 | 0 | 0/0 | Not promoted: INCUMBENT_NOT_EVICTABLE | 0 / 0 / 0 |
| SNOW / MOVER | 2.64% | 10:12:28 | 2/2 | 3 | 114/84 | Chief did not approve; strategy/authorization detail below | 0 / 0 / 0 |
| PBR / MOVER | 2.45% | 10:12:28 | 0/0 | 0 | 0/0 | Not promoted: SWAP_CAP_REACHED | 0 / 0 / 0 |
| T / MOVER | 2.32% | 10:12:28 | 0/0 | 0 | 0/0 | Not promoted: SWAP_CAP_REACHED | 0 / 0 / 0 |
| IBB / MOVER | 2.31% | 10:12:27 | 0/0 | 0 | 0/0 | Not promoted: SWAP_CAP_REACHED | 0 / 0 / 0 |
| UBER / MOVER | 2.23% | 10:12:28 | 2/2 | 2 | 116/88 | Chief did not approve; strategy/authorization detail below | 0 / 0 / 0 |
| CPNG / MOVER | 2.23% | 11:14:34 | 0/0 | 0 | 0/0 | Admitted; downstream handoff not demonstrated | 0 / 0 / 0 |
| PBR.A / MOVER | 2.03% | 10:27:41 | 0/0 | 0 | 0/0 | Not promoted: SWAP_CAP_REACHED | 0 / 0 / 0 |
| SGOV / CONTROL | 0.00% | 10:12:28 | 0/0 | 0 | 0/0 | Admitted; downstream handoff not demonstrated | 0 / 0 / 0 |
| DUK / CONTROL | -0.01% | 10:27:41 | 0/0 | 0 | 0/0 | Admitted; downstream handoff not demonstrated | 0 / 0 / 0 |
| MS / CONTROL | -0.02% | 10:27:41 | 0/0 | 0 | 0/0 | Not promoted: SWAP_CAP_REACHED | 0 / 0 / 0 |
| VCSH / CONTROL | -0.02% | 10:27:41 | 0/0 | 0 | 0/0 | Admitted; downstream handoff not demonstrated | 0 / 0 / 0 |
| IGSB / CONTROL | -0.03% | 10:58:28 | 0/0 | 0 | 0/0 | Admitted; downstream handoff not demonstrated | 0 / 0 / 0 |
| OFAL / FILTERED_HEADLINE | 36.89% | 09:53:51 | 0/0 | 0 | 0/0 | Discovery filter: PRICE | 0 / 0 / 0 |
| FRGT / FILTERED_HEADLINE | 16.28% | 09:53:51 | 0/0 | 0 | 0/0 | Discovery filter: PRICE | 0 / 0 / 0 |
| MOGU / FILTERED_HEADLINE | 14.05% | 10:34:50 | 0/0 | 0 | 0/0 | Discovery filter: PRICE | 0 / 0 / 0 |
| WFF / FILTERED_HEADLINE | 13.16% | 09:53:51 | 0/0 | 0 | 0/0 | Discovery filter: PRICE | 0 / 0 / 0 |
| SOAR / FILTERED_HEADLINE | 12.62% | 09:53:51 | 0/0 | 0 | 0/0 | Discovery filter: PRICE | 0 / 0 / 0 |

## Allocation reconstruction

### MRNA

- 10:29:49 ET: CHALLENGER_SELECTED; Beat weakest active dynamic symbol TXN (1.048) by more than the hysteresis edge (0.15).
- 10:32:25 ET: INCUMBENT_NOT_EVICTABLE; No streaming slots available and no non-core dynamic symbol eligible to displace.
- 10:35:06 ET: CHALLENGER_SELECTED; Beat weakest active dynamic symbol AMAT (0.667) by more than the hysteresis edge (0.15).
- 10:40:15 ET: SWAP_CAP_REACHED; Hot-swap cap reached this cycle (1 slot(s)) before this candidate was reached.

### RBLX

- 09:47:56 ET: CHALLENGER_SELECTED; Filled an empty streaming slot (35 available).
- 10:36:06 ET: CHALLENGER_SELECTED; Beat weakest active dynamic symbol TSM (1.183) by more than the hysteresis edge (0.15).

### PCVX

- 11:15:01 ET: SWAP_CAP_REACHED; Hot-swap cap reached this cycle (1 slot(s)) before this candidate was reached.

### SNAP

- 09:47:56 ET: CHALLENGER_SELECTED; Filled an empty streaming slot (38 available).
- 10:35:06 ET: SWAP_CAP_REACHED; Hot-swap cap reached this cycle (1 slot(s)) before this candidate was reached.
- 10:36:06 ET: SWAP_CAP_REACHED; Hot-swap cap reached this cycle (1 slot(s)) before this candidate was reached.
- 10:37:13 ET: CHALLENGER_SELECTED; Beat weakest active dynamic symbol DIA (0.567) by more than the hysteresis edge (0.15).

### CRCL

- 11:21:15 ET: CHALLENGER_SELECTED; Beat weakest active dynamic symbol DELL (0.843) by more than the hysteresis edge (0.15).

### MRK

- 11:50:45 ET: CHALLENGER_SELECTED; Beat weakest active dynamic symbol MRVL (1.421) by more than the hysteresis edge (0.15).
- 12:01:43 ET: CHALLENGER_SELECTED; Filled an empty streaming slot (37 available).

### TSLG

- 11:07:44 ET: SWAP_CAP_REACHED; Hot-swap cap reached this cycle (1 slot(s)) before this candidate was reached.

### CF

- 11:08:22 ET: INCUMBENT_NOT_EVICTABLE; No streaming slots available and no non-core dynamic symbol eligible to displace.

### SNOW

- 09:47:56 ET: CHALLENGER_SELECTED; Filled an empty streaming slot (33 available).
- 12:01:07 ET: CHALLENGER_SELECTED; Filled an empty streaming slot (56 available).

### PBR

- 10:14:49 ET: SWAP_CAP_REACHED; Hot-swap cap reached this cycle (1 slot(s)) before this candidate was reached.
- 10:18:42 ET: SWAP_CAP_REACHED; Hot-swap cap reached this cycle (1 slot(s)) before this candidate was reached.

### T

- 10:12:57 ET: SWAP_CAP_REACHED; Hot-swap cap reached this cycle (1 slot(s)) before this candidate was reached.
- 10:13:50 ET: OTHER; Score 1.162 does not beat the weakest active dynamic symbol (PFE: 2.409) by the required hysteresis edge (0.15) - prevents subscription thrashing.

### IBB

- 10:29:09 ET: SWAP_CAP_REACHED; Hot-swap cap reached this cycle (1 slot(s)) before this candidate was reached.
- 10:45:27 ET: SWAP_CAP_REACHED; Hot-swap cap reached this cycle (1 slot(s)) before this candidate was reached.

### UBER

- 09:47:56 ET: CHALLENGER_SELECTED; Filled an empty streaming slot (26 available).
- 10:51:37 ET: INCUMBENT_NOT_EVICTABLE; No streaming slots available and no non-core dynamic symbol eligible to displace.
- 12:01:07 ET: CHALLENGER_SELECTED; Filled an empty streaming slot (45 available).

### PBR.A

- 10:40:15 ET: SWAP_CAP_REACHED; Hot-swap cap reached this cycle (1 slot(s)) before this candidate was reached.
- 11:02:34 ET: SWAP_CAP_REACHED; Hot-swap cap reached this cycle (1 slot(s)) before this candidate was reached.

### MS

- 10:46:38 ET: SWAP_CAP_REACHED; Hot-swap cap reached this cycle (1 slot(s)) before this candidate was reached.
- 10:47:21 ET: SWAP_CAP_REACHED; Hot-swap cap reached this cycle (1 slot(s)) before this candidate was reached.

The recorded swap-cap, hysteresis and non-evictable-incumbent decisions establish why these specific cycles refused promotion. They do not establish that the ranking was economically wrong. Complete per-cycle competitor scores, fresh inputs and subsequent executable opportunities are needed before calling this a starvation defect. MRNA was repeatedly promoted yet recorded no Quant assessment: subscription promotion alone plainly does not certify quantitative coverage.

## Strategy and authorization findings

Quantitative base timeframe in every sampled persisted assessment was 1Day. The current agent optionally fetches intraday bars for the ORB experiment and selected features; daily CORE context is not inherently erroneous, but it cannot establish coverage of an intraday breakout merely because the stock rose.

The current quant-readiness diagnostic returned 21 strategies: 0 authorized Quant-policy, 0 requiring consensus, 1 ineligible and 20 not authorized due to missing lifecycle. Eligible IDs were empty. This is verified current readiness evidence, not retrospective proof of each pre-restart authorization. Missing lifecycle must remain fail closed; fabricate neither performance nor promotion.

There were 51 authorization checks and 51 policy-selection events, but zero Quant-policy approval or rejection events in the window. Several sampled pre-restart authorization/reason values are [REDACTED]. Thus the policy evaluator’s organic authorized branch was not demonstrated. Absence of policy approvals alone does not prove its implementation is broken.

No trade-plan rows were found with plan_date=2026-10-09 and created_at before the audit cutoff (query cap 1,001 not reached). This is absence of durable plans, not proof that an AI provider failed or that every agent required a plan.

### Exact recorded strategy conditions

These are persisted production outputs, NOT independently recomputed formulas. The complete first assessment per evaluated sample is listed to avoid selecting only bullish triggers. Trigger=true is not equivalent to full strategy eligibility, cost-backed positive EV, lifecycle authorization or Chief approval.

#### RBLX: 11:27:24 ET, 1Day, SIDEWAYS_RANGE

- **SR_BOUNCE**: BUY; confidence 0.4; trigger=false; setupScore=75. Met: Nearest support and/or resistance exists; Price within 0.4% of the nearer boundary; Not a volume-spike breakout (RVOL below breakout threshold). Failed: Bullish reversal candle. Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **VWAP_MEAN_REVERSION**: SELL; confidence 0.67; trigger=true; setupScore=67. Met: Ranging / non-trending regime; Extended above VWAP (distancePct >= 1); Volume not a trend-day expansion (RVOL < 1.5); VWAP rejection print (or still above waiting rejection). Failed: ADX below range ceiling (< 20); Bearish reversal candlestick. Contradictions: none.
- **OSCILLATOR_MOMENTUM**: SELL; confidence 0.34; trigger=true; setupScore=67. Met: RSI below midline (50); MACD histogram negative; ROC < 0; ADX not dead (< 25 still allowed as confirmation only if DI aligned). Failed: -DI > +DI; Favorable market regime. Contradictions: none.
- **RANGE_REVERSION**: BUY; confidence 0.6; trigger=true; setupScore=60. Met: Price near the range support boundary; No real volume spike (a genuine breakout would show one); No real structural break in the fade direction (range still holding). Failed: Range regime confirmed (RANGING market structure + real consolidation); RSI showing weakness at the boundary (<=40). Contradictions: none.
- **FIBONACCI_PULLBACK**: SELL; confidence 0.2; trigger=false; setupScore=60. Met: Fibonacci retracement of the trailing daily range is available; RSI in a healthy (non-extreme) pullback zone; Volume not exploding (RVOL < breakout threshold — pullback, not a new breakout). Failed: Price near 61.8% retracement (within 0.35%); Downtrend structure or bearish regime. Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **VOLUME_CONFIRMATION**: SELL; confidence 0.2; trigger=false; setupScore=60. Met: Chaikin Money Flow < 0; MFI < 50; Structure not printing BOS_BULLISH. Failed: RVOL spike (>= 2x) or isSpike flag; Favorable market regime. Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **PULLBACK_CONTINUATION**: SELL; confidence 0.2; trigger=false; setupScore=50. Met: RSI in a healthy (non-extreme) pullback zone; Volume contracted during the pullback (below average - lack of opposing pressure); No structural reversal against the trend (no opposing CHoCH). Failed: Established downtrend (market structure + regime); Price pulled back to/near SMA20 without breaking decisively through it; Bearish reversal candlestick at the pullback high. Contradictions: DMI shows +DI > -DI despite a bearish pullback setup - directional momentum has already flipped bullish.; Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **OPENING_RANGE_BREAKOUT**: SELL; confidence 0.5; trigger=true; setupScore=50. Met: Opening range resolved (30m window); Close below opening-range low; Prior-day low available as range context (not a fabricated PDL). Failed: RVOL confirmation (>= 2x); Price below session VWAP; Directional regime (not fading a range as a default). Contradictions: Regime is SIDEWAYS_RANGE on an OR break — elevated false-break risk..
- **MA_CROSSOVER**: SELL; confidence 0.25; trigger=true; setupScore=50. Met: SMA50 and SMA200 available; SMA50 below SMA200 (death-cross stack); EMA9 below EMA20. Failed: Price below SMA50; ADX trend strength (>= 25); Favorable market regime. Contradictions: none.
- **CANDLESTICK_REVERSAL**: BUY; confidence 0.4; trigger=false; setupScore=50. Met: Near support (within 0.4%); RSI not already overbought. Failed: A detected candlestick pattern is present; Bullish reversal candle (hammer/engulfing/doji). Contradictions: No matching 1–2 bar pattern in PriceActionFeatures — other named candles are not separately detected.; Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **RELATIVE_STRENGTH_ROTATION**: SELL; confidence 0.25; trigger=true; setupScore=50. Met: Relative strength vs SPY is available (not fabricated); Negative relative strength vs SPY; Stock period % < 0 while SPY period % > 0 (RW while SPY is up); EMA9 < EMA20 (existing EMAs; Argus does not compute EMA8/EMA21). Failed: Favorable market regime; Favorable sector regime when a sector ETF trend exists; ADX trend strength (>= 25); Bearish daily stack (price < SMA50 < SMA200). Contradictions: No market-breadth data source (advance/decline, new highs/lows) exists in this codebase - not fabricated from the handful of symbols fetched here..
- **PREVIOUS_PERIOD_BREAKOUT**: BUY; confidence 0.2; trigger=true; setupScore=40. Met: Previous-day high/low available; Close above previous-day high. Failed: RVOL confirmation (>= 2x); ATR expansion (volatility regime EXPANDING); Favorable market regime. Contradictions: none.
- **STATISTICAL_MEAN_REVERSION**: BUY; confidence 0.4; trigger=false; setupScore=40. Met: Close z-score available (20-bar window); Ranging regime (not fading a trend as a default). Failed: Close z-score <= -2.5; RSI oversold (<= 30); ADX below range ceiling (< 20). Contradictions: none.
- **MEAN_REVERSION**: BUY; confidence 0.2; trigger=false; setupScore=20. Met: Ranging / non-trending regime (not a real directional trend). Failed: RSI oversold (<=30); Price at/below the lower Keltner Channel; Stochastic RSI confirming oversold (<=20); Bullish reversal candlestick. Contradictions: none.
- **BOLLINGER_VOLATILITY**: BUY; confidence 0.2; trigger=false; setupScore=20. Met: Bollinger width available (squeeze is prior-bar state; not required on the same print as EXPANDING). Failed: Price above upper Keltner (expansion break); Volatility regime EXPANDING on the break; RVOL confirmation (>= 1.5x); ADX trend strength (>= 25). Contradictions: none.
- **GAP_CONTINUATION**: BUY; confidence 0.1; trigger=false; setupScore=20. Met: Price above session VWAP. Failed: Gap up vs prior UTC-day close; Gap size >= 0.5%; RVOL confirmation (>= 2x); Favorable market regime. Contradictions: No gap vs prior UTC-day close (threshold in detectGap) — not a fabricated earnings/news gap..
- **DONCHIAN_CHANNEL_BREAKOUT**: BUY; confidence 0.09; trigger=false; setupScore=17. Met: Prior 20-bar channel available (current bar excluded). Failed: Close above prior-channel high; ADX trend strength (>= 25); RVOL confirmation (>= 1.5x); Favorable market regime; ATR expansion (volatility regime EXPANDING). Contradictions: none.
- **MOMENTUM_BREAKOUT**: BUY; confidence 0.07; trigger=false; setupScore=13. Met: Price above session VWAP. Failed: Structural break in trade direction (BOS); RVOL confirmation (>=1.5x average volume); ATR expansion (volatility regime EXPANDING); Favorable market regime; Favorable sector regime; Positive relative strength vs SPY; Positive momentum (ROC > 0). Contradictions: none.
- **TREND_FOLLOWING**: BUY; confidence 0; trigger=false; setupScore=0. Met: none. Failed: Strong BULLISH_TREND regime (trendStrength >= 50); Market structure real TRENDING (not ranging/choppy); Moving averages ordered bullishly (SMA20 > SMA50 > SMA200); DMI +DI > -DI with real ADX trend strength; MACD bullish (line above signal); Chaikin Money Flow confirming accumulation (CMF > 0). Contradictions: Price is below SMA200 despite a bullish trend-following signal - the long-term trend disagrees with the short/medium-term read..
- **SMC_LIQUIDITY_SWEEP**: BUY; confidence 0; trigger=false; setupScore=0. Met: Liquidity identified (swing or equal high/low). Failed: Liquidity swept (wick beyond level, close back inside — not a trade by itself); CHoCH confirmation in reversal direction (required — sweep without CHoCH is ignored as a trade); Displacement in trade direction; Order block in trade direction; Unfilled FVG in trade direction; Volume confirmation (RVOL >= 1.2); Same-timeframe regime alignment (not a higher-timeframe read — this stack evaluates one bar timeframe per cycle). Contradictions: No liquidity sweep: SMC does not treat BOS/CHoCH or an indicator print as an automatic entry..
- **VWAP_VOLUME_STRUCTURE**: SELL; confidence 0; trigger=false; setupScore=0. Met: none. Failed: Established downtrend (market structure); Price at or below session VWAP; Pullback toward VWAP (|distancePct| <= 0.35); RVOL confirmation (>= 1.5x); ADX trend strength (>= 25); Bearish rejection candle (shooting star / engulfing). Contradictions: none.

#### SNAP: 10:07:25 ET, 1Day, BULLISH_TREND

- **FIBONACCI_PULLBACK**: BUY; confidence 0.4; trigger=false; setupScore=80. Met: Fibonacci retracement of the trailing daily range is available; Uptrend structure or bullish regime; RSI in a healthy (non-extreme) pullback zone; Volume not exploding (RVOL < breakout threshold — pullback, not a new breakout). Failed: Price near 61.8% retracement (within 0.35%). Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **SR_BOUNCE**: BUY; confidence 0.4; trigger=false; setupScore=75. Met: Nearest support and/or resistance exists; Price within 0.4% of the nearer boundary; Not a volume-spike breakout (RVOL below breakout threshold). Failed: Bullish reversal candle. Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **PULLBACK_CONTINUATION**: BUY; confidence 0.4; trigger=false; setupScore=67. Met: Price pulled back to/near SMA20 without breaking decisively through it; RSI in a healthy (non-extreme) pullback zone; Volume contracted during the pullback (below average - lack of opposing pressure); No structural reversal against the trend (no opposing CHoCH). Failed: Established uptrend (market structure + regime); Bullish reversal candlestick at the pullback low. Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **MA_CROSSOVER**: BUY; confidence 0.67; trigger=true; setupScore=67. Met: SMA50 and SMA200 available; SMA50 above SMA200 (golden-cross stack); Price above SMA50; Favorable market regime. Failed: EMA9 above EMA20; ADX trend strength (>= 25). Contradictions: none.
- **OSCILLATOR_MOMENTUM**: BUY; confidence 0.4; trigger=false; setupScore=67. Met: RSI above midline (50); ADX not dead (< 25 still allowed as confirmation only if DI aligned); +DI > -DI; Favorable market regime. Failed: MACD histogram positive; ROC > 0. Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **RANGE_REVERSION**: BUY; confidence 0.3; trigger=true; setupScore=60. Met: Price near the range support boundary; No real volume spike (a genuine breakout would show one); No real structural break in the fade direction (range still holding). Failed: Range regime confirmed (RANGING market structure + real consolidation); RSI showing weakness at the boundary (<=40). Contradictions: none.
- **PREVIOUS_PERIOD_BREAKOUT**: BUY; confidence 0.6; trigger=true; setupScore=60. Met: Previous-day high/low available; Close above previous-day high; Favorable market regime. Failed: RVOL confirmation (>= 2x); ATR expansion (volatility regime EXPANDING). Contradictions: none.
- **GAP_CONTINUATION**: BUY; confidence 0.6; trigger=true; setupScore=60. Met: Gap up vs prior UTC-day close; Gap size >= 0.5%; Favorable market regime. Failed: RVOL confirmation (>= 2x); Price above session VWAP. Contradictions: none.
- **CANDLESTICK_REVERSAL**: BUY; confidence 0.4; trigger=false; setupScore=50. Met: Near support (within 0.4%); RSI not already overbought. Failed: A detected candlestick pattern is present; Bullish reversal candle (hammer/engulfing/doji). Contradictions: No matching 1–2 bar pattern in PriceActionFeatures — other named candles are not separately detected.; Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **RELATIVE_STRENGTH_ROTATION**: SELL; confidence 0.5; trigger=true; setupScore=50. Met: Relative strength vs SPY is available (not fabricated); Negative relative strength vs SPY; Stock period % < 0 while SPY period % > 0 (RW while SPY is up); EMA9 < EMA20 (existing EMAs; Argus does not compute EMA8/EMA21). Failed: Favorable market regime; Favorable sector regime when a sector ETF trend exists; ADX trend strength (>= 25); Bearish daily stack (price < SMA50 < SMA200). Contradictions: No market-breadth data source (advance/decline, new highs/lows) exists in this codebase - not fabricated from the handful of symbols fetched here..
- **VOLUME_CONFIRMATION**: SELL; confidence 0.4; trigger=false; setupScore=40. Met: Chaikin Money Flow < 0; Structure not printing BOS_BULLISH. Failed: RVOL spike (>= 2x) or isSpike flag; MFI < 50; Favorable market regime. Contradictions: none.
- **OPENING_RANGE_BREAKOUT**: BUY; confidence 0.33; trigger=false; setupScore=33. Met: Directional regime (not fading a range as a default); Prior-day high available as range context (not a fabricated PDH). Failed: Opening range available (intraday bars required): Only daily-granularity bars available - opening range requires intraday bars.; Close above opening-range high; RVOL confirmation (>= 2x); Price above session VWAP. Contradictions: No opening range: daily bars cannot produce an ORB. This is HOLD evidence, not a skip of the condition..
- **DONCHIAN_CHANNEL_BREAKOUT**: BUY; confidence 0.33; trigger=false; setupScore=33. Met: Prior 20-bar channel available (current bar excluded); Favorable market regime. Failed: Close above prior-channel high; ADX trend strength (>= 25); RVOL confirmation (>= 1.5x); ATR expansion (volatility regime EXPANDING). Contradictions: none.
- **BOLLINGER_VOLATILITY**: BUY; confidence 0.2; trigger=false; setupScore=20. Met: Bollinger width available (squeeze is prior-bar state; not required on the same print as EXPANDING). Failed: Price above upper Keltner (expansion break); Volatility regime EXPANDING on the break; RVOL confirmation (>= 1.5x); ADX trend strength (>= 25). Contradictions: none.
- **STATISTICAL_MEAN_REVERSION**: BUY; confidence 0.1; trigger=false; setupScore=20. Met: Close z-score available (20-bar window). Failed: Close z-score <= -2.5; RSI oversold (<= 30); Ranging regime (not fading a trend as a default); ADX below range ceiling (< 20). Contradictions: none.
- **TREND_FOLLOWING**: BUY; confidence 0.17; trigger=false; setupScore=17. Met: Moving averages ordered bullishly (SMA20 > SMA50 > SMA200). Failed: Strong BULLISH_TREND regime (trendStrength >= 50); Market structure real TRENDING (not ranging/choppy); DMI +DI > -DI with real ADX trend strength; MACD bullish (line above signal); Chaikin Money Flow confirming accumulation (CMF > 0). Contradictions: none.
- **VWAP_MEAN_REVERSION**: BUY; confidence 0.09; trigger=false; setupScore=17. Met: Volume not a trend-day expansion (RVOL < 1.5). Failed: Ranging / non-trending regime; Extended below VWAP (distancePct <= -1); ADX below range ceiling (< 20); Bullish reversal candlestick; VWAP reclaim print (or still below waiting reclaim). Contradictions: No genuine session VWAP (real intraday bars required) — the extension read is not a real VWAP deviation..
- **MOMENTUM_BREAKOUT**: BUY; confidence 0.13; trigger=false; setupScore=13. Met: Favorable market regime. Failed: Structural break in trade direction (BOS); RVOL confirmation (>=1.5x average volume); ATR expansion (volatility regime EXPANDING); Price above session VWAP; Favorable sector regime; Positive relative strength vs SPY; Positive momentum (ROC > 0). Contradictions: none.
- **MEAN_REVERSION**: BUY; confidence 0; trigger=false; setupScore=0. Met: none. Failed: Ranging / non-trending regime (not a real directional trend); RSI oversold (<=30); Price at/below the lower Keltner Channel; Stochastic RSI confirming oversold (<=20); Bullish reversal candlestick. Contradictions: none.
- **SMC_LIQUIDITY_SWEEP**: BUY; confidence 0; trigger=false; setupScore=0. Met: Liquidity identified (swing or equal high/low); Liquidity swept (wick beyond level, close back inside — not a trade by itself); Unfilled FVG in trade direction; Same-timeframe regime alignment (not a higher-timeframe read — this stack evaluates one bar timeframe per cycle). Failed: CHoCH confirmation in reversal direction (required — sweep without CHoCH is ignored as a trade); Displacement in trade direction; Order block in trade direction; Volume confirmation (RVOL >= 1.2). Contradictions: Sweep without CHoCH confirmation — wait; do not fade the breakout on the sweep bar alone.; Wick sweep of sell-side liquidity then close back inside. Pattern classification only — not evidence of intentional institutional manipulation..
- **VWAP_VOLUME_STRUCTURE**: BUY; confidence 0; trigger=false; setupScore=0. Met: none. Failed: Established uptrend (market structure); Price at or above session VWAP; Pullback toward VWAP (|distancePct| <= 0.35); RVOL confirmation (>= 1.5x); ADX trend strength (>= 25); Bullish rejection candle (hammer / engulfing). Contradictions: No genuine session VWAP (real intraday bars required) — the VWAP anchor is not real on this bar set..

#### MRK: 10:21:18 ET, 1Day, SIDEWAYS_RANGE

- **OSCILLATOR_MOMENTUM**: SELL; confidence 0.42; trigger=true; setupScore=83. Met: RSI below midline (50); MACD histogram negative; ROC < 0; ADX not dead (< 25 still allowed as confirmation only if DI aligned); -DI > +DI. Failed: Favorable market regime. Contradictions: none.
- **RANGE_REVERSION**: SELL; confidence 0.6; trigger=true; setupScore=60. Met: Price near the range resistance boundary; No real volume spike (a genuine breakout would show one); No real structural break in the fade direction (range still holding). Failed: Range regime confirmed (RANGING market structure + real consolidation); RSI showing strength at the boundary (>=60). Contradictions: none.
- **FIBONACCI_PULLBACK**: SELL; confidence 0.2; trigger=false; setupScore=60. Met: Fibonacci retracement of the trailing daily range is available; RSI in a healthy (non-extreme) pullback zone; Volume not exploding (RVOL < breakout threshold — pullback, not a new breakout). Failed: Price near 61.8% retracement (within 0.35%); Downtrend structure or bearish regime. Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **PULLBACK_CONTINUATION**: SELL; confidence 0.2; trigger=false; setupScore=50. Met: RSI in a healthy (non-extreme) pullback zone; Volume contracted during the pullback (below average - lack of opposing pressure); No structural reversal against the trend (no opposing CHoCH). Failed: Established downtrend (market structure + regime); Price pulled back to/near SMA20 without breaking decisively through it; Bearish reversal candlestick at the pullback high. Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **SR_BOUNCE**: SELL; confidence 0.4; trigger=false; setupScore=50. Met: Nearest support and/or resistance exists; Not a volume-spike breakout (RVOL below breakout threshold). Failed: Price within 0.4% of the nearer boundary; Bearish reversal candle. Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **MEAN_REVERSION**: BUY; confidence 0.4; trigger=false; setupScore=40. Met: Ranging / non-trending regime (not a real directional trend); Stochastic RSI confirming oversold (<=20). Failed: RSI oversold (<=30); Price at/below the lower Keltner Channel; Bullish reversal candlestick. Contradictions: none.
- **PREVIOUS_PERIOD_BREAKOUT**: SELL; confidence 0.2; trigger=true; setupScore=40. Met: Previous-day high/low available; Close below previous-day low. Failed: RVOL confirmation (>= 2x); ATR expansion (volatility regime EXPANDING); Favorable market regime. Contradictions: none.
- **VOLUME_CONFIRMATION**: SELL; confidence 0.2; trigger=false; setupScore=40. Met: Chaikin Money Flow < 0; Structure not printing BOS_BULLISH. Failed: RVOL spike (>= 2x) or isSpike flag; MFI < 50; Favorable market regime. Contradictions: none.
- **STATISTICAL_MEAN_REVERSION**: BUY; confidence 0.4; trigger=false; setupScore=40. Met: Close z-score available (20-bar window); Ranging regime (not fading a trend as a default). Failed: Close z-score <= -2.5; RSI oversold (<= 30); ADX below range ceiling (< 20). Contradictions: none.
- **RELATIVE_STRENGTH_ROTATION**: BUY; confidence 0.19; trigger=true; setupScore=38. Met: Relative strength vs SPY is available (not fabricated); Positive relative strength vs SPY; Favorable sector regime when a sector ETF trend exists. Failed: Favorable market regime; ADX trend strength (>= 25); Stock period % > 0 while SPY period % < 0 (RS while SPY is down); Bullish daily stack (price > SMA50 > SMA200); EMA9 > EMA20 (existing EMAs; Argus does not compute EMA8/EMA21). Contradictions: No market-breadth data source (advance/decline, new highs/lows) exists in this codebase - not fabricated from the handful of symbols fetched here..
- **VWAP_MEAN_REVERSION**: BUY; confidence 0.33; trigger=false; setupScore=33. Met: Ranging / non-trending regime; Volume not a trend-day expansion (RVOL < 1.5). Failed: Extended below VWAP (distancePct <= -1); ADX below range ceiling (< 20); Bullish reversal candlestick; VWAP reclaim print (or still below waiting reclaim). Contradictions: No genuine session VWAP (real intraday bars required) — the extension read is not a real VWAP deviation..
- **DONCHIAN_CHANNEL_BREAKOUT**: SELL; confidence 0.17; trigger=true; setupScore=33. Met: Prior 20-bar channel available (current bar excluded); Close below prior-channel low. Failed: ADX trend strength (>= 25); RVOL confirmation (>= 1.5x); Favorable market regime; ATR expansion (volatility regime EXPANDING). Contradictions: none.
- **MA_CROSSOVER**: BUY; confidence 0.17; trigger=true; setupScore=33. Met: SMA50 and SMA200 available; SMA50 above SMA200 (golden-cross stack). Failed: EMA9 above EMA20; Price above SMA50; ADX trend strength (>= 25); Favorable market regime. Contradictions: none.
- **MOMENTUM_BREAKOUT**: BUY; confidence 0.13; trigger=false; setupScore=25. Met: Favorable sector regime; Positive relative strength vs SPY. Failed: Structural break in trade direction (BOS); RVOL confirmation (>=1.5x average volume); ATR expansion (volatility regime EXPANDING); Price above session VWAP; Favorable market regime; Positive momentum (ROC > 0). Contradictions: none.
- **CANDLESTICK_REVERSAL**: BUY; confidence 0.25; trigger=false; setupScore=25. Met: RSI not already overbought. Failed: A detected candlestick pattern is present; Bullish reversal candle (hammer/engulfing/doji); Near support (within 0.4%). Contradictions: No matching 1–2 bar pattern in PriceActionFeatures — other named candles are not separately detected..
- **BOLLINGER_VOLATILITY**: BUY; confidence 0.2; trigger=false; setupScore=20. Met: Bollinger width available (squeeze is prior-bar state; not required on the same print as EXPANDING). Failed: Price above upper Keltner (expansion break); Volatility regime EXPANDING on the break; RVOL confirmation (>= 1.5x); ADX trend strength (>= 25). Contradictions: none.
- **TREND_FOLLOWING**: BUY; confidence 0.09; trigger=false; setupScore=17. Met: Moving averages ordered bullishly (SMA20 > SMA50 > SMA200). Failed: Strong BULLISH_TREND regime (trendStrength >= 50); Market structure real TRENDING (not ranging/choppy); DMI +DI > -DI with real ADX trend strength; MACD bullish (line above signal); Chaikin Money Flow confirming accumulation (CMF > 0). Contradictions: none.
- **OPENING_RANGE_BREAKOUT**: BUY; confidence 0.17; trigger=false; setupScore=17. Met: Prior-day high available as range context (not a fabricated PDH). Failed: Opening range available (intraday bars required): Only daily-granularity bars available - opening range requires intraday bars.; Close above opening-range high; RVOL confirmation (>= 2x); Price above session VWAP; Directional regime (not fading a range as a default). Contradictions: No opening range: daily bars cannot produce an ORB. This is HOLD evidence, not a skip of the condition..
- **SMC_LIQUIDITY_SWEEP**: BUY; confidence 0; trigger=false; setupScore=0. Met: Liquidity identified (swing or equal high/low). Failed: Liquidity swept (wick beyond level, close back inside — not a trade by itself); CHoCH confirmation in reversal direction (required — sweep without CHoCH is ignored as a trade); Displacement in trade direction; Order block in trade direction; Unfilled FVG in trade direction; Volume confirmation (RVOL >= 1.2); Same-timeframe regime alignment (not a higher-timeframe read — this stack evaluates one bar timeframe per cycle). Contradictions: No liquidity sweep: SMC does not treat BOS/CHoCH or an indicator print as an automatic entry..
- **VWAP_VOLUME_STRUCTURE**: SELL; confidence 0; trigger=false; setupScore=0. Met: none. Failed: Established downtrend (market structure); Price at or below session VWAP; Pullback toward VWAP (|distancePct| <= 0.35); RVOL confirmation (>= 1.5x); ADX trend strength (>= 25); Bearish rejection candle (shooting star / engulfing). Contradictions: No genuine session VWAP (real intraday bars required) — the VWAP anchor is not real on this bar set..
- **GAP_CONTINUATION**: BUY; confidence 0; trigger=false; setupScore=0. Met: none. Failed: Gap up vs prior UTC-day close; Gap size >= 0.5%; RVOL confirmation (>= 2x); Price above session VWAP; Favorable market regime. Contradictions: No gap vs prior UTC-day close (threshold in detectGap) — not a fabricated earnings/news gap..

#### SNOW: 10:26:42 ET, 1Day, BULLISH_TREND

- **MA_CROSSOVER**: BUY; confidence 1; trigger=true; setupScore=100. Met: SMA50 and SMA200 available; SMA50 above SMA200 (golden-cross stack); EMA9 above EMA20; Price above SMA50; ADX trend strength (>= 25); Favorable market regime. Failed: none. Contradictions: none.
- **PULLBACK_CONTINUATION**: BUY; confidence 0.4; trigger=false; setupScore=83. Met: Price pulled back to/near SMA20 without breaking decisively through it; RSI in a healthy (non-extreme) pullback zone; Bullish reversal candlestick at the pullback low; Volume contracted during the pullback (below average - lack of opposing pressure); No structural reversal against the trend (no opposing CHoCH). Failed: Established uptrend (market structure + regime). Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **RANGE_REVERSION**: SELL; confidence 0.4; trigger=true; setupScore=80. Met: Price near the range resistance boundary; RSI showing strength at the boundary (>=60); No real volume spike (a genuine breakout would show one); No real structural break in the fade direction (range still holding). Failed: Range regime confirmed (RANGING market structure + real consolidation). Contradictions: none.
- **FIBONACCI_PULLBACK**: BUY; confidence 0.4; trigger=false; setupScore=80. Met: Fibonacci retracement of the trailing daily range is available; Uptrend structure or bullish regime; RSI in a healthy (non-extreme) pullback zone; Volume not exploding (RVOL < breakout threshold — pullback, not a new breakout). Failed: Price near 61.8% retracement (within 0.35%). Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **CANDLESTICK_REVERSAL**: BUY; confidence 0.4; trigger=false; setupScore=75. Met: A detected candlestick pattern is present; Bullish reversal candle (hammer/engulfing/doji); RSI not already overbought. Failed: Near support (within 0.4%). Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **RELATIVE_STRENGTH_ROTATION**: BUY; confidence 0.75; trigger=true; setupScore=75. Met: Relative strength vs SPY is available (not fabricated); Positive relative strength vs SPY; Favorable market regime; ADX trend strength (>= 25); Bullish daily stack (price > SMA50 > SMA200); EMA9 > EMA20 (existing EMAs; Argus does not compute EMA8/EMA21). Failed: Favorable sector regime when a sector ETF trend exists; Stock period % > 0 while SPY period % < 0 (RS while SPY is down). Contradictions: No market-breadth data source (advance/decline, new highs/lows) exists in this codebase - not fabricated from the handful of symbols fetched here..
- **TREND_FOLLOWING**: BUY; confidence 0.4; trigger=false; setupScore=67. Met: Market structure real TRENDING (not ranging/choppy); Moving averages ordered bullishly (SMA20 > SMA50 > SMA200); DMI +DI > -DI with real ADX trend strength; Chaikin Money Flow confirming accumulation (CMF > 0). Failed: Strong BULLISH_TREND regime (trendStrength >= 50); MACD bullish (line above signal). Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **OSCILLATOR_MOMENTUM**: BUY; confidence 0.4; trigger=false; setupScore=67. Met: RSI above midline (50); ADX not dead (< 25 still allowed as confirmation only if DI aligned); +DI > -DI; Favorable market regime. Failed: MACD histogram positive; ROC > 0. Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **VOLUME_CONFIRMATION**: BUY; confidence 0.4; trigger=false; setupScore=60. Met: Chaikin Money Flow >= 0; Structure not printing BOS_BEARISH; Favorable market regime. Failed: RVOL spike (>= 2x) or isSpike flag; MFI > 50. Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **VWAP_MEAN_REVERSION**: BUY; confidence 0.2; trigger=false; setupScore=50. Met: Volume not a trend-day expansion (RVOL < 1.5); Bullish reversal candlestick; VWAP reclaim print (or still below waiting reclaim). Failed: Ranging / non-trending regime; Extended below VWAP (distancePct <= -1); ADX below range ceiling (< 20). Contradictions: No genuine session VWAP (real intraday bars required) — the extension read is not a real VWAP deviation.; Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **DONCHIAN_CHANNEL_BREAKOUT**: BUY; confidence 0.4; trigger=false; setupScore=50. Met: Prior 20-bar channel available (current bar excluded); ADX trend strength (>= 25); Favorable market regime. Failed: Close above prior-channel high; RVOL confirmation (>= 1.5x); ATR expansion (volatility regime EXPANDING). Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **SR_BOUNCE**: SELL; confidence 0.4; trigger=false; setupScore=50. Met: Nearest support and/or resistance exists; Not a volume-spike breakout (RVOL below breakout threshold). Failed: Price within 0.4% of the nearer boundary; Bearish reversal candle. Contradictions: Selling a resistance bounce against BULLISH_TREND - a breakout through the level is the higher-probability outcome.; Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **BOLLINGER_VOLATILITY**: BUY; confidence 0.4; trigger=false; setupScore=40. Met: Bollinger width available (squeeze is prior-bar state; not required on the same print as EXPANDING); ADX trend strength (>= 25). Failed: Price above upper Keltner (expansion break); Volatility regime EXPANDING on the break; RVOL confirmation (>= 1.5x). Contradictions: none.
- **PREVIOUS_PERIOD_BREAKOUT**: BUY; confidence 0.4; trigger=false; setupScore=40. Met: Previous-day high/low available; Favorable market regime. Failed: Close above previous-day high; RVOL confirmation (>= 2x); ATR expansion (volatility regime EXPANDING). Contradictions: none.
- **VWAP_VOLUME_STRUCTURE**: BUY; confidence 0.33; trigger=false; setupScore=33. Met: ADX trend strength (>= 25); Bullish rejection candle (hammer / engulfing). Failed: Established uptrend (market structure); Price at or above session VWAP; Pullback toward VWAP (|distancePct| <= 0.35); RVOL confirmation (>= 1.5x). Contradictions: No genuine session VWAP (real intraday bars required) — the VWAP anchor is not real on this bar set..
- **OPENING_RANGE_BREAKOUT**: BUY; confidence 0.33; trigger=false; setupScore=33. Met: Directional regime (not fading a range as a default); Prior-day high available as range context (not a fabricated PDH). Failed: Opening range available (intraday bars required): Only daily-granularity bars available - opening range requires intraday bars.; Close above opening-range high; RVOL confirmation (>= 2x); Price above session VWAP. Contradictions: No opening range: daily bars cannot produce an ORB. This is HOLD evidence, not a skip of the condition..
- **MOMENTUM_BREAKOUT**: BUY; confidence 0.25; trigger=false; setupScore=25. Met: Favorable market regime; Positive relative strength vs SPY. Failed: Structural break in trade direction (BOS); RVOL confirmation (>=1.5x average volume); ATR expansion (volatility regime EXPANDING); Price above session VWAP; Favorable sector regime; Positive momentum (ROC > 0). Contradictions: none.
- **MEAN_REVERSION**: BUY; confidence 0.1; trigger=false; setupScore=20. Met: Bullish reversal candlestick. Failed: Ranging / non-trending regime (not a real directional trend); RSI oversold (<=30); Price at/below the lower Keltner Channel; Stochastic RSI confirming oversold (<=20). Contradictions: none.
- **GAP_CONTINUATION**: BUY; confidence 0.2; trigger=false; setupScore=20. Met: Favorable market regime. Failed: Gap up vs prior UTC-day close; Gap size >= 0.5%; RVOL confirmation (>= 2x); Price above session VWAP. Contradictions: No gap vs prior UTC-day close (threshold in detectGap) — not a fabricated earnings/news gap..
- **STATISTICAL_MEAN_REVERSION**: BUY; confidence 0.1; trigger=false; setupScore=20. Met: Close z-score available (20-bar window). Failed: Close z-score <= -2.5; RSI oversold (<= 30); Ranging regime (not fading a trend as a default); ADX below range ceiling (< 20). Contradictions: none.
- **SMC_LIQUIDITY_SWEEP**: SELL; confidence 0; trigger=false; setupScore=0. Met: Liquidity identified (swing or equal high/low); Liquidity swept (wick beyond level, close back inside — not a trade by itself). Failed: CHoCH confirmation in reversal direction (required — sweep without CHoCH is ignored as a trade); Displacement in trade direction; Order block in trade direction; Unfilled FVG in trade direction; Volume confirmation (RVOL >= 1.2); Same-timeframe regime alignment (not a higher-timeframe read — this stack evaluates one bar timeframe per cycle). Contradictions: Sweep without CHoCH confirmation — wait; do not fade the breakout on the sweep bar alone.; Wick sweep of buy-side liquidity then close back inside. Pattern classification only — not evidence of intentional institutional manipulation..

#### UBER: 10:32:36 ET, 1Day, BEARISH_TREND

- **OSCILLATOR_MOMENTUM**: SELL; confidence 1; trigger=true; setupScore=100. Met: RSI below midline (50); MACD histogram negative; ROC < 0; ADX not dead (< 25 still allowed as confirmation only if DI aligned); -DI > +DI; Favorable market regime. Failed: none. Contradictions: none.
- **PULLBACK_CONTINUATION**: SELL; confidence 0.83; trigger=true; setupScore=83. Met: Established downtrend (market structure + regime); Price pulled back to/near SMA20 without breaking decisively through it; RSI in a healthy (non-extreme) pullback zone; Volume contracted during the pullback (below average - lack of opposing pressure); No structural reversal against the trend (no opposing CHoCH). Failed: Bearish reversal candlestick at the pullback high. Contradictions: none.
- **MA_CROSSOVER**: SELL; confidence 0.83; trigger=true; setupScore=83. Met: SMA50 and SMA200 available; SMA50 below SMA200 (death-cross stack); EMA9 below EMA20; Price below SMA50; Favorable market regime. Failed: ADX trend strength (>= 25). Contradictions: none.
- **FIBONACCI_PULLBACK**: SELL; confidence 0.4; trigger=false; setupScore=80. Met: Fibonacci retracement of the trailing daily range is available; Downtrend structure or bearish regime; RSI in a healthy (non-extreme) pullback zone; Volume not exploding (RVOL < breakout threshold — pullback, not a new breakout). Failed: Price near 61.8% retracement (within 0.35%). Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **VOLUME_CONFIRMATION**: SELL; confidence 0.4; trigger=false; setupScore=80. Met: Chaikin Money Flow < 0; MFI < 50; Structure not printing BOS_BULLISH; Favorable market regime. Failed: RVOL spike (>= 2x) or isSpike flag. Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **RELATIVE_STRENGTH_ROTATION**: SELL; confidence 0.75; trigger=true; setupScore=75. Met: Relative strength vs SPY is available (not fabricated); Negative relative strength vs SPY; Favorable market regime; Stock period % < 0 while SPY period % > 0 (RW while SPY is up); Bearish daily stack (price < SMA50 < SMA200); EMA9 < EMA20 (existing EMAs; Argus does not compute EMA8/EMA21). Failed: Favorable sector regime when a sector ETF trend exists; ADX trend strength (>= 25). Contradictions: No market-breadth data source (advance/decline, new highs/lows) exists in this codebase - not fabricated from the handful of symbols fetched here..
- **RANGE_REVERSION**: SELL; confidence 0.3; trigger=true; setupScore=60. Met: Price near the range resistance boundary; No real volume spike (a genuine breakout would show one); No real structural break in the fade direction (range still holding). Failed: Range regime confirmed (RANGING market structure + real consolidation); RSI showing strength at the boundary (>=60). Contradictions: none.
- **TREND_FOLLOWING**: SELL; confidence 0.4; trigger=false; setupScore=50. Met: Moving averages ordered bearishly (SMA20 < SMA50 < SMA200); MACD bearish (line below signal); Chaikin Money Flow confirming distribution (CMF < 0). Failed: Strong BEARISH_TREND regime (trendStrength >= 50); Market structure real TRENDING (not ranging/choppy); DMI -DI > +DI with real ADX trend strength. Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **SR_BOUNCE**: SELL; confidence 0.4; trigger=false; setupScore=50. Met: Nearest support and/or resistance exists; Not a volume-spike breakout (RVOL below breakout threshold). Failed: Price within 0.4% of the nearer boundary; Bearish reversal candle. Contradictions: Defining trigger did not fire on this bar - confidence capped; not a tradeable setup..
- **PREVIOUS_PERIOD_BREAKOUT**: BUY; confidence 0.4; trigger=true; setupScore=40. Met: Previous-day high/low available; Close above previous-day high. Failed: RVOL confirmation (>= 2x); ATR expansion (volatility regime EXPANDING); Favorable market regime. Contradictions: none.
- **CANDLESTICK_REVERSAL**: BUY; confidence 0.25; trigger=false; setupScore=25. Met: RSI not already overbought. Failed: A detected candlestick pattern is present; Bullish reversal candle (hammer/engulfing/doji); Near support (within 0.4%). Contradictions: No matching 1–2 bar pattern in PriceActionFeatures — other named candles are not separately detected..
- **BOLLINGER_VOLATILITY**: BUY; confidence 0.2; trigger=false; setupScore=20. Met: Bollinger width available (squeeze is prior-bar state; not required on the same print as EXPANDING). Failed: Price above upper Keltner (expansion break); Volatility regime EXPANDING on the break; RVOL confirmation (>= 1.5x); ADX trend strength (>= 25). Contradictions: none.
- **STATISTICAL_MEAN_REVERSION**: BUY; confidence 0.1; trigger=false; setupScore=20. Met: Close z-score available (20-bar window). Failed: Close z-score <= -2.5; RSI oversold (<= 30); Ranging regime (not fading a trend as a default); ADX below range ceiling (< 20). Contradictions: Fading a negative z-score against BEARISH_TREND — non-stationary series can keep falling..
- **VWAP_VOLUME_STRUCTURE**: SELL; confidence 0.17; trigger=true; setupScore=17. Met: Established downtrend (market structure). Failed: Price at or below session VWAP; Pullback toward VWAP (|distancePct| <= 0.35); RVOL confirmation (>= 1.5x); ADX trend strength (>= 25); Bearish rejection candle (shooting star / engulfing). Contradictions: No genuine session VWAP (real intraday bars required) — the VWAP anchor is not real on this bar set..
- **OPENING_RANGE_BREAKOUT**: BUY; confidence 0.17; trigger=false; setupScore=17. Met: Prior-day high available as range context (not a fabricated PDH). Failed: Opening range available (intraday bars required): Only daily-granularity bars available - opening range requires intraday bars.; Close above opening-range high; RVOL confirmation (>= 2x); Price above session VWAP; Directional regime (not fading a range as a default). Contradictions: No opening range: daily bars cannot produce an ORB. This is HOLD evidence, not a skip of the condition..
- **VWAP_MEAN_REVERSION**: BUY; confidence 0.09; trigger=false; setupScore=17. Met: Volume not a trend-day expansion (RVOL < 1.5). Failed: Ranging / non-trending regime; Extended below VWAP (distancePct <= -1); ADX below range ceiling (< 20); Bullish reversal candlestick; VWAP reclaim print (or still below waiting reclaim). Contradictions: Fading a VWAP extension against BEARISH_TREND — mean reversion is not a trend-kill.; No genuine session VWAP (real intraday bars required) — the extension read is not a real VWAP deviation..
- **DONCHIAN_CHANNEL_BREAKOUT**: BUY; confidence 0.17; trigger=false; setupScore=17. Met: Prior 20-bar channel available (current bar excluded). Failed: Close above prior-channel high; ADX trend strength (>= 25); RVOL confirmation (>= 1.5x); Favorable market regime; ATR expansion (volatility regime EXPANDING). Contradictions: none.
- **MOMENTUM_BREAKOUT**: BUY; confidence 0; trigger=false; setupScore=0. Met: none. Failed: Structural break in trade direction (BOS); RVOL confirmation (>=1.5x average volume); ATR expansion (volatility regime EXPANDING); Price above session VWAP; Favorable market regime; Favorable sector regime; Positive relative strength vs SPY; Positive momentum (ROC > 0). Contradictions: none.
- **MEAN_REVERSION**: BUY; confidence 0; trigger=false; setupScore=0. Met: none. Failed: Ranging / non-trending regime (not a real directional trend); RSI oversold (<=30); Price at/below the lower Keltner Channel; Stochastic RSI confirming oversold (<=20); Bullish reversal candlestick. Contradictions: Regime is BEARISH_TREND, not ranging - fading an oversold reading against a real downtrend is a materially riskier trade..
- **SMC_LIQUIDITY_SWEEP**: SELL; confidence 0; trigger=false; setupScore=0. Met: Liquidity identified (swing or equal high/low); Liquidity swept (wick beyond level, close back inside — not a trade by itself); Same-timeframe regime alignment (not a higher-timeframe read — this stack evaluates one bar timeframe per cycle). Failed: CHoCH confirmation in reversal direction (required — sweep without CHoCH is ignored as a trade); Displacement in trade direction; Order block in trade direction; Unfilled FVG in trade direction; Volume confirmation (RVOL >= 1.2). Contradictions: Sweep without CHoCH confirmation — wait; do not fade the breakout on the sweep bar alone.; Wick sweep of buy-side liquidity then close back inside. Pattern classification only — not evidence of intentional institutional manipulation..
- **GAP_CONTINUATION**: BUY; confidence 0; trigger=false; setupScore=0. Met: none. Failed: Gap up vs prior UTC-day close; Gap size >= 0.5%; RVOL confirmation (>= 2x); Price above session VWAP; Favorable market regime. Contradictions: No gap vs prior UTC-day close (threshold in detectGap) — not a fabricated earnings/news gap..

## Synthetic tests versus organic trading

The prior synthetic protected-path round trip established that controlled evidence can produce consensus, risk approval, sizing, an order, fill and exit. It did not establish that today’s actual quotes, strategy conditions, calibration, independence and lifecycle authorization would produce approved entries. Environment-controlled synthetic fixtures are engineering controls, not empirical alpha. No synthetic result authorizes an organic trade, and no threshold should be lowered to imitate a fixture.

## Direct answers to the 25 requested questions

1. Early discovery of the market’s strongest movers: UNKNOWN market-wide. Argus recorded the sampled movers; earliest logged discovery may follow earlier promotion. No independently timed setup-onset benchmark was certified.
2. Fresh usable data at setup onset: UNKNOWN. Snapshot timestamps exist, but complete contemporaneous quotes, spread endpoints and exact bars are missing.
3. Subscription/evaluation: seven sampled movers had promotion events; five had Quant assessments. Provider acknowledgment/continuous freshness are not certified.
4. Evaluated strategies: exact first-assessment strategy outputs listed above; subsequent assessments are included in the accompanying evidence JSON.
5. Failed conditions: exact persisted failures listed above; do not interpret them as independent recalculations.
6. Formula disagreement: NOT TESTED from exact inputs; no disagreement can be claimed.
7. Legitimate Quant triggers lost before ideas: NOT PROVEN. Some strong triggers exist, but the full eligibility/economics/selection chain is not reconstructed.
8. Incorrect lifecycle rejection: NOT PROVEN. Current missing-lifecycle authorization is correctly fail closed. Earlier redacted records limit attribution.
9. QuantExecutionPolicy functioning organically: authorized execution branch NOT DEMONSTRATED; zero policy approvals/rejections. Current authorization inventory is empty.
10. AI accidentally blocking Quant: NOT PROVEN. There is no evidence here of an authorized Quant idea incorrectly sent through an AI veto.
11. Ideas reached ChiefTrader: YES; 7,708 started and terminal consensus events.
12. Ideas reached RiskEngine: no risk assessment observed.
13. Incorrect Risk rejection: no applicable evaluated case in this window.
14. Incorrect zero sizing: not exercised; cannot blame sizing.
15. Broker submission: no submitted-order events or trade ledger rows in the window.
16. Submitted-but-unfilled cause: not applicable.
17. Passive limits/stale order reference: not applicable to this zero-order window.
18. Hindsight-only opportunity count: UNKNOWN. No sampled price rise alone was certified as an executable opportunity.
19. Captureable move/profit: UNKNOWN; requires valid signal time, executable spreads, costs and future path held out from signal computation.
20. Largest measured terminal subsystem: Chief evidence/confidence; 7,403 confidence rejections. Economic missed-opportunity share is UNKNOWN.
21. Primary observed problem: upstream evidence/authorization, plus per-symbol data allocation and strategy coverage gaps. Not a demonstrated OMS/broker/fill problem.
22. Defect versus limitation: no new calculation/routing defect proved in this audit. Missing PIT replay inputs is an observability limitation; empty lifecycle authority is a certification gap; missing strategy coverage is a research question.
23. New defects fixed in isolation this mission: NONE. Prior deployed repairs are documented separately; they are not counted again as findings here.
24. Exact-scenario post-fix progression: NOT CERTIFIED; no new repair or exact-input replay occurred.
25. After-close deployment: no new trading-code deployment is justified by this audit alone. First build isolated provenance/regression work; collect complete evidence before proposing changes.

## Prioritized next work and acceptance criteria

1. **Quant lifecycle certification:** inventory each existing strategy’s real lifecycle/evaluation records and reason it is missing; identify whether genuine grading/promotion wiring is broken or real validation is absent. Repair only proven wiring defects; never seed synthetic results as organic authority. Acceptance: exact strategy ID, evidence scope, sample sufficiency, promotion decision and current authorization are traceable.
2. **Quant scheduling coverage:** reconstruct MRNA/CRCL subscription lifetime, fresh quote/bar availability, rotating cycle position, provider backoff and worker duration. Acceptance: every admitted active candidate has an explicit assessment, pending schedule, data refusal or eviction reason; bounded scheduling without increased broker cap or safety relaxation.
3. **Point-in-time replay provenance:** extend canonical telemetry to retain input bar identities, observed/available times, current quote timestamps, spread endpoint timestamps, StrategyContext inputs, versions and trace links in bounded records. Reuse existing evidence infrastructure; no parallel order path. Acceptance: isolated Java recomputation of the exact context matches production outputs, with late/unavailable data excluded.
4. **Allocation investigation:** reconstruct full challenger cycles for PCVX/T/PBR/CF and incumbent competitors. Test repeated deferral and hysteresis with real timestamped evidence before altering scheduling. Control-plane scheduling is distinct from quant score calculations, which belong in Java.
5. **Organic shadow/paper verification:** after independently validated repairs, replay positive, negative, stale-data, missing-lifecycle and provider-outage cases through the protected spine. Observe a real supervised session; correct NO TRADE remains valid.

No new trading formulas, strategy families, safety settings, environment values or runtime processes were changed. No tests/build are claimed for code that was not changed. The audit is complete for the stated persisted window; market-wide ranking, exact PIT counterfactual and organic profitable readiness remain open.
