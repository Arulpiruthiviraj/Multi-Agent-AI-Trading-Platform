# Quant Knowledge Base — Record Schema

Every entry is a Markdown file in `knowledge-base/entries/<slug>.md` with this front-matter
plus free-form sections. Epistemic status labels are mandatory on every factual claim.

```yaml
---
kind: strategy | concept | method | infrastructure | paper | book
family: momentum | mean-reversion | stat-arb | factor | volatility | regime | ml | feature-engineering | portfolio | risk | execution | microstructure | architecture | data
status: RESEARCHED | SPECIFIED | IMPLEMENTED | TESTED | BACKTESTED | REJECTED | PROMOTED
argus_status: EXISTS_GOOD | EXISTS_INCOMPLETE | EXISTS_QUESTIONABLE | EXISTS_WRONG_LAYER | MISSING_HIGH | MISSING_MEDIUM | MISSING_LOW | NOT_APPROPRIATE
argus_refs: [paths in repo, if any]
sources:
  - { title: "", authors: "", year: 0, url: "", license: "" }
evidence_quality: 0-100   # 100 = multiple independent replications + post-publication OOS
data_requirements: [daily-OHLCV | intraday | options | fundamentals | macro | alternative]
feasibility_daily_bars: true | false
last_reviewed: YYYY-MM-DD
---
```

## Required sections

1. **Claim inventory** — every substantive claim as a bullet, each prefixed with its epistemic label.
2. **Mathematics** — full equations, every variable defined. No verbal-only specifications.
3. **Economic rationale** — why the effect should exist (risk premium? behavioral? microstructure?).
4. **Argus mapping** — what exists, what's missing, what layer it belongs in.
5. **Failure modes** — how it breaks, when it decays, cost sensitivity.
6. **Verdict** — PROMOTE / RESEARCH FURTHER / REJECT, with reasons.
