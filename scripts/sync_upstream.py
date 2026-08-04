#!/usr/bin/env python3
"""Arcus Build: upstream sync tooling.

Applies upstream xai-org/grok-build sync bundles to the fork with minimal
friction and a verifiable outcome. Policy is UPSTREAM.md: bundle-shaped
intake (whole "Synced from monorepo" commits, never cherry-picks),
thin-diff, rebase-rarely, refresh SOURCE_REV when the baseline moves.

Upstream's public tree publishes *sync-bundle commits*: bot-authored commits
titled "Synced from monorepo" with a `Source-Revision:` trailer naming the
internal monorepo SHA. Those bundle commits are the intake unit. The fork's
SOURCE_REV pin stores the *public sync-bundle SHA* (the last one the fork
merged), NOT upstream's internal monorepo SHA — the internal SHA is not a
fetchable git object and pinning it makes the pin unverifiable (the current
staleness).

Modes:
    --check          fetch upstream, report how far behind, what the newest
                     bundle contains; exit 0 always (informational).
    --apply          fetch, create sync/<sha> branch off HEAD, `git merge`
                     upstream/main (bundle-shaped intake). Refuses a dirty
                     tree. Never commits -- leaves the merge for review.
    --verify         run the post-merge checklist against the current tree
                     (works after --apply or after a manual merge).
    --update-pin     rewrite SOURCE_REV to upstream/main (only after a
                     verified merge; use --after <sha> to pin exactly).

Flags:
    --after <sha>    with --update-pin: pin SOURCE_REV to this public SHA
                     instead of current upstream/main.
    --dry-run        show what would happen; write/merge nothing.
    --no-fetch       don't fetch upstream first (use local remotes/upstream).

Windows: `py scripts/sync_upstream.py --check`. Unix: `python3 ...`.

The script is stdlib-only and CI-safe (no prompts, no writes except where a
mode explicitly mutates).
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SOURCE_REV_FILE = REPO / "SOURCE_REV"
UPSTREAM_REMOTE = "upstream"
UPSTREAM_MAIN = f"{UPSTREAM_REMOTE}/main"

# The fork's verify checklist keys on these being true after a rebase
# (UPSTREAM.md §6.4).
HARD_OFF_SENTINEL = "FORK_AUTO_UPDATE_HARD_OFF: bool = true"
HARD_OFF_FILE = "crates/codegen/xai-grok-update/src/auto_update.rs"
ARGV0_MARKER = '"arcus" | "arcus-build" | "grok" | "agent"'
ARGV0_FILE = "crates/codegen/xai-grok-pager/src/app/cli.rs"
INIT_OWNERSHIP_TEST = "crates/codegen/xai-grok-pager/tests/init_ownership.rs"
BOUNDARY_SCRIPT = "scripts/check_grok_boundary.py"

# User-visible branding deltas live in upstream pager files the boundary
# script cannot see (it scans only the fork-owned surface outside crates/).
# A sync merge that drops a `resolved_bin_name()` call site silently reverts
# the resume dialog / title bar to 'grok' with no build failure -- pin the
# sites here so the re-apply is gated, not remembered.
RESUMED_BIN_DEF = "pub fn resolved_bin_name"
RESUMED_BIN_FILE = "crates/codegen/xai-grok-pager/src/app/cli.rs"
RESUME_HINT_FILE = "crates/codegen/xai-grok-pager/src/app/mod.rs"
SCREEN_RELAUNCH_FILE = "crates/codegen/xai-grok-pager/src/app/screen_mode_relaunch.rs"
NOTIF_TITLE_FILE = "crates/codegen/xai-grok-pager/src/notifications/title.rs"
COMPLETIONS_FILE = "crates/codegen/xai-grok-pager/src/completions_cmd.rs"

# The doctor fix surface is runtime-coupled, not display-only: the managed
# namespace marker is written into user shell/tmux configs and read back, and
# the ssh alias body must name a binary that exists on the user's PATH. A
# merge that drops any of these silently reverts the namespace to `grok
# doctor` (stranding every arcus-written block) or re-breaks the ssh alias.
DOCTOR_FIX_FILE = "crates/codegen/xai-grok-pager/src/diagnostics/fix.rs"
MANAGED_TEXT_MOD = "crates/codegen/xai-grok-config/src/managed_text/mod.rs"
MANAGED_TEXT_FORMAT = "crates/codegen/xai-grok-config/src/managed_text/format.rs"


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, **kw)


def git(*args: str) -> subprocess.CompletedProcess:
    return run(["git", *args])


def fail(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


# --------------------------------------------------------------------------
# state helpers
# --------------------------------------------------------------------------

def is_dirty() -> bool:
    out = git("status", "--porcelain")
    return bool(out.stdout.strip())


def recorded_pin() -> str | None:
    """Read the last non-comment line of SOURCE_REV (the SHA). The file may
    carry a header comment; the pin is the final line."""
    try:
        lines = SOURCE_REV_FILE.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return None
    for line in reversed(lines):
        line = line.strip()
        if line and not line.startswith("#"):
            return line
    return None


def fetch_upstream() -> None:
    r = git("fetch", UPSTREAM_REMOTE)
    if r.returncode != 0:
        fail(f"git fetch {UPSTREAM_REMOTE} failed:\n{r.stderr.strip()}")


def upstream_head() -> str:
    r = git("rev-parse", UPSTREAM_MAIN)
    if r.returncode != 0:
        fail(f"{UPSTREAM_MAIN} not resolvable; run --check (fetches) first")
    return r.stdout.strip()


def fork_head() -> str:
    return git("rev-parse", "HEAD").stdout.strip()


def bundle_summary(sha: str) -> dict:
    """Extract title + Changes list + Source-Revision from a sync bundle."""
    out = git("show", "-s", "--format=%B", sha).stdout
    title = (out.strip().splitlines() or [""])[0]
    changes = []
    src_rev = None
    in_changes = False
    for line in out.splitlines():
        if line.startswith("Changes:"):
            in_changes = True
            continue
        if line.startswith("Source-Revision:"):
            src_rev = line.split(":", 1)[1].strip()
            in_changes = False
            continue
        if in_changes and line.strip().startswith("-"):
            changes.append(line.strip()[2:].strip())
    return {"title": title, "changes": changes, "source_revision": src_rev}


def behind_ahead() -> tuple[int, int]:
    r = git("rev-list", "--left-right", "--count", f"{UPSTREAM_MAIN}...HEAD")
    if r.returncode != 0:
        fail(f"rev-list failed: {r.stderr.strip()}")
    behind, ahead = r.stdout.split()
    return int(behind), int(ahead)


def is_sync_bundle(sha: str) -> bool:
    out = git("show", "-s", "--format=%B", sha).stdout
    return "Synced from monorepo" in out and "Source-Revision:" in out


# --------------------------------------------------------------------------
# modes
# --------------------------------------------------------------------------

def cmd_check(dry_run: bool, no_fetch: bool) -> int:
    if not no_fetch and not dry_run:
        fetch_upstream()
    elif not no_fetch and dry_run:
        print("[dry-run] would fetch upstream (skipped)")

    head = fork_head()
    pin = recorded_pin()
    try:
        up = upstream_head()
    except SystemExit:
        up = None

    print(f"fork HEAD          {head}")
    print(f"SOURCE_REV pin     {pin or '(none)'}")
    if up:
        print(f"upstream/main      {up}")
        behind, ahead = behind_ahead()
        print(f"fork is            {behind} behind, {ahead} ahead of upstream/main")
        if behind:
            newest = git("log", "-1", "--format=%H", UPSTREAM_MAIN).stdout.strip()
            if is_sync_bundle(newest):
                s = bundle_summary(newest)
                print(f"\nnewest upstream bundle: {newest}")
                print(f"  {s['title']}")
                if s["changes"]:
                    print("  changes:")
                    for c in s["changes"][:20]:
                        print(f"    - {c}")
                    if len(s["changes"]) > 20:
                        print(f"    ... and {len(s['changes']) - 20} more")
                if s["source_revision"]:
                    print(f"  source-revision: {s['source_revision']}")
        else:
            print("up to date with upstream/main")
        if pin and pin != up:
            print(f"\nnote: SOURCE_REV ({pin}) != upstream/main ({up}); "
                  "run --update-pin after a verified merge")
    else:
        print("(upstream/main not resolvable; run without --no-fetch)")

    if dry_run:
        print("\n[dry-run] nothing written")
    return 0


def cmd_apply(dry_run: bool, no_fetch: bool) -> int:
    if is_dirty():
        fail("working tree is dirty; commit or stash before --apply "
             "(a sync merge must be reviewable on its own)")
    if not no_fetch:
        fetch_upstream()

    up = upstream_head()
    branch = f"sync/{up[:12]}"
    existing = git("rev-parse", "--verify", branch).returncode == 0
    if existing:
        fail(f"branch {branch} already exists; delete or reuse it")

    if dry_run:
        print(f"[dry-run] would create branch {branch} off HEAD and merge "
              f"upstream/main ({up})")
        return 0

    if git("checkout", "-b", branch).returncode != 0:
        fail("could not create sync branch")
    r = git("merge", UPSTREAM_MAIN, "-m",
            f"sync: merge upstream {up[:12]} (bundle-shaped intake)")
    print(r.stdout.strip())
    if r.returncode != 0:
        print("\nmerge produced conflicts; resolve them, then run "
              "--verify, commit, and --update-pin", file=sys.stderr)
        print(r.stderr.strip(), file=sys.stderr)
        return 2
    print(f"\nmerged into {branch} (not committed). Next:")
    print("  1. python scripts/sync_upstream.py --verify")
    print("  2. re-apply the thin fork delta if the merge drifted it")
    print("  3. git commit (message: 'sync: merge upstream <sha>')")
    print("  4. python scripts/sync_upstream.py --update-pin")
    return 0


def _check_file_contains(path: str, needle: str, what: str, problems: list[str]) -> None:
    p = REPO / path
    if not p.exists():
        problems.append(f"MISSING {path} — cannot verify {what}")
        return
    text = p.read_text(encoding="utf-8", errors="replace")
    if needle in text:
        print(f"  ok  {what}")
    else:
        problems.append(f"{what}: {path} no longer contains '{needle}'")


def cmd_verify(dry_run: bool) -> int:
    problems: list[str] = []
    print("post-merge verify: fork surfaces")
    print("-" * 50)

    # 1. config-dir precedence: .arcus is the fork-native project root
    #    (read files directly -- git grep with quote-y patterns mangles under
    #    git-bash-on-Windows; plain substring checks are host-portable)
    arcus_load_sites = [
        "crates/codegen/xai-grok-agent/src/prompt/skills.rs",
        "crates/codegen/xai-grok-agent/src/discovery.rs",
        "crates/codegen/xai-grok-agent/src/plugins/discovery.rs",
    ]
    found_site = False
    for rel in arcus_load_sites:
        p = REPO / rel
        if p.exists() and '.arcus' in p.read_text(encoding="utf-8", errors="replace"):
            found_site = True
            break
    if found_site:
        print("  ok  .arcus is the fork-native project config root (agent load sites)")
    else:
        problems.append("no .arcus project-root load site found in agent crates")

    # 2. default home compiled in
    _check_file_contains(
        "crates/codegen/xai-grok-config/src/paths.rs",
        'join(".arcus")', "~/.arcus compiled-in default home", problems)

    # 3. binary/identity naming + argv0 aliases
    _check_file_contains(
        ARGV0_FILE, ARGV0_MARKER, "argv0 alias set (arcus | arcus-build | grok | agent)",
        problems)

    # 4. auto-update hard-off
    _check_file_contains(
        HARD_OFF_FILE, HARD_OFF_SENTINEL,
        "auto-update hard-off (FORK_AUTO_UPDATE_HARD_OFF = true)", problems)

    # 5. embed + init ownership tests still target arcus
    _check_file_contains(
        INIT_OWNERSHIP_TEST, "arcus init", "init ownership tests target `arcus init`",
        problems)

    # 6. fork-owned surface boundary (Phase-2 script, if present)
    if (REPO / BOUNDARY_SCRIPT).exists():
        r = run(["python", BOUNDARY_SCRIPT, "--check"])
        if r.returncode == 0:
            print("  ok  fork-surface grok boundary clean (check_grok_boundary.py)")
        else:
            problems.append("fork-surface grok boundary check failed:\n" + r.stdout)
    else:
        print("  --  check_grok_boundary.py absent; boundary check skipped")

    # 6b. user-visible branding deltas still channel through the single
    #     resolved_bin_name() source of truth (see constants above).
    _check_file_contains(
        RESUMED_BIN_FILE, RESUMED_BIN_DEF,
        "resolved_bin_name() defined in cli.rs", problems)
    _check_file_contains(
        RESUME_HINT_FILE, "cli::resolved_bin_name()",
        "resume hint + window title use resolved_bin_name()", problems)
    _check_file_contains(
        SCREEN_RELAUNCH_FILE, "resolved_bin_name()",
        "relaunch-failure hint uses resolved_bin_name()", problems)
    _check_file_contains(
        NOTIF_TITLE_FILE, "resolved_bin_name()",
        "notification title product name uses resolved_bin_name()", problems)
    _check_file_contains(
        COMPLETIONS_FILE, "resolved_bin_name()",
        "shell completions name after the invoked binary", problems)

    # 6c. doctor namespace migration (runtime-coupled, not display-only):
    #     the managed-config namespace is `arcus doctor` with grok-doctor
    #     legacy adoption, and the doctor/ssh-wrap command strings channel
    #     through the invoked binary name.
    _check_file_contains(
        DOCTOR_FIX_FILE, 'MANAGED_NAMESPACE: &str = "arcus doctor"',
        "managed shell/tmux blocks use the `arcus doctor` namespace", problems)
    _check_file_contains(
        DOCTOR_FIX_FILE, 'LEGACY_MANAGED_NAMESPACE: &str = "grok doctor"',
        "legacy `grok doctor` blocks are adopted (constant present)", problems)
    _check_file_contains(
        DOCTOR_FIX_FILE, "legacy_namespace: Some(LEGACY_MANAGED_NAMESPACE.to_owned())",
        "doctor fix requests wire legacy-namespace adoption", problems)
    _check_file_contains(
        DOCTOR_FIX_FILE, "NAME.get_or_init(crate::app::cli::resolved_bin_name)",
        "doctor command strings + ssh alias derive from resolved_bin_name()", problems)
    _check_file_contains(
        MANAGED_TEXT_MOD, "pub legacy_namespace: Option<String>",
        "ManagedConfigRequest carries legacy_namespace", problems)
    _check_file_contains(
        MANAGED_TEXT_FORMAT, "fn adopt_legacy_namespace",
        "managed_text adopts legacy-namespace blocks in plan", problems)

    # 7. build + smoke (this host). Build is the long pole; allow skipping.
    #    The full Linux pager suite remains CI-owned (UPSTREAM.md §5).
    if dry_run:
        print("[dry-run] would build xai-grok-pager-bin and smoke arcus")
    else:
        print("  .. building xai-grok-pager-bin (this can take a while)")
        b = run(["cargo", "build", "--release", "-p", "xai-grok-pager-bin"])
        if b.returncode != 0:
            problems.append("cargo build -p xai-grok-pager-bin failed:\n" + b.stderr[-2000:])
        else:
            print("  ok  cargo build -p xai-grok-pager-bin")
            exe = REPO / "target" / "release" / ("arcus.exe" if sys.platform == "win32" else "arcus")
            if exe.exists():
                v = run([str(exe), "--version"])
                print(f"  ok  {v.stdout.strip() or v.stderr.strip()}")
            else:
                problems.append(f"built binary not found at {exe}")

    print("-" * 50)
    if problems:
        print("FAILED checks:")
        for p in problems:
            print(f"  ! {p}")
        return 1
    print("all verify checks passed")
    return 0


def cmd_update_pin(dry_run: bool, after: str | None, no_fetch: bool) -> int:
    if is_dirty():
        fail("working tree is dirty; --update-pin should follow a committed merge")
    if not no_fetch:
        fetch_upstream()
    pin = after or upstream_head()
    if not re.fullmatch(r"[0-9a-f]{40}", pin):
        fail(f"not a full 40-hex SHA: {pin}")
    if dry_run:
        print(f"[dry-run] would write SOURCE_REV = {pin}")
        return 0

    # Preserve any header comment: replace only the last non-comment line so
    # the file keeps its provenance notes across pin moves.
    lines = SOURCE_REV_FILE.read_text(encoding="utf-8").splitlines()
    last_data = max((i for i, line in enumerate(lines)
                     if line.strip() and not line.strip().startswith("#")),
                    default=-1)
    if last_data >= 0:
        lines[last_data] = pin
        text = "\n".join(lines) + "\n"
    else:
        text = pin + "\n"
    SOURCE_REV_FILE.write_text(text, encoding="utf-8")
    print(f"SOURCE_REV -> {pin}")
    return 0


# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--update-pin", action="store_true")
    ap.add_argument("--after", metavar="SHA")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-fetch", action="store_true")
    args = ap.parse_args()

    modes = [m for m in ("check", "apply", "verify", "update_pin")
             if getattr(args, m)]
    if len(modes) != 1:
        ap.error("pick exactly one of --check / --apply / --verify / --update-pin")

    mode = modes[0]
    if mode == "check":
        return cmd_check(args.dry_run, args.no_fetch)
    if mode == "apply":
        return cmd_apply(args.dry_run, args.no_fetch)
    if mode == "verify":
        if args.no_fetch:
            print("note: --no-fetch is irrelevant to --verify; ignoring")
        return cmd_verify(args.dry_run)
    if mode == "update_pin":
        return cmd_update_pin(args.dry_run, args.after, args.no_fetch)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
