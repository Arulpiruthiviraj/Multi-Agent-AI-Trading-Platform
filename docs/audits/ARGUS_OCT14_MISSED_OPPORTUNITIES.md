# Argus October 14, 2026 — Missed-Opportunity Benchmark and Outcomes

Status vocabulary as in the session audit. Read-only. No credentials.

## 1. What could and could not be established (honest scope)

| Item | Status |
|---|---|
| Independent **full-universe** Oct 14 benchmark | **NOT_PROVEN / not built.** The Alpha Vantage top-gainers feed returned `last_updated 2026-10-13 16:15 US/Eastern` (Oct 13, dominated by sub-$5 micro-caps and warrants) and its daily series had no Oct 14 row yet; Alpha Vantage intraday is a premium endpoint. Neither may be used for Oct 14 |
| Independent **point-in-time intraday bars** | Available through the IBKR connector (15-minute bars, regular hours) for individually requested symbols; I verified 5 symbols |
| Argus's own observations | Every candidate admission/filter event carries Alpaca-IEX snapshot evidence with timestamps (`price`, `dollarVolume`, `spreadBps`, `gapPct`, `gapEvidence`). Note: **`gapPct` is the return since the session open (`VALID_SAME_SESSION_INTRADAY_RETURN`), not the move versus the previous close** — an overnight gap that then drifts is not reflected |
| Hindsight control | Winners are not labelled trades. Each entry below states what was knowable at first observation, and a hypothetical long entry at Argus's first promotion price is compared with the close only as an illustration, not as a trade claim |

The four categories (MARKET MOVER / DISCOVERABLE / STRATEGY-QUALIFYING / TRADE-ELIGIBLE) are applied per symbol. **STRATEGY-QUALIFYING was not evaluated for any symbol** (it needs a point-in-time replay through the real strategies — Report 4). **TRADE-ELIGIBLE: none**, because no strategy had authority and no consensus reached 0.75.

## 2. Argus-observed population

From 1,055 symbols with gap evidence, 443 admitted. Largest |move vs open| among **admitted** symbols (top 60, ≥ 6.2 %): 5 up, 55 down. The universe's top movers by |gap| overall (e.g. TC +155 %, WFF −89 %, TGL +65 %) were **all filtered on PRICE** (sub-$5 / sub-$1 names, rights, warrants) or DOLLAR_VOLUME — correct for this system (long-only, penny/micro MARKET execution not supported). They are not missed opportunities.

Of the 55 large down-movers admitted (CRWV −10.3 %, IREN −8.9 %, DOCN −13.7 % …), the system is long-only: a down-move is not a BUY candidate unless a mean-reversion strategy fires. None did with authority.

## 3. Verified positive movers (independent bars vs Argus records)

Independent source: IBKR 15-minute bars (SMART last), regular hours, Oct 13–14. Times are Z; ET = Z−4. "Entry reference" = the bar containing Argus's first promotion.

| Symbol | Independent facts (Oct 13 close → Oct 14) | Argus first seen | Admitted | Promoted | First analysis / idea | First blocking stage | Class |
|---|---|---|---|---|---|---|---|
| **FAST** (Fastenal) | prev close 51.46 → **open 47.30 (−8.1 % gap down)** low 47.30 in the first bar, recovered to **close 52.02** (+1.1 % vs prev close, +10 % from the low) | 13:39:46 | 13:39:46 | **13:49:46** (price ≈ 49.9–50.4); re-promoted 14:43, 15:11, 16:57 | 13:50:18 / 13:51:10; 432 ideas, 860 analyses | **Consensus**: 268 `CONFIDENCE_BELOW_STRONG` (Technical BUY 0.71 + Kronos BUY 0.50 ≈ 0.54). FAST is not among the 19 symbols with `NO_LIFECYCLE_RECORD` events (whether a strategy fired and was filtered earlier is UNKNOWN) | DISCOVERABLE ✔ · MARKET MOVER ✔ · consensus legitimately below bar. Best-case handling: discovered in 10 min, evaluated in 1 min |
| **VSTM** (Verastem) | prev close 7.46 → open 8.00 (+7.2 %), high **8.96 (+20 %)** ≈ 15:00Z, **close 7.71** (+3.4 % vs prev close, −3.6 % vs open) — gap-and-fade | 13:54:52 | 14:34:55 | 14:40:18 (price ≈ 8.6–8.8) | 14:41:15 / 14:41:14; 70 ideas | Discovery filters 13:54–14:34 (DOLLAR_VOLUME ×8, RANK_CAP ×12) then **consensus** (39 below-strong). A long at the promotion price would have been under water by the close | hindsight trap; not a missed trade |
| **BSP** (Bending Spoons) | prev close 37.92 → **open 50.10 (+32 % gap)**, first-bar high 58.56, **close 53.69 (+41.6 %)** | 13:34:51 | 14:59:59 | 15:25:18 (≈ 52.7) | 15:26:42 / 15:27:09; 62 ideas | **Discovery SPREAD filter** (64 events 13:34–15:00Z, new listing with wide opening spreads), then SWAP_CAP_REACHED ×4, then consensus (39 below-strong). Argus engaged **1 h 55 min after the open** | DISCOVERABLE after ≈ 15:00Z. The edge was the overnight gap (before Argus could act); after 15:25Z the stock ranged 51.3–56.9 and closed 53.69 (≈ +2 % from the promotion price) |
| **HALO** (Halozyme) | prev close 109.62 → open 109.90, **+5.3 % in the first 15 minutes (115.46)**, high 119.21, close 116.80 (+6.5 %) | 14:40:00 | 14:40:00 | 14:47:00 (≈ 117.4) | 14:48:14 / 14:48:13; 231 ideas | **Discovery first-seen lag**: not observed until 14:40Z (≈ 70 min after the move began; `RANK_CAP`), then consensus (144 below-strong). A long at 14:47Z (≈ 117.5) finished −0.6 % | late discovery, not a profitable entry in hindsight |
| **IBRX** (ImmunityBio) | prev close 9.905 → open 9.69, high 10.455 (+5.6 %), close 9.905 (flat) | 15:25:05 | 18:11:27 (14 `RANK_CAP` filters before) | **never promoted** (1 `OTHER` not-promoted) | none | Admission cap, then promotion competition | MARKET MOVER (moderate, round-trip); not a trade-quality setup |

Observations:
* **Discovery-to-analysis latency for admitted symbols was good**: promotion → first technical analysis p50 1.4 s, p90 98 s over 381 promotions.
* **The slow stage is the front of the funnel** (first seen / admitted / ranking cap): HALO 70 min after its move began; BSP held out by the spread filter and then the swap budget for ≈ 2 hours; IBRX admitted only at 14:11 ET. These are discovery-cadence and ranking-cap effects, not Quant or consensus.
* **Consensus never approved any of them**; for the two verified clean uptrends (FAST, HALO) the real agents produced two agreeing BUY groups at ≈ 0.54 confidence.
* **Gap blindness (CONFIRMED by payload)**: because `gapPct` measures return since the session open, BSP's +32 % opening gap and VSTM's +7 % gap are invisible to the gap/mover score; the movers endpoint (Alpaca) is what surfaced them (`MARKET_MOVER` source on BSP, VSTM).

## 4. Delayed promotions caused by the dwell defect (CCI-class) on Oct 14

| Symbol | Promoted | Evicted after | First analysis | Delay |
|---|---|---|---|---|
| CIEN | 16:21:08Z | 30.6 s | 17:33:06Z | 72 min |
| TXN | 17:12:07Z / 17:14:10Z | 30.6 s / 30.4 s | 17:50:35Z | 38.5 / 36.4 min |
| CVNA | 17:13:08Z | 30.6 s | 17:49:39Z | 36.5 min |

26 of 381 promotions (6.8 %) were evicted within 60 s of promotion (e.g. TMO 30.6 s, JPM 48.4 s, COHR 1.9 s, WMT 5.2 s). **CONFIRMED DEFECT** (mechanism: the dwell guard released at 10 ticks). None of these were among the five verified positive movers.

## 5. October 9 follow-up (from the earlier forensic, offline records)

| Symbol | Records | Finding |
|---|---|---|
| NVAX | admitted 12:30 ET, first technical analysis 13:38 ET | **NOT_PROVEN** cause of the 68-minute gap (Oct 14's CIEN shows one mechanism: promote → quick evict → re-promote; not verified for NVAX) |
| CCI | promoted 12:49 and 13:37 ET, evicted 28 s and 10 s later, never analyzed | CONFIRMED DEFECT (dwell tick release) |
| FSLY | admitted 12:31 ET, subscribed 12:57, 82 ideas, only 2 consensus rounds, 17 rate-limited, 13 evictions | subscription churn + `IDEA_RATE_LIMITED`; PROBABLE |
| MRNA | 54 consensus rounds, 53 below-strong | consensus legitimately below bar |

Independent confirmation of the date discrepancy you found: Alpha Vantage daily bars show NVAX 2026-10-09 open 11.17, high 13.04, close 12.75 on prev close 11.01 (+15.80 %); Oct 13 close 12.82. The "today" gainers list was not Oct 14.

## 6. What this does not show

* No full-universe recall/precision number can be quoted for Oct 14.
* Positive-mover count is from Argus's own admitted set (selection bias: names Argus never observed are unknowable here). The 5 independently checked names are not a sample of the market.
* Whether a CORE strategy would have qualified at the time (STRATEGY-QUALIFYING) is **NOT_PROVEN** for every symbol above.
