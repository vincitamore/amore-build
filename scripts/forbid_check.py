#!/usr/bin/env python3
"""Tier-1 forbid-list grep gate for the public-release campaign.

Walks a tree, reports every tier-1 hit as ``file:line: pattern``, exits 1
on any hit. Tier-2 patterns are reported as warnings only (exit unaffected).

List-file syntax: bare lines are case-sensitive exact substrings; lines
prefixed ``wb:`` are case-sensitive word-boundary matches
(``\\b`` + re.escape(body) + ``\\b``).

Stdlib-only, cross-platform (Windows / macOS / Linux).
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple

# Directories never entered (name match at any depth).
SKIP_DIR_NAMES = {
    ".git",
    "target",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
}

# Extensions treated as binary / non-text (skipped without open).
BINARY_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".bmp",
    ".pdf",
    ".zip",
    ".gz",
    ".tgz",
    ".bz2",
    ".xz",
    ".7z",
    ".rar",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".a",
    ".o",
    ".obj",
    ".lib",
    ".pdb",
    ".wasm",
    ".bin",
    ".dat",
    ".rlib",
    ".rmeta",
    ".ttf",
    ".otf",
    ".woff",
    ".woff2",
    ".eot",
    ".mp3",
    ".mp4",
    ".wav",
    ".ogg",
    ".webm",
    ".mov",
    ".avi",
    ".class",
    ".jar",
    ".pyc",
    ".pyo",
    ".pyd",
    ".node",
    ".lock",  # Cargo.lock / package-lock: huge; not a leak surface
}

# Basenames that *define* the patterns (must contain the strings; not leaks).
SELF_CATALOG_NAMES = {
    "forbid-list.txt",
    "forbid-list-release-gate.txt",
    "forbid-strip-map.txt",
}

# Tier-2 context-review strings (protocol). Warnings only; never fail the gate.
TIER2_PATTERNS: Tuple[str, ...] = (
    "opus",
    "steward",
    "grader",
    "exercise",
    "inbox subagent",
)


def repo_root_from_script() -> Path:
    """scripts/ lives one level under the product repo root."""
    return Path(__file__).resolve().parent.parent


# Prefix for word-boundary patterns in the list file (see forbid-list.txt header).
WB_PREFIX = "wb:"


@dataclass(frozen=True)
class Pattern:
    """One tier-1 rule.

    display: label printed in hit reports (preserves list-file spelling, e.g. wb:token).
    exact: non-None for substring mode (case-sensitive ``in``).
    regex: non-None for word-boundary mode (case-sensitive ``re.search``).
    """

    display: str
    exact: Optional[str] = None
    regex: Optional[re.Pattern[str]] = None

    def matches(self, line: str) -> bool:
        if self.exact is not None:
            return self.exact in line
        assert self.regex is not None
        return self.regex.search(line) is not None


def load_patterns(list_path: Path) -> List[Pattern]:
    """Load tier-1 patterns. ``wb:<text>`` → case-sensitive word-boundary regex;
    bare lines → case-sensitive exact substring."""
    patterns: List[Pattern] = []
    text = list_path.read_text(encoding="utf-8")
    for raw_lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith(WB_PREFIX):
            body = line[len(WB_PREFIX) :]
            if not body:
                print(
                    f"error: {list_path}:{raw_lineno}: empty pattern after {WB_PREFIX!r}",
                    file=sys.stderr,
                )
                sys.exit(2)
            # Case-sensitive: no re.IGNORECASE. Separate list lines for casings.
            rx = re.compile(r"\b" + re.escape(body) + r"\b")
            patterns.append(Pattern(display=line, regex=rx))
        else:
            patterns.append(Pattern(display=line, exact=line))
    return patterns


def is_probably_binary(path: Path, sample: bytes) -> bool:
    if path.suffix.lower() in BINARY_EXTENSIONS:
        return True
    if b"\x00" in sample:
        return True
    return False


def decode_text(data: bytes) -> str | None:
    for enc in ("utf-8", "utf-8-sig", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return None


def iter_text_files(root: Path) -> Iterable[Path]:
    root = root.resolve()
    if root.is_file():
        yield root
        return
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune in-place so os.walk does not descend.
        dirnames[:] = sorted(
            d for d in dirnames if d not in SKIP_DIR_NAMES and not d.startswith(".git")
        )
        for name in sorted(filenames):
            path = Path(dirpath) / name
            if path.suffix.lower() in BINARY_EXTENSIONS:
                continue
            yield path


def scan_file(
    path: Path, patterns: Sequence[Pattern]
) -> List[Tuple[int, str, str]]:
    """Return list of (line_no, pattern_display, line_text) hits."""
    try:
        raw = path.read_bytes()
    except (OSError, PermissionError) as exc:
        print(f"warn: cannot read {path}: {exc}", file=sys.stderr)
        return []

    # Cap giant files: sample first 8 KiB for binary sniff; still scan full if text.
    sample = raw[:8192]
    if is_probably_binary(path, sample):
        return []

    text = decode_text(raw)
    if text is None:
        return []

    hits: List[Tuple[int, str, str]] = []
    if not patterns:
        return hits

    for lineno, line in enumerate(text.splitlines(), start=1):
        for pat in patterns:
            if pat.matches(line):
                hits.append((lineno, pat.display, line))
    return hits


def patterns_from_exact_strings(strings: Sequence[str]) -> List[Pattern]:
    """Wrap bare strings as exact-substring patterns (tier-2, etc.)."""
    return [Pattern(display=s, exact=s) for s in strings if s]


def rel_display(path: Path, base: Path) -> str:
    try:
        return path.resolve().relative_to(base.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Report tier-1 forbid-list hits (exit 1 on any); tier-2 as warnings."
    )
    parser.add_argument(
        "--path",
        default=None,
        help="Directory (or file) to scan (default: repository root)",
    )
    parser.add_argument(
        "--list",
        default=None,
        dest="list_file",
        help="Tier-1 pattern list file (default: scripts/forbid-list.txt)",
    )
    parser.add_argument(
        "--no-tier2",
        action="store_true",
        help="Skip tier-2 warning scan",
    )
    args = parser.parse_args(argv)

    root = Path(args.path) if args.path else repo_root_from_script()
    list_path = (
        Path(args.list_file)
        if args.list_file
        else Path(__file__).resolve().parent / "forbid-list.txt"
    )

    if not list_path.is_file():
        print(f"error: pattern list not found: {list_path}", file=sys.stderr)
        return 2
    if not root.exists():
        print(f"error: path not found: {root}", file=sys.stderr)
        return 2

    patterns = load_patterns(list_path)
    if not patterns:
        print(f"error: no patterns loaded from {list_path}", file=sys.stderr)
        return 2

    base = root if root.is_dir() else root.parent
    # Prefer repo root for relative paths when scanning default tree.
    display_base = repo_root_from_script() if args.path is None else base

    tier1_hits: List[Tuple[str, int, str]] = []
    tier2_hits: List[Tuple[str, int, str]] = []
    tier2_patterns = (
        patterns_from_exact_strings(TIER2_PATTERNS) if not args.no_tier2 else []
    )

    list_resolved = list_path.resolve()
    files = list(iter_text_files(root))
    for path in files:
        # Skip pattern catalogs (the list under test + strip map): they define
        # the strings by necessity and are not product leaks.
        try:
            resolved = path.resolve()
        except OSError:
            resolved = path
        if resolved == list_resolved or path.name in SELF_CATALOG_NAMES:
            continue

        # Always scan tier-1.
        for lineno, pat, _line in scan_file(path, patterns):
            rel = rel_display(path, display_base)
            tier1_hits.append((rel, lineno, pat))
            print(f"{rel}:{lineno}: {pat}")

        if tier2_patterns:
            for lineno, pat, _line in scan_file(path, tier2_patterns):
                rel = rel_display(path, display_base)
                tier2_hits.append((rel, lineno, pat))

    print()
    print(f"tier-1 patterns: {len(patterns)}  files scanned: {len(files)}")
    print(f"tier-1 hits: {len(tier1_hits)}")

    if tier2_hits and not args.no_tier2:
        print()
        print("=== tier-2 warnings (context-review; exit unaffected) ===")
        for rel, lineno, pat in tier2_hits:
            print(f"{rel}:{lineno}: {pat}")
        print(f"tier-2 hits: {len(tier2_hits)}")

    if tier1_hits:
        print()
        print(f"FAIL: {len(tier1_hits)} tier-1 hit(s)")
        return 1

    print("OK: no tier-1 hits")
    return 0


if __name__ == "__main__":
    sys.exit(main())
