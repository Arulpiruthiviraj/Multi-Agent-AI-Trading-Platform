# DevOps Lifecycle (`argus.sh` / ecosystem process management)

Real command reference — pulled from `argus.sh`, `scripts/ecosystem-dev.ts`, and
`scripts/devWithOpenAlice.ts`. `argus.sh`'s own header comment is the authority if this drifts:
*"Wraps the existing `npm run dev` orchestrator... does not replace it or duplicate its
Chronos/OpenAlice/IBKR spawn logic — this only manages the *process lifecycle* around it (ports,
PIDs, health)."*

## Commands

```bash
./argus.sh start      # nohup npm run dev, backgrounded, logs to logs/argus-dev.log
./argus.sh stop       # SIGTERM/taskkill the tracked launcher PID + tree
./argus.sh restart    # stop, then start
./argus.sh status     # real health probes (see below), not just "is a process running"
./argus.sh nuke       # aggressive cleanup of ports 3000/8008/47332/8085 + stale PID files
```

`npm run dev` itself (`scripts/ecosystem-dev.ts` → `scripts/devWithOpenAlice.ts` →
`tsx server.ts`) is what actually spawns every companion process. `argus.sh` never spawns
Chronos/Ollama/OpenAlice/IBKR/Java Quant Core itself — it only tracks the PID tree `npm run dev`
created and probes the real ports/health endpoints those companions expose.

## Boot sequence (what actually happens, in order)

1. `ecosystem-dev.ts` optionally starts sibling research repos (Vibe-Trading MCP, AutoHedge,
   FinceptTerminal) if their `ENABLE_*` flags are set — all read-only/research, never given Argus
   broker credentials.
2. `devWithOpenAlice.ts` starts, in parallel: Ollama (unless `ARGUS_SKIP_OLLAMA=true`), Chronos
   (unless `ARGUS_SKIP_CHRONOS=true`), OpenAlice Guardian (unless skipped), **Java Quant Core**
   (only if `QUANT_JAVA_CORE_ENABLED=true` — opposite default polarity from the others, since this
   one is opt-in shadow tooling, not a required companion).
3. IB Gateway is *probed* (never spawned in the default socket mode) —
   `docs/operations/IBKR_GATEWAY_SETUP.md`.
4. `tsx server.ts` (or the built `dist/server.cjs` in prod) starts last, once companions have had
   their health-wait window.

## Ports this manages/tracks

| Port | Service | Tracked by `argus.sh`'s kill/status logic |
|---|---|---|
| 3000 | Argus Node/Vite | Yes |
| 8008 | Chronos/Kronos | Yes |
| 47332 | OpenAlice Guardian MCP | Yes |
| 8085 | Java Quant Core (optional) | Yes (harmless FREE when `QUANT_JAVA_CORE_ENABLED` is off) |
| 11434 | Ollama | Probed via `check_node_health`-style curl, not in the kill-conflict array |
| 4002 / 7497 | IB Gateway (external app) | Probed only — `argus.sh` never kills or owns this process |

## Logs

| File | Contents |
|---|---|
| `logs/argus-dev.log` | Combined stdout/stderr of the entire `npm run dev` process tree (everything using `stdio:'inherit'`) |
| `logs/ollama-serve.log` | Ollama's own dedicated log (started directly by `argus.sh`, not through the Node tree) |
| `logs/quant-core-java.log` | Java Quant Core's dedicated log (structured JSON lines — see `docs/architecture/ARGUS_ARCHITECTURE.md (Java Quant Core section)`) |

## First-run / troubleshooting

- **Java Quant Core jar missing**: auto-built via `mvn -B package -DskipTests` on first
  `QUANT_JAVA_CORE_ENABLED=true` start. Watch `logs/quant-core-java.log` if it doesn't come up.
- **Port already bound**: `./argus.sh status` prints a real BOUND/FREE table
  (`scripts/argus-ecosystem-status.ts`); `./argus.sh nuke` clears stale listeners/PID files.
- **Stale PID file**: `argus.sh` clears it automatically once it detects the tracked PID is dead.

## Related

- `docs/operations/IBKR_GATEWAY_SETUP.md`
- `docs/architecture/ARGUS_ARCHITECTURE.md (Java Quant Core section)`
- `README.md` — `npm run dev` variants (`dev:core`, `dev:server-only`, `dev:headless`, ...)
