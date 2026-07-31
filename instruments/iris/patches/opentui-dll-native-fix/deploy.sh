#!/usr/bin/env bash
# Deploy the natively-patched opentui.dll over the pnpm store prebuilt.
# WHY (three cumulative fixes; source diff ../opentui-dll-native-fix.yoga.zig.patch,
# built from github.com/sst/opentui @ v0.4.2 / 3e2d0aab with zig 0.15.2, ReleaseFast;
# build tree kept at a local checkout of github.com/sst/opentui):
#   v1: frees deferred while a layout walk is on the stack (JS-reentrancy teardown race).
#   v2: CallbackContexts never destroyed, fields neutralized (Yoga-3 clones share the ptr).
#   v3: DEP-execute guard - internalMeasureFunc/internalDirtiedFunc VirtualQuery the
#       trampoline page before calling; non-executable -> skip + capped stderr note
#       ("[opentui-guard] ..." + prot/allocBase/regionSize lands in tui-crash.log).
#   v4: guard trip replays the node's LAST cached measure size instead of NaN (NaN made
#       Yoga spam "invalid dimension" warnings to STDOUT - screen-corrupting in a TUI;
#       live-exhibited 2026-07-02). Field basis: dump #3 proved a
#       LIVE node/context holding an intact Bun trampoline whose page lost executability
#       (Bun-internal page-protection churn, not an opentui lifecycle bug).
#
# RE-RUN THIS AFTER ANY `pnpm install` in instruments/vitrum - pnpm may restore
# the prebuilt from its content-addressable store. Symbols: the matching
# opentui.pdb lives at ~/.iris/tools/opentui-patched.pdb (machine-local).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE="$HERE/../../node_modules/.pnpm/@opentui+core-win32-x64@0.4.2/node_modules/@opentui/core-win32-x64"
if [ ! -d "$STORE" ]; then echo "store dir not found: $STORE" >&2; exit 1; fi
[ -f "$STORE/opentui.dll.prebuilt-orig" ] || cp "$STORE/opentui.dll" "$STORE/opentui.dll.prebuilt-orig"
cp "$HERE/opentui.dll" "$STORE/opentui.dll"
echo "patched opentui.dll deployed -> $STORE"
