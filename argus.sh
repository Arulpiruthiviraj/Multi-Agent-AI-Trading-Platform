#!/usr/bin/env bash
# Argus DevOps control script — single entry point for start/stop/restart/status/nuke.
# Wraps the existing `npm run dev` orchestrator (scripts/ecosystem-dev.ts); does not
# replace it or duplicate its Chronos/OpenAlice/IBKR spawn logic — this only manages
# the *process lifecycle* around it (ports, PIDs, health).
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# MSYS/Git Bash rewrites args that look like unix paths (e.g. "/PID") before handing
# them to native .exe tools. Disabling that here is what makes taskkill //PID work below.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

LOG_DIR="$ROOT_DIR/logs"
DEV_LOG="$LOG_DIR/argus-dev.log"
PID_FILE="$ROOT_DIR/.argus_dev.pid"
mkdir -p "$LOG_DIR"

# port:label — kept as parallel arrays for portability (no assoc arrays on bash 3.2/macOS)
PORTS=(3000 5000 8008 47332)
PORT_LABELS=("Argus Node/Vite server" "IBKR Client Portal Gateway" "Chronos/Kronos local AI service" "OpenAlice Guardian MCP")

label_for_port() {
  local port="$1" i
  for i in "${!PORTS[@]}"; do
    if [ "${PORTS[$i]}" = "$port" ]; then
      echo "${PORT_LABELS[$i]}"
      return
    fi
  done
  echo "unknown"
}

is_windows() {
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Port utilities
# ---------------------------------------------------------------------------

pids_on_port() {
  local port="$1"
  if is_windows; then
    # Git Bash `netstat` is MSYS and often has no PID column, so restart left the
    # Node listener alive (seen 2026-08-18: pid 35128 survived `argus.sh restart`).
    local netstat_bin
    netstat_bin="$(command -v netstat.exe 2>/dev/null || true)"
    if [ -z "$netstat_bin" ] && [ -x /c/Windows/System32/netstat.exe ]; then
      netstat_bin="/c/Windows/System32/netstat.exe"
    fi
    "${netstat_bin:-netstat.exe}" -ano -p tcp 2>/dev/null | awk -v p="$port" '
      $0 ~ /LISTENING/ {
        n = split($2, addr, ":")
        if (addr[n] == p) print $NF
      }' | sort -u
  else
    if command -v lsof >/dev/null 2>&1; then
      lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null
    elif command -v fuser >/dev/null 2>&1; then
      fuser "$port"/tcp 2>/dev/null | tr -s ' \t' '\n' | grep -E '^[0-9]+$'
    fi
  fi
}

port_in_use() {
  [ -n "$(pids_on_port "$1")" ]
}

kill_pid_tree() {
  local pid="$1"
  if is_windows; then
    # Real bugs found and fixed (2026-08-18), confirmed live with a direct taskkill.exe call:
    # 1) The double-slash `//PID`/`//T`/`//F`/`//c` forms were a leftover MSYS path-conversion
    #    escape from before this script set MSYS_NO_PATHCONV=1/MSYS2_ARG_CONV_EXCL="*" above. With
    #    those already disabling path conversion, the double slash is no longer collapsed to a
    #    single one - it reaches taskkill.exe literally as "//PID", which it rejects outright
    #    ("ERROR: Invalid argument/option - '//PID'."), and reaches cmd.exe as "//c", which it
    #    doesn't recognize as /c either - so cmd.exe silently opens an interactive shell instead of
    #    running the command, which then exits doing nothing the moment its stdin (redirected from
    #    /dev/null below) hits EOF. Both the primary AND the fallback kill path were silently
    #    no-ops this whole time (errors swallowed by >/dev/null 2>&1) - ports stayed occupied on
    #    every restart/stop regardless of what the script printed. Single-slash is correct now.
    # 2) Neither invocation redirected stdin, which is still connected to the interactive terminal
    #    here. taskkill.exe can prompt for confirmation in some environments/PID-ownership cases
    #    even with /F; with stdout/stderr sent to /dev/null that prompt was invisible, so the
    #    script could sit there waiting on input that was never coming - the "stuck for long"
    #    symptom seen against a heavily-loaded (739MB RSS, ~30min accumulated CPU) node process.
    #    `</dev/null` guarantees EOF instead of a hang; `timeout 8` is defense-in-depth in case
    #    something else (AV scanning a large process, etc.) still blocks it either way.
    timeout 8 taskkill.exe /PID "$pid" /T /F </dev/null >/dev/null 2>&1 || \
      timeout 8 cmd.exe /c "taskkill /PID $pid /T /F" </dev/null >/dev/null 2>&1
  else
    kill -TERM "$pid" >/dev/null 2>&1
    sleep 1
    kill -KILL "$pid" >/dev/null 2>&1
  fi
}

kill_port() {
  local port="$1" pids pid
  pids="$(pids_on_port "$port")"
  [ -z "$pids" ] && return 0
  for pid in $pids; do
    echo "    killing pid $pid on port $port ($(label_for_port "$port"))"
    kill_pid_tree "$pid"
  done
}

wait_port_free() {
  local port="$1" timeout="${2:-10}" waited=0
  while port_in_use "$port"; do
    [ "$waited" -ge "$timeout" ] && return 1
    sleep 1
    waited=$((waited + 1))
  done
  return 0
}

# ---------------------------------------------------------------------------
# Environment + curl (Windows Git Bash prefers curl.exe)
# ---------------------------------------------------------------------------

curl_cmd() {
  if is_windows && command -v curl.exe >/dev/null 2>&1; then
    curl.exe "$@"
  else
    curl "$@"
  fi
}

env_from_dotenv() {
  local key="$1" default="${2:-}"
  if [ -f "$ROOT_DIR/.env" ]; then
    local val
    val="$(grep -E "^${key}=" "$ROOT_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' | sed 's/^["'\''"]//; s/["'\''"]$//')"
    if [ -n "$val" ]; then
      echo "$val"
      return
    fi
  fi
  echo "$default"
}

env_flag_true() {
  case "$(echo "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

ollama_port() {
  local host="${1:-$(env_from_dotenv OLLAMA_HOST 'http://127.0.0.1:11434')}"
  local port=11434
  if [[ "$host" =~ :([0-9]+)(/|$) ]]; then
    port="${BASH_REMATCH[1]}"
  fi
  echo "$port"
}

command_works() {
  local cmd="$1"
  shift
  if is_windows; then
    "$cmd" "$@" </dev/null >/dev/null 2>&1
  else
    command -v "$cmd" >/dev/null 2>&1 && "$cmd" "$@" >/dev/null 2>&1
  fi
}

run_ecosystem_status() {
  local status_mode="${1:-live}"
  local after_start="${2:-false}"
  echo ""
  echo "============================================================"
  echo "  ECOSYSTEM SERVICE STATUS"
  echo "============================================================"
  if command -v node >/dev/null 2>&1 && [ -f "$ROOT_DIR/scripts/argus-ecosystem-status.ts" ]; then
    local status_extra=()
    if [ "$after_start" = "true" ]; then
      status_extra+=(--after-start)
    fi
    if ! (cd "$ROOT_DIR" && NPM_CONFIG_LOGLEVEL=error npx --yes tsx scripts/argus-ecosystem-status.ts --mode "$status_mode" "${status_extra[@]}"); then
      echo "  (status script failed — showing port summary below)"
      print_port_summary
    fi
  else
    echo "  node or scripts/argus-ecosystem-status.ts unavailable — port summary:"
    print_port_summary
  fi
  if [ -f "$PID_FILE" ]; then
    local tracked_pid
    tracked_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$tracked_pid" ] && kill -0 "$tracked_pid" 2>/dev/null; then
      echo "  Tracked launcher pid: $tracked_pid (started via this script)"
    elif [ "$status_mode" = "live" ]; then
      echo "  Tracked launcher pid file is stale (process not running) — clearing."
      rm -f "$PID_FILE"
    fi
  fi
  echo "  Log: $DEV_LOG"
  echo ""
}

print_port_summary() {
  local port label port_state
  for port in "${PORTS[@]}"; do
    label="$(label_for_port "$port")"
    if port_in_use "$port"; then port_state="BOUND"; else port_state="FREE"; fi
    printf "  port %-5s %-34s %s\n" "$port" "$label" "$port_state"
  done
}

try_fix_ollama() {
  if env_flag_true "$(env_from_dotenv ARGUS_SKIP_OLLAMA 'false')"; then
    return 0
  fi
  local host port code
  host="$(env_from_dotenv OLLAMA_HOST 'http://127.0.0.1:11434')"
  host="${host//localhost/127.0.0.1}"
  port="$(ollama_port "$host")"
  if port_in_use "$port"; then
    code="$(curl_cmd -s -o /dev/null -w '%{http_code}' --max-time 3 "${host}/api/tags" 2>/dev/null || true)"
    if [ "$code" = "200" ]; then
      return 0
    fi
    echo "  [fix] Port $port is open but Ollama /api/tags is not healthy yet."
    return 1
  fi
  if ! command_works ollama --version; then
    echo "  [fix] ollama is not on PATH — install from https://ollama.com/download then re-run start."
    return 1
  fi
  echo "  [fix] Ollama not reachable — starting ollama serve (logging to $LOG_DIR/ollama-serve.log)..."
  : > "$LOG_DIR/ollama-serve.log"
  nohup ollama serve >> "$LOG_DIR/ollama-serve.log" 2>&1 &
  disown "$!" 2>/dev/null || true
  local waited=0
  while [ "$waited" -lt 20 ]; do
    code="$(curl_cmd -s -o /dev/null -w '%{http_code}' --max-time 3 "${host}/api/tags" 2>/dev/null || true)"
    if [ "$code" = "200" ]; then
      echo "  [fix] Ollama is now responding on ${host}."
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "  [fix] Ollama still not healthy after 20s — see $LOG_DIR/ollama-serve.log"
  return 1
}

wait_for_ecosystem() {
  local timeout="${1:-90}" waited=0
  echo "  Waiting for Argus + companions (up to ${timeout}s)..."
  while [ "$waited" -lt "$timeout" ]; do
    if port_in_use 3000; then
      local health
      health="$(check_node_health)"
      if [ "$health" = "200" ]; then
        echo "  Argus GET /health returned 200."
        break
      fi
    fi
    sleep 2
    waited=$((waited + 2))
  done
  if ! port_in_use 3000; then
    echo "  Argus (port 3000) is not listening yet — check $DEV_LOG"
  fi
  try_fix_ollama || true
  # Chronos first model load can exceed 90s; give companions a short settle window.
  sleep 5
}


check_node_health() {
  # server.ts:672 GET /health
  curl_cmd -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:3000/health" 2>/dev/null
}

check_chronos_health() {
  # scripts/local_ai_service.py GET /health
  curl_cmd -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:8008/health" 2>/dev/null
}

check_ibkr_gateway() {
  # InteractiveBrokersAdapter.ts GET /iserver/auth/status (self-signed cert; 401 pending
  # manual 2FA is expected and still counts as "up" per CLAUDE.md, not a failure)
  curl_cmd -sk -o /dev/null -w '%{http_code}' --max-time 3 "https://localhost:5000/v1/api/iserver/auth/status" 2>/dev/null
}

check_openalice_guardian() {
  # Same capability check as OpenAliceAdapter.healthCheck() / mcpEndpointHasGuardianTools():
  # a bare handshake success is not proof this is Guardian and not OpenAlice's UTA trading MCP.
  local body
  body="$(curl_cmd -s --max-time 3 -X POST "http://127.0.0.1:47332/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' 2>/dev/null)"
  if [ -z "$body" ]; then
    echo "DOWN"
  elif echo "$body" | grep -q 'issue_create' && echo "$body" | grep -q 'inbox_read'; then
    echo "GUARDIAN"
  else
    echo "WRONG_MCP"
  fi
}

# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------

print_header() {
  echo ""
  echo "============================================================"
  echo "  ARGUS ECOSYSTEM CONTROL"
  echo "============================================================"
}

action_status() {
  print_header
  run_ecosystem_status "live"
}

action_start_impl() {
  echo "  Starting ecosystem — clean-slate port check first."
  local conflict=0 port
  for port in "${PORTS[@]}"; do
    if port_in_use "$port"; then
      echo "  [conflict] port $port ($(label_for_port "$port")) already bound."
      conflict=1
    fi
  done
  if [ "$conflict" -eq 1 ]; then
    if [ -t 0 ]; then
      read -r -p "  One or more ports are occupied. Stop them and continue? [y/N] " ans
    else
      ans="y"
    fi
    if [[ "$ans" =~ ^[Yy]$ ]]; then
      action_stop_impl
    else
      echo "  Aborting start — resolve port conflicts first."
      return 1
    fi
  fi
  if port_in_use 3000; then
    echo "  ERROR: port 3000 still bound after stop — refusing to start a second Node on the live SQLite file."
    return 1
  fi

  echo "  Booting dev orchestrator (npm run dev) — logging to $DEV_LOG"
  : > "$DEV_LOG"
  nohup npm run dev >> "$DEV_LOG" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  disown "$pid" 2>/dev/null || true
  echo "  Launcher pid: $pid"

  wait_for_ecosystem 90
  echo ""
  echo "  --- last 20 lines of $DEV_LOG ---"
  tail -n 20 "$DEV_LOG" 2>/dev/null || true
  echo "  ---------------------------------"
  return 0
}

action_start() {
  print_header
  action_start_impl || return 1
  run_ecosystem_status "live" "true"
}

action_stop_impl() {
  echo "  Stopping ecosystem — freeing ports: ${PORTS[*]}"
  local port
  for port in "${PORTS[@]}"; do
    if port_in_use "$port"; then
      echo "  Port $port ($(label_for_port "$port")) is occupied — killing."
      kill_port "$port"
    else
      echo "  Port $port ($(label_for_port "$port")) already free."
    fi
  done

  if [ -f "$PID_FILE" ]; then
    local main_pid
    main_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$main_pid" ] && kill -0 "$main_pid" 2>/dev/null; then
      echo "  Killing tracked launcher pid $main_pid"
      kill_pid_tree "$main_pid"
    fi
    rm -f "$PID_FILE"
  fi

  sleep 1
  local still_busy=0
  for port in "${PORTS[@]}"; do
    if port_in_use "$port"; then
      echo "  WARNING: port $port still occupied after kill attempt."
      still_busy=1
    fi
  done
  if [ "$still_busy" -eq 0 ]; then
    echo "  All tracked ports free."
  fi
}

action_stop() {
  print_header
  action_stop_impl
  run_ecosystem_status "stopped"
}

action_restart() {
  print_header
  echo "  Restarting ecosystem."
  action_stop_impl
  echo "  Confirming ports released before restart..."
  local port ok=1
  for port in "${PORTS[@]}"; do
    if ! wait_port_free "$port" 10; then
      echo "  Port $port did not release within 10s."
      ok=0
    fi
  done
  if [ "$ok" -eq 0 ]; then
    echo "  Proceeding anyway — start will re-check ports."
  fi
  action_start_impl || return 1
  run_ecosystem_status "live" "true"
}

action_nuke() {
  print_header
  echo "  Nuking stale/zombie Argus processes (no services will be started)."
  action_stop_impl

  echo "  Sweeping for orphaned Node/Python/Gateway processes by command line..."
  if is_windows; then
    if command -v powershell.exe >/dev/null 2>&1; then
      powershell.exe -NoProfile -Command '
        # $PID excluded below - the pattern text is embedded in this very -Command string, so
        # without the exclusion this sweep matches (and kills) its own transient process.
        $patterns = "ecosystem-dev\.ts|devWithOpenAlice\.ts|server\.ts|local_ai_service\.py|OpenAlice.*guardian"
        Get-CimInstance Win32_Process |
          Where-Object { $_.CommandLine -match $patterns -and $_.ProcessId -ne $PID } |
          ForEach-Object {
            Write-Host ("  killing pid {0}: {1}" -f $_.ProcessId, $_.CommandLine)
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
          }
      ' 2>/dev/null
    else
      echo "  powershell.exe not found — skipping command-line-based sweep (port sweep above still ran)."
    fi
  else
    if command -v pgrep >/dev/null 2>&1; then
      local pid
      for pid in $(pgrep -f 'ecosystem-dev\.ts|devWithOpenAlice\.ts|server\.ts|local_ai_service\.py' 2>/dev/null); do
        echo "  killing pid $pid"
        kill_pid_tree "$pid"
      done
    else
      echo "  pgrep not found — skipping command-line-based sweep (port sweep above still ran)."
    fi
  fi
  echo "  Nuke complete."
  run_ecosystem_status "stopped"
}

# ---------------------------------------------------------------------------
# Menu
# ---------------------------------------------------------------------------

show_menu() {
  print_header
  echo "  1) Start ecosystem"
  echo "  2) Stop ecosystem (hard kill)"
  echo "  3) Restart ecosystem"
  echo "  4) Service health & status"
  echo "  5) Nuke stale/zombie processes"
  echo "  6) Exit"
  echo ""
}

run_interactive() {
  while true; do
    show_menu
    read -r -p "  Select an option [1-6]: " choice
    case "$choice" in
      1) action_start ;;
      2) action_stop ;;
      3) action_restart ;;
      4) action_status ;;
      5) action_nuke ;;
      6) echo "  Exiting."; exit 0 ;;
      *) echo "  Invalid option: $choice" ;;
    esac
    echo ""
    read -r -p "  Press Enter to return to the menu..." _
  done
}

main() {
  case "${1:-}" in
    start) action_start ;;
    stop) action_stop ;;
    restart) action_restart ;;
    status) action_status ;;
    nuke) action_nuke ;;
    "") run_interactive ;;
    *)
      echo "Usage: $0 [start|stop|restart|status|nuke]"
      echo "Run with no arguments for the interactive menu."
      exit 1
      ;;
  esac
}

main "$@"
