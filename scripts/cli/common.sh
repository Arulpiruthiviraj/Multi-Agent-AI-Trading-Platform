#!/usr/bin/env bash
# Shared helpers for ./argus — operator shell only (no trading brain).
# shellcheck shell=bash

ARGUS_EXIT_OK=0
ARGUS_EXIT_FAIL=1
ARGUS_EXIT_USAGE=2
ARGUS_EXIT_ENGINE_DOWN=3
ARGUS_EXIT_NOT_READY=4
ARGUS_EXIT_AUTH=5
ARGUS_EXIT_SAFETY=6

argus_wants_help() {
  for a in "$@"; do
    case "$a" in
      -h|--help|help) return 0 ;;
    esac
  done
  return 1
}

argus_has_flag() {
  local needle="$1"
  shift
  for a in "$@"; do
    [[ "$a" == "$needle" ]] && return 0
  done
  return 1
}

argus_version() {
  local ver="0.0.0"
  if [[ -f "$ARGUS_ROOT/package.json" ]]; then
    ver="$(cd "$ARGUS_ROOT" && node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "0.0.0")"
  fi
  echo "argus ${ver} (shell operator control plane)"
  echo "engine API: ${ARGUS_API_URL}"
  echo "repo: ${ARGUS_ROOT}"
}

argus_npm_cli() {
  (cd "$ARGUS_ROOT" && npm run -s argus-cli -- "$@")
}

argus_help_main() {
  cat <<'EOF'
ARGUS — Autonomous Trading Engine

Usage:
  argus <command> [options]

Engine:
  start             Start Argus Engine
  stop              Gracefully stop Argus Engine
  restart           Restart Argus Engine
  status            Show runtime status
  health            Check process health
  ready             Check trading readiness (LIVE readiness API)
  pipeline-ready    Process-alive vs trading-pipeline-ready (DB/market data/broker/AI providers)
  session-report    Pre-market/market-open counters (ideas, consensus, risk, execution, AI, safety)
  nuke              Force-kill stale/zombie Argus processes (no services started after)

Trading:
  enable            Enable Autobot
  disable           Disable Autobot
  kill-switch       Trigger emergency trading stop

Portfolio:
  positions         Show current positions
  trades            Show trade history
  orders            Show order state

Observability:
  config            Runtime config
  risk              RiskEngine status (via API)
  agents            Pipeline agents
  events            Recent events (snapshot; --follow not supported)
  logs              Recent logs (snapshot; --follow not supported)

Historical Evaluation:
  replay run        Run historical evaluation (inside engine)
  replay list       List evaluation runs
  replay report     Show evaluation report
  replay analyze    Same evidence as report (forensic view)
  replay diagnostics  Run metadata + report summary

Auth (when AUTH_PASSWORD is set on the server):
  login             POST /api/v1/auth/login; save session cookie to data/.argus_cli_session
  logout            Clear local session (and server session when possible)

Diagnostics:
  doctor            Diagnose environment and engine
  check             Architecture protection / health checks
  test              Run test suite
  build             Build production artifact

Run:
  argus <command> --help
  argus --version

Architecture:
  ./argus → npm run argus-cli → HTTP → Argus Engine → Argus Core
  The shell does not contain RiskEngine, OMS, or BrokerManager.

See: ARGUS_SHELL_CLI.md, ARGUS_CLI.md
EOF
}

argus_help_start() {
  cat <<'EOF'
Usage: argus start [--dev|--prod|--headless]

  --dev       Development engine (npm run start:engine / tsx)
  --prod      Production engine (requires dist/server.cjs)
  --headless  Headless engine (default for start via CLI)

Does not spawn a second engine if one is already running.
EOF
}

argus_help_stop() {
  cat <<'EOF'
Usage: argus stop

Sends SIGTERM via existing engine PID lifecycle (graceful shutdown).
Does not use kill -9.
EOF
}

argus_help_restart() {
  cat <<'EOF'
Usage: argus restart

Stops then starts the Argus Engine via existing lifecycle.
EOF
}

argus_help_status() {
  cat <<'EOF'
Usage: argus status [--json]

Human-readable engine status by default.
--json prints the raw /api/v2/runtime/status payload.
EOF
}

argus_help_health() {
  cat <<'EOF'
Usage: argus health [--json]

Process/API health (alive?), not trading readiness.
EOF
}

argus_help_ready() {
  cat <<'EOF'
Usage: argus ready [--json]

Trading / LIVE readiness from GET /api/v2/live-readiness.
Health ≠ ready. LIVE is currently expected to be NO-GO.
EOF
}

argus_help_trading() {
  cat <<'EOF'
Usage: argus enable | disable | kill-switch

Delegates to Argus Application over HTTP.
Does not bypass RiskEngine, kill-switch, or LIVE safety.
EOF
}

argus_help_obs() {
  cat <<'EOF'
Usage: argus positions|trades|orders|config|risk|agents|events|logs

Reads from the running engine HTTP API (bounded snapshot).

logs / events:
  Default          One JSON snapshot from the API (limit=50).
  --follow         NOT SUPPORTED — no streaming endpoint yet.
                   Prints a clear message and exits with code 2.
                   Does not poll in a loop (unsafe infinite poll avoided).
                   Use a single snapshot without --follow, or the UI/WebSocket.
EOF
}

argus_help_replay() {
  cat <<'EOF'
Usage:
  argus replay run [options]
  argus replay list
  argus replay report <run-id>
  argus replay analyze <run-id>
  argus replay diagnostics <run-id>

Options for run:
  --capital <n>     Initial capital (default 100000)
  --start YYYY-MM-DD
  --end YYYY-MM-DD
  --universe discovery|symbols
  --symbols AAPL,NVDA
  --provider <name>

  argus replay run --help   Show this help (does not start a run)

Historical Evaluation runs INSIDE the Argus Engine over HTTP.
The CLI does not execute a second replay engine.
EOF
}

argus_help_replay_run() {
  argus_help_replay
}

argus_help_auth() {
  cat <<'EOF'
Usage: argus login | logout

When AUTH_PASSWORD is set on the Argus Engine, /api/* requires a session cookie
from POST /api/v1/auth/login. ARGUS_DEV_TOKEN is IGNORED in that mode.

Credentials (never printed):
  Prefer:  ARGUS_CLI_USER + ARGUS_CLI_PASSWORD
  Or reuse: AUTH_USERNAME + AUTH_PASSWORD from the process environment

Session file: data/.argus_cli_session (Cookie header for subsequent commands).
Override path with ARGUS_CLI_SESSION_FILE if needed.

  argus login
  argus status
  argus logout
EOF
}

argus_help_doctor() {
  cat <<'EOF'
Usage: argus doctor

Environment and engine diagnostics. Never prints secrets.
Exit: 0 healthy, 1 warnings, 2 critical.
EOF
}

argus_help_check() {
  cat <<'EOF'
Usage: argus check

Runs architecture protection tests (vitest filter).
EOF
}

argus_cmd_start() {
  local mode="dev"
  local headless=1
  for a in "$@"; do
    case "$a" in
      --prod) mode="prod" ;;
      --dev) mode="dev" ;;
      --headless|-H) headless=1 ;;
      --ui|--with-ui) headless=0 ;;
    esac
  done

  # Already running? Prefer TS CLI (PID + health) — do not duplicate spawn.
  if argus_has_flag --json "$@"; then
    if [[ "$mode" == "prod" ]]; then
      argus_npm_cli start --prod ${headless:+--headless}
    else
      argus_npm_cli start ${headless:+--headless}
    fi
    return $?
  fi

  local out
  if [[ "$mode" == "prod" ]]; then
    out="$(argus_npm_cli start --prod --headless 2>&1)" || {
      echo "$out"
      return "$ARGUS_EXIT_FAIL"
    }
  else
    out="$(argus_npm_cli start --headless 2>&1)" || {
      echo "$out"
      return "$ARGUS_EXIT_FAIL"
    }
  fi

  if echo "$out" | grep -q 'already running'; then
    echo "✔ Argus Engine already running"
  else
    echo "✔ Argus Engine start requested"
  fi
  echo
  echo "$out" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
      try {
        const j=JSON.parse(s);
        if (j.pid!=null) console.log("PID:  "+j.pid);
        if (j.api) console.log("API:  "+j.api);
        if (j.message) console.log("Msg:  "+j.message);
        if (j.ok===false) process.exitCode=1;
      } catch { console.log(s.trim()); }
    });
  ' || echo "$out"
}

argus_cmd_status() {
  local json=0
  argus_has_flag --json "$@" && json=1
  if [[ "$json" -eq 1 ]]; then
    argus_npm_cli status
    return $?
  fi
  local raw
  if ! raw="$(argus_npm_cli status 2>&1)"; then
    if echo "$raw" | grep -qiE 'unauthorized|401|forbidden|403'; then
      echo "✖ API unauthorized at ${ARGUS_API_URL} (run: argus login — or unset AUTH_PASSWORD for localhost-only mode)" >&2
      echo "$raw" >&2
      return "$ARGUS_EXIT_AUTH"
    fi
    echo "✖ Engine unavailable at ${ARGUS_API_URL}" >&2
    echo "$raw" >&2
    return "$ARGUS_EXIT_ENGINE_DOWN"
  fi
  echo "$raw" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
      let j; try { j=JSON.parse(s); } catch { console.log(s); process.exitCode=1; return; }
      const dash="—";
      const get=(o,...ks)=>{ let cur=o; for (const k of ks){ if(cur==null||typeof cur!=="object") return undefined; cur=cur[k]; } return cur; };
      const show=(v)=> v===undefined||v===null||v==="" ? dash : String(v);
      const yn=(v)=> v===true ? "true" : (v===false ? "false" : dash);
      const rt=get(j,"runtime")||{};
      const ab=get(j,"autobot")||{};
      const sys=get(j,"system")||{};
      const modeParts=[];
      if (rt.headless===true) modeParts.push("headless");
      if (rt.engineDaemon===true) modeParts.push("engineDaemon");
      if (rt.webUiEnabled===true) modeParts.push("webUi");
      if (rt.apiEnabled===true) modeParts.push("api");
      const mode=modeParts.length ? modeParts.join("+") : dash;
      let uptime=dash;
      if (typeof rt.uptimeMs==="number" && Number.isFinite(rt.uptimeMs)) {
        const sec=Math.floor(rt.uptimeMs/1000);
        uptime=sec>=3600 ? Math.floor(sec/3600)+"h "+Math.floor((sec%3600)/60)+"m" : (sec>=60 ? Math.floor(sec/60)+"m "+(sec%60)+"s" : sec+"s");
      }
      console.log("ARGUS ENGINE STATUS");
      console.log("");
      console.log("Engine");
      console.log("  Phase:         "+show(rt.phase));
      console.log("  PID:           "+show(rt.pid));
      console.log("  Uptime:        "+uptime);
      console.log("  Mode flags:    "+mode);
      console.log("  Core booted:   "+show(rt.coreBootedAt));
      console.log("  Boot error:    "+show(rt.bootError));
      console.log("");
      console.log("Connectivity");
      console.log("  API:           "+(process.env.ARGUS_API_URL||"http://127.0.0.1:3000"));
      console.log("  HTTP ok:       "+yn(j.ok));
      console.log("  Consistent:    "+yn(j.consistent));
      console.log("  System run:    "+yn(sys.running));
      console.log("");
      console.log("Trading");
      console.log("  State:         "+show(ab.tradingState));
      console.log("  Autobot:       "+(ab.autoBotEnabled===true?"ENABLED":(ab.autoBotEnabled===false?"DISABLED":(ab.enabled===true?"ENABLED":(ab.enabled===false?"DISABLED":dash)))));
      console.log("  Trading mode:  "+show(ab.tradingMode));
      console.log("  Emergency:     "+yn(ab.emergencyStopActive));
      console.log("  Budget:        "+show(ab.budget));
      console.log("  Live readiness:"+show(j.liveReadiness));
      console.log("  live field:    "+show(j.live));
      const pa=get(j,"pipelineAgents")||{};
      console.log("");
      console.log("Session / ideas");
      console.log("  interruptedSessionHold: "+yn(pa.interruptedSessionHold));
      console.log("  ideaWorkersArmed:       "+yn(pa.ideaWorkersArmed));
      console.log("  liveIdeaGeneration:     "+yn(pa.liveIdeaGenerationEnabled));
      if (pa.interruptedSessionHold===true) {
        console.log("  note: hold clears on in-process RECONCILIATION_MATCH only (not ack/resume; not Autobot)");
      }
      console.log("");
      console.log("(Mapped from GET /api/v2/runtime/status only — use --json for full payload)");
    });
  '
}

# Format /api/v2/runtime/health using ArgusRuntimeHealth fields only.
argus_cmd_health() {
  if argus_has_flag --json "$@"; then
    argus_npm_cli health
    return $?
  fi
  local raw
  if ! raw="$(argus_npm_cli health 2>&1)"; then
    if echo "$raw" | grep -qiE 'unauthorized|401|forbidden|403'; then
      echo "✖ API unauthorized (run: argus login — or unset AUTH_PASSWORD for localhost-only mode)" >&2
      echo "$raw" >&2
      return "$ARGUS_EXIT_AUTH"
    fi
    echo "✖ Health check failed (engine down?)" >&2
    echo "$raw" >&2
    return "$ARGUS_EXIT_ENGINE_DOWN"
  fi
  echo "$raw" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
      try {
        const j=JSON.parse(s);
        const dash="—";
        const h=(j&&j.health&&typeof j.health==="object")?j.health:{};
        const show=(v)=> v===undefined||v===null||v==="" ? dash : String(v);
        const yn=(v)=> v===true ? "true" : (v===false ? "false" : dash);
        console.log("ARGUS HEALTH");
        console.log("  ok:              "+yn(j.ok));
        console.log("  phase:           "+show(h.phase));
        console.log("  coreBooted:      "+yn(h.coreBooted));
        console.log("  tradingState:    "+show(h.tradingState));
        console.log("  autobotEnabled:  "+yn(h.autobotEnabled));
        console.log("  emergencyStop:   "+yn(h.emergencyStopActive));
        console.log("  marketData:      "+yn(h.marketDataConnected));
        console.log("  brokerId:        "+show(h.brokerId));
        console.log("  pipelineRunning: "+yn(h.pipelineRunning));
        console.log("  safeMode:        "+yn(h.safeMode));
        console.log("  liveReadiness:   "+show(h.liveReadiness));
        console.log("  live (top):      "+show(j.live));
        console.log("  pid:             "+show(h.pid));
        console.log("  (use --json for full payload)");
        if (j.ok!==true) process.exitCode=3;
      } catch { console.log(s); process.exitCode=1; }
    });
  '
}

argus_cmd_ready() {
  if argus_has_flag --json "$@"; then
    argus_npm_cli ready
    return $?
  fi
  local raw
  if ! raw="$(argus_npm_cli ready 2>&1)"; then
    if echo "$raw" | grep -qiE 'unauthorized|401|forbidden|403'; then
      echo "✖ Readiness API unauthorized (run: argus login — or unset AUTH_PASSWORD for localhost-only mode)" >&2
      echo "$raw" >&2
      return "$ARGUS_EXIT_AUTH"
    fi
    echo "✖ Readiness API unavailable" >&2
    echo "$raw" >&2
    return "$ARGUS_EXIT_ENGINE_DOWN"
  fi
  echo "$raw" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
      try {
        const j=JSON.parse(s);
        const dash="—";
        const show=(v)=> v===undefined||v===null||v==="" ? dash : String(v);
        console.log("ARGUS READINESS");
        console.log("  result: "+show(j.result));
        if (j.summary!=null) console.log("  summary: "+(typeof j.summary==="string"?j.summary:JSON.stringify(j.summary)));
        console.log("  note:   health ≠ trading ready; LIVE expected NO-GO until evaluateLiveReadiness says otherwise");
        console.log("  (use --json for full LiveReadinessReport)");
        const r=String(j.result||"");
        if (r && r!=="LIVE_READY") process.exitCode=4;
      } catch { console.log(s); process.exitCode=1; }
    });
  '
}

# logs/events have no streaming API — refuse --follow (no unsafe infinite poll).
argus_cmd_obs_follow_guard() {
  local which="$1"
  shift
  if argus_has_flag --follow "$@"; then
    echo "✖ ${which} --follow is not supported." >&2
    echo "  No streaming endpoint is exposed for ${which}." >&2
    echo "  Use a single snapshot: argus ${which}" >&2
    echo "  Or watch the UI / WebSocket. Help: argus ${which} --help" >&2
    return "$ARGUS_EXIT_USAGE"
  fi
  argus_npm_cli "$which" "$@"
}

argus_cmd_replay() {
  local sub="${1:-}"
  shift || true
  if [[ -z "$sub" || "$sub" == "--help" || "$sub" == "-h" || "$sub" == "help" ]]; then
    argus_help_replay
    return 0
  fi
  # Subcommand help: argus replay run --help (must not start a run)
  if argus_wants_help "$@"; then
    argus_help_replay
    return 0
  fi
  if [[ "$sub" == "run" ]] || [[ "$sub" == --* ]]; then
    if [[ "$sub" == "run" ]]; then
      argus_npm_cli replay run "$@"
    else
      argus_npm_cli replay run "$sub" "$@"
    fi
    return $?
  fi
  case "$sub" in
    list|report|export|analyze|diagnostics)
      argus_npm_cli replay "$sub" "$@"
      ;;
    *)
      echo "Unknown replay subcommand: $sub" >&2
      argus_help_replay >&2
      return "$ARGUS_EXIT_USAGE"
      ;;
  esac
}


# Bounded HTTP probe for doctor (does not hang when engine is down).
# Exit: 0 ok, 5 unauthorized, 1 unreachable/other.
# Sends Cookie from data/.argus_cli_session when present (never prints it).
argus_http_probe() {
  local path="$1"
  local timeout_ms="${2:-2000}"
  local session_file="${ARGUS_CLI_SESSION_FILE:-$ARGUS_ROOT/data/.argus_cli_session}"
  node -e '
    const fs = require("fs");
    const url = process.argv[1];
    const ms = Number(process.argv[2] || 2000);
    const sessionFile = process.argv[3] || "";
    const headers = {};
    try {
      if (sessionFile && fs.existsSync(sessionFile)) {
        const line = fs.readFileSync(sessionFile, "utf8").trim().split(/\r?\n/)[0] || "";
        if (line.startsWith("argus_session=") && line.length > "argus_session=".length) {
          headers.Cookie = line;
        }
      }
    } catch (_) { /* ignore */ }
    // Server ignores DEV_TOKEN when AUTH_PASSWORD is set; useful only in no-auth mode.
    if (process.env.ARGUS_DEV_TOKEN) {
      headers["x-argus-dev-token"] = process.env.ARGUS_DEV_TOKEN;
    }
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    fetch(url, { signal: ac.signal, headers })
      .then((r) => {
        clearTimeout(t);
        if (r.status === 401 || r.status === 403) process.exit(5);
        process.exit(r.ok ? 0 : 1);
      })
      .catch(() => { clearTimeout(t); process.exit(1); });
  ' "${ARGUS_API_URL}${path}" "$timeout_ms" "$session_file"
}


argus_cmd_doctor() {
  local warn=0
  local crit=0
  echo "ARGUS DOCTOR"
  echo ""

  if command -v bash >/dev/null 2>&1; then
    echo "✔ Bash available ($(bash --version | head -1))"
  else
    echo "✖ Bash missing"; crit=1
  fi

  if command -v node >/dev/null 2>&1; then
    echo "✔ Node $(node -v)"
  else
    echo "✖ Node missing"; crit=1
  fi

  if command -v npm >/dev/null 2>&1; then
    echo "✔ npm $(npm -v)"
  else
    echo "✖ npm missing"; crit=1
  fi

  if [[ -d "$ARGUS_ROOT/node_modules" ]]; then
    echo "✔ Dependencies installed (node_modules present)"
  else
    echo "✖ Dependencies missing (run npm install)"; crit=1
  fi

  if [[ -f "$ARGUS_ROOT/.env" ]]; then
    echo "✔ Configuration found (.env present; secrets not printed)"
  else
    echo "! .env not found (copy from .env.example)"; warn=1
  fi

  if [[ -f "$ARGUS_ROOT/dist/server.cjs" ]]; then
    echo "✔ Build artifact present (dist/server.cjs)"
  else
    echo "! Production build artifact missing (optional for --dev)"; warn=1
  fi

  local health_rc=0
  argus_http_probe "/api/v2/runtime/health" 2000 || health_rc=$?
  if [[ "$health_rc" -eq 0 ]]; then
    echo "✔ API reachable / runtime health OK"
  elif [[ "$health_rc" -eq 5 ]]; then
    echo "! API requires auth at ${ARGUS_API_URL} (run: argus login)"; warn=1
  else
    echo "! API not reachable at ${ARGUS_API_URL}"; warn=1
  fi

  local pidfile="$ARGUS_ROOT/data/.argus_engine.pid"
  local runtime_session="$ARGUS_ROOT/data/.argus_runtime_session.json"
  if [[ -f "$pidfile" ]]; then
    local pid
    pid="$(tr -d '[:space:]' < "$pidfile" || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "✔ Engine PID file valid (pid $pid alive)"
    else
      echo "! Engine PID file stale or process not visible to this shell"; warn=1
    fi
  else
    # Missing daemon PID is not critical when Argus is clearly up (runtime session PID
    # alive, or API reachable). server.ts / npm run dev also write .argus_engine.pid on
    # listen — do not elevate to WARNINGS solely for the missing file.
    local runtime_alive=0
    if [[ -f "$runtime_session" ]]; then
      local sess_pid
      sess_pid="$(
        node -e '
          try {
            const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
            const p = Number(j && j.pid);
            if (Number.isFinite(p) && p > 0) process.stdout.write(String(p));
          } catch (_) {}
        ' "$runtime_session" 2>/dev/null || true
      )"
      if [[ -n "$sess_pid" ]] && kill -0 "$sess_pid" 2>/dev/null; then
        runtime_alive=1
      fi
    fi
    if [[ "$runtime_alive" -eq 1 ]]; then
      echo "ℹ No .argus_engine.pid — runtime session PID alive (Argus likely via server.ts/dev; not critical)"
    elif [[ "$health_rc" -eq 0 ]] || [[ "$health_rc" -eq 5 ]]; then
      echo "ℹ No .argus_engine.pid but API reachable — not critical (daemon file optional when process is clearly up)"
    else
      echo "! No engine PID file (engine may be stopped)"; warn=1
    fi
  fi

  local dev_pidfile="$ARGUS_ROOT/.argus_dev.pid"
  if [[ -f "$dev_pidfile" ]]; then
    local dev_pid
    dev_pid="$(tr -d '[:space:]' < "$dev_pidfile" || true)"
    if [[ -n "$dev_pid" ]] && kill -0 "$dev_pid" 2>/dev/null; then
      echo "ℹ .argus_dev.pid present (pid $dev_pid alive) — ecosystem/dev helper; not the trading engine PID"
    else
      echo "ℹ .argus_dev.pid present but process dead — ignore (stale file)"
    fi
  fi

  local ready_rc=0
  argus_http_probe "/api/v2/live-readiness" 2000 || ready_rc=$?
  if [[ "$ready_rc" -eq 0 ]]; then
    echo "✔ Readiness endpoint reachable (LIVE may still be NO-GO)"
  elif [[ "$ready_rc" -eq 5 ]]; then
    echo "! Readiness endpoint requires auth (run: argus login)"; warn=1
  else
    echo "! Readiness endpoint unreachable"; warn=1
  fi

  local session_file="${ARGUS_CLI_SESSION_FILE:-$ARGUS_ROOT/data/.argus_cli_session}"
  if [[ -f "$session_file" ]]; then
    echo "✔ CLI session file present (cookie value not printed)"
  elif [[ "$health_rc" -eq 5 ]] || [[ "$ready_rc" -eq 5 ]] || [[ -n "${AUTH_PASSWORD:-}" ]]; then
    echo "! No CLI session file (run: argus login)"; warn=1
  fi

  if [[ -f "$ARGUS_ROOT/data/argus.db" ]] || [[ -f "$ARGUS_ROOT/data/argus.sqlite" ]]; then
    echo "✔ SQLite database file present (not mutated by doctor)"
  else
    echo "! SQLite DB file not found under data/ (may be first boot)"; warn=1
  fi

  # Surface interrupted-session entry hold when API+session allow (no secrets printed).
  if [[ "$health_rc" -eq 0 ]]; then
    local hold_rc=0
    local hold_out=""
    hold_out="$(
      node -e '
        const fs = require("fs");
        const url = process.argv[1];
        const sessionFile = process.argv[2] || "";
        const headers = {};
        try {
          if (sessionFile && fs.existsSync(sessionFile)) {
            const line = fs.readFileSync(sessionFile, "utf8").trim().split(/\r?\n/)[0] || "";
            if (line.startsWith("argus_session=") && line.length > "argus_session=".length) {
              headers.Cookie = line;
            }
          }
        } catch (_) {}
        if (process.env.ARGUS_DEV_TOKEN) headers["x-argus-dev-token"] = process.env.ARGUS_DEV_TOKEN;
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 2500);
        fetch(url, { signal: ac.signal, headers })
          .then(async (r) => {
            clearTimeout(t);
            if (r.status === 401 || r.status === 403) process.exit(5);
            if (!r.ok) process.exit(1);
            const j = await r.json();
            process.stdout.write(j.interruptedSessionHold === true ? "HOLD" : "CLEAR");
            process.exit(0);
          })
          .catch(() => { clearTimeout(t); process.exit(1); });
      ' "${ARGUS_API_URL}/api/v1/system/pipeline-agents" "${ARGUS_CLI_SESSION_FILE:-$ARGUS_ROOT/data/.argus_cli_session}"
    )" || hold_rc=$?
    if [[ "$hold_rc" -eq 0 && "$hold_out" == "HOLD" ]]; then
      echo "! interruptedSessionHold=true (new BUY ideas held until in-process RECONCILIATION_MATCH; not a kill-switch; Autobot still separate)"; warn=1
    elif [[ "$hold_rc" -eq 0 && "$hold_out" == "CLEAR" ]]; then
      echo "✔ interruptedSessionHold=false (entry ideas not held by dirty-session marker)"
    elif [[ "$hold_rc" -eq 5 ]]; then
      echo "! Could not read interruptedSessionHold (auth required — run: argus login)"; warn=1
    fi
  fi

  echo ""
  if [[ "$crit" -eq 1 ]]; then
    echo "Result: CRITICAL"
    return 2
  fi
  if [[ "$warn" -eq 1 ]]; then
    echo "Result: WARNINGS"
    return 1
  fi
  echo "Result: HEALTHY"
  return 0
}

argus_cmd_check() {
  (cd "$ARGUS_ROOT" && npx vitest run src/server/architecture.protection.test.ts scripts/cli/shellCli.protection.test.ts 2>/dev/null) \
    || (cd "$ARGUS_ROOT" && npx vitest run src/server/architecture.protection.test.ts)
}
