# Argus documentation index

Start here. Forensic docs live under `docs/`. The live-path **contract** remains repo-root [`CLAUDE.md`](../CLAUDE.md). Adding markdown does not raise LIVE readiness.

**Why the name ARGUS?** [`README.md`](../README.md) § Why "ARGUS"? (Argus Panoptes — many eyes, one disciplined decision process). Do not treat the metaphor as unlimited visibility or a second trading brain.

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
| [`ARGUS_HISTORICAL_EVALUATION.md`](../ARGUS_HISTORICAL_EVALUATION.md) | MODE B replay product (not organic paper) |

---

## FOR OPERATORS

Daily “is the desk working?” and “why no trades?”

1. [ARGUS_DAILY_FORENSIC_CHECKLIST.md](ARGUS_DAILY_FORENSIC_CHECKLIST.md) — health checklist, diagnostic URLs, config hierarchy, secret-safe checks  
2. [ARGUS_WHY_NOT_TRADING.md](ARGUS_WHY_NOT_TRADING.md) — 16-step idle/reject runbook  
3. [ARGUS_WHY_DID_IT_TRADE.md](ARGUS_WHY_DID_IT_TRADE.md) — reconstruct a fill  
4. [ARGUS_FORENSIC_DEBUGGING_GUIDE.md](ARGUS_FORENSIC_DEBUGGING_GUIDE.md) — master map of the pipeline  
5. Paper soak / LIVE_NO_GO: `CLAUDE.md` §5 and `GET /api/v2/live-readiness`  
6. [ARGUS_MOBILE_SETTINGS.md](ARGUS_MOBILE_SETTINGS.md) — phone Settings tab (writable vs read-only; overlay APIs; does not arm LIVE)
7. Engine without a browser: `npm run start:engine` then `npm run argus-cli -- status` — see `ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md`

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
| `docs/ARGUS_OPPORTUNITY_DISCOVERY.md` | Seed watchlist vs optional screener ideas |
| `docs/ARGUS_PORTFOLIO_INTELLIGENCE.md` | Position SELL still uses the spine |
| `docs/ARGUS_READINESS.md` | Levels 1–6; LIVE stays NO-GO |
| `docs/ARGUS_INCIDENTS.md` | Incident notes (root incident reports were folded here) |
| `ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md` | Headless + engine daemon |
| `docs/ARGUS_TRADING_FLOW.md` | End-to-end BUY/SELL walkthrough |
| `ARGUS_CURRENT_ARCHITECTURE.md` | **Stub** — superseded by CLAUDE.md + architecture contracts |

---

## Debugging / database / agents / consensus / risk / execution / portfolio / observability

Unchanged forensic set under `docs/`: `ARGUS_FORENSIC_DEBUGGING_GUIDE.md`, `ARGUS_WHY_NOT_TRADING.md`, `ARGUS_WHY_DID_IT_TRADE.md`, `ARGUS_TRADE_FORENSIC_IDS.md`, `ARGUS_DAILY_FORENSIC_CHECKLIST.md`, `ARGUS_DATABASE_ARCHITECTURE.md`, `docs/sql/`, `ARGUS_AGENT_FORENSICS.md`, `ARGUS_CONSENSUS_FORENSICS.md`, `ARGUS_RISK_FORENSICS.md`, `ARGUS_EXECUTION_FORENSICS.md`, `ARGUS_PORTFOLIO_EXIT_FORENSICS.md`, `ARGUS_LOGGING_AND_OBSERVABILITY.md`, `ARGUS_OBSERVABILITY.md`, `ARGUS_EVENTBUS_REFERENCE.md`.

---

## Argus Historical Evaluation (MODE B)

Not organic paper. Not LIVE. Default universe **ARGUS_DISCOVERY**.

| Doc |
|---|
| [`ARGUS_HISTORICAL_EVALUATION.md`](../ARGUS_HISTORICAL_EVALUATION.md) — product / honesty |
| [`docs/ARGUS_REPLAY_USER_GUIDE.md`](ARGUS_REPLAY_USER_GUIDE.md) — operator UI/API |
| [`ARGUS_PHASE_C_HISTORICAL_EVALUATION_FINAL_AUDIT.md`](../ARGUS_PHASE_C_HISTORICAL_EVALUATION_FINAL_AUDIT.md) — Phase C evidence snapshot |

---

## Engine daemon (Phase D)

| Doc |
|---|
| [`ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md`](../ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md) |
| [`ARGUS_PHASE_D_ENGINE_DAEMON_FINAL_AUDIT.md`](../ARGUS_PHASE_D_ENGINE_DAEMON_FINAL_AUDIT.md) — 1814 tests PASS · build PASS · still **LIVE_NO_GO** |

**Stubs** (superseded; short pointers only):  
`ARGUS_HEADLESS_ARCHITECTURE.md`, `ARGUS_HEADLESS_ARCHITECTURE_AUDIT.md`, `ARGUS_HEADLESS_RUNTIME_FINAL_AUDIT.md`, `ARGUS_PHASE_C_HISTORICAL_EVALUATION_AUDIT.md`, `ARGUS_PHASE_C_LOOKAHEAD_AUDIT.md`, `ARGUS_CURRENT_ARCHITECTURE.md`, `ARGUS_TOMORROW_PAPER_READINESS_FINAL.md`, `ARGUS_PIPELINE_STATUS.md`, `ARGUS_CONSENSUS_RUNTIME_FORENSIC.md`, `ARGUS_CONTINUOUS_INTELLIGENCE_REPORT.md`, `ARGUS_MULTI_ASSET_IMPLEMENTATION_REPORT.md`, `ARGUS_AUTONOMOUS_ENGINE_IMPLEMENTATION_PLAN.md`, `ARGUS_TARGET_MISSION_PLAN.md`, `ARGUS_EXIT_INTELLIGENCE_PLAN.md`, `docs/ARGUS_DOCUMENTATION_AUDIT.md`.

---

## Configuration / security

| Doc |
|---|
| `ARGUS_CONFIGURATION_ARCHITECTURE.md` |
| `ARGUS_SETTINGS_CONFIGURATION_MATRIX.md` |
| `ARGUS_ENV_SETTINGS_MIGRATION.md` |
| `ARGUS_CONFIGURATION_SECURITY.md` |
| `docs/ARGUS_MOBILE_SETTINGS.md` |

---

## Retained forensic snapshots (linked from code or capital rules)

| Doc | Why kept (not living contract) |
|---|---|
| `ARGUS_CAPITAL_AUDIT_REPORT.md` | Budget vs broker equity / `argus_capital_allocation` forensics |
| `ARGUS_2024_ZERO_TRADE_FORENSIC_AUDIT.md` | Referenced from RiskEngine comments; session idle forensics |

Prefer `CLAUDE.md` + current code where any snapshot disagrees.
