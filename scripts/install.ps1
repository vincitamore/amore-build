# Arcus Build installer — Windows PowerShell.
#
#   irm https://amore.build/download/arcus-install-ps1 | iex
#
# Downloads the newest GitHub release asset (arcus-windows-x64), verifies its
# published sha256, installs arcus.exe, and offers to put it on the User PATH.
#
# Environment overrides:
#   ARCUS_VERSION      install a specific tag (e.g. v0.2.120) instead of latest
#   ARCUS_INSTALL_DIR  target directory (default: %USERPROFILE%\arcus\bin)

$ErrorActionPreference = 'Stop'

$repo = 'vincitamore/arcus-build'
$artifact = 'arcus-windows-x64'

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne 'AMD64') {
    Write-Error "No published build for Windows/$arch — build from source: https://github.com/$repo#build-from-source"
}

$installDir = if ($env:ARCUS_INSTALL_DIR) { $env:ARCUS_INSTALL_DIR } else { Join-Path $env:USERPROFILE 'arcus\bin' }
$base = if ($env:ARCUS_VERSION) {
    "https://github.com/$repo/releases/download/$($env:ARCUS_VERSION)"
} else {
    "https://github.com/$repo/releases/latest/download"
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("arcus-install-" + [System.IO.Path]::GetRandomFileName())
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
    $target = Join-Path $installDir 'arcus.exe'
    # Keep a rollback if a previous install exists (also dodges the running-file lock).
    if (Test-Path $target) {
        Move-Item -Force $target "$target.prev"
    }
    Copy-Item (Join-Path $tmp 'pkg\arcus.exe') $target
    # License hygiene: keep the archive's notices beside the binary.
    foreach ($f in 'LICENSE', 'NOTICE') {
        $src = Join-Path $tmp "pkg\$f"
        if (Test-Path $src) { Copy-Item $src (Join-Path $installDir "$f.arcus") }
    }

    Write-Host ''
    & $target --version
    Write-Host "Installed to $target"

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $onPath = ($userPath -split ';' | Where-Object { $_.TrimEnd('\') -eq $installDir.TrimEnd('\') }).Count -gt 0
    if (-not $onPath) {
        [Environment]::SetEnvironmentVariable('Path', "$userPath;$installDir", 'User')
        Write-Host "Added $installDir to your User PATH — open a new terminal to pick it up."
    }
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
