# Argus Fast Lane — October 5 Counterfactual

**Date:** 2026-10-05
**Type:** Forensic scenario analysis (not a deterministic replay)
**Status:** RESEARCH ONLY. No profitability claims.

---

## Method and limits

The recorded October 5 event stream is **not available** in this environment
(local DB: 47 events; backups: pre-market only). This counterfactual uses the
VERIFIED forensic findings as a scenario timeline. It quantifies the latency
gap the fast lane closes; it does NOT prove what would have traded.

**Honest scope:** This measures detection latency, not trading outcomes.

## Forensic baseline (verified)

| Symbol | Normal-lane timeline | Forensic fact |
|--------|---------------------|---------------|
| PTC | Catalyst 08:16 → challenger 10:37 | 141-min gap, 94 admissions |
| MPWR | 2 admissions, 0 challenger | Lost in top-N truncation |
| TSLA | 2,162 ideas | Idea path works, consensus weak |
| META | 505 ideas | Same pattern |
| XP | 58 ideas | Same pattern |

## Fast-lane counterfactual

| Symbol | Fast-lane detection | Improvement | Classification |
|--------|-------------------|-------------|----------------|
| PTC | 08:16 (NEWS_CATALYST event) | ~4 min vs first admission; ~141 min vs first challenger | DETECTED_EARLIER |
| MPWR | Not detected (no catalyst event in scenario) | N/A | INSUFFICIENT_EVIDENCE |

**PTC:** The fast lane would have created a candidate at 08:16 via
`NEWS_CATALYST` injection, then fetched Tier-1 data (snapshot + bars) within
seconds. The normal lane took until 10:37 for challenger scoring — a 141-minute
gap during which PTC was known but not evaluable.

**MPWR:** The fast lane as currently built would NOT have caught MPWR, because
MPWR's signal was broad-universe admission (not a news catalyst). This is an
honest limit: the fast lane needs RVOL/price-acceleration detectors (not yet
built) to catch non-news movers. The normal lane remains the path for those.

## What the replay runner measures

- `detectionLatencyMs`: event → candidate creation (synchronous, sub-ms)
- `latencyImprovementMs`: normal detection time − fast detection time
- Per-symbol classification: DETECTED_EARLIER / SAME / DETECTED_BUT_NO_SETUP /
  VALID_SETUP / INSUFFICIENT_EVIDENCE / NOT_APPROPRIATE_FOR_STRATEGY

## What still prevents approval

1. **No intraday strategy wiring:** The fast lane can detect and fetch data,
   but there are no validated intraday entry rules to evaluate candidates against.
   ORB exists but is experimental and UNVALIDATED.

2. **No lane runner:** Detectors → candidate → strategy eval → ChiefTrader is
   not yet wired end-to-end.

3. **Consensus independence:** Even with faster detection, the 0.75 threshold
   with overstated independence remains the binding constraint (see TSLA:
   2,162 ideas, weak consensus).

4. **No historical validation:** One session proves nothing about expectancy.

## Benchmark symbols status

MXL, SYNA, WOLF, RXO, PCVX, NVDA, MSFT, ARM, RKLB: no forensic timeline data
available in this environment. They are in the benchmark list for future replay
when the operational event stream is accessible.

## Conclusion

The fast lane closes the **detection latency** gap (PTC: 141 min → seconds).
It does NOT close the **strategy** gap (no validated intraday entries) or the
**consensus** gap (overstated independence). Those are the binding constraints
for tomorrow's PAPER session.

**Recommendation:** Tomorrow remains a PAPER research day. The meaningful
benchmark is whether the fast lane detects the next PTC-type catalyst in
seconds and preserves all execution safeguards — not whether it produces a trade.
