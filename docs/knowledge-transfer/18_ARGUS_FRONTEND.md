# 18 — Frontend

SPA: Vite, Tailwind, Recharts, lucide. `src/App.tsx` (~10k+ lines). Auth: `AUTH_PASSWORD` gates Login; **hooks above early return still run** — gate fetches on `isAuthenticated`.

## 21 tabs (`activeTab`)

Trade: dashboard, command, portfolio, arena.  
Markets: news, opportunities, scanner, intelligence.  
Agents: agents, evaluation, kronos, learning, memory.  
Ops: observatory, activity, diagnostics, audit.  
System: validation, deployment, settings, documentation.

**Real (prefer these):** Observatory (`TransactionExplorer`), Activity log, Agent Evaluation, Kronos (honest unavailable), News core APIs, scanner RSI via `/api/v2/strategy/rsi-scan` (not charCodeAt overlay — overlay now AwaitingSignal).

**Purged 2026-08-15:** Arena mock risk-decomp, regime heatmap, model benchmark bars, 40-bar overlay, mock factor drilldown → `AwaitingSignal`.

**Still fabricated / mixed:** Opportunity cards theater, Validation Date.now tests, Deployment dropdown score, `audit` vs observatory, Dashboard hardcoded shells, Agent dialogue/heatmap theater, Intelligence fallbacks. L2: honest unavailable.

Walkthrough: `localStorage argus_tour_seen`. Wizard: `settings.onboardingComplete` (e2e seeds both).

No Redux as system of record — React state + fetch + WS.
