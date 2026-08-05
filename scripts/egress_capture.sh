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

# --- 3. One headless prompt under network strace. ----------------------------
echo "running one-shot prompt under strace..."
AMORE_HOME="$HOME_DIR" strace -f -e trace=network -o "$OUT/strace.log" \
  "$BIN" -p 'Reply with exactly: EGRESS-OK' > "$OUT/session-output.txt" 2>&1 || true
echo "session output tail:"
tail -3 "$OUT/session-output.txt" || true

# --- 4. Reduce + attribute. --------------------------------------------------
egress_attribute_strace "$OUT" "$EGRESS_HOST"
