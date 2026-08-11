#!/usr/bin/env python3
"""Amore Build: upstream sync tooling.

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
ARGV0_MARKER = '"amore" | "amore-build" | "grok" | "agent"'
ARGV0_FILE = "crates/codegen/xai-grok-pager/src/app/cli.rs"
INIT_OWNERSHIP_TEST = "crates/codegen/xai-grok-pager/tests/init_ownership.rs"
BOUNDARY_SCRIPT = "scripts/check_grok_boundary.py"
HYGIENE_SCRIPT = "scripts/check_source_hygiene.py"

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
# doctor` (stranding every amore-written block) or re-breaks the ssh alias.
DOCTOR_FIX_FILE = "crates/codegen/xai-grok-pager/src/diagnostics/fix.rs"
MANAGED_TEXT_MOD = "crates/codegen/xai-grok-config/src/managed_text/mod.rs"
MANAGED_TEXT_FORMAT = "crates/codegen/xai-grok-config/src/managed_text/format.rs"

# Instrument companions (iris default-on; lucerna/speculum opt-in): init flags,
# shared fetch/release-asset contract, doctor registration, and CI/release
# lanes. An upstream merge that drops these silently reverts companion install
# and doctor coverage — pin the re-apply surface here.
INIT_CMD_FILE = "crates/codegen/xai-grok-pager/src/init_cmd/mod.rs"
INSTRUMENT_FETCH_FILE = "crates/codegen/xai-grok-pager/src/init_cmd/instrument_fetch.rs"
INSTRUMENTS_DIAG_FILE = "crates/codegen/xai-grok-pager/src/diagnostics/instruments.rs"
INSTRUMENTS_DIAG_MOD = "crates/codegen/xai-grok-pager/src/diagnostics/mod.rs"
DOCTOR_CMD_FILE = "crates/codegen/xai-grok-pager/src/doctor_cmd/mod.rs"
RELEASE_WORKFLOW = ".github/workflows/release.yml"
INSTRUMENTS_CI_WORKFLOW = ".github/workflows/instruments-ci.yml"
RELEASE_BASE_NEEDLE = "vincitamore/amore-build"


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

    # 1. config-dir precedence: .amore is the fork-native project root
    #    (read files directly -- git grep with quote-y patterns mangles under
    #    git-bash-on-Windows; plain substring checks are host-portable)
    amore_load_sites = [
        "crates/codegen/xai-grok-agent/src/prompt/skills.rs",
        "crates/codegen/xai-grok-agent/src/discovery.rs",
        "crates/codegen/xai-grok-agent/src/plugins/discovery.rs",
    ]
    found_site = False
    for rel in amore_load_sites:
        p = REPO / rel
        if p.exists() and '.amore' in p.read_text(encoding="utf-8", errors="replace"):
            found_site = True
            break
    if found_site:
        print("  ok  .amore is the fork-native project config root (agent load sites)")
    else:
        problems.append("no .amore project-root load site found in agent crates")

    # 2. default home compiled in
    _check_file_contains(
        "crates/codegen/xai-grok-config/src/paths.rs",
        'join(".amore")', "~/.amore compiled-in default home", problems)

    # 3. binary/identity naming + argv0 aliases
    _check_file_contains(
        ARGV0_FILE, ARGV0_MARKER, "argv0 alias set (amore | amore-build | grok | agent)",
        problems)

    # 4. auto-update hard-off: constant + enforcement (funnel + call-site guards)
    _check_file_contains(
        HARD_OFF_FILE, HARD_OFF_SENTINEL,
        "upstream update origins remain unreachable (constant + enforcement)", problems)
    _check_file_contains(
        HARD_OFF_FILE,
        "fork: upstream installers are unreachable (FORK_AUTO_UPDATE_HARD_OFF)",
        "upstream update origins remain unreachable (constant + enforcement)", problems)
    _check_file_contains(
        HARD_OFF_FILE,
        "fork guard: ensure_latest_on_disk stays inert",
        "upstream update origins remain unreachable (constant + enforcement)", problems)
    _check_file_contains(
        HARD_OFF_FILE,
        "fork guard: run_update_if_available stays inert",
        "upstream update origins remain unreachable (constant + enforcement)", problems)
    _check_file_contains(
        HARD_OFF_FILE,
        "fork guard: run_update stays inert",
        "upstream update origins remain unreachable (constant + enforcement)", problems)

    # 5. embed + init ownership tests still target amore
    _check_file_contains(
        INIT_OWNERSHIP_TEST, "amore init", "init ownership tests target `amore init`",
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

    # 6a. public source-hygiene: process language out of instruments/ + templates/
    if (REPO / HYGIENE_SCRIPT).exists():
        r = run(["python", HYGIENE_SCRIPT, "--check"])
        if r.returncode == 0:
            print("  ok  source-hygiene clean (check_source_hygiene.py)")
        else:
            problems.append("source-hygiene check failed:\n" + r.stdout)
    else:
        print("  --  check_source_hygiene.py absent; hygiene check skipped")

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
    #     the managed-config namespace is `amore doctor` with grok-doctor
    #     legacy adoption, and the doctor/ssh-wrap command strings channel
    #     through the invoked binary name.
    _check_file_contains(
        DOCTOR_FIX_FILE, 'MANAGED_NAMESPACE: &str = "amore doctor"',
        "managed shell/tmux blocks use the `amore doctor` namespace", problems)
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

    # 6d. egress posture: the telemetry subsystem stays inert by default and
    #     no release lane bakes in a reporting token. These pins back the
    #     public egress statement (README / SECURITY / the announcement); a
    #     sync that flips either must be caught here, not by a reader.
    _check_file_contains(
        "crates/codegen/xai-grok-telemetry/src/config.rs",
        "#[default]\n    Disabled",
        "telemetry mode defaults to Disabled", problems)
    workflow_dir = REPO / ".github" / "workflows"
    workflows = sorted(workflow_dir.glob("*.yml")) if workflow_dir.exists() else []
    tainted = [w.name for w in workflows
               if "GROK_TELEMETRY_BUILD" in w.read_text(encoding="utf-8", errors="replace")]
    if not workflows:
        problems.append("no workflow files found — cannot verify no-baked-token")
    elif tainted:
        problems.append(f"telemetry build token referenced in workflows: {tainted}")
    else:
        print("  ok  no GROK_TELEMETRY_BUILD_* token in any workflow")

    # 6e. instrument companions — init flags, fetch/release-asset contract,
    #     doctor registration, and companion lanes in release + instruments-ci.
    #     Re-apply these if an upstream merge drops them.
    _check_file_contains(
        INIT_CMD_FILE, 'long = "with-lucerna"',
        "init exposes --with-lucerna opt-in companion flag", problems)
    _check_file_contains(
        INIT_CMD_FILE, 'long = "with-speculum"',
        "init exposes --with-speculum opt-in companion flag", problems)
    _check_file_contains(
        INIT_CMD_FILE, 'long = "no-qmd"',
        "init exposes --no-qmd opt-out for semantic search setup", problems)
    _check_file_contains(
        INIT_CMD_FILE, "qmd_setup::run",
        "init calls qmd_setup::run after iris companion install", problems)
    _check_file_contains(
        INIT_CMD_FILE, "fn ancestor_house_blocks_new_init",
        "init ancestor-house guard blocks nested house creates", problems)
    _check_file_contains(
        INSTRUMENTS_DIAG_FILE, "probe_qmd_search",
        "doctor instruments probe registers qmd/search probe (probe_qmd_search)", problems)
    _check_file_contains(
        INSTRUMENT_FETCH_FILE, RELEASE_BASE_NEEDLE,
        "instrument_fetch RELEASE_BASE names the fork release repo", problems)
    _check_file_contains(
        INSTRUMENT_FETCH_FILE, "format!(\"{name}-{suffix}.exe.zip\")",
        "instrument_fetch Windows asset naming <name>-<suffix>.exe.zip", problems)
    _check_file_contains(
        INSTRUMENT_FETCH_FILE, "format!(\"{name}-{suffix}.tar.gz\")",
        "instrument_fetch unix asset naming <name>-<suffix>.tar.gz", problems)
    _check_file_contains(
        INSTRUMENT_FETCH_FILE, 'name: "lucerna"',
        "instrument_fetch registers lucerna InstrumentSpec", problems)
    _check_file_contains(
        INSTRUMENT_FETCH_FILE, 'name: "speculum"',
        "instrument_fetch registers speculum InstrumentSpec", problems)
    _check_file_contains(
        INSTRUMENTS_DIAG_FILE, "pub fn apply_instruments_probe",
        "doctor instruments probe module present (apply_instruments_probe)", problems)
    _check_file_contains(
        INSTRUMENTS_DIAG_MOD, "pub mod instruments",
        "diagnostics mod registers instruments submodule", problems)
    _check_file_contains(
        INSTRUMENTS_DIAG_MOD, "apply_instruments_probe",
        "diagnostics re-exports apply_instruments_probe", problems)
    _check_file_contains(
        DOCTOR_CMD_FILE, "apply_instruments_probe",
        "standalone doctor collect_report applies instruments probe", problems)
    _check_file_contains(
        RELEASE_WORKFLOW, "lucerna:",
        "release.yml has lucerna companion lane", problems)
    _check_file_contains(
        RELEASE_WORKFLOW, "speculum:",
        "release.yml has speculum companion lane", problems)
    _check_file_contains(
        RELEASE_WORKFLOW, "needs: [amore, iris, lucerna, speculum]",
        "release job waits on iris/lucerna/speculum companion lanes", problems)
    _check_file_contains(
        INSTRUMENTS_CI_WORKFLOW, "instrument: [lucerna, speculum]",
        "instruments-ci.yml matrices lucerna + speculum", problems)
    _check_file_contains(
        INSTRUMENTS_CI_WORKFLOW, "instruments/lucerna/**",
        "instruments-ci.yml path-scoped to instruments/lucerna", problems)
    _check_file_contains(
        INSTRUMENTS_CI_WORKFLOW, "instruments/speculum/**",
        "instruments-ci.yml path-scoped to instruments/speculum", problems)

    # 6d. defect-remediation fix pins (amore-build-defect-remediation campaign,
    #     2026-08-07). Each pins an upstream file so a future sync cannot
    #     silently drop the fix.
    _check_file_contains(
        "crates/codegen/xai-grok-shell/src/leader/client.rs", "control_command_min_protocol",
        "per-command minimum-floor control-protocol gate (replaces exact-equality)", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-shell/src/leader/mod.rs", "client::control_command_min_protocol",
        "discovery enforces the same per-command floor as send_control", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-shell/src/session/acp_session.rs", "fn is_busy_live",
        "scheduled/background obligations keep a session resident so idle eviction cannot drop them", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-sampling-types/src/types.rs", "impl<'de> Deserialize<'de> for ChatChunkDelta",
        "hand-written ChatChunkDelta Deserialize accepting all three reasoning-trace spellings", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-sampler/src/events.rs", "input_overflow_error",
        "zero-output length-stops build an Api context-overflow error carrying model_metadata", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-sampler/src/actor/request_task.rs", "classify_length_stop",
        "zero-output length-stops classify to input-overflow (compaction) not MaxTokensTruncation", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-sampler/src/stream/messages.rs", "input_overflow_error",
        "Messages backend routes zero-output length-stops to input-overflow carrying model_metadata", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-sampling-types/src/conversation/messages.rs", "prepare_history",
        "strip foreign reasoning signatures on a cross-backend switch (rule in messages.rs)", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-sampling-types/src/conversation.rs", "pub use messages::prepare_history;",
        "conversation.rs re-exports prepare_history for the shell caller", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-shell/src/session/acp_session_impl/model_switch.rs", "prepare_history(&mut conversation, true)",
        "model switch strips foreign reasoning signatures only when the backend changed", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-shell/src/session/acp_session_tests/tool_layer_images_bridge_tests.rs", "use base64::Engine;",
        "test-target unblock: base64 Engine trait import (shell lib-test target compiles)", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-sampling-types/src/types.rs", "pub cache_write_tokens: u32",
        "PromptTokensDetails carries the cache-write token field", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-sampling-types/src/conversation.rs", "d.cache_write_tokens",
        "ChatCompletions From<Usage> maps cache_write into cache_creation_prompt_tokens", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-shell/src/remote/client.rs", "fn warn_default_context_window_once",
        "unknown-model context-window fallback stays audible (warn + surface-once), not silent", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-sampler/src/client.rs", "fn extract_request_id(",
        "provider x-request-id/request-id extracted from failed responses and logged", problems)
    _check_file_contains(
        "instruments/iris/packages/tui/package.json", '"@opentui/core": "^0.4.5"',
        "iris TUI pins @opentui at a named floor, not floating latest", problems)
    _check_file_contains(
        ".github/workflows/release.yml", "it need not agree with",
        "release version gate is tag-driven GROK_VERSION; the crate tracks upstream", problems)
    _check_file_contains(
        ".github/workflows/installers.yml", "name: installers",
        "keeps the installer parse + run-and-print smoke from being dropped", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-pager-render/src/render/line_utils.rs", "grapheme_display_width",
        "width/truncate helpers are grapheme-cluster aware (RI pairs, ZWJ families)", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-shell/src/agent/mvp_agent/agent_ops.rs", "detachment lives on the leader",
        "driver/subscriber detach comment points at the real leader home", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-shell/src/active_sessions.rs", "started_at",
        "active-session start-identity survives so a recycled PID is not the same alive session", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-shell/src/agent/config.rs", "nearest_declared_effort",
        "out-of-list per-model reasoning_effort clamped to nearest declared option and warned", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-pager/src/actions/mod.rs", "pub fn chord_collisions",
        "action-registry reports chord collisions instead of silently first-winning", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-pager/src/headless.rs", "// start identity filled in by register()",
        "headless ActiveSession literal names the started_at field", problems)
    _check_file_contains(
        "crates/codegen/xai-grok-pager/src/app/effects/mod.rs", "// start identity filled in by register()",
        "RegisterActiveSession effect literal names the started_at field", problems)

    # remote startup-gate refusal: server-synced layers cannot set required_* that exit at launch
    _check_file_contains(
        "crates/codegen/xai-grok-shell/src/util/config/resolve/version.rs",
        "// fork: remote-synced layers cannot gate startup",
        "remote-synced required_* keys cannot gate startup", problems)

    # 7. build + smoke (this host). Build is the long pole; allow skipping.
    #    The full Linux pager suite remains CI-owned (UPSTREAM.md §5).
    if dry_run:
        print("[dry-run] would build xai-grok-pager-bin and smoke amore")
    else:
        print("  .. building xai-grok-pager-bin (this can take a while)")
        b = run(["cargo", "build", "--release", "-p", "xai-grok-pager-bin"])
        if b.returncode != 0:
            problems.append("cargo build -p xai-grok-pager-bin failed:\n" + b.stderr[-2000:])
        else:
            print("  ok  cargo build -p xai-grok-pager-bin")
            exe = REPO / "target" / "release" / ("amore.exe" if sys.platform == "win32" else "amore")
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
