# Argus on Windows: keeping engine + watchdog alive across sleep, logoff and session teardown

Status: tooling written 2026-10-13 in `feature/oct13-intraday-and-recovery`; **nothing here is installed or deployed** (installing a Scheduled Task changes the host and needs the operator's explicit go-ahead).

## What happened (evidence)
- Windows System log: `Kernel-Power 42 "The system is entering sleep" Sleep Reason: Application API` at **2026-10-12 23:44:19 ET**, resume (107) at 23:44:22, and the clock jumped to **08:57:21** on 10-13. Idle sleep/hibernate timeouts are 0 (never) on AC and DC, so this was an explicit request by an application, not an idle timeout. The initiating application is **not identified** [U].
- Argus engine: last event 23:43:48 ET (event gap of 564 minutes); watchdog: last decision 23:44:03 ET ("SUSPECT", frozen-suspect tick 2/10); **no log line from either process after the resume** and no node process existed at 09:07 [C].
- How the processes died is **not proven**. Strongly supported [S]: both were started by the Claude Code session's shell (`argus start`, detached) and were torn down with that session/tree when it ended around the sleep; a process that merely slept would have resumed and the watchdog would have logged a stale-heartbeat decision after 08:57. Either way, nothing independent of the interactive session was supervising them.

## What is NOT guaranteed by any watchdog
A watchdog that is a child of the same session dies with it. A Node timer cannot fire while the machine sleeps. Software exits (PortfolioMonitor, 60 s) are therefore not protection while the host is asleep or the engine is down; only a broker-resident order protects through that window (not built; needs operator authorization, see below).

## Tooling (this branch)
| File | Purpose |
|---|---|
| `scripts/windows/argus-supervisor.ps1` | Idempotent recovery: if `/health` is down, start ONE engine via `argus start` (no `--enable-trading`, boots paused), start the watchdog, record reconciliation. Never resumes trading, never touches orders/DB/config; refuses unless `.env` has `PAPER_TRADING_ONLY=true`. Logs to `data/logs/supervisor.log`. |
| `scripts/windows/install-argus-supervisor.ps1` | Registers it as a per-user Scheduled Task (startup, logon, every 15 min; wake-to-run; restart on failure). **Dry run by default**; `-Apply` registers, `-Remove -Apply` removes. |
| `scripts/windows/check-argus-power-readiness.ps1` | Read-only: sleep/hibernate timeouts, lid action, every sleep/resume since a date, supervisor-task presence. |

## Entry control during recovery
The supervisor boots paused. With `tradingSafety.restartSafetyEntriesOnlyPause=true` (default **false**) the boot restart-safety pause is `ENTRIES_ONLY`: new entries are blocked until an operator resumes, but a SEALED protective SELL (minted only by PortfolioMonitor, bound to trace+symbol) may pass RiskEngine's `emergency_stop` gate; every other gate (position existence, quantity, price, session/spread policy, freshness, reconciliation) still applies, EMERGENCY_STOP is never exempt, and every other pause source (reconciliation, operator, memory, watchdog) stays a FULL pause. Tests: `RiskEngine.entriesOnlyPause.test.ts`.

## Operator decisions required
1. Install the Scheduled Task (`install-argus-supervisor.ps1 -Apply`)?
2. Enable `restartSafetyEntriesOnlyPause` (so a recovery boot can still stop out a carried position)?
3. Keep the host awake while PAPER positions are open (power plan never sleep/hibernate, lid action do nothing); find what requested sleep at 23:44 (`powercfg /requests`, app logs).
4. Broker-resident protective orders for any carried position (new OMS order path; needs separate review).
