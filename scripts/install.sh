#!/usr/bin/env bash
# Amore Build installer — macOS / Linux / Git Bash (Windows).
#
#   curl -fsSL https://amore.build/download/amore-install-sh | bash
#
# Downloads the newest GitHub release asset for this host, verifies its
# published sha256, and installs the `amore` binary.
#
# Environment overrides:
#   AMORE_VERSION      install a specific tag (e.g. v0.2.120) instead of latest
#   AMORE_INSTALL_DIR  target directory (default: ~/.local/bin, or ~/amore/bin
#                      under Git Bash to match the Windows convention)
#   AMORE_INSTALL_NO_UPDATE_CHECK=1
#                      write cli.update_check = false into the user config
#                      before the binary runs (air-gapped / no startup check)
#   AMORE_HOME         config home (default: ~/.amore); used when writing the
#                      update-check opt-out above
set -euo pipefail

REPO="vincitamore/amore-build"

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

artifact="amore-${os}-${arch}"
case "$artifact" in
  amore-linux-x64|amore-linux-arm64|amore-darwin-x64|amore-darwin-arm64|amore-windows-x64) ;;
  *) echo "error: no published build for ${os}-${arch} — build from source:" >&2
     echo "  https://github.com/${REPO}#build-from-source" >&2; exit 1 ;;
esac

if [ "$os" = "windows" ]; then
  ext="zip"; bin="amore.exe"
  install_dir="${AMORE_INSTALL_DIR:-$HOME/amore/bin}"
else
  ext="tar.gz"; bin="amore"
  install_dir="${AMORE_INSTALL_DIR:-$HOME/.local/bin}"
fi

if [ -n "${AMORE_VERSION:-}" ]; then
  base="https://github.com/${REPO}/releases/download/${AMORE_VERSION}"
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
  [ -f "$tmp/pkg/$f" ] && cp "$tmp/pkg/$f" "$install_dir/$f.amore" || true
done

# Install-time opt-out of startup update checks (before the binary is invoked).
if [ "${AMORE_INSTALL_NO_UPDATE_CHECK:-}" = "1" ]; then
  amore_home="${AMORE_HOME:-$HOME/.amore}"
  mkdir -p "$amore_home"
  cfg="$amore_home/config.toml"
  if [ ! -f "$cfg" ]; then
    printf '%s\n' '[cli]' 'update_check = false' >"$cfg"
  elif grep -Eq '^[[:space:]]*update_check[[:space:]]*=' "$cfg"; then
    # Force the install-time opt-out when the key is already present.
    tmp_cfg="$(mktemp)"
    sed -E 's/^[[:space:]]*update_check[[:space:]]*=.*/update_check = false/' "$cfg" >"$tmp_cfg"
    mv "$tmp_cfg" "$cfg"
  elif grep -Eq '^[[:space:]]*\[cli\][[:space:]]*$' "$cfg"; then
    tmp_cfg="$(mktemp)"
    awk '
      BEGIN { done = 0 }
      /^[[:space:]]*\[cli\][[:space:]]*$/ && !done {
        print
        print "update_check = false"
        done = 1
        next
      }
      { print }
    ' "$cfg" >"$tmp_cfg"
    mv "$tmp_cfg" "$cfg"
  else
    printf '\n%s\n%s\n' '[cli]' 'update_check = false' >>"$cfg"
  fi
  echo "Wrote update_check = false to $cfg (AMORE_INSTALL_NO_UPDATE_CHECK=1)"
fi

echo
# Smoke-gate: the binary must run AND print a version. Exit code alone is not
# enough — a glibc-floor mismatch has been observed to print loader errors and
# still exit 0 with no output.
if ! smoke="$("$install_dir/$bin" --version)" || [ -z "$smoke" ]; then
  echo "error: the installed binary failed to run on this host." >&2
  echo "  On Linux this usually means the host's glibc is older than the" >&2
  echo "  release floor (releases target Ubuntu 22.04+ / Debian 12+)." >&2
  if [ -f "$install_dir/$bin.prev" ]; then
    mv -f "$install_dir/$bin.prev" "$install_dir/$bin"
    echo "  The previous binary was restored from rollback." >&2
  else
    rm -f "$install_dir/$bin"
  fi
  exit 1
fi
printf '%s\n' "$smoke"
echo "Installed to $install_dir/$bin"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo
     echo "note: $install_dir is not on your PATH. Add it, e.g.:"
     echo "  export PATH=\"$install_dir:\$PATH\"" ;;
esac
