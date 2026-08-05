#!/usr/bin/env bash
# Shared helpers for Amore Build egress capture scripts.
# Source this file; do not execute it directly.
#
# Conventions shared by scripts/egress_capture.sh and
# scripts/lucerna_egress_capture.sh:
#   - Linux + strace for syscall-level capture
#   - Scratch AMORE_HOME with exactly one [model.<entry>] block
#   - Attribute connect/sendto/sendmsg destinations: configured host,
#     DNS, local/private plumbing, or UNKNOWN (nonzero exit on UNKNOWN)

# shellcheck shell=bash

egress_die() {
  echo "$*" >&2
  exit 2
}

# Exit 2 with a plain message on non-Linux or when strace is missing.
# Callers may pass a second line of context (for example the script purpose).
egress_require_linux_strace() {
  local context=${1:-egress capture}
  local uname_s
  uname_s=$(uname -s 2>/dev/null || echo unknown)
  if [ "$uname_s" != "Linux" ]; then
    cat >&2 <<EOF
Linux + strace is required for $context.
This host reports: $uname_s.
The capture method is not portable: non-Linux hosts degrade here without
pretending to attribute network traffic. Run the script on a Linux box
(or container) that has strace, getent, awk, and python3.
EOF
    exit 2
  fi
  command -v strace >/dev/null 2>&1 || egress_die "strace is required for $context"
  command -v python3 >/dev/null 2>&1 || egress_die "python3 is required for $context"
  command -v getent >/dev/null 2>&1 || egress_die "getent is required for $context"
  command -v awk >/dev/null 2>&1 || egress_die "awk is required for $context"
}

# Write a scratch config.toml containing only [models] default + one model block.
# Args: source_config model_entry dest_config
egress_write_scratch_config() {
  local src=$1 entry=$2 dst=$3
  python3 - "$src" "$entry" "$dst" <<'PY'
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
}

# Print the host name from a config.toml base_url field (first match).
# Args: config_path
# Sets globals: EGRESS_BASE_URL EGRESS_HOST when sourced under set -a patterns
# are avoided; callers capture stdout of the host line via this helper instead.
egress_read_base_host() {
  local config=$1
  EGRESS_BASE_URL=$(awk -F'"' '/^base_url/ {print $2; exit}' "$config")
  if [ -z "${EGRESS_BASE_URL:-}" ]; then
    egress_die "no base_url found in scratch config: $config"
  fi
  EGRESS_HOST=$(printf '%s' "$EGRESS_BASE_URL" | sed -E 's#^[a-z]+://##; s#[/:].*$##')
  if [ -z "${EGRESS_HOST:-}" ]; then
    egress_die "could not parse host from base_url: $EGRESS_BASE_URL"
  fi
  echo "configured endpoint: $EGRESS_HOST ($EGRESS_BASE_URL)"
}

# Resolve host to allowed IPs (pre-run look). Args: host out_file
egress_resolve_allowed() {
  local host=$1 out_file=$2
  getent ahosts "$host" | awk '{print $1}' | sort -u > "$out_file"
  echo "resolved $(wc -l < "$out_file") addresses for $host"
}

# Attribute every remote endpoint in an strace network log.
# Args: outdir configured_host [require_network]
#   require_network: if "1", exit 1 when the log has no network endpoints
#   (used by lucerna dream-cycle capture so a silent refuse is not a PASS).
# Exit 1 if any UNKNOWN endpoint remains; 0 on full attribution.
egress_attribute_strace() {
  local out=$1 host=$2 require_network=${3:-0}
  python3 - "$out" "$host" "$require_network" <<'PY'
import re, subprocess, sys, ipaddress
out, host, require_network = sys.argv[1], sys.argv[2], sys.argv[3]
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
if not seen and require_network == "1":
    print("\nFAIL: no connect/sendto/sendmsg endpoints observed in the strace log.")
    print("A dream cycle that never reaches the network cannot support the")
    print("model-endpoint claim (dreams disabled, missing binary, or refuse")
    print("before spawn). Inspect session-output.txt and the lucerna log.")
    sys.exit(1)
print("\nPASS: every touched endpoint is the configured host, DNS, or local plumbing.")
PY
}
