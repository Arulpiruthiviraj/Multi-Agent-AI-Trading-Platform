# ARGUS Phase E — Shell CLI Final Audit

**Date:** 2026-08-20  
**Scope:** Operator shell control plane (`./argus` + `scripts/cli/`)  
**Honesty rule:** Evidence grades are literal. `RUN-VERIFIED` only where commands were executed in this session.

---

## 1. Architecture before / after

### Before (Phase E)

```text
npm run argus-cli -- <cmd>     →  HTTP / enginePid spawn  →  Argus Engine  →  Argus Core
npm run argus.sh / argus.sh    →  broader DevOps ecosystem script (legacy)
```

Operators used the TypeScript HTTP client directly (`scripts/argus-cli.ts`) or the ecosystem shell. There was no thin industry-style `./argus` router with local help, doctor, and exit codes.

### After (Phase E)

```text
./argus | bash ./argus | npm run argus -- <cmd>
    → scripts/cli/common.sh (router / formatting / doctor)
    → npm run argus-cli  |  npm run start:engine | test | build | vitest check
    → Argus Engine HTTP API (+ PID lifecycle for start/stop)
    → Argus Core (ChiefTrader → RiskEngine → PositionSizing → OMS → BrokerManager)
```

**Invariant preserved:** The shell does **not** import or call RiskEngine, OMS, BrokerManager, or `.placeOrder(`. Historical Evaluation (`replay *`) stays inside the engine over HTTP.

Legacy ecosystem entry remains: `npm run argus:ecosystem` → `bash ./argus.sh`.

---

## 2. Files created / modified

### Created

| Path | Role |
|------|------|
| `argus` | Root bash entry (command router) |
| `scripts/cli/common.sh` | Shared helpers, help text, start/status/health/ready/replay/doctor |
| `scripts/cli/shellCli.protection.test.ts` | Architecture + RUN-when-bash tests |
| `ARGUS_SHELL_CLI.md` | Shell CLI operator doc |
| `ARGUS_PHASE_E_SHELL_CLI_FINAL_AUDIT.md` | This audit |

### Modified (Phase E + verification fixes)

| Path | Change |
|------|--------|
| `ARGUS_CLI.md` | Engine requirement; Historical Evaluation inside engine |
| `scripts/argus-cli.ts` | ROOT via `import.meta`; version/ready/replay analyze/diagnostics; fetch timeout; `--prod` only when explicit |
| `package.json` | `"argus": "bash ./argus"`, `"argus:ecosystem": "bash ./argus.sh"`, `stop`/`status` → `./argus` |
| `docs/ARGUS_DOCUMENTATION_INDEX.md` | Index pointer to shell CLI |
| `README.md` | Commands table row for `bash ./argus` / `npm run argus` |
| `scripts/cli/common.sh` | Version resolves `package.json` under `ARGUS_ROOT`; doctor bounded HTTP probe; auth (401/403) vs down; `--follow` refusal |
| `scripts/cli/shellCli.protection.test.ts` | Windows Git Bash discovery; doctor timeout |

---

## 3. Delegation flow

| Layer | Responsibility |
|-------|----------------|
| `./argus` | Parse first arg; route; local help/version; exit codes |
| `scripts/cli/common.sh` | Help text, human formatting, doctor env checks, follow-guard, replay sub-router |
| `npm run argus-cli` | HTTP client + engine PID start/stop/restart (no trading brain) |
| Engine HTTP | Runtime status/health/readiness, trading toggles, portfolio, replay APIs |
| Argus Core | Protected spine only (unchanged) |

`argus check` → vitest architecture + shell protection filters.  
`argus test` / `argus build` → `npm test` / `npm run build`.

---

## 4. Safety boundaries

- Shell sources must not call `evaluateRisk(`, `BrokerManager.getInstance`, OMS imports, or `.placeOrder(`.
- `argus-cli.ts` must remain HTTP / `enginePid` only.
- No second kill switch; `kill-switch` delegates to existing emergency-stop API.
- `logs`/`events --follow` refused (exit 2); no unsafe infinite poll.
- Doctor never prints secrets (`.env` presence only).
- Stop path uses existing SIGTERM / enginePid lifecycle (no `kill -9` from shell).
- Replay runs **inside** the engine; CLI does not spawn a second evaluation brain.

**TEST-VERIFIED:** `scripts/cli/shellCli.protection.test.ts` + `src/server/architecture.protection.test.ts` (29/29 focused).

---

## 5. Exit codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `ARGUS_EXIT_OK` | Success |
| 1 | `ARGUS_EXIT_FAIL` | Generic failure / doctor warnings |
| 2 | `ARGUS_EXIT_USAGE` | Unknown command / `--follow` refused / doctor critical (doctor help text) |
| 3 | `ARGUS_EXIT_ENGINE_DOWN` | Engine/API unavailable |
| 4 | `ARGUS_EXIT_NOT_READY` | Live readiness not `LIVE_READY` |
| 5 | `ARGUS_EXIT_AUTH` | HTTP 401/403 |
| 6 | `ARGUS_EXIT_SAFETY` | Reserved safety refusal |

Doctor: `0` healthy, `1` warnings, `2` critical (local env missing node/npm/etc.).

---

## 6. Command matrix (evidence grades)

Grades: **CODE-VERIFIED** (present in source), **TEST-VERIFIED** (automated), **RUN-VERIFIED** (executed this session), **NOT VERIFIED**, **UNKNOWN**.

| Command | CODE | TEST | RUN | Notes / evidence |
|---------|------|------|-----|------------------|
| `help` | Y | Y | **RUN-VERIFIED** | exit 0; prints ARGUS usage |
| `--help` / `-h` | Y | — | **RUN-VERIFIED** | first-arg case `-h\|--help\|help`; exit 0 |
| `version` / `--version` | Y | Y | **RUN-VERIFIED** | `argus 0.0.0 …`; package.json is literally `0.0.0` |
| unknown cmd | Y | Y | **RUN-VERIFIED** | `definitely-not-a-command` → exit **2** |
| `start --help` | Y | — | **RUN-VERIFIED** | exit 0; usage for `--dev\|--prod\|--headless` |
| `replay --help` | Y | — | **RUN-VERIFIED** | exit 0; subcommands listed |
| `replay run --help` | Y | Y | **RUN-VERIFIED** | exit 0; does not start a run |
| `doctor` | Y | Y | **RUN-VERIFIED** | exit **1** WARNINGS; auth distinguished |
| `help` from other dir | Y | Y | **RUN-VERIFIED** | `bash /c/WorkProjects/.../argus help` |
| `logs --follow` | Y | Y | **RUN-VERIFIED** | exit **2**; NOT SUPPORTED |
| `status` (auth wall) | Y | — | **RUN-VERIFIED** | exit **5** unauthorized (port 3000 listening, no token) |
| `status` human format (full payload) | Y | — | **NOT VERIFIED** | needs successful authenticated status JSON |
| `health` / `ready` happy path | Y | — | **NOT VERIFIED** | auth required on :3000 this session |
| `start` / `stop` / `restart` | Y | — | **NOT VERIFIED** | did not spawn long-lived engine (port busy / policy) |
| `enable` / `disable` / `kill-switch` | Y | — | **NOT VERIFIED** | requires auth + intentional trading action |
| `positions` / `trades` / `orders` / obs | Y | — | **NOT VERIFIED** | HTTP behind auth |
| `replay run\|list\|report\|analyze\|diagnostics` live | Y | — | **NOT VERIFIED** | needs engine + auth; help only verified |
| `check` / `test` / `build` via `./argus` | Y | — | **NOT VERIFIED** as `./argus *` | equivalent `npx vitest` / `npm test` / `npm run build` run directly |
| Engine listen / organic paper | — | — | **NOT VERIFIED** | PID 10296 on :3000 returns **401**; no `ARGUS_DEV_TOKEN` used; no engine start by this audit |

Windows: Git Bash at `C:\Program Files\Git\bin\bash.exe` (bash 5.3.15). Invoke as `bash ./argus` when `bash` is not on PATH.

---

## 7. RUN-VERIFIED command log (this session)

```text
bash ./argus help                         → exit 0
bash ./argus --help                       → exit 0
bash ./argus version                      → exit 0  (argus 0.0.0 …)
bash ./argus --version                    → exit 0
bash ./argus definitely-not-a-command     → exit 2  (Unknown command)
bash ./argus start --help                 → exit 0
bash ./argus replay --help                → exit 0
bash ./argus replay run --help            → exit 0
bash ./argus doctor                       → exit 1  (WARNINGS; auth required)
bash ./argus logs --follow                → exit 2
bash ./argus status                       → exit 5  (unauthorized)
bash <abs>/argus help   (cwd = %TEMP%)    → exit 0
```

---

## 8. Test / build results

### Focused

```text
npx vitest run scripts/cli/shellCli.protection.test.ts src/server/architecture.protection.test.ts
→ Test Files  2 passed (2)
→ Tests       29 passed (29)
```

Re-check after doctor auth patch:

```text
npx vitest run scripts/cli/shellCli.protection.test.ts
→ Tests  11 passed (11)
```

### Full suite

```text
npm test
→ Test Files  1 failed | 290 passed (291)
→ Tests       1 failed | 1843 passed (1844)
→ Duration    ~266.5s
```

**Failure (classified pre-existing — not shell CLI):**

- `src/server/services/RiskAgent.transactionLifecycle.test.ts`
- Expected `transactions.status === 'RISK_REJECTED'`, received `'OPEN'`
- Outside shell / `argus-cli` / docs; **not fixed** in this phase (per scope).

### Build

```text
npm run build
→ PASS (vite SPA + esbuild `dist/server.cjs`)
```

Chunk size warning on SPA bundle is pre-existing noise, not a Phase E regression.

---

## 9. Bugs found and fixed during verification

1. **`argus_version` cwd** — `require('./package.json')` depended on process cwd; now `cd "$ARGUS_ROOT"` first.  
2. **Doctor slow / test timeout** — doctor called full `npm run argus-cli` health/ready (slow fail); replaced with 2s `argus_http_probe`; doctor test timeout 20s; Windows Git Bash path discovery in protection tests.  
3. **Doctor mislabeled auth as “not reachable”** — port 3000 returned 401; probe now exits 5 on 401/403; doctor prints “requires auth”.  
4. **`argus-cli` fetch hang risk** — default `AbortSignal.timeout(10_000)` via `ARGUS_CLI_FETCH_TIMEOUT_MS`.  
5. **README** — added `bash ./argus` / `npm run argus` row (was only `argus-cli` / ecosystem).

`--help` as first argument already worked (no mapping bug).

---

## 10. Pre-existing failures / remaining limitations

| Item | Classification |
|------|----------------|
| RiskAgent transactionLifecycle status stuck `OPEN` | **Pre-existing** full-suite fail; not shell |
| Port 3000 occupied with AUTH_PASSWORD / no `ARGUS_DEV_TOKEN` in this shell | Environment; status/health/ready payloads **NOT VERIFIED** |
| Engine start/stop not exercised | Policy: avoid long-lived spawn; port busy |
| `package.json` version `0.0.0` | Honest; not a CLI bug |
| `./argus` not in Windows `cmd.exe` PATH without Git Bash | Documented; use `bash ./argus` or `npm run argus` |
| Human `status` formatter fields | CODE-VERIFIED; full happy-path **NOT VERIFIED** without auth |
| SPA chunk > 2MB warning on build | Pre-existing |

---

## 11. Verdict

Phase E shell CLI is **usable on Windows via Git Bash**, architecture boundaries hold under protection tests, help/version/usage/doctor/follow-guard paths are **RUN-VERIFIED**, and production **build passes**. Authenticated runtime control and engine lifecycle remain **NOT VERIFIED** in this session because `:3000` required auth and no long-lived engine was started by the auditor.

Do not treat this audit as LIVE readiness or organic paper evidence.

