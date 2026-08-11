# Amore Build installer for Windows PowerShell.
#
#   irm https://amore.build/download/amore-install-ps1 | iex
#
# Downloads the newest GitHub release asset (amore-windows-x64), verifies its
# published sha256, installs amore.exe, and offers to put it on the User PATH.
#
# Environment overrides:
#   AMORE_VERSION      install a specific tag (e.g. v0.2.120) instead of latest
#   AMORE_INSTALL_DIR  target directory (default: %USERPROFILE%\amore\bin)
#   AMORE_INSTALL_NO_UPDATE_CHECK=1
#                      write cli.update_check = false into the user config
#                      before the binary runs (air-gapped / no startup check)
#   AMORE_HOME         config home (default: %USERPROFILE%\.amore)

$ErrorActionPreference = 'Stop'

$repo = 'vincitamore/amore-build'
$artifact = 'amore-windows-x64'

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne 'AMD64') {
    Write-Error "No published build for Windows/$arch. Build from source: https://github.com/$repo#build-from-source"
}

$installDir = if ($env:AMORE_INSTALL_DIR) { $env:AMORE_INSTALL_DIR } else { Join-Path $env:USERPROFILE 'amore\bin' }
$base = if ($env:AMORE_VERSION) {
    "https://github.com/$repo/releases/download/$($env:AMORE_VERSION)"
} else {
    "https://github.com/$repo/releases/latest/download"
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("amore-install-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    Write-Host "Downloading $artifact.zip ..."
    Invoke-WebRequest -Uri "$base/$artifact.zip" -OutFile (Join-Path $tmp "$artifact.zip")
    Invoke-WebRequest -Uri "$base/$artifact.zip.sha256" -OutFile (Join-Path $tmp "$artifact.zip.sha256")

    $expected = ((Get-Content (Join-Path $tmp "$artifact.zip.sha256") -Raw).Trim() -split '\s+')[0].ToLower()
    $actual = (Get-FileHash (Join-Path $tmp "$artifact.zip") -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) {
        Write-Error "sha256 mismatch for $artifact.zip`n  expected: $expected`n  actual:   $actual"
    }

    Write-Host "Checksum OK. Extracting ..."
    Expand-Archive -LiteralPath (Join-Path $tmp "$artifact.zip") -DestinationPath (Join-Path $tmp 'pkg') -Force

    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    $target = Join-Path $installDir 'amore.exe'
    # Keep a rollback if a previous install exists (also dodges the running-file lock).
    if (Test-Path $target) {
        Move-Item -Force $target "$target.prev"
    }
    Copy-Item (Join-Path $tmp 'pkg\amore.exe') $target
    # License hygiene: keep the archive's notices beside the binary.
    foreach ($f in 'LICENSE', 'NOTICE') {
        $src = Join-Path $tmp "pkg\$f"
        if (Test-Path $src) { Copy-Item $src (Join-Path $installDir "$f.amore") }
    }

    # Install-time opt-out of startup update checks (before the binary is invoked).
    if ($env:AMORE_INSTALL_NO_UPDATE_CHECK -eq '1') {
        $amoreHome = if ($env:AMORE_HOME) { $env:AMORE_HOME } else { Join-Path $env:USERPROFILE '.amore' }
        New-Item -ItemType Directory -Force -Path $amoreHome | Out-Null
        $cfg = Join-Path $amoreHome 'config.toml'
        if (-not (Test-Path $cfg)) {
            Set-Content -LiteralPath $cfg -Value "[cli]`nupdate_check = false`n" -NoNewline
        } else {
            $raw = Get-Content -LiteralPath $cfg -Raw
            if ($raw -match '(?m)^[ \t]*update_check[ \t]*=') {
                $raw = [regex]::Replace($raw, '(?m)^[ \t]*update_check[ \t]*=.*$', 'update_check = false')
            } elseif ($raw -match '(?m)^[ \t]*\[cli\][ \t]*$') {
                $raw = [regex]::Replace($raw, '(?m)^([ \t]*\[cli\][ \t]*\r?\n)', "`$1update_check = false`n")
            } else {
                if (-not $raw.EndsWith("`n")) { $raw += "`n" }
                $raw += "`n[cli]`nupdate_check = false`n"
            }
            Set-Content -LiteralPath $cfg -Value $raw -NoNewline
        }
        Write-Host "Wrote update_check = false to $cfg (AMORE_INSTALL_NO_UPDATE_CHECK=1)"
    }

    Write-Host ''
    # Smoke-gate: the binary must run AND print a version (exit code alone has
    # been observed insufficient on loader failures).
    $smoke = (& $target --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($smoke)) {
        Write-Host 'error: the installed binary failed to run on this host.' -ForegroundColor Red
        if (Test-Path "$target.prev") {
            Move-Item -Force "$target.prev" $target
            Write-Host 'The previous binary was restored from rollback.'
        } else {
            Remove-Item -Force $target -ErrorAction SilentlyContinue
        }
        throw 'install smoke test failed'
    }
    Write-Host $smoke
    Write-Host "Installed to $target"

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $onPath = ($userPath -split ';' | Where-Object { $_.TrimEnd('\') -eq $installDir.TrimEnd('\') }).Count -gt 0
    if (-not $onPath) {
        [Environment]::SetEnvironmentVariable('Path', "$userPath;$installDir", 'User')
        Write-Host "Added $installDir to your User PATH. Open a new terminal to pick it up."
    }
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
