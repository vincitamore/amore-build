#!/usr/bin/env bash
# Egress capture harness: run a one-shot session of a shipped `amore` binary
# under syscall-level network tracing and report every remote endpoint the
# process (and its children) asked the kernel to reach.
#
# This is the method behind the release announcement's egress claim. It is
# deliberately simple enough to audit in one sitting:
#
#   1. A scratch AMORE_HOME is built containing ONLY the model entry under
#      test (copied from an existing config), so nothing else in your config
#      can talk.
#   2. The binary runs one headless prompt under `strace -f -e trace=network`.
#      strace records every connect/sendto/sendmsg the process tree issues.
#      Per-process ground truth, not a network-interface guess. A binary
#      cannot opt out of the tracer the way it could ignore an HTTPS proxy.
#   3. The log is reduced to the set of unique remote endpoints, and each is
#      attributed: the configured endpoint's resolved addresses, the local
#      DNS resolver, loopback/unix-domain plumbing, or UNKNOWN.
#
# Exit is non-zero if any UNKNOWN endpoint remains. Pair it with a packet
# capture (`tcpdump -i any port 53`) if you also want the DNS question names
# on the wire; strace already gives you every destination address.
#
# Usage:
#   scripts/egress_capture.sh <amore-binary> <source-config.toml> <model-entry> [outdir]
#
# Example:
#   scripts/egress_capture.sh ~/.local/bin/amore ~/.amore/config.toml deepseek-openrouter /tmp/egress
#
# Linux only (strace). Requires: bash, strace, getent, awk, python3.
# Non-Linux hosts exit 2 with an honest degrade message.
#
# Lucerna dream-cycle capture (same attribution harness):
#   scripts/lucerna_egress_capture.sh

set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=egress_lib.sh
. "$SCRIPT_DIR/egress_lib.sh"

BIN=${1:?usage: egress_capture.sh <amore-binary> <source-config.toml> <model-entry> [outdir]}
SRC_CONFIG=${2:?source config.toml required}
ENTRY=${3:?model entry name required}
OUT=${4:-/tmp/amore-egress}

egress_require_linux_strace "amore one-shot egress capture"
[ -x "$BIN" ] || egress_die "not executable: $BIN"
[ -r "$SRC_CONFIG" ] || egress_die "unreadable: $SRC_CONFIG"

mkdir -p "$OUT"
HOME_DIR="$OUT/home"
rm -rf "$HOME_DIR"
mkdir -p "$HOME_DIR"

# --- 1. Scratch home: extract exactly one [model.<entry>] block. -------------
# The secret stays file-to-file; nothing is echoed.
egress_write_scratch_config "$SRC_CONFIG" "$ENTRY" "$HOME_DIR/config.toml"
egress_read_base_host "$HOME_DIR/config.toml"

# --- 2. Resolve the allowed set BEFORE the run. ------------------------------
egress_resolve_allowed "$EGRESS_HOST" "$OUT/allowed-ips.txt"

# Release-origin attribution is CONDITIONAL on the version check being enabled.
# When checks are off (AMORE_UPDATE_CHECK=0 / AMORE_DISABLE_UPDATES / falsy),
# github.com must NOT be an allowed class so a checks-off capture still proves
# the kill switch. When checks are on, github.com is "release origin".
egress_update_checks_enabled() {
  local v
  v=$(printf '%s' "${AMORE_DISABLE_UPDATES:-}" | tr '[:upper:]' '[:lower:]')
  case "$v" in
    1|true|yes|on) return 1 ;;
  esac
  v=$(printf '%s' "${GROK_DISABLE_AUTOUPDATER:-}" | tr '[:upper:]' '[:lower:]')
  case "$v" in
    1|true|yes|on) return 1 ;;
  esac
  v=$(printf '%s' "${AMORE_UPDATE_CHECK:-1}" | tr '[:upper:]' '[:lower:]')
  case "$v" in
    0|false|no|off|disabled) return 1 ;;
  esac
  return 0
}

RELEASE_ORIGIN_HOST="github.com"
: > "$OUT/release-origin-ips.txt"
if egress_update_checks_enabled; then
  echo "update checks enabled: attributing ${RELEASE_ORIGIN_HOST} as release origin"
  getent ahosts "$RELEASE_ORIGIN_HOST" | awk '{print $1}' | sort -u \
    > "$OUT/release-origin-ips.txt" || true
else
  echo "update checks disabled: ${RELEASE_ORIGIN_HOST} is NOT an allowed class"
fi

# --- 3. One headless prompt under network strace. ----------------------------
echo "running one-shot prompt under strace..."
AMORE_HOME="$HOME_DIR" strace -f -e trace=network -o "$OUT/strace.log" \
  "$BIN" -p 'Reply with exactly: EGRESS-OK' > "$OUT/session-output.txt" 2>&1 || true
echo "session output tail:"
tail -3 "$OUT/session-output.txt" || true

# --- 4. Reduce + attribute (configured host + optional release origin). ------
# Extends egress_lib attribution with a named "release origin (github.com)"
# class when checks are enabled. When checks are off, github.com remains
# UNKNOWN if observed (kill-switch proof).
python3 - "$OUT" "$EGRESS_HOST" "$RELEASE_ORIGIN_HOST" <<'PY'
import ipaddress, re, subprocess, sys
out, host, release_host = sys.argv[1], sys.argv[2], sys.argv[3]
allowed = set(open(f"{out}/allowed-ips.txt").read().split())
try:
    r = subprocess.run(["getent", "ahosts", host], capture_output=True, text=True)
    allowed |= {l.split()[0] for l in r.stdout.splitlines() if l.split()}
except Exception:
    pass
release_ips = set()
try:
    release_ips = {l.strip() for l in open(f"{out}/release-origin-ips.txt") if l.strip()}
except FileNotFoundError:
    pass
# Re-resolve release host after the run when the allow-list is non-empty.
if release_ips:
    try:
        r = subprocess.run(["getent", "ahosts", release_host], capture_output=True, text=True)
        release_ips |= {l.split()[0] for l in r.stdout.splitlines() if l.split()}
    except Exception:
        pass

pat = re.compile(r'sin6?_addr=inet_pton\([^,]+, "([^"]+)"\)|sin_addr=inet_addr\("([^"]+)"\)')
port_pat = re.compile(r'sin6?_port=htons\((\d+)\)')
seen = {}
for line in open(f"{out}/strace.log", errors="replace"):
    if not any(k in line for k in ("connect(", "sendto(", "sendmsg(")):
        continue
    m = pat.search(line)
    if not m:
        continue
    ip = m.group(1) or m.group(2)
    pm = port_pat.search(line)
    port = pm.group(1) if pm else "?"
    seen.setdefault((ip, port), 0)
    seen[(ip, port)] += 1

unknown = []
print("\n=== remote endpoints the process tree touched ===")
for (ip, port), n in sorted(seen.items()):
    a = ipaddress.ip_address(ip)
    if a.is_loopback or a.is_unspecified:
        cls = "local"
    elif port == "53":
        cls = "DNS resolver"
    elif ip in allowed:
        cls = f"configured endpoint ({host})"
    elif ip in release_ips:
        cls = f"release origin ({release_host})"
    elif a.is_private:
        cls = "private/local network (DNS forwarder, proxy, or local infra)"
    else:
        cls = "UNKNOWN"
        unknown.append((ip, port))
    print(f"  {ip}:{port}  x{n}  -> {cls}")

if unknown:
    print(f"\nFAIL: {len(unknown)} unattributed endpoint(s): {unknown}")
    sys.exit(1)
print("\nPASS: every touched endpoint is the configured host, DNS, local plumbing, or disclosed release origin.")
PY
