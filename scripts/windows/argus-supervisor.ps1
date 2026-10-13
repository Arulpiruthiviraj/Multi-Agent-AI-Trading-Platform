<#
.SYNOPSIS
  Argus boot-time recovery supervisor (Windows). Detects that the engine/watchdog are not running (power loss,
  sleep/hibernate kill, session teardown, crash) and restores MONITORING safely.

.DESCRIPTION
  Created 2026-10-13 after the Oct 12 night: the PC slept at 23:44 ET (reason "Application API") and was awake again at
  08:57 with no Argus engine and no watchdog, so a carried PAPER position (S, 38 sh) was unmonitored all night.

  What this script does, in order:
    1. Appends a line to data\logs\supervisor.log for every run (why it ran, what it found, what it did).
    2. If the engine already answers /health: does nothing (never restarts a running engine).
    3. Otherwise starts exactly one engine through the documented CLI:  argus start   (NO --enable-trading).
       The engine boots PAUSED (restart-safety guard + reconciliation gate); new entries stay disabled.
       With tradingSafety.restartSafetyEntriesOnlyPause=true the pause is ENTRIES_ONLY, so a sealed protective exit
       can still run; otherwise the pause is FULL and the operator must review before anything can trade or exit.
    4. Starts the watchdog (argus watchdog-start) and records the reconciliation status.

  What it NEVER does: resume trading, enable Autobot, arm LIVE, place or cancel orders, edit the database or config.
  PAPER_TRADING_ONLY / LIVE_NO_GO are enforced by the engine itself; this script refuses to run if the repo .env
  does not say PAPER_TRADING_ONLY=true.

  Install as a Scheduled Task (independent of any interactive session or Claude/IDE process tree) with
  install-argus-supervisor.ps1. It is NOT installed automatically.
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [int]$HealthTimeoutSec = 5,
  [string]$Reason = 'scheduled'
)

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $RepoRoot 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'supervisor.log'
function Write-Log([string]$msg) {
  $line = '[{0}] [{1}] {2}' -f (Get-Date).ToUniversalTime().ToString('o'), $Reason, $msg
  Add-Content -Path $log -Value $line -Encoding utf8
  Write-Host $line
}

try {
  Set-Location $RepoRoot
  $envFile = Join-Path $RepoRoot '.env'
  if (-not (Test-Path $envFile) -or -not (Select-String -Path $envFile -Pattern '^\s*PAPER_TRADING_ONLY\s*=\s*true\s*$' -Quiet)) {
    Write-Log 'REFUSED: .env does not contain PAPER_TRADING_ONLY=true. Nothing started.'
    exit 2
  }

  $lastWake = $null
  try { $lastWake = (& powercfg /lastwake 2>$null | Out-String).Trim() } catch { }
  Write-Log ("supervisor run; os boot time = {0}" -f (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'))

  $healthy = $false
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/health' -UseBasicParsing -TimeoutSec $HealthTimeoutSec
    $healthy = ($r.StatusCode -eq 200)
  } catch { $healthy = $false }

  if ($healthy) {
    Write-Log 'engine already healthy - no action (a running engine is never restarted by the supervisor).'
  } else {
    Write-Log 'engine NOT answering /health - starting ONE engine via the documented CLI, WITHOUT --enable-trading (boots paused).'
    $argusCmd = Join-Path $RepoRoot 'argus.ps1'
    if (-not (Test-Path $argusCmd)) { throw "argus.ps1 not found at $argusCmd" }
    & $argusCmd start 2>&1 | ForEach-Object { Write-Log ("argus start: {0}" -f $_) }
  }

  # Watchdog: the CLI is idempotent ("Watchdog already running").
  & (Join-Path $RepoRoot 'argus.ps1') watchdog-start 2>&1 | ForEach-Object { Write-Log ("watchdog-start: {0}" -f $_) }

  # Record (never change) the reconciliation / trading state for the operator.
  & (Join-Path $RepoRoot 'argus.ps1') reconciliation-status 2>&1 | ForEach-Object { Write-Log ("reconciliation: {0}" -f $_) }
  Write-Log 'done. Trading was NOT resumed; the operator (or the documented certified resume path) must do that after reviewing reconciliation.'
  exit 0
} catch {
  Write-Log ("ERROR: {0}" -f $_.Exception.Message)
  exit 1
}
