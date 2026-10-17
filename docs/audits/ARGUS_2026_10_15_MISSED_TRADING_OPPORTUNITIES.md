# Argus missed-opportunity review — October 15, 2026

## Scope and decision standard

This report compares selected U.S. stock movers with Argus's October 15 ledgers. Public close data identifies stocks that moved; it does not prove they were tradable at a particular time. A genuine missed entry requires point-in-time price, quote/spread, volume, strategy eligibility, authorized signal, risk economics, and an executable entry hypothesis. Those data are incomplete, so **no candidate is classified as a proven profitable miss**.

Market session is 09:30–16:00 EDT (13:30–20:00 UTC). Argus event counts use the same bounded UTC session. Local minute bars are stored in `ohlcv_bars`; some symbols have complete rows, while IP ends at 11:25 EDT in the reviewed table and several candidates have no rows. The ingestion timestamp/provenance is not sufficient to prove when the bars were first available to the live engine. OHLC ranges in local bars are retrospective, not an executable quote stream.

## Independently identified daily movers

| Symbol | Oct. 15 result | Argus evidence in local DB | Classification |
|---|---|---|---|
| TTD | S&P 500 top gainer, +7.80%; close $13.13; relative volume 1.0x | Promoted 09:36:59 EDT; first Quant/consensus about 09:38. 170 Quant finishes; 212 consensus terminal events (211 CONFIDENCE_BELOW_STRONG, 1 AGENT_DATA_UNAVAILABLE). Local minute bars: open 12.20, high 13.24, low 12.20, close 13.11, volume 19.14M. | DETECTED_BUT_REJECTED; no proven missed trade. |
| EFX | +7.25%; close $161.26; relative volume 1.0x | Two promotions around 12:33 EDT, two Quant finishes, one consensus around 15:03 EDT, rejected below strong confidence; local bars partial. | DETECTED_LATE/REJECTED; not proven miss. |
| RDDT | +7.24%; close $159.36; relative volume 0.8x | Promoted around 15:39 EDT; five Quant finishes and consensus rounds, all below strong confidence; local bars incomplete. | DETECTED_LATE/REJECTED; not proven miss. |
| FICO | +6.99%; close $769.93; relative volume 0.6x | Two SUBSCRIPTION_NOT_PROMOTED events; no RTH Quant, idea or consensus. Fractional-share/budget eligibility not checked. | NOT_EVALUATED; no proven opportunity loss. |
| APP | +6.52%; close $279.29; relative volume 0.8x | Four promotions near open; 29 Quant finishes, 79 ideas, 44 consensus rounds, all below strong confidence; local bars cover 101 minutes. | DETECTED_BUT_REJECTED; no executable setup proven. |
| IP | +6.90%; close $34.10; relative volume 1.6x | Subscription requests were not promoted at 10:45; first promotion 11:23:43, Quant assessment about 11:25. 30 Quant finishes, 44 consensus rounds (all confidence below 0.75), 19 ideas rate-limited. Local minute bars stop at 11:25 (116 bars), so remainder of session is unavailable. | DETECTED_LATE/REJECTED; potential coverage issue, no proven miss. |
| CSGP | +6.28%; close $32.00; relative volume 0.9x | Two SUBSCRIPTION_NOT_PROMOTED events late in session; no Quant finish, idea, or consensus; no local minute bars in bounded query. | NOT_EVALUATED/NOT_PROMOTED; potential coverage gap, no proven loss. |
| AJG | +5.51%; close $250.10; relative volume 1.5x | One SUBSCRIPTION_NOT_PROMOTED around 10:40 EDT; no Quant assessment, idea, or consensus during RTH. | SUBSCRIPTION_NOT_PROMOTED; potential coverage issue, no proven opportunity loss. |
| INTU | +6.36%; close $330.17; relative volume 1.1x | Quant first assessed about 09:31; 325 ideas, 174 Quant finishes, 216 consensus rounds (all confidence below 0.75), 208 rate-limited. Full local minute bars, but no received-at provenance. | DETECTED_BUT_REJECTED/PROCESSING_PRESSURE; not proven missed. |
| LLY | +3.54% to +3.55%; O 1,211.08 H 1,275.88 L 1,230.66 C 1,253.94 (MarketBeat) | Local 390 one-minute bars agree on high/low; volume sum 2.24M vs public daily ~3.75M. 175 Quant finishes, 339 ideas, 223 terminal rounds (222 confidence below, 1 data unavailable), 178 rate-limited. First consensus 09:35 EDT. | DETECTED_BUT_REJECTED; not proven missed. |
| UNH | Public daily return not independently matched here | 438 ideas, 201 Quant finishes, 280 consensus rounds (all confidence below 0.75), 153 rate-limited. Subscriptions promoted twice; exact first time and point-in-time entry quality remain unresolved. | DETECTED_BUT_REJECTED; no proven miss. |
| PAG | No verified daily return or local minute bars in this pass | No direct symbol-indexed event proof was obtained; substring scans are not adequate to claim no discovery. | `NOT_VERIFIABLE`. |
| MRNA | Local high 242.29, low 217.02; volume 11.65M | 128 terminal rows: 117 confidence below, 6 calibration, 5 participation; 98 rate-limited. Quant BUY 13:38:52 and 13:43:44; both Chief results were 0.97857, one group, insufficient participation. Later two-group BUY at 13:44:49 scored 0.4423. | DETECTED_BUT_REJECTED_BY_POLICY; not proven profitable. |
| MCD | Local high 245.46, low 241.76, close 242.51; volume 4.38M | 328 terminal rows: 261 confidence below, 63 calibration, 3 independence, 1 participation; 355 rate-limited. Quant SELL 13:38:55 rejected for one-group participation. | CORRECTLY_NOT_AUTHORIZED for recorded direction. |

The market-day cross-check found a broad rotational session: AP reported S&P 500 +0.3%, Dow +1.1%, Nasdaq +0.1%, Russell 2000 +1.4%; Quant500's close table reports TTD +7.8% as the S&P 500 top gainer, 381/501 index constituents higher, and broad strength in consumer cyclical and health care. Its table also reports relative volume for the listed movers. These are after-close facts. [AP](https://apnews.com/article/f0a4f8aa60a6a24237c419aba38f31fd) · [Quant500 movers](https://quant500.com/sp500-gainers-losers) · [LLY OHLCV](https://www.marketbeat.com/stocks/NYSE/LLY/chart/).

## Directly verified candidate decisions

### MRNA

- 13:38:52 EDT: `TRADE_IDEA_GENERATED`, QuantEngine BUY, confidence 0.8 (raw signal strength in the terminal record).
- 13:38:54 EDT: Quant assessment finished as `ASSESSED`; consensus was 0.97857, approved false, one independent group `CORE_QUANT_ENSEMBLE`, required two. MacroAgent contributed HOLD with zero confidence. The terminal code was `INSUFFICIENT_AGENT_PARTICIPATION`.
- 13:43:44 EDT: a later Quant BUY produced the same one-group 0.97857 consensus; terminal code again `INSUFFICIENT_AGENT_PARTICIPATION`.
- 13:44:16 EDT: a TechnicalAgent MRNA idea was rate-limited by `MAX_TRADE_IDEAS_PER_MINUTE`; this is a real dropped vote, but it arrived after the prior Quant-only consensus completed. In a later 13:44:49 round, Technical and Kronos both voted BUY, but calibrated group confidences were about 0.2157 and 0.5005 and final consensus was 0.4423. Chief correctly declined below 0.75.
- No recorded Chief approval, Risk assessment, order, or fill followed. Entry price, spread, stop distance, liquidity at signal time and expected value are not proven from daily bars.

The high-confidence Quant-only result must not be described as “an almost approved trade”: confidence and independent corroboration are separate gates. Adding Jev or a second Quant-derived Java agent by repeating the same evidence would violate independence.

### MCD

- 13:38:55 EDT: QuantEngine generated SELL with raw signal strength 0.8.
- 13:38:56 EDT: Chief recorded 0.97857 confidence, one `CORE_QUANT_ENSEMBLE` group, and terminal code `INSUFFICIENT_AGENT_PARTICIPATION`. MacroAgent was HOLD.
- The signal direction was SELL; no evidence indicates a permissible short-entry path. Later BUY ideas/rounds do not establish an actionable long setup.

## What the global limiter proves

Across RTH, 17,801 of 35,230 idea events were rate-limited (50.5% of event count). Rejections by emitting agent were KronosEngine 9,874, MacroAgent 3,689, TechnicalAgent 3,016, QuantEngine 867, JavaCoreEnsemble 355. Top affected symbols included MCD 355, PATH 272, INTC 267, WMT 266, SCHW 257 and NVDA 251. This proves capacity suppression and broad impact on signal processing. Because these are repeated/correlated agent evaluations, it does not prove that 17,801 unique or useful signals were lost, or that the limiter caused any named missed winner.

## Why we cannot label winners “genuine missed opportunities” ye

The database has 1-minute OHLCV for several names but not complete coverage (IP and EFX are partial; PAG and CSGP were absent in the bounded bar query), and available bars do not carry a point-in-time received-at audit sufficient to reconstruct what Argus knew. Daily bars and close-to-close returns cannot establish entry timing, spread, slippage, stop feasibility, or after-entry return. The event lineage still needs unique signal episode IDs rather than counts of repeated evaluations. For that reason, the proven missed-opportunity count is **0 verified**, with the true count unknown.

## Ranked follow-up research

1. Build a bounded, day-scoped replay for TTD, IP, CSGP, AJG, INTU, LLY, UNH, MRNA and MCD from point-in-time minute quotes/bars and news publication timestamps. Tag every missing input; do not infer it from later cached data.
2. Reconstruct discovery rankings and market-data subscription lifecycles from candidate ranking/observability tables, including request, acknowledgement, first tick, freshness, eviction and assessment. Do not use payload substring matching as symbol proof.
3. Replay each exact consensus decision with the persisted evidence, calibration snapshot, decision IDs and windows; verify whether independent evidence arrived after that window or was suppressed. Keep 0.75 and two independent groups unchanged.
4. Evaluate the research limiter offline with causal replay and source fairness metrics. Compare only the same requests under alternative scheduling; do not report hypothetical fills as production outcomes.
5. Evaluate strategy recall and net expectancy on a point-in-time walk-forward corpus, with spread/slippage/costs and out-of-sample controls. Do not promote a strategy from one strong day.
