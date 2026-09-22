# ARGUS shell operator control plane - PowerShell port of ./argus (bash).
# Does NOT contain RiskEngine, OMS, BrokerManager, or trading logic - same contract as ./argus.
# See ARGUS_SHELL_CLI.md and ARGUS_CLI.md. Every subcommand not explicitly implemented below
# forwards verbatim to `npm run -s argus-cli -- <args>` (scripts/argus-cli.ts), so this script can
# never leave a real command unreachable even before every bash-side convenience is ported.
#
# Usage: .\argus.ps1 <command> [options]           (or: pwsh ./argus.ps1 <command> ...)
#
# Pretty-printers for status/health/ready reuse the EXACT SAME embedded Node.js formatting
# snippets scripts/cli/common.sh already uses (copied verbatim, not re-derived) - this guarantees
# identical output between the bash and PowerShell entry points rather than a second, potentially
# drifting implementation of the same formatting logic.

# Deliberately NOT 'Stop': this script shells out to native executables (npm.cmd, node) constantly,
# and PowerShell 5.1 can surface a native command's stderr output as a terminating NativeCommandError
# when ErrorActionPreference is Stop, even when the command's real exit code is handled explicitly
# below - a real bug found and fixed while testing this script. Every native-command result is
# checked via $LASTEXITCODE explicitly throughout instead of relying on this preference.
$ErrorActionPreference = 'Continue'
$ArgusRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ArgusRoot

if (-not $env:ARGUS_API_URL) { $env:ARGUS_API_URL = 'http://127.0.0.1:3000' }

$ExitOk = 0
$ExitFail = 1
$ExitUsage = 2
$ExitEngineDown = 3
$ExitNotReady = 4
$ExitAuth = 5

function Invoke-ArgusCli {
    param([string[]]$ArgList)
    & npm.cmd run -s argus-cli -- @ArgList
    return $LASTEXITCODE
}

function Get-ArgusCliJson {
    param([string[]]$ArgList)
    # Deliberately does NOT merge stderr into stdout (`2>&1` on a native exe wraps each stderr
    # line in a NativeCommandError object in Windows PowerShell 5.1, corrupting a clean JSON
    # stdout stream with garbage when later joined to a string - a real bug found and fixed while
    # testing this script). npm's own "> script" banner line already goes to stderr by
    # convention (silenced further by -s), so stdout alone is the pure JSON payload. stderr is
    # captured to a temp file (single invocation, safe for any command including mutating ones)
    # and only read back when the call actually failed.
    $stderrFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "argus-cli-stderr-$([guid]::NewGuid()).log")
    try {
        $stdout = & npm.cmd run -s argus-cli -- @ArgList 2>$stderrFile
        $rc = $LASTEXITCODE
        # PowerShell 5.1 on Windows can prepend a UTF-8 BOM (U+FEFF) to captured native-command
        # output in some console-encoding configurations, which breaks JSON.parse() with
        # "Unexpected token" on an otherwise perfectly valid payload - a real bug found and fixed
        # while testing this script. Stripping it is always safe (a real JSON payload never starts
        # with U+FEFF).
        $rawStdout = ($stdout -join "`n").TrimStart([char]0xFEFF)
        if ($rc -ne 0) {
            $stderrText = if (Test-Path $stderrFile) { Get-Content -Path $stderrFile -Raw } else { '' }
            return @{ Raw = ($rawStdout + "`n" + $stderrText); ExitCode = $rc }
        }
        return @{ Raw = $rawStdout; ExitCode = $rc }
    } finally {
        Remove-Item -Path $stderrFile -ErrorAction SilentlyContinue
    }
}

function Test-WantsHelp {
    param([string[]]$ArgList)
    foreach ($a in $ArgList) { if ($a -in @('-h', '--help', 'help')) { return $true } }
    return $false
}

function Show-Unauthorized {
    param([string]$Raw)
    Write-Host "X API unauthorized at $($env:ARGUS_API_URL) (run: .\argus.ps1 login - or unset AUTH_PASSWORD for localhost-only mode)" -ForegroundColor Red
    Write-Host $Raw -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Pretty-printers - Node snippets copied verbatim from scripts/cli/common.sh
# ---------------------------------------------------------------------------

$StatusFormatter = @'
const fs = require("fs");
const s = fs.readFileSync(process.argv[2], "utf8");
(() => {
  let j; try { j=JSON.parse(s); } catch { console.log(s); process.exitCode=1; return; }
  const dash="-";
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
  console.log("(Mapped from GET /api/v2/runtime/status only - use --json for full payload)");
})();
'@

$HealthFormatter = @'
const fs = require("fs");
const s = fs.readFileSync(process.argv[2], "utf8");
(() => {
  try {
    const j=JSON.parse(s);
    const dash="-";
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
})();
'@

$ReadyFormatter = @'
const fs = require("fs");
const s = fs.readFileSync(process.argv[2], "utf8");
(() => {
  try {
    const j=JSON.parse(s);
    const dash="-";
    const show=(v)=> v===undefined||v===null||v==="" ? dash : String(v);
    console.log("ARGUS READINESS");
    console.log("  result: "+show(j.result));
    if (j.summary!=null) console.log("  summary: "+(typeof j.summary==="string"?j.summary:JSON.stringify(j.summary)));
    console.log("  note:   health != trading ready; LIVE expected NO-GO until evaluateLiveReadiness says otherwise");
    console.log("  (use --json for full LiveReadinessReport)");
    const r=String(j.result||"");
    if (r && r!=="LIVE_READY") process.exitCode=4;
  } catch { console.log(s); process.exitCode=1; }
})();
'@

function Invoke-Formatted {
    param([string[]]$CliArgs, [string]$Formatter, [string]$UnavailableMessage)
    # Three real, distinct PowerShell-on-Windows bugs were found and fixed while testing this
    # function - each reproduced and verified against the live running engine:
    #  1. A multi-line JS string with embedded double-quotes cannot safely cross PowerShell's
    #     argument-quoting into `node -e <string>` (native-exe arg re-quoting mangles it) - fixed
    #     by writing the formatter script to a temp .js file and running that instead.
    #  2. `$string | node script.js` re-encodes the piped string with a leading UTF-8 BOM (U+FEFF)
    #     somewhere in PowerShell 5.1's native-process pipe machinery, even when the source string
    #     has no BOM - this broke JSON.parse() on an otherwise perfectly valid payload. Fixed by
    #     writing the JSON payload to its own temp file with explicit no-BOM UTF8 (.NET
    #     File.WriteAllText, not Set-Content/Out-File, which have their own BOM defaults) and
    #     having the formatter read it via fs.readFileSync(path) instead of process.stdin.
    #  3. Calling this function as `exit (Invoke-Formatted ...)` or `$x = Invoke-Formatted ...`
    #     forces PowerShell to materialize the function's entire output stream as a captured
    #     value - which silently swallows the native `node` child process's inherited-console
    #     output instead of letting it stream to the terminal. Fixed by never `return`-ing the
    #     exit code through the pipeline: it is written to $script:LastExitCode instead, and every
    #     call site invokes this function as a bare statement (no assignment, no parens) then reads
    #     that variable - this is exactly why, unlike a normal function, callers must NOT wrap this
    #     one in `exit (...)`.
    $script:LastExitCode = $ExitOk
    if (Test-WantsHelp $CliArgs) { return }
    if ($CliArgs -contains '--json') {
        Invoke-ArgusCli -ArgList $CliArgs
        $script:LastExitCode = $LASTEXITCODE
        return
    }
    # Real bug found and fixed (2026-09-22): `health` (unlike status/ready) mixes JSON with
    # human-readable diagnostic lines by design when called WITHOUT --json (see
    # printFullHealthReport()'s own doc comment in scripts/argus-cli.ts) - naively JSON.parse()-ing
    # that combined output always threw, silently breaking this exact pretty-print path (reproduced
    # live before this fix, in both this script and the pre-existing bash ./argus). Reaching this
    # line already means the wrapper's own --json branch above did NOT match, so the underlying
    # data-fetch call explicitly requests --json anyway - that is what actually guarantees a clean,
    # parseable payload regardless of which command this is.
    $result = Get-ArgusCliJson -ArgList ($CliArgs + '--json')
    if ($result.ExitCode -ne 0) {
        if ($result.Raw -match '(?i)unauthorized|401|forbidden|403') {
            Show-Unauthorized -Raw $result.Raw
            $script:LastExitCode = $ExitAuth
            return
        }
        Write-Host "X $UnavailableMessage" -ForegroundColor Red
        Write-Host $result.Raw -ForegroundColor DarkGray
        $script:LastExitCode = $ExitEngineDown
        return
    }
    $scriptFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "argus-cli-format-$([guid]::NewGuid()).js")
    $dataFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "argus-cli-data-$([guid]::NewGuid()).json")
    try {
        $noBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($scriptFile, $Formatter, $noBom)
        [System.IO.File]::WriteAllText($dataFile, $result.Raw, $noBom)
        & node $scriptFile $dataFile
        $script:LastExitCode = $LASTEXITCODE
    } finally {
        Remove-Item -Path $scriptFile -ErrorAction SilentlyContinue
        Remove-Item -Path $dataFile -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------

function Show-HelpMain {
    @'
ARGUS - Autonomous Trading Engine (PowerShell control plane)

Usage:
  .\argus.ps1 <command> [options]

Engine:
  start [cli]       Start Argus Engine headless/API-only (web-UI mode: use ./argus.sh or WSL - see note)
  stop              Gracefully stop Argus Engine
  restart           Restart Argus Engine
  status            Show runtime status
  health            Check process health
  ready             Check trading readiness (LIVE readiness API)
  pipeline-ready    Process-alive vs trading-pipeline-ready (DB/market data/broker/AI providers)
  session-report    Pre-market/market-open counters (alias: trading-audit)
  doctor            Environment + API reachability diagnostics
  nuke              Force-kill stale/zombie Argus processes (no services started after)

Watchdog:
  watchdog-start / watchdog-stop / watchdog-restart / watchdog-status

Trading:
  enable / disable  Toggle Autobot (gates new BUY idea generation only)
  kill-switch       Trigger emergency trading stop (asks for confirmation - real, destructive)
  resume / pause    Resume/pause tradingState without stopping the engine

Portfolio / Observability:
  positions / trades / orders / config / risk / agents / events / logs

Historical Evaluation:
  replay run|list|report|export|analyze|diagnostics

Auth:
  login / logout

Dev:
  test              npm test (full suite)
  build             npm run build

Any other <command> is forwarded verbatim to: npm run -s argus-cli -- <command> [options]
so every scripts/argus-cli.ts command remains reachable from PowerShell.

Note (web UI): this PowerShell port covers the headless/API control plane only. The full dev
ecosystem with the browser UI (argus.sh's process-lifecycle/port-management logic) is bash-specific
- run it via Git Bash / WSL: ./argus.sh start
'@ | Write-Host
}

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

$cmd = if ($args.Count -ge 1) { $args[0] } else { 'help' }
$rest = if ($args.Count -ge 2) { $args[1..($args.Count - 1)] } else { @() }

switch ($cmd) {
    { $_ -in @('-h', '--help', 'help') } {
        Show-HelpMain
        exit $ExitOk
    }
    { $_ -in @('-v', '--version', 'version') } {
        $ver = try { (Get-Content (Join-Path $ArgusRoot 'package.json') -Raw | ConvertFrom-Json).version } catch { '0.0.0' }
        Write-Host "argus $ver (PowerShell operator control plane)"
        Write-Host "engine API: $($env:ARGUS_API_URL)"
        Write-Host "repo: $ArgusRoot"
        exit $ExitOk
    }
    'start' {
        if (Test-WantsHelp $rest) {
            Write-Host "Usage: .\argus.ps1 start [--enable-trading] [--reason=...] [--prod]"
            Write-Host "  Starts the headless engine (npm run argus-cli -- start --headless ...)."
            exit $ExitOk
        }
        if ($rest -contains 'web') {
            Write-Host "Web-UI mode is bash-specific (argus.sh's port/PID management). Run: ./argus.sh start (Git Bash/WSL)" -ForegroundColor Yellow
            exit $ExitUsage
        }
        $forwardArgs = @('start', '--headless') + ($rest | Where-Object { $_ -ne 'cli' })
        exit (Invoke-ArgusCli -ArgList $forwardArgs)
    }
    'stop' {
        if (Test-WantsHelp $rest) { Write-Host "Usage: .\argus.ps1 stop"; exit $ExitOk }
        if ($rest -contains 'web') {
            Write-Host "Web-UI mode is bash-specific. Run: ./argus.sh stop (Git Bash/WSL)" -ForegroundColor Yellow
            exit $ExitUsage
        }
        exit (Invoke-ArgusCli -ArgList (@('stop') + ($rest | Where-Object { $_ -ne 'cli' })))
    }
    'restart' {
        if (Test-WantsHelp $rest) { Write-Host "Usage: .\argus.ps1 restart"; exit $ExitOk }
        if ($rest -contains 'web') {
            Write-Host "Web-UI mode is bash-specific. Run: ./argus.sh restart (Git Bash/WSL)" -ForegroundColor Yellow
            exit $ExitUsage
        }
        exit (Invoke-ArgusCli -ArgList (@('restart') + ($rest | Where-Object { $_ -ne 'cli' })))
    }
    'status' {
        # Deliberately a bare statement (no assignment, no parens/exit-wrapping) - see
        # Invoke-Formatted's own header comment (bug #3) for why that silently swallows the
        # node child process's console output. Exit code comes back via $script:LastExitCode.
        Invoke-Formatted -CliArgs (@('status') + $rest) -Formatter $StatusFormatter -UnavailableMessage "Engine unavailable at $($env:ARGUS_API_URL)"
        exit $script:LastExitCode
    }
    'health' {
        Invoke-Formatted -CliArgs (@('health') + $rest) -Formatter $HealthFormatter -UnavailableMessage 'Health check failed (engine down?)'
        exit $script:LastExitCode
    }
    'ready' {
        Invoke-Formatted -CliArgs (@('ready') + $rest) -Formatter $ReadyFormatter -UnavailableMessage 'Readiness API unavailable'
        exit $script:LastExitCode
    }
    'kill-switch' {
        if (Test-WantsHelp $rest) {
            Write-Host "Usage: .\argus.ps1 kill-switch"
            Write-Host "  Triggers the REAL emergency stop (POST /api/v1/system/emergency-stop). Destructive - confirms first."
            exit $ExitOk
        }
        $confirmation = Read-Host "This will trigger the REAL production emergency stop and block new trading. Type YES to confirm"
        if ($confirmation -ne 'YES') {
            Write-Host 'Aborted - no change made.' -ForegroundColor Yellow
            exit $ExitOk
        }
        exit (Invoke-ArgusCli -ArgList (@('kill-switch') + $rest))
    }
    'test' {
        if (Test-WantsHelp $rest) { Write-Host "Usage: .\argus.ps1 test"; exit $ExitOk }
        & npm.cmd test
        exit $LASTEXITCODE
    }
    'build' {
        if (Test-WantsHelp $rest) { Write-Host "Usage: .\argus.ps1 build"; exit $ExitOk }
        & npm.cmd run build
        exit $LASTEXITCODE
    }
    'doctor' {
        if (Test-WantsHelp $rest) { Write-Host "Usage: .\argus.ps1 doctor"; exit $ExitOk }
        Write-Host "ARGUS DOCTOR"
        Write-Host ""
        $warn = $false
        try { $nodeVer = (& node -v); Write-Host "OK  Node $nodeVer" } catch { Write-Host "X   Node missing" -ForegroundColor Red }
        try { $npmVer = (& npm.cmd -v); Write-Host "OK  npm $npmVer" } catch { Write-Host "X   npm missing" -ForegroundColor Red }
        if (Test-Path (Join-Path $ArgusRoot 'node_modules')) { Write-Host "OK  Dependencies installed (node_modules present)" } else { Write-Host "X   Dependencies missing (run npm install)" -ForegroundColor Red }
        if (Test-Path (Join-Path $ArgusRoot '.env')) { Write-Host "OK  Configuration found (.env present; secrets not printed)" } else { Write-Host "!   .env not found (copy from .env.example)" -ForegroundColor Yellow; $warn = $true }
        if (Test-Path (Join-Path $ArgusRoot 'dist\server.cjs')) { Write-Host "OK  Build artifact present (dist/server.cjs)" } else { Write-Host "!   Production build artifact missing (optional for dev)" -ForegroundColor Yellow; $warn = $true }
        try {
            $null = Invoke-RestMethod -Uri "$($env:ARGUS_API_URL)/api/v2/runtime/health" -TimeoutSec 2 -ErrorAction Stop
            Write-Host "OK  API reachable / runtime health OK"
        } catch {
            $statusCode = $null
            if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
            if ($statusCode -in @(401, 403)) {
                Write-Host "!   API requires auth at $($env:ARGUS_API_URL) (run: .\argus.ps1 login)" -ForegroundColor Yellow
            } else {
                Write-Host "!   API not reachable at $($env:ARGUS_API_URL)" -ForegroundColor Yellow
            }
            $warn = $true
        }
        Write-Host ""
        if ($warn) { Write-Host "Doctor finished with warnings." -ForegroundColor Yellow; exit $ExitFail }
        Write-Host "Doctor finished clean." -ForegroundColor Green
        exit $ExitOk
    }
    'nuke' {
        exit (Invoke-ArgusCli -ArgList (@('nuke') + $rest))
    }
    default {
        # Universal fallback - every scripts/argus-cli.ts command stays reachable even if this
        # router hasn't given it a dedicated PowerShell-native pretty-printer yet.
        exit (Invoke-ArgusCli -ArgList (@($cmd) + $rest))
    }
}
