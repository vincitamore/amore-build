#!/usr/bin/env bash
# Lucerna dream-cycle egress capture: run one Lucerna dream cycle under the
# same strace-attribution harness as scripts/egress_capture.sh, and show that
# the process tree reaches only the operator's configured model endpoint
# (plus DNS and local plumbing).
#
# Method (audit in one sitting):
#
#   1. Scratch AMORE_HOME with exactly one [model.<entry>] block (copied from
#      an existing config). Lucerna inherits this via AMORE_HOME on the
#      spawned amore child.
#   2. Scratch house tree with lucerna.enable.json dreams on, auto-commit
#      dry-run (autoCommitLive false), and minimal house markers so Lucerna
#      can load.
#   3. Run `lucerna dream-cycle --force --dreams-enabled` under
#      `strace -f -e trace=network` so every connect/sendto/sendmsg in the
#      lucerna + amore process tree is recorded.
#   4. Attribute endpoints: configured host / DNS / local / UNKNOWN.
#      Nonzero exit on any UNKNOWN, or when the log shows no network touch
#      at all (incomplete for the model-endpoint claim).
#
# Usage:
#   scripts/lucerna_egress_capture.sh \
#     <lucerna-binary> <amore-binary> <source-config.toml> <model-entry> [outdir]
#
# Example:
#   scripts/lucerna_egress_capture.sh \
#     ~/.local/bin/lucerna ~/.local/bin/amore \
#     ~/.amore/config.toml deepseek-openrouter /tmp/lucerna-egress
#
# Linux only (strace). Non-Linux hosts exit 2 with an honest degrade message.
# Requires: bash, strace, getent, awk, python3.
#
# See also: scripts/egress_capture.sh (one-shot amore prompt), docs/egress.md.

set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=egress_lib.sh
. "$SCRIPT_DIR/egress_lib.sh"

LUCERNA_BIN=${1:?usage: lucerna_egress_capture.sh <lucerna-binary> <amore-binary> <source-config.toml> <model-entry> [outdir]}
AMORE_BIN=${2:?amore binary required}
SRC_CONFIG=${3:?source config.toml required}
ENTRY=${4:?model entry name required}
OUT=${5:-/tmp/lucerna-egress}

egress_require_linux_strace "lucerna dream-cycle egress capture"
[ -x "$LUCERNA_BIN" ] || egress_die "not executable: $LUCERNA_BIN"
[ -x "$AMORE_BIN" ] || egress_die "not executable: $AMORE_BIN"
[ -r "$SRC_CONFIG" ] || egress_die "unreadable: $SRC_CONFIG"

mkdir -p "$OUT"
HOME_DIR="$OUT/amore-home"
HOUSE_DIR="$OUT/house"
rm -rf "$HOME_DIR" "$HOUSE_DIR"
mkdir -p "$HOME_DIR" "$HOUSE_DIR/instruments/lucerna" "$HOUSE_DIR/forge/dreams" \
  "$HOUSE_DIR/inbox/captures" "$HOUSE_DIR/tasks"

# Minimal house markers so Lucerna resolves the tree.
printf '%s\n' "# Scratch house for egress capture" > "$HOUSE_DIR/AGENTS.md"
# Dreams enabled; live auto-commit stays off (dry-run default).
cat > "$HOUSE_DIR/instruments/lucerna/lucerna.enable.json" <<'JSON'
{
  "dreamsEnabled": true,
  "autoCommitLive": false
}
JSON

# --- 1. Scratch AMORE_HOME: one model entry only. ----------------------------
egress_write_scratch_config "$SRC_CONFIG" "$ENTRY" "$HOME_DIR/config.toml"
egress_read_base_host "$HOME_DIR/config.toml"

# --- 2. Resolve allowed IPs before the run. ----------------------------------
egress_resolve_allowed "$EGRESS_HOST" "$OUT/allowed-ips.txt"

# --- 3. One dream cycle under network strace. --------------------------------
# --force overrides cycle cooldown only; enablement comes from the file and
# --dreams-enabled. LUCERNA_AMORE_BIN pins the amore binary under test.
# AMORE_HOME forces the child harness to the scratch config.
echo "running lucerna dream-cycle under strace..."
# shellcheck disable=SC2034
AMORE_HOME="$HOME_DIR" \
LUCERNA_AMORE_BIN="$AMORE_BIN" \
LUCERNA_HOUSE_ROOT="$HOUSE_DIR" \
strace -f -e trace=network -o "$OUT/strace.log" \
  "$LUCERNA_BIN" dream-cycle --house "$HOUSE_DIR" --force --dreams-enabled \
  > "$OUT/session-output.txt" 2>&1 || true

echo "session output tail:"
tail -20 "$OUT/session-output.txt" || true
echo "---"
if [ -f "$HOUSE_DIR/instruments/lucerna/log" ]; then
  echo "lucerna log tail:"
  tail -10 "$HOUSE_DIR/instruments/lucerna/log" || true
fi

# --- 4. Reduce + attribute (require at least one network touch). -------------
egress_attribute_strace "$OUT" "$EGRESS_HOST" 1
