#!/usr/bin/env python3
"""Campaign porting utility: ordered find→replace under templates/ only.

Reads substitutions from scripts/forbid-strip-map.txt.
Default mode is --dry-run (report only). Pass --apply to rewrite files.

Stdlib-only, cross-platform.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import List, Sequence, Tuple

# Never rewrite outside this tree (relative to repo root).
ALLOWED_ROOT_NAME = "templates"

SKIP_DIR_NAMES = {
    ".git",
    "target",
    "node_modules",
    "__pycache__",
}


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parent.parent


def load_map(map_path: Path) -> List[Tuple[str, str]]:
    """Load ordered (find, replace) pairs."""
    pairs: List[Tuple[str, str]] = []
    text = map_path.read_text(encoding="utf-8")
    for raw_lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "\t" in raw:
            # Prefer TAB split on the raw (un-stripped) line for fidelity,
            # but trim each side.
            left, right = raw.split("\t", 1)
            find, repl = left.strip(), right.strip()
        elif " => " in line:
            find, repl = line.split(" => ", 1)
            find, repl = find.strip(), repl.strip()
        else:
            print(
                f"error: {map_path}:{raw_lineno}: expected 'find<TAB>replace' "
                f"or 'find => replace', got: {raw!r}",
                file=sys.stderr,
            )
            sys.exit(2)
        if not find:
            print(
                f"error: {map_path}:{raw_lineno}: empty find pattern",
                file=sys.stderr,
            )
            sys.exit(2)
        pairs.append((find, repl))
    return pairs


def iter_text_files(root: Path) -> List[Path]:
    out: List[Path] = []
    if root.is_file():
        return [root]
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIR_NAMES)
        for name in sorted(filenames):
            path = Path(dirpath) / name
            # Skip obvious binaries by extension.
            if path.suffix.lower() in {
                ".png",
                ".jpg",
                ".jpeg",
                ".gif",
                ".webp",
                ".ico",
                ".pdf",
                ".exe",
                ".dll",
                ".so",
                ".dylib",
                ".pyc",
                ".woff",
                ".woff2",
                ".ttf",
            }:
                continue
            out.append(path)
    return out


def apply_subs(text: str, pairs: Sequence[Tuple[str, str]]) -> Tuple[str, List[Tuple[str, int]]]:
    """Apply substitutions in order. Returns (new_text, [(find, count), ...])."""
    counts: List[Tuple[str, int]] = []
    for find, repl in pairs:
        n = text.count(find)
        if n:
            text = text.replace(find, repl)
        counts.append((find, n))
    return text, counts


def ensure_under_templates(path: Path, repo_root: Path) -> Path:
    """Resolve path and require it stays under repo_root/templates/."""
    allowed = (repo_root / ALLOWED_ROOT_NAME).resolve()
    resolved = path.resolve()
    if resolved == allowed or allowed in resolved.parents or resolved == allowed:
        return resolved
    # Also allow path that is templates itself via relative.
    try:
        resolved.relative_to(allowed)
        return resolved
    except ValueError:
        pass
    print(
        f"error: refuse to touch path outside templates/: {path} "
        f"(allowed root: {allowed})",
        file=sys.stderr,
    )
    sys.exit(2)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Ordered find→replace under templates/ only. "
            "Default is --dry-run; pass --apply to rewrite."
        )
    )
    parser.add_argument(
        "--path",
        default=None,
        help="Subtree under templates/ to process (default: <repo>/templates)",
    )
    parser.add_argument(
        "--map",
        default=None,
        dest="map_file",
        help="Substitution map file (default: scripts/forbid-strip-map.txt)",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run",
        action="store_true",
        default=True,
        help="Report planned rewrites without writing (default)",
    )
    mode.add_argument(
        "--apply",
        action="store_true",
        help="Rewrite files in place",
    )
    args = parser.parse_args(argv)

    # argparse mutual exclusive with dry-run default True is awkward when
    # --apply is set: clear dry-run.
    do_apply = bool(args.apply)
    dry_run = not do_apply

    repo_root = repo_root_from_script()
    map_path = (
        Path(args.map_file)
        if args.map_file
        else Path(__file__).resolve().parent / "forbid-strip-map.txt"
    )
    if not map_path.is_file():
        print(f"error: map file not found: {map_path}", file=sys.stderr)
        return 2

    pairs = load_map(map_path)
    if not pairs:
        print(f"error: no substitutions loaded from {map_path}", file=sys.stderr)
        return 2

    if args.path:
        target = ensure_under_templates(Path(args.path), repo_root)
    else:
        target = ensure_under_templates(repo_root / ALLOWED_ROOT_NAME, repo_root)

    if not target.exists():
        # templates/ may be empty / missing early in campaign — not a hard error
        # if the directory is simply absent; report and succeed.
        print(f"warn: path does not exist: {target}", file=sys.stderr)
        print("OK: nothing to strip")
        return 0

    files = iter_text_files(target)
    total_subs = 0
    files_touched = 0

    mode_label = "APPLY" if do_apply else "DRY-RUN"
    print(f"forbid_strip.py [{mode_label}]  map={map_path.name}  path={target}")
    print(f"rules: {len(pairs)}  files: {len(files)}")

    for path in files:
        try:
            original = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            try:
                original = path.read_text(encoding="latin-1")
            except OSError as exc:
                print(f"warn: skip {path}: {exc}", file=sys.stderr)
                continue
        except OSError as exc:
            print(f"warn: skip {path}: {exc}", file=sys.stderr)
            continue

        new_text, counts = apply_subs(original, pairs)
        file_hits = [(f, n) for f, n in counts if n]
        if not file_hits:
            continue

        files_touched += 1
        try:
            rel = path.resolve().relative_to(repo_root.resolve()).as_posix()
        except ValueError:
            rel = path.as_posix()

        for find, n in file_hits:
            total_subs += n
            print(f"  {rel}: {n}× {find!r}")

        if do_apply and new_text != original:
            path.write_text(new_text, encoding="utf-8", newline="\n")

    print()
    print(f"files with hits: {files_touched}  substitutions: {total_subs}")
    if dry_run:
        print("DRY-RUN: no files written (pass --apply to rewrite)")
    else:
        print("APPLY: rewrites complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
