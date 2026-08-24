# Argus documentation index

Start here. Forensic docs live under `docs/`. The live-path **contract** remains repo-root [`CLAUDE.md`](../CLAUDE.md). Adding markdown does not raise LIVE readiness.

**Why the name ARGUS?** [`README.md`](../README.md) § Why "ARGUS"? (Argus Panoptes — many eyes, one disciplined decision process). Do not treat the metaphor as unlimited visibility or a second trading brain.

**Verified harness (2026-08-23):** `npm run lint` exit 0 · `npm test` **348** files / **2207** tests (re-check with `npm test` — trust the runner, not a remembered count) · Node **24.18.0** / npm **12** · schema **60** tables · **LIVE_NO_GO** · organic closed PAPER FILLED SELL P&L soak baseline still **0** until soak counts real closes.

---

## Living documents (prefer these)

| Doc | Role |
|---|---|
| [`README.md`](../README.md) | Name philosophy, setup, commands (`start:engine`) |
| [`CLAUDE.md`](../CLAUDE.md) | Operational master spec — live path, 24 gates, soak, LIVE_NO_GO |
| [`ARGUS_ARCHITECTURE_CONTRACT.md`](../ARGUS_ARCHITECTURE_CONTRACT.md) | Binding 15-point contract |
| [`ARGUS_ARCHITECTURE_PROTECTION.md`](../ARGUS_ARCHITECTURE_PROTECTION.md) | What must not be modified |
| [`ARGUS_ARCHITECTURE_INVARIANTS.md`](../ARGUS_ARCHITECTURE_INVARIANTS.md) | Spine / safety / required tests |
| [`ARGUS_AI_CHANGE_RULES.md`](../ARGUS_AI_CHANGE_RULES.md) | Rules for AI-authored changes |
| [`ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md`](../ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md) | Engine daemon + headless (one core; Vite optional) |
| [`ARGUS_CLI.md`](../ARGUS_CLI.md) | HTTP CLI + process start/stop |
| [`ARGUS_SHELL_CLI.md`](../ARGUS_SHELL_CLI.md) | `./argus` Bash operator control plane |
| [`ARGUS_HISTORICAL_EVALUATION.md`](../ARGUS_HISTORICAL_EVALUATION.md) | MODE B replay product (not organic paper) |
| [`ARGUS_CAMPAIGN_TRACKER.md`](../ARGUS_CAMPAIGN_TRACKER.md) | Daily Goal Campaign (flag-gated; attribution + soft-lock) |
| [`ARGUS_CONFIGURATION_ARCHITECTURE.md`](../ARGUS_CONFIGURATION_ARCHITECTURE.md) | Config layers / overlays |
| [`ARGUS_CONFIGURATION_SECURITY.md`](../ARGUS_CONFIGURATION_SECURITY.md) | Secrets / auth / overlays |
| [`docs/architecture/SYSTEM_OVERVIEW.md`](architecture/SYSTEM_OVERVIEW.md) | Navigational architecture summary (points back to `CLAUDE.md`) |
| [`docs/architecture/RISK_ENGINE_24_GATES.md`](architecture/RISK_ENGINE_24_GATES.md) | 24-gate name list + how to verify current thresholds |
| [`docs/architecture/MULTI_AGENT_CONSENSUS.md`](architecture/MULTI_AGENT_CONSENSUS.md) | ChiefTrader weighting/debate/quorum mechanics |
| [`docs/architecture/JAVA_QUANT_CORE.md`](architecture/JAVA_QUANT_CORE.md) | Java Quant Core entry point (→ blueprint + status audit) |
| [`docs/operations/DEVOPS_LIFECYCLE.md`](operations/DEVOPS_LIFECYCLE.md) | `argus.sh` / `npm run dev` process lifecycle |
| [`docs/operations/IBKR_GATEWAY_SETUP.md`](operations/IBKR_GATEWAY_SETUP.md) | IB Gateway socket/web_api setup + troubleshooting |
| [`docs/operations/CAMPAIGN_MANAGEMENT.md`](operations/CAMPAIGN_MANAGEMENT.md) | Daily Goal Campaign operations summary |

---

## FOR OPERATORS

Daily “is the desk working?” and “why no trades?”

1. [ARGUS_DAILY_FORENSIC_CHECKLIST.md](ARGUS_DAILY_FORENSIC_CHECKLIST.md) — health checklist, diagnostic URLs, config hierarchy, secret-safe checks  
2. [ARGUS_WHY_NOT_TRADING.md](ARGUS_WHY_NOT_TRADING.md) — 16-step idle/reject runbook  
3. [ARGUS_WHY_DID_IT_TRADE.md](ARGUS_WHY_DID_IT_TRADE.md) — reconstruct a fill  
4. [ARGUS_FORENSIC_DEBUGGING_GUIDE.md](ARGUS_FORENSIC_DEBUGGING_GUIDE.md) — master map of the pipeline  
5. Paper soak / LIVE_NO_GO: `CLAUDE.md` §5 and `GET /api/v2/live-readiness`  
6. [ARGUS_MOBILE_SETTINGS.md](ARGUS_MOBILE_SETTINGS.md) — phone Settings tab (writable vs read-only; overlay APIs; does not arm LIVE)
7. Engine without a browser: `./argus start` then `./argus status` (or `npm run start:engine` / `npm run argus-cli -- status`) — see `ARGUS_SHELL_CLI.md` and `ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md`
8. Daily Goal Campaign (optional): [`ARGUS_CAMPAIGN_TRACKER.md`](../ARGUS_CAMPAIGN_TRACKER.md) — does **not** force trades or lower consensus

Do not enable Autobot or LIVE from documentation.

---

## FOR DEVELOPERS

Extend around the protected spine. Do not rewrite ChiefTrader / RiskEngine / OMS / BrokerManager. Discovery and position intelligence must **feed** that spine (`emitTradeIdea`), never bypass it.

1. [`CLAUDE.md`](../CLAUDE.md)  
2. [`ARGUS_ARCHITECTURE_PROTECTION.md`](../ARGUS_ARCHITECTURE_PROTECTION.md)  
3. [ARGUS_FORENSIC_DEBUGGING_GUIDE.md](ARGUS_FORENSIC_DEBUGGING_GUIDE.md)  
4. [ARGUS_TRADE_FORENSIC_IDS.md](ARGUS_TRADE_FORENSIC_IDS.md)  
5. [ARGUS_DATABASE_ARCHITECTURE.md](ARGUS_DATABASE_ARCHITECTURE.md)  
6. [ARGUS_EVENTBUS_REFERENCE.md](ARGUS_EVENTBUS_REFERENCE.md)  
7. Setup: [`README.md`](../README.md)

---

## Architecture

| Doc | Contents |
|---|---|
| Binding five | `CLAUDE.md`, contract, protection, invariants, AI change rules |
| `docs/ARGUS_OPPORTUNITY_DISCOVERY.md` | Seed watchlist vs optional screener ideas (`maxActiveSubscriptions` **30**) |
| `docs/ARGUS_PORTFOLIO_INTELLIGENCE.md` | Position SELL still uses the spine |
| `docs/ARGUS_READINESS.md` | Levels 1–6; LIVE stays NO-GO |
| `docs/ARGUS_INCIDENTS.md` | Incident notes (root incident reports were folded here) |
| `ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md` | Headless + engine daemon |
| `docs/ARGUS_TRADING_FLOW.md` | End-to-end BUY/SELL walkthrough |
| `ARGUS_CAMPAIGN_TRACKER.md` | Campaign soft-lock + attribution (additive) |

---

## Debugging / database / agents / consensus / risk / execution / portfolio / observability

Unchanged forensic set under `docs/`: `ARGUS_FORENSIC_DEBUGGING_GUIDE.md`, `ARGUS_WHY_NOT_TRADING.md`, `ARGUS_WHY_DID_IT_TRADE.md`, `ARGUS_TRADE_FORENSIC_IDS.md`, `ARGUS_DAILY_FORENSIC_CHECKLIST.md`, `ARGUS_DATABASE_ARCHITECTURE.md`, `docs/sql/`, `ARGUS_AGENT_FORENSICS.md`, `ARGUS_CONSENSUS_FORENSICS.md`, `ARGUS_RISK_FORENSICS.md`, `ARGUS_EXECUTION_FORENSICS.md`, `ARGUS_PORTFOLIO_EXIT_FORENSICS.md`, `ARGUS_LOGGING_AND_OBSERVABILITY.md`, `ARGUS_OBSERVABILITY.md`, `ARGUS_EVENTBUS_REFERENCE.md`.

---

## Argus Historical Evaluation (MODE B)

Not organic paper. Not LIVE. Default universe **ARGUS_DISCOVERY**. Labels: **HISTORICAL_SIMULATION** / **NOT_PROMOTION_EVIDENCE**.

| Doc |
|---|
| [`ARGUS_HISTORICAL_EVALUATION.md`](../ARGUS_HISTORICAL_EVALUATION.md) — product / honesty |
| [`docs/ARGUS_REPLAY_USER_GUIDE.md`](ARGUS_REPLAY_USER_GUIDE.md) — operator UI/API |
| [`ARGUS_CLI.md`](../ARGUS_CLI.md) / [`ARGUS_SHELL_CLI.md`](../ARGUS_SHELL_CLI.md) — `./argus replay …` thin router |
| [`docs/audits/archive/ARGUS_PHASE_C_HISTORICAL_EVALUATION_FINAL_AUDIT.md`](audits/archive/ARGUS_PHASE_C_HISTORICAL_EVALUATION_FINAL_AUDIT.md) — Phase C evidence snapshot (**historical**) |

---

## Engine daemon (Phase D)

| Doc |
|---|
| [`ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md`](../ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md) |
| [`docs/audits/archive/ARGUS_PHASE_D_ENGINE_DAEMON_FINAL_AUDIT.md`](audits/archive/ARGUS_PHASE_D_ENGINE_DAEMON_FINAL_AUDIT.md) — Phase D snapshot (**historical** test counts; prefer `npm test` for current totals). Still **LIVE_NO_GO**. |

---

## Configuration / security

| Doc |
|---|
| `ARGUS_CONFIGURATION_ARCHITECTURE.md` |
| `ARGUS_SETTINGS_CONFIGURATION_MATRIX.md` |
| `ARGUS_ENV_SETTINGS_MIGRATION.md` |
| `ARGUS_CONFIGURATION_SECURITY.md` |
| `docs/ARGUS_MOBILE_SETTINGS.md` |

Canonical env catalog: `config/runtimeEnvCatalog.json`. Reviewed safety numbers: `config/tradingSafety.json`.

---

## Historical forensic audits (immutable)

Dated phase / market / remediation reports, relocated (2026-08-23, `git mv` — history preserved)
from repo root into `docs/audits/archive/` to keep the root down to living canonical docs (e.g.
`docs/audits/archive/ARGUS_POST_FIX_FORENSIC_AUDIT_2026-08-21.md`,
`docs/audits/archive/ARGUS_PHASE_D_ENGINE_DAEMON_FINAL_AUDIT.md`,
`docs/audits/archive/ARGUS_PREDICTIVE_EDGE_FORENSIC_AUDIT.md`,
`docs/audits/archive/ARGUS_PHASE_F_NEWS_ARCHITECTURE_AUDIT.md`). **Do not rewrite** their facts —
only their location changed. Living docs may **cite conclusions** but must not present old PIDs /
old test totals as current. More-recent, still-active audits (e.g. IBKR/discovery forensics, the
Java Quant Core status audit) stay directly under `docs/audits/` — only superseded/dated snapshots
move to `docs/audits/archive/`.

| Doc | Why kept |
|---|---|
| `docs/audits/archive/ARGUS_CAPITAL_AUDIT_REPORT.md` | Budget vs broker equity / `argus_capital_allocation` forensics |
| `docs/audits/archive/ARGUS_2024_ZERO_TRADE_FORENSIC_AUDIT.md` | Referenced from RiskEngine comments; session idle forensics |
| `docs/audits/archive/ARGUS_PHASE_F_NEWS_ARCHITECTURE_AUDIT.md` | News 24/7 / staging design snapshot (living behavior: `NewsEngine` + `MarketOpenNewsConfluence`) |

Prefer `CLAUDE.md` + current code where any snapshot disagrees.
