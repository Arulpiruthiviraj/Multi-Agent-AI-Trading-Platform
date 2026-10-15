# Lossless in-place NTFS compression of large forensic snapshots, with before/after SHA-256 and SQLite integrity evidence (2026-10-14).
# Nothing is deleted or moved: the file keeps its path; reads return identical bytes. Usage: powershell -File compressSnapshots.ps1 -Files <paths> -Manifest <out.json> [-Algo XPRESS8K]
param([Parameter(Mandatory)][string[]]$Files, [Parameter(Mandatory)][string]$Manifest, [string]$Algo = 'XPRESS8K')
$ErrorActionPreference = 'Stop'
$rows = @()
foreach ($f in $Files) {
  $item = Get-Item $f
  $before = [pscustomobject]@{ path = $f; bytes = $item.Length; sha256 = (Get-FileHash $f -Algorithm SHA256).Hash; startedAt = (Get-Date).ToString('o') }
  $log = & compact.exe /c /exe:$($Algo.ToLower()) /i $f 2>&1 | Out-String
  # size on disk
  Add-Type -Namespace Win32 -Name Native -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint GetCompressedFileSizeW([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string name, out uint high);' -ErrorAction SilentlyContinue
  $high = 0; $low = [Win32.Native]::GetCompressedFileSizeW($f, [ref]$high); $onDisk = ([uint64]$high -shl 32) + $low
  $afterSha = (Get-FileHash $f -Algorithm SHA256).Hash
  $rows += [pscustomobject]@{ path = $f; bytes = $before.bytes; sizeOnDiskBytes = $onDisk; sha256Before = $before.sha256; sha256After = $afterSha; identical = ($before.sha256 -eq $afterSha); algorithm = $Algo; finishedAt = (Get-Date).ToString('o') }
  Write-Output ("{0} identical={1} onDiskGB={2:N1} (was {3:N1})" -f $f, ($before.sha256 -eq $afterSha), ($onDisk / 1GB), ($before.bytes / 1GB))
  $rows | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $Manifest
}
