<#
.SYNOPSIS
  Registers the Argus supervisor as a Windows Scheduled Task so engine + watchdog recovery does not depend on an
  interactive terminal, an IDE, or a Claude Code session (their process trees were torn down on Oct 12-13).

.DESCRIPTION
  DRY RUN BY DEFAULT: prints the task definition and changes nothing. Pass -Apply to register it (needs the user's own
  account; no admin rights required for a per-user task). Remove with -Remove.

  Triggers: at system startup, at user logon, and every 15 minutes (the supervisor is idempotent: a healthy engine is
  never touched). Settings: start when available, wake the machine to run, restart on failure, no execution time limit.

  This does NOT prevent Windows from sleeping. Sleep on Oct 12 was initiated by an application ("Application API").
  Keep the machine awake while PAPER positions are open (power plan: never sleep / hibernate, lid action: do nothing) -
  see docs/operations/ARGUS_WINDOWS_SUPERVISION.md and scripts/windows/check-argus-power-readiness.ps1.
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$Remove,
  [string]$TaskName = 'ArgusSupervisor',
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

$script = Join-Path $RepoRoot 'scripts\windows\argus-supervisor.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Reason scheduled' -f $script) -WorkingDirectory $RepoRoot
$triggers = @(
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15))
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Hours 0)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

if ($Remove) {
  if ($Apply) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Host "Removed task $TaskName" }
  else { Write-Host "DRY RUN: would remove task $TaskName (pass -Apply)." }
  return
}

Write-Host "Task      : $TaskName"
Write-Host "Action    : powershell.exe -File $script -Reason scheduled"
Write-Host "Triggers  : at startup, at logon, every 15 minutes"
Write-Host "Behavior  : idempotent; starts the engine PAUSED (never --enable-trading); never restarts a healthy engine"
if (-not $Apply) { Write-Host "DRY RUN: nothing registered. Re-run with -Apply to register."; return }

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered scheduled task $TaskName. Verify with: Get-ScheduledTask -TaskName $TaskName"
