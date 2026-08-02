#!/usr/bin/env python3
"""Arcus Build fork: enforce the grok-mention boundary.

The fork is a perpetual friendly fork of xAI's Grok Build. Most `grok`
mentions in the tree are *upstream substrate* and must never be renamed:
crate ids (`xai-grok-*`), `~/.grok` paths, `GROK_*` env vars, the `grok`
model name, and provenance/attribution text. Renaming those would turn every
upstream sync into a conflict storm (see UPSTREAM.md §4: "Do not rename
xai-grok-* for branding").

This script scans the *fork-owned surface* (everything outside crates/,
third_party/, prod/) and reports grok mentions that are not on the allow-list
below. An allow-listed mention is one of:

- crate references: `xai-grok-*` / `xai_grok_*`
- legacy config: `.grok`, `$GROK_HOME`, `GROK_*` env names
- upstream provenance: `grok-build`, `xai-org/grok-build`, "Grok Build"
- the model rail: `grok-4.5`, `[model.grok-native]`, "grok native",
  `grok-cli:access` (OAuth scope), `grok.com`
- theme attribution: `groknight` / `grokday` (xAI original, THIRD-PARTY-NOTICES)

Anything else in the fork-owned surface is *stray product-name drift* — a
user-visible string or doc that still names the upstream product where the
fork identity should appear.

Modes:
    --scan    print the stratified survey (counts per layer) and the flagged
              lines; exit 0 regardless (informational).
    --check   exit 1 if any stray mention is found, 0 otherwise. For CI.
    --json    emit machine-readable output (with --scan/--check).

    python scripts/check_grok_boundary.py --scan
    python scripts/check_grok_boundary.py --check

Deliberately stdlib-only (re, pathlib, argparse, json) so it runs without
toolchain ceremony on any host. Windows: `py scripts/...`; unix: `python3`.

The house tree (`arcus/`) is NOT scanned: its `.grok`/`--grok-compat` mentions
are the documented legacy-fallback lane and are linted by the house's own
`scripts/house_lint.ts` / `sync_orientation_rules.py --check`.
"""

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Layers that are upstream substrate / vendored / legacy. Never flagged,
# never renamed. These are the merge seam.
SUBSTRATE_DIRS = ("crates", "third_party", "prod")

# The fork-owned surface: everything else. Scanned for stray mentions.
SCAN_EXCLUDES = {
    ".git", "target", "node_modules", ".sweep-scratch",
}
# Scripts whose whole job is describing the grok boundary. They mention the
# word in self-documenting prose (docstrings, the allowed list itself) and
# are the wrong place to look for product-name drift. Scanned by hand;
# exempted here.
SELF_DOC = {"scripts/check_grok_boundary.py", "scripts/sync_upstream.py"}
# Files that are build/packaging metadata or binary-ish; grok there is always
# upstream names (Cargo.toml dependency paths, lockfiles) or intentional.
SCAN_SKIP_NAMES = {"Cargo.lock", "Cargo.toml", "package-lock.json", "bun.lock"}
# Binary asset extensions.
BINARY_EXT = {".png", ".ttf", ".tmtheme", ".woff", ".woff2", ".ico", ".otf"}

WORD = re.compile(r"\bgrok\b", re.IGNORECASE)

# Tokens that are legitimately part of the fork surface. The boundary check
# passes when every mention in a line is covered by one of these.
ALLOWED = [
    r"xai-grok-", r"xai_grok_",          # crate references
    r"\.grok", r"GROK_HOME", r"GROK_",   # legacy config surface (env + dirs)
    r"grok-build", r"grok_build",        # upstream provenance
    r"Grok Build",                       # upstream product name in prose
    r"grok-4\.5", r"grok-4",             # the model name
    r"\[model\.grok-native\]",           # config key
    r"grok native", r"grok-native",      # the second rail
    r"grok-cli:access",                  # OAuth scope (protocol)
    r"grok\.com",                        # relay host
    r"groknight", r"grokday",            # theme names (attribution)
    # The model rail, named variously in prose. `grok-4.5` / `grok-4` are the
    # model; "native grok", "grok freight", "Grok rail", "grok subagent" name
    # the second (native xAI) rail the fork documents. These are model/protocol
    # names, not product branding.
    r"native grok", r"grok freight", r"grok subagent", r"grok rail",
    r"Grok rail", r"xAI grok", r"xAI's grok", r"grok headless",
    r"argv0 also tolerates",           # the documented multi-call alias list
    r"\bgrok\b, and `agent`",          # argv0 alias tail (README/UPSTREAM)
    r"tolerates `arcus-build`, `grok`",
    r"grok-4\.5",                      # model name (covers "Grok 4.5")
]
ALLOWED_RE = re.compile("|".join(f"(?:{p})" for p in ALLOWED), re.IGNORECASE)

# Explicitly-reviewed exceptions: (file, content-signature) pairs whose
# lowercase `grok` mentions are intentional and documented here. Signatures
# are line-content fragments (case-insensitive) rather than line numbers, so
# an edit that shifts lines by a few does not false-positive. Add to this
# list only with a reason; it is the human-sign-off surface of the boundary.
# (A line already covered by an allow token or the proper-noun/compat-lane
# rules does not need an entry.)
REVIEWED_EXCEPTIONS = [
    # argv0 alias list: `grok` is the documented multi-call legacy alias the
    # binary still tolerates (DEFAULT_BIN_NAME logic in app/cli.rs).
    ("README.md", "argv0 also tolerates `arcus-build`, `grok`, and `agent`"),
    ("UPSTREAM.md", "argv0 also tolerates `arcus-build`, `grok`, `agent`"),
    # Prose that names upstream's own spelling while contrasting it with the
    # fork home — describing the legacy brand, not using it as the product.
    ("README.md", "upstream brand spellings (`grok` / `~/.grok`)"),
    ("docs/setup-glm.md", "upstream brand paths may still say `~/.grok` / `grok`"),
    # UPSTREAM.md documents the boundary tooling itself: "grok boundary",
    # "grok mentions" are prose about the check, not product-name drift.
    ("UPSTREAM.md", "fork-surface grok boundary is enforced by"),
    ("UPSTREAM.md", "which `grok` mentions are"),
]


def _compat_lane(line: str) -> bool:
    """True when a line is about the *compat lane* (upstream-grok-format
    trees): a `.grok/` path, a `grok-` prefixed flag/token, or the literal
    `grok-compat`. Those are the documented legacy-fallback pattern in house
    scripts (sync_orientation_rules.py --grok-compat, house_lint.ts), not
    product-name drift. Decided per line, not by token, because tokens like
    `grok in` are prose-fragile.
    """
    low = line.lower()
    return (
        ".grok/" in low
        or "grok-" in low
        or "grok_compat" in low
        or "grok-compat" in low
        or "--grok" in low
    )


def _proper_noun(line: str) -> bool:
    """True when every grok mention in the line is the capitalized proper
    noun "Grok" — the model name ("Grok 4.5"), the trademark line, or the
    upstream product in prose. Lowercase `grok` in the fork-owned surface is
    the drift signal; capitalized Grok-as-proper-noun is legitimate. Mixed
    lines (a lowercase mention alongside a proper noun) are not exempted.
    """
    if not WORD.search(line):
        return True
    low = line.lower()
    rest = re.sub(r"\bGrok\b", "", line)
    return not WORD.search(rest) and "grok" in low


def is_skipped(path: Path) -> bool:
    rel = path.relative_to(REPO)
    parts = rel.parts
    if any(p in SCAN_EXCLUDES for p in parts):
        return True
    if path.name in SCAN_SKIP_NAMES:
        return True
    if path.suffix.lower() in BINARY_EXT:
        return True
    if rel.as_posix() in SELF_DOC:
        return True
    return False


def surface_files():
    for p in sorted(REPO.rglob("*")):
        if not p.is_file() or is_skipped(p):
            continue
        rel = p.relative_to(REPO)
        if rel.parts[0] in SUBSTRATE_DIRS:
            continue
        yield p


def read_text(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return p.read_text(encoding="utf-8", errors="replace")


def _reviewed_exception(rel: str, line: str) -> bool:
    low = line.lower()
    return any(rel == f and sig.lower() in low for f, sig in REVIEWED_EXCEPTIONS)


def scan_surface():
    """Return {path: [line_no, ...]} for stray grok mentions in the surface."""
    findings = {}
    for p in surface_files():
        text = read_text(p)
        rel = p.relative_to(REPO).as_posix()
        bad_lines = []
        for i, line in enumerate(text.splitlines(), 1):
            if not WORD.search(line):
                continue
            # A line passes if every grok mention is covered by an allow token,
            # the line is about the compat lane, every mention is the
            # capitalized proper noun (model / trademark / upstream product),
            # or the line is an explicitly-reviewed exception.
            stripped = ALLOWED_RE.sub(" ", line)
            if (WORD.search(stripped) and not _compat_lane(line)
                    and not _proper_noun(line)
                    and not _reviewed_exception(rel, line)):
                bad_lines.append(i)
        if bad_lines:
            findings[rel] = bad_lines
    return findings


def stratified_counts():
    """Reproduce the survey: {layer: {files, mentions}} for all layers."""
    counts = {
        "crates": {"files": 0, "mentions": 0},
        "third_party+prod": {"files": 0, "mentions": 0},
        "fork-owned-surface": {"files": 0, "mentions": 0},
    }
    for p in sorted(REPO.rglob("*")):
        if not p.is_file() or is_skipped(p):
            continue
        rel = p.relative_to(REPO)
        top = rel.parts[0]
        n = len(WORD.findall(read_text(p)))
        if not n:
            continue
        if top in ("crates",):
            layer = "crates"
        elif top in ("third_party", "prod"):
            layer = "third_party+prod"
        else:
            layer = "fork-owned-surface"
        counts[layer]["files"] += 1
        counts[layer]["mentions"] += n
    return counts


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--scan", action="store_true", help="print stratified survey + findings, exit 0")
    ap.add_argument("--check", action="store_true", help="exit 1 if stray mentions exist, else 0")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    if not (args.scan or args.check):
        args.scan = True  # default: informational scan

    strata = stratified_counts()
    findings = scan_surface()

    if args.json:
        out = {
            "strata": strata,
            "stray_files": findings,
            "stray_total_lines": sum(len(v) for v in findings.values()),
        }
        print(json.dumps(out, indent=2))
    else:
        print("grok mention survey (fork-owned surface vs upstream substrate)")
        print("=" * 70)
        for layer, c in strata.items():
            print(f"  {layer:<20} {c['files']:>5} files  {c['mentions']:>6} mentions")
        print("=" * 70)
        if findings:
            print(f"\nSTRAY mentions in fork-owned surface "
                  f"({sum(len(v) for v in findings.values())} lines, "
                  f"{len(findings)} files):")
            for path, lines in findings.items():
                print(f"  {path}: lines {', '.join(str(n) for n in lines)}")
        else:
            print("\nfork-owned surface clean: every grok mention is "
                  "allow-listed (crate ref / legacy config / provenance / "
                  "model name).")

    if args.check:
        return 1 if findings else 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
