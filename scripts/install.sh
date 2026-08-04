#!/usr/bin/env bash
# Arcus Build installer — macOS / Linux / Git Bash (Windows).
#
#   curl -fsSL https://amore.build/download/arcus-install-sh | bash
#
# Downloads the newest GitHub release asset for this host, verifies its
# published sha256, and installs the `arcus` binary.
#
# Environment overrides:
#   ARCUS_VERSION      install a specific tag (e.g. v0.2.120) instead of latest
#   ARCUS_INSTALL_DIR  target directory (default: ~/.local/bin, or ~/arcus/bin
#                      under Git Bash to match the Windows convention)
set -euo pipefail

REPO="vincitamore/arcus-build"

case "$(uname -s)" in
  Linux)                     os="linux" ;;
  Darwin)                    os="darwin" ;;
  MINGW*|MSYS*|CYGWIN*)      os="windows" ;;
  *) echo "error: unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64)   arch="x64" ;;
  aarch64|arm64)  arch="arm64" ;;
  *) echo "error: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

artifact="arcus-${os}-${arch}"
case "$artifact" in
  arcus-linux-x64|arcus-linux-arm64|arcus-darwin-x64|arcus-darwin-arm64|arcus-windows-x64) ;;
  *) echo "error: no published build for ${os}-${arch} — build from source:" >&2
     echo "  https://github.com/${REPO}#build-from-source" >&2; exit 1 ;;
esac

if [ "$os" = "windows" ]; then
  ext="zip"; bin="arcus.exe"
  install_dir="${ARCUS_INSTALL_DIR:-$HOME/arcus/bin}"
else
  ext="tar.gz"; bin="arcus"
  install_dir="${ARCUS_INSTALL_DIR:-$HOME/.local/bin}"
fi

if [ -n "${ARCUS_VERSION:-}" ]; then
  base="https://github.com/${REPO}/releases/download/${ARCUS_VERSION}"
else
  base="https://github.com/${REPO}/releases/latest/download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading ${artifact}.${ext} ..."
curl -fsSL -o "$tmp/${artifact}.${ext}" "${base}/${artifact}.${ext}"
curl -fsSL -o "$tmp/${artifact}.${ext}.sha256" "${base}/${artifact}.${ext}.sha256"

expected="$(awk '{print $1}' < "$tmp/${artifact}.${ext}.sha256")"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/${artifact}.${ext}" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$tmp/${artifact}.${ext}" | awk '{print $1}')"
fi
if [ "$expected" != "$actual" ]; then
  echo "error: sha256 mismatch for ${artifact}.${ext}" >&2
  echo "  expected: $expected" >&2
  echo "  actual:   $actual" >&2
  exit 1
fi

echo "Checksum OK. Extracting ..."
if [ "$ext" = "zip" ]; then
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$tmp/${artifact}.zip" -d "$tmp/pkg"
  else
    powershell.exe -NoProfile -Command \
      "Expand-Archive -LiteralPath '$(cygpath -w "$tmp/${artifact}.zip")' -DestinationPath '$(cygpath -w "$tmp/pkg")' -Force" \
      >/dev/null
  fi
else
  mkdir -p "$tmp/pkg"
  tar -xzf "$tmp/${artifact}.${ext}" -C "$tmp/pkg"
fi

mkdir -p "$install_dir"
# Keep a rollback if a previous install exists.
if [ -f "$install_dir/$bin" ]; then
  mv -f "$install_dir/$bin" "$install_dir/$bin.prev"
fi
cp "$tmp/pkg/$bin" "$install_dir/$bin"
chmod +x "$install_dir/$bin"
# License hygiene: the release archive carries these; keep them beside the binary.
for f in LICENSE NOTICE; do
  [ -f "$tmp/pkg/$f" ] && cp "$tmp/pkg/$f" "$install_dir/$f.arcus" || true
done

echo
"$install_dir/$bin" --version
echo "Installed to $install_dir/$bin"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo
     echo "note: $install_dir is not on your PATH. Add it, e.g.:"
     echo "  export PATH=\"$install_dir:\$PATH\"" ;;
esac
