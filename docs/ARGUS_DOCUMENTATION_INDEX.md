# Argus documentation index

Start here. Forensic docs live under `docs/`. The live-path **contract** remains repo-root [`CLAUDE.md`](../CLAUDE.md). Adding markdown does not raise LIVE readiness.

---

## FOR OPERATORS

Daily “is the desk working?” and “why no trades?”

1. [ARGUS_DAILY_FORENSIC_CHECKLIST.md](ARGUS_DAILY_FORENSIC_CHECKLIST.md) — health checklist, diagnostic URLs, config hierarchy, secret-safe checks  
2. [ARGUS_WHY_NOT_TRADING.md](ARGUS_WHY_NOT_TRADING.md) — 16-step idle/reject runbook  
3. [ARGUS_WHY_DID_IT_TRADE.md](ARGUS_WHY_DID_IT_TRADE.md) — reconstruct a fill  
4. [ARGUS_FORENSIC_DEBUGGING_GUIDE.md](ARGUS_FORENSIC_DEBUGGING_GUIDE.md) — master map of the pipeline  
5. Paper soak / LIVE_NO_GO: `CLAUDE.md` §5 and `GET /api/v2/live-readiness`  
6. [ARGUS_MOBILE_SETTINGS.md](ARGUS_MOBILE_SETTINGS.md) — phone Settings tab (writable vs read-only; overlay APIs; does not arm LIVE)

Do not enable Autobot or LIVE from documentation.

---

## FOR DEVELOPERS

Extend around the protected spine. Do not rewrite ChiefTrader / RiskEngine / OMS / BrokerManager.

1. [`CLAUDE.md`](../CLAUDE.md) — architecture protection, 24 gates, EventBus path  
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
| `CLAUDE.md` | Live path contract |
| `ARGUS_ARCHITECTURE_PROTECTION.md` | What must not be modified |
| `ARGUS_CURRENT_ARCHITECTURE.md` | Prior architecture write-up (cross-check; prefer code) |
| `docs/ARGUS_FORENSIC_DEBUGGING_GUIDE.md` | Pipeline stages |

## Debugging

| Doc |
|---|
| `docs/ARGUS_FORENSIC_DEBUGGING_GUIDE.md` |
| `docs/ARGUS_WHY_NOT_TRADING.md` |
| `docs/ARGUS_WHY_DID_IT_TRADE.md` |
| `docs/ARGUS_TRADE_FORENSIC_IDS.md` |
| `docs/ARGUS_DAILY_FORENSIC_CHECKLIST.md` |

## Database

| Doc |
|---|
| `docs/ARGUS_DATABASE_ARCHITECTURE.md` |
| `docs/sql/README.md` |
| `docs/sql/01_recent_trades.sql` … `18_integrity_checks.sql` |

## Agents

| Doc |
|---|
| `docs/ARGUS_AGENT_FORENSICS.md` |

## Consensus

| Doc |
|---|
| `docs/ARGUS_CONSENSUS_FORENSICS.md` |

## Risk

| Doc |
|---|
| `docs/ARGUS_RISK_FORENSICS.md` |

## Execution

| Doc |
|---|
| `docs/ARGUS_EXECUTION_FORENSICS.md` |

## Portfolio

| Doc |
|---|
| `docs/ARGUS_PORTFOLIO_EXIT_FORENSICS.md` |

## Observability

| Doc |
|---|
| `docs/ARGUS_LOGGING_AND_OBSERVABILITY.md` |
| `docs/ARGUS_EVENTBUS_REFERENCE.md` |

## Configuration / security

| Doc |
|---|
| `ARGUS_CONFIGURATION_ARCHITECTURE.md` |
| `ARGUS_SETTINGS_CONFIGURATION_MATRIX.md` |
| `ARGUS_ENV_SETTINGS_MIGRATION.md` |
| `ARGUS_CONFIGURATION_SECURITY.md` |
| `docs/ARGUS_DAILY_FORENSIC_CHECKLIST.md` (hierarchy + secret-safe commands) |
| `docs/ARGUS_MOBILE_SETTINGS.md` (phone Settings tab; same overlay APIs as desktop Dual configuration) |

## SQL

| Doc |
|---|
| `docs/sql/` |

## Audit of this documentation set

| Doc |
|---|
| `docs/ARGUS_DOCUMENTATION_AUDIT.md` |
