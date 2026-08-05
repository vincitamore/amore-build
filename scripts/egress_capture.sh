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
#      strace records every connect/sendto/sendmsg the process tree issues —
#      per-process ground truth, not a network-interface guess. A binary
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

set -euo pipefail

BIN=${1:?usage: egress_capture.sh <amore-binary> <source-config.toml> <model-entry> [outdir]}
SRC_CONFIG=${2:?source config.toml required}
ENTRY=${3:?model entry name required}
OUT=${4:-/tmp/amore-egress}

command -v strace >/dev/null || { echo "strace is required" >&2; exit 2; }
[ -x "$BIN" ] || { echo "not executable: $BIN" >&2; exit 2; }
[ -r "$SRC_CONFIG" ] || { echo "unreadable: $SRC_CONFIG" >&2; exit 2; }

mkdir -p "$OUT"
HOME_DIR="$OUT/home"
rm -rf "$HOME_DIR"
mkdir -p "$HOME_DIR"

# --- 1. Scratch home: extract exactly one [model.<entry>] block. -------------
# The secret stays file-to-file; nothing is echoed.
python3 - "$SRC_CONFIG" "$ENTRY" "$HOME_DIR/config.toml" <<'PY'
import sys, re
src, entry, dst = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(src, encoding="utf-8").read()
m = re.search(rf'^\[model\.{re.escape(entry)}\]\n(?:(?!^\[).*\n?)*', text, re.M)
if not m:
    sys.exit(f"model entry [model.{entry}] not found in {src}")
block = m.group(0).rstrip() + "\n"
with open(dst, "w", encoding="utf-8", newline="\n") as f:
    f.write("[models]\n")
    f.write(f'default = "{entry}"\n\n')
    f.write(block)
print(f"scratch config written: 1 model entry ({entry})")
PY

BASE_URL=$(awk -F'"' '/^base_url/ {print $2; exit}' "$HOME_DIR/config.toml")
HOST=$(printf '%s' "$BASE_URL" | sed -E 's#^[a-z]+://##; s#[/:].*$##')
echo "configured endpoint: $HOST ($BASE_URL)"

# --- 2. Resolve the allowed set BEFORE the run. ------------------------------
getent ahosts "$HOST" | awk '{print $1}' | sort -u > "$OUT/allowed-ips.txt"
echo "resolved $(wc -l < "$OUT/allowed-ips.txt") addresses for $HOST"

# --- 3. One headless prompt under network strace. ----------------------------
echo "running one-shot prompt under strace..."
AMORE_HOME="$HOME_DIR" strace -f -e trace=network -o "$OUT/strace.log" \
  "$BIN" -p 'Reply with exactly: EGRESS-OK' > "$OUT/session-output.txt" 2>&1 || true
echo "session output tail:"
tail -3 "$OUT/session-output.txt" || true

# --- 4. Reduce + attribute. --------------------------------------------------
# Endpoints the tracee asked for: connect() and sendto()/sendmsg() sockaddrs.
python3 - "$OUT" "$HOST" <<'PY'
import re, subprocess, sys, ipaddress
out, host = sys.argv[1], sys.argv[2]
allowed = set(open(f"{out}/allowed-ips.txt").read().split())
# Re-resolve after the run too: CDN rotation between resolve and connect is
# the common false-UNKNOWN, so the allowed set is the union of both looks.
try:
    r = subprocess.run(["getent", "ahosts", host], capture_output=True, text=True)
    allowed |= {l.split()[0] for l in r.stdout.splitlines() if l.split()}
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
    elif a.is_private:
        cls = "private/local network (DNS forwarder, proxy, or local infra)"
    else:
        cls = "UNKNOWN"
        unknown.append((ip, port))
    print(f"  {ip}:{port}  x{n}  -> {cls}")

if unknown:
    print(f"\nFAIL: {len(unknown)} unattributed endpoint(s): {unknown}")
    sys.exit(1)
print("\nPASS: every touched endpoint is the configured host, DNS, or local plumbing.")
PY
