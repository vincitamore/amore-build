# Enable Windows full crash dumps for bun.exe — the DEFINITIVE native-segfault diagnostic.
#
# The iris TUI runs on Bun over OpenTUI's native Zig renderer. A native segfault (access
# violation) bypasses Bun's JS crash handlers, so the instrument home's tui-debug.log
# breadcrumbs and tui-crash.log (Bun's stderr trace) narrow WHERE it died — but a full
# minidump gives the exact native call stack (which Zig/OpenTUI function faulted).
#
# This configures Windows Error Reporting LocalDumps for bun.exe to write a FULL dump on crash.
# Run ONCE, elevated (it writes to HKLM). Dumps land in the folder below; analyze with WinDbg/cdb
# (`!analyze -v`) or send the .dmp + the Bun version for symbolication.
#
#   Run:     powershell -ExecutionPolicy Bypass -File enable-bun-crash-dumps.ps1
#   Disable: pass -Disable
#
# Reference: https://learn.microsoft.com/windows/win32/wer/collecting-user-mode-dumps

param([switch]$Disable)

$ErrorActionPreference = 'Stop'
$key = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\bun.exe'
if ($env:IRIS_HOME -and $env:IRIS_HOME.Trim() -ne '') {
  $dumpDir = Join-Path $env:IRIS_HOME 'crashdumps'
} else {
  $dumpDir = Join-Path $env:USERPROFILE '.amore\instruments\iris\crashdumps'
}

# Must be elevated to write under HKLM.
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Error 'Run this elevated (Administrator) — it writes to HKLM.'; exit 1 }

if ($Disable) {
  if (Test-Path $key) { Remove-Item $key -Recurse -Force; Write-Host "Disabled: removed $key" }
  else { Write-Host 'Already disabled (no LocalDumps key for bun.exe).' }
  exit 0
}

New-Item -Path $dumpDir -ItemType Directory -Force | Out-Null
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name 'DumpFolder'  -Value $dumpDir -PropertyType ExpandString -Force | Out-Null
New-ItemProperty -Path $key -Name 'DumpType'    -Value 2        -PropertyType DWord        -Force | Out-Null  # 2 = full dump
New-ItemProperty -Path $key -Name 'DumpCount'   -Value 10       -PropertyType DWord        -Force | Out-Null

Write-Host "Enabled full crash dumps for bun.exe."
Write-Host "  Dumps -> $dumpDir"
Write-Host "  On the next segfault, a bun.exe.<pid>.dmp appears there."
Write-Host "  Analyze: windbg/cdb -> '!analyze -v', or share the .dmp + 'bun --revision'."
Write-Host "  Disable later: powershell -File enable-bun-crash-dumps.ps1 -Disable"
