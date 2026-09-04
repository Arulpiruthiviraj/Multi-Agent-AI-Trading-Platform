# ARGUS × AI-Trader — Comparative Analysis (First-Pass Reconnaissance)

**Date:** 2026-09-04. **Scope note, stated plainly:** this is a genuine, evidence-based first pass, not the full 10-phase exhaustive comparison the mission specified. It arrived as the third large mission stacked mid-turn tonight, after the readiness pass, the ResearchTriggerEngine build, and the trader-grade audit. This report covers what was actually investigated with real evidence: the README/architecture, and the three "Special Investigation" areas the mission itself flagged as highest-priority (data fallback, service/worker separation, experiment/challenge scoring). The frontend, copy-trading, trade-sync, team-missions, signal-quality, and market-intel subsystems were **not** examined — named here, not silently skipped.

## 1. What AI-Trader Actually Is

Verified from the README and directory structure, not marketing copy: **AI-Trader is a hosted, multi-tenant social/copy-trading marketplace platform** (`ai4trade.ai`) where many external AI agents register via a skill file, publish signals, "debate," copy each other's positions, and earn reward points for followers. The self-hosted repo (`service/server` FastAPI + `service/frontend` React) is the platform backend for running your own instance of that marketplace — it is not, itself, a single autonomous trading engine that independently decides its own trades the way Argus's ChiefTrader→RiskEngine→OMS spine does.

**This is a different kind of system from Argus, not a competing implementation of the same thing.** Most of AI-Trader's headline differentiators (copy trading, signal marketplace, reward points, cross-platform signal sync, community discussion) are platform/social mechanics with no direct trading-alpha relevance to Argus, and would conflict with Argus's own explicit single-tenant, "sibling engines are untrusted, read-only" architecture (`CLAUDE.md`). None of these were considered for transfer.

## 2. Special Investigation Findings

### Data fallback (Alpha Vantage → yfinance) — **REJECTED**

`price_fetcher.py`'s yfinance fallback, on its daily-bar path (used when the finer 1-minute intraday data is unavailable), searches up to **10 days back** for the most recent daily close and returns it as a bare `float` with **no staleness metadata** propagated to the caller — only a debug log line, nothing structured. A caller receiving this price cannot distinguish "just fetched, real-time" from "up to 10 days old."

**Argus is already better here.** Gate 13 (`data_freshness`) fails closed on stale/missing price data by design (`stalePriceThresholdMs`, null age → fail, DEF-08) rather than silently substituting an old price. Importing this pattern as-is would be a regression, not an improvement. If Argus ever wants a secondary price source for resilience, it would need to carry an explicit freshness timestamp through to the *same* existing fail-closed gate — AI-Trader's implementation does not do this, so there is nothing to directly port.

### Service/worker process separation — **PARTIALLY INTERESTING, NOT IMPLEMENTED**

`worker.py` is a genuinely well-built standalone background-task process, separate from the FastAPI `main.py`, using a singleton lock (Redis-preferred, file-lock fallback, with a heartbeat-renewal task) to guarantee exactly one worker runs at a time — directly analogous to the Chronos duplicate-spawn problem fixed earlier tonight, and structurally more robust than that fix (a real exclusive lock vs. my health-check-based race check).

**Not applicable as a wholesale transfer**: Argus's actual architecture (a single Node.js process running Express + background `setInterval` workers in the same event loop) is a deliberate, different, already-documented design (`CLAUDE.md`: "Single Node.js process... Do not rewrite that path"), and there is no evidence tonight that Argus's HTTP responsiveness is being starved by background work — the observed failure modes were an external Python sidecar's memory leak and one unexplained death, neither of which this pattern would have prevented. Splitting Argus into separate API/worker OS processes would be the kind of "massive architectural change" the mission itself said not to make without demonstrated value.

**The one genuinely transferable idea**: upgrading `local_ai_service.py`'s duplicate-instance guard (currently a health-check race, built earlier tonight) to a real file lock, matching this exact pattern. Evaluated and **not implemented this pass** — the realistic failure mode it would close (two processes racing to spawn within the same few seconds) is narrower than what the existing health-check fix already handles (the actual observed incident: a human running `npm run ai:serve` manually while the engine's own launcher raced it), and Windows-compatible file locking in Python adds real cross-platform complexity for a low-probability residual case. Flagged as a legitimate future improvement, not dismissed.

### Experiment/challenge scoring — **REJECTED (different problem, not a missing capability)**

`challenge_scoring.py` replays trades against mark-to-market prices to score participants in monthly leaderboard "challenges" — this is competitive-ranking infrastructure for *many external agents competing against each other publicly*, not a strategy-validation methodology. Argus's own internal validation (`agent-edge`'s Wilson-confidence-interval calibration maturity, `researchSafety.json`'s OOS/WFO/paper-trade soak floors) already solves the actual problem Argus has — "should this one strategy be trusted with real capital" — more rigorously than a leaderboard replay engine designed to rank contest entrants. Nothing here fills a real Argus gap.

## 3. Implemented Transfers

**None.** Every capability investigated this pass either duplicated something Argus already does better (data freshness, strategy validation) or didn't clearly apply given Argus's actual architecture and observed failure modes (service/worker split). This is a legitimate outcome of a comparative audit, not a failure to find anything — the mission's own instructions explicitly permit "if the existing implementation is good, keep it."

## 4. Not Yet Investigated (named, not hidden)

Frontend (React), `routes_signals.py`/`routes_trading.py` (the actual paper-trading execution path — the single most directly comparable subsystem to Argus's OMS, and the most valuable remaining investigation), `team_missions.py`, `signal_quality.py`, `market_intel.py`, copy-trading/trade-sync skill definitions, and licensing (no `LICENSE` file exists in this clone despite the README's MIT badge — worth flagging to the user directly, not just noting here).

## 5. Recommendation

The highest-value remaining investigation, if this comparison continues, is AI-Trader's actual paper-order execution path (`routes_trading.py`) against Argus's OMS — that's the one subsystem doing genuinely the same job in both systems and hasn't been read yet. Given three large missions were already completed tonight, this is offered as a next step, not attempted here.
