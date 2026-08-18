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
    taskkill.exe //PID "$pid" //T //F >/dev/null 2>&1 || \
      cmd.exe //c "taskkill /PID $pid /T /F" >/dev/null 2>&1
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
# Health checks (real endpoints only — no fabricated probes)
# ---------------------------------------------------------------------------

check_node_health() {
  # server.ts:672 GET /health
  curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:3000/health" 2>/dev/null
}

check_chronos_health() {
  # scripts/local_ai_service.py GET /health
  curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:8008/health" 2>/dev/null
}

check_ibkr_gateway() {
  # InteractiveBrokersAdapter.ts GET /iserver/auth/status (self-signed cert; 401 pending
  # manual 2FA is expected and still counts as "up" per CLAUDE.md, not a failure)
  curl -sk -o /dev/null -w '%{http_code}' --max-time 3 "https://localhost:5000/v1/api/iserver/auth/status" 2>/dev/null
}

check_openalice_guardian() {
  # Same capability check as OpenAliceAdapter.healthCheck() / mcpEndpointHasGuardianTools():
  # a bare handshake success is not proof this is Guardian and not OpenAlice's UTA trading MCP.
  local body
  body="$(curl -s --max-time 3 -X POST "http://127.0.0.1:47332/mcp" \
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
  printf "  %-8s %-34s %-10s %s\n" "PORT" "SERVICE" "PORT" "HEALTH"
  echo "  ------------------------------------------------------------"
  local port label port_state health
  for port in "${PORTS[@]}"; do
    label="$(label_for_port "$port")"
    if port_in_use "$port"; then port_state="BOUND"; else port_state="FREE"; fi

    case "$port" in
      3000)
        if [ "$port_state" = "BOUND" ]; then
          health="$(check_node_health)"
          [ "$health" = "200" ] && health="UP (200)" || health="NO RESPONSE"
        else
          health="OFFLINE"
        fi
        ;;
      8008)
        if [ "$port_state" = "BOUND" ]; then
          health="$(check_chronos_health)"
          [ "$health" = "200" ] && health="UP (200)" || health="NO RESPONSE"
        else
          health="OFFLINE (optional)"
        fi
        ;;
      5000)
        if [ "$port_state" = "BOUND" ]; then
          health="$(check_ibkr_gateway)"
          if [ -n "$health" ] && [ "$health" != "000" ]; then health="UP ($health, 2FA may be pending)"; else health="NO RESPONSE"; fi
        else
          health="OFFLINE (optional)"
        fi
        ;;
      47332)
        if [ "$port_state" = "BOUND" ]; then
          health="$(check_openalice_guardian)"
          case "$health" in
            GUARDIAN) health="UP (Guardian tools confirmed)" ;;
            WRONG_MCP) health="WRONG MCP (not Guardian — see CLAUDE.md OpenAlice section)" ;;
            *) health="NO RESPONSE" ;;
          esac
        else
          health="OFFLINE (optional)"
        fi
        ;;
    esac
    printf "  %-8s %-34s %-10s %s\n" "$port" "$label" "$port_state" "$health"
  done
  echo ""
  if [ -f "$PID_FILE" ]; then
    local tracked_pid
    tracked_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$tracked_pid" ] && kill -0 "$tracked_pid" 2>/dev/null; then
      echo "  Tracked launcher pid: $tracked_pid (started via this script)"
    else
      echo "  Tracked launcher pid file is stale (process not running) — clearing."
      rm -f "$PID_FILE"
    fi
  fi
  echo "  Log: $DEV_LOG"
  echo ""
}

action_start() {
  print_header
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
      action_stop
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

  echo "  Waiting for Argus to bind port 3000 (up to 45s)..."
  local waited=0
  while [ "$waited" -lt 45 ]; do
    if port_in_use 3000; then
      echo "  Argus is listening on port 3000."
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if ! port_in_use 3000; then
    echo "  Still starting — this can take longer if Chronos/Ollama/OpenAlice are also booting."
  fi
  echo ""
  echo "  --- last 20 lines of $DEV_LOG ---"
  tail -n 20 "$DEV_LOG" 2>/dev/null || true
  echo "  ---------------------------------"
}

action_stop() {
  print_header
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

action_restart() {
  print_header
  echo "  Restarting ecosystem."
  action_stop
  echo "  Confirming ports released before restart..."
  local port ok=1
  for port in "${PORTS[@]}"; do
    if ! wait_port_free "$port" 10; then
      echo "  Port $port did not release within 10s."
      ok=0
    fi
  done
  if [ "$ok" -eq 0 ]; then
    echo "  Proceeding anyway — start will re-check and offer to stop again."
  fi
  action_start
}

action_nuke() {
  print_header
  echo "  Nuking stale/zombie Argus processes (no services will be started)."
  action_stop

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
