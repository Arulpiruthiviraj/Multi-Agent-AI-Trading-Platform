#!/bin/bash
# Counterfactual diagnostics for universal discovery (SYNTHETIC; production config untouched). Usage: discoveryCounterfactuals.sh <outdir>
cd "$(dirname "$0")/../.."
OUT="$1"; mkdir -p "$OUT"
run() { # name, env...
  local name="$1"; shift
  mkdir -p "$OUT/$name"
  env DISCOVERY_REPORT_DIR="$OUT/$name" "$@" node node_modules/vitest/vitest.mjs run src/server/certification/universalDiscovery -t "seed 102" > "$OUT/$name.log" 2>&1
  echo "$name done" >> "$OUT/progress.txt"
}
run base_cap12
run cap90_ibkr_actual DISCOVERY_CAP=90
run cap_unlimited DISCOVERY_CAP=100000
run limit_unlimited DISCOVERY_CHALLENGER_LIMIT=100000
run edge_zero DISCOVERY_SCORE_EDGE=0
run all_relaxed DISCOVERY_CAP=100000 DISCOVERY_CHALLENGER_LIMIT=100000 DISCOVERY_SCORE_EDGE=0
echo ALLDONE >> "$OUT/progress.txt"
