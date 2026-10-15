<#
.SYNOPSIS
  Read-only check: can this Windows host keep Argus alive overnight while PAPER positions are open?
  Reports sleep/hibernate timeouts, lid action, and every sleep/resume since the given time.
#>
[CmdletBinding()]
param([datetime]$Since = (Get-Date).AddDays(-3))

Write-Host '--- power plan (AC/DC timeouts, minutes; 0 = never) ---'
foreach ($setting in @('STANDBYIDLE', 'HIBERNATEIDLE')) {
  $q = powercfg /query SCHEME_CURRENT SUB_SLEEP $setting 2>$null | Select-String 'Current (AC|DC) Power Setting Index'
  foreach ($line in $q) {
    $hex = ($line.Line -split ':')[-1].Trim()
    $min = [math]::Round([Convert]::ToInt32($hex, 16) / 60, 1)
    Write-Host ('{0,-14} {1}  = {2} min' -f $setting, ($line.Line -replace '.*Current ', '').Split(':')[0], $min)
  }
}
Write-Host '--- lid close action (0 = do nothing, 1 = sleep) ---'
powercfg /query SCHEME_CURRENT SUB_BUTTONS LIDACTION 2>$null | Select-String 'Current (AC|DC) Power Setting Index'

Write-Host "--- sleep / resume events since $Since ---"
Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = $Since; Id = 42, 107, 1074, 6005, 6006, 6008 } -ErrorAction SilentlyContinue |
  Where-Object { $_.ProviderName -match 'Kernel-Power|User32|EventLog' } |
  Sort-Object TimeCreated |
  ForEach-Object { '{0}  id={1}  {2}' -f $_.TimeCreated, $_.Id, (($_.Message -split "`n") | Select-Object -First 2) -join ' | ' }

Write-Host '--- last wake / what can wake the PC ---'
powercfg /lastwake 2>$null
Write-Host '--- Argus supervisor task ---'
Get-ScheduledTask -TaskName 'ArgusSupervisor' -ErrorAction SilentlyContinue | Format-List TaskName, State
if (-not (Get-ScheduledTask -TaskName 'ArgusSupervisor' -ErrorAction SilentlyContinue)) { Write-Host 'ArgusSupervisor scheduled task is NOT installed.' }
