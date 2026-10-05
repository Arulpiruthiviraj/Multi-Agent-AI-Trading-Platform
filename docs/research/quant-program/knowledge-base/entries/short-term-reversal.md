---
kind: strategy
family: momentum
status: REJECTED
argus_status: NOT_APPROPRIATE
argus_refs: []
sources:
  - { title: "Returns to Buying Winners and Selling Losers", authors: "Jegadeesh, Titman", year: 1993, url: "https://doi.org/10.1111/j.1540-6261.1993.tb04702.x", license: "academic" }
  - { title: "Momentum Crashes", authors: "Daniel, Moskowitz", year: 2016, url: "https://doi.org/10.1016/j.jfineco.2016.01.033", license: "academic" }
evidence_quality: 70
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- RESEARCH FINDING: Long top-decile / short bottom-decile by past J-month return earned ~1%/month 1965-1989 (Jegadeesh-Titman 1993).
- RESEARCH FINDING: Momentum crashes: -91% (1932), -73% (2009) for WML (Daniel & Moskowitz 2016).
- RESEARCH FINDING: Profits largely explained by bid-ask bounce at short horizons (Conrad et al. 1997); net edge vanishes at trivial costs for short-term reversal.
- INFERENCE: Requires shorting + broad cross-sectional universe + high turnover (~85% semi-annual).

## Mathematics
Each month-end: rank universe by past J-month return (J in {3,6,9,12}), long top decile / short bottom decile equal-weight, hold K months, skip 1 month between formation and holding.

## Economic rationale
Same as time-series momentum (behavioral underreaction/overreaction), cross-sectional variant.

## Argus mapping
NOT_APPROPRIATE: live brokers lack short-selling (AlpacaBroker.getCapabilities().shortSelling == false); cross-sectional breadth needs institutional data Argus doesn't have; turnover makes it cost-fragile at Argus's scale. CrossSectionalRankingEngine exists for research.

## Failure modes
Momentum crashes; crowding; transaction costs erase the edge at retail scale.

## Verdict
REJECT for implementation. Revisit only if: (a) shorting becomes available, (b) institutional breadth data arrives, (c) cost model proves net edge. Recorded as a valuable negative result.
