---
strategy: "Post-earnings-announcement drift (PEAD)"
family: "factor"
source: { paper: "Post-Earnings-Announcement Drift: Delayed Price Response or Risk Premium?", authors: "Bernard, Thomas", year: 1989, url: "", license: "academic (Journal of Accounting Research; verify DOI before citing)" }
status: RESEARCHED
argus_status: MISSING_HIGH
evidence_quality: 90
last_reviewed: 2026-10-05
---

## Economic rationale
Behavioral + structural: investors underreact to earnings news (anchoring, limited attention), and the drift persists because arbitrage is constrained around idiosyncratic, hard-to-hedge earnings risk. It is among the most replicated anomalies in finance — five decades of evidence across markets. The "who pays" is inattentive capital and constrained arbitrageurs.

## Mathematical definition
Standardized unexpected earnings: `SUE_{i,q} = (EPS_{i,q} − E[EPS_{i,q}]) / σ(surprise_{i})`, where `E[EPS]` is the analyst consensus (or a seasonal random-walk forecast: `EPS_{q} − EPS_{q−4}`) and `σ` the surprise volatility. Each quarter, sort reporters into deciles by SUE; the drift is the subsequent 60-trading-day abnormal return spread between top and bottom deciles.

## Signal construction
1. Obtain earnings announcement date + actual vs expected EPS (point-in-time — announcement timestamp, never restated values).
2. Compute SUE per report.
3. Long-only variant for Argus (no shorting): go long top-SUE-quintile reporters within N days of announcement, hold ~60 trading days.

## Entry / Exit / Position sizing
Entry: within 1–2 sessions after the announcement (the drift starts immediately; delay bleeds it). Exit: time-based, 60 trading days post-announcement, or on the next earnings announcement — whichever comes first. Sizing: equal-weight across active PEAD positions; cap concurrent PEAD positions (earnings cluster seasonally).

## Required data & frequency
Fundamentals + corporate calendar: earnings dates, actual EPS, consensus expected EPS — point-in-time. Daily OHLCV for execution. HYPOTHESIS (unverified in this task): AlphaVantage's EARNINGS endpoint (already an Argus data vendor via FundamentalAgent) can supply dates/actuals; consensus estimates may need a second source.

## Transaction-cost sensitivity
MEDIUM. Quarterly holding period keeps turnover low, but entries cluster in earnings season and chase post-announcement moves — entry slippage is the main cost. Long-only avoids borrow costs.

## Expected capacity
HIGH for Argus's size. The anomaly lives in mid/small caps where Argus-sized orders are noise.

## Regime dependence
Works across regimes (documented in bull and bear markets); attenuates when analyst coverage saturates attention (large caps) — a small/mid-cap tilt helps. Vulnerable to regime where earnings themselves become uninformative (e.g. meme-stock periods where price detaches from fundamentals).

## Known weaknesses
- Data is the whole game: restated (not as-reported) earnings introduce lookahead bias — the Qlib entry's point-in-time discipline applies with full force.
- SUE needs a surprise-volatility normalizer; naive EPS-minus-consensus without scaling is dominated by volatile reporters.
- Earnings-season capacity: dozens of signals at once; needs the portfolio layer (HRP/risk budgets) to avoid concentration.

## Academic evidence
Foster, Olsen & Shevlin (1984) documented the drift; Bernard & Thomas (1989, 1990) showed it is not a risk-premium artifact (it doesn't behave like priced risk). Decades of replications (US + international); Chordia et al. and others document attenuation but not disappearance. Evidence quality 90 reflects replication breadth, not a guarantee of future returns.

## Post-publication evidence
Attenuated but persistent: the long-short spread has roughly halved since the 1980s–90s heyday (documented in multiple replication studies), consistent with partial arbitrage. The long-only leg retains most of the practical value for a no-shorting system like Argus.

## Crowding risk
MEDIUM. Quant funds trade earnings momentum, but the signal is refreshed quarterly with idiosyncratic risk that limits arbitrage capital — crowding expresses as attenuation, not sudden death.

## Complexity
MEDIUM. The math is trivial; the data plumbing (point-in-time earnings calendar, consensus feeds, restatement handling) is the real work.

## Argus relevance
8/10 — signal layer. Argus has *nothing* in the earnings space (verified: no PEAD/earnings-surprise engine anywhere in TS or Java, 2026-10-05) despite having the vendor relationship (AlphaVantage) and a FundamentalAgent. This is the largest evidence-per-unit-novelty gap in the survey.

## Confidence
55% that a long-only PEAD sleeve earns positive net-of-cost OOS returns on Argus's universe. What would change it: (a) verifying the earnings data feed is point-in-time and affordable — if not, confidence drops to ~20%; (b) a 10-year cost-aware backtest on US equities; (c) evidence the drift has fully arbitraged away in the post-2020 sample.

## Verdict
RESEARCH FURTHER — second-highest-priority card, gated on a data-spike: verify AlphaVantage (or alternative) can supply as-reported earnings dates/actuals/consensus with knowledge timestamps, at acceptable cost. No Java implementation until the data question is answered — building the engine before the feed exists is how research backlogs are born.
