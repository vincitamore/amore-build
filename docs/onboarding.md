# Onboarding: what `amore init` installs

`amore init` **creates a house**: a directory carrying orientation surfaces,
folder schemas, hooks, skills, the iris companion, and an install manifest
that records ownership. The house is the place you launch from for all your
work, not per-repo config; the working method is explained in
[the-house.md](the-house.md). This page answers the mechanics: **what got
installed, what Amore owns vs what you own, and what happens on
`--refresh`.**

Binary spelling: **`amore`** (argv0 also tolerates `amore-build`).

```sh
amore init              # create ./amore (default name): lattice + skills + hooks + iris
amore init <dir>        # create <dir> as the house
amore init --dry-run    # plan only
amore init --refresh    # upgrade untouched files only
```

`init` writes into a new directory (or an existing house); it **refuses a
non-empty directory that is not already a house** rather than overlaying it.
Running bare `amore init` from inside an existing house is also refused so a
nested `amore/` tree is never planted by accident. Refresh that house with
`amore init .` from its root (or pass `--force-new` only when a nested house
is intentional).

### Adopting a pre-manifest house

A directory that already holds house content but has no
`.amore/house-install.json` is not treated as a house yet: `amore init .`
refuses non-empty non-house directories. To adopt it without overwriting
customized files, write a minimal install manifest first, then run init on
the house root:

```sh
mkdir -p .amore
printf '%s\n' '{"version":1,"files":{}}' > .amore/house-install.json
amore init .
```

Init then preserves every existing file whose content differs from the pack
and writes only paths that are still missing. Prefer this path over nesting
a second house under the first.

---

## 1. The installed tree

Default run writes the embedded `templates/house/**` pack (files only; empty
directories are created as parents of written files) and stamps the install
manifest. Ground truth for the content set: `amore init --dry-run --yes`
lists every path under **would-write** (currently **127** files), plus the
iris companion install (§ below).

```
<house>/
  AGENTS.md                       # house identity ({{HOUSE_NAME}} expanded)
  README.md
  .gitignore                      # house/projects git boundary (projects/* ignored)
  context/
    README.md
    current-state.md              # dynamic session-handoff surface
    previous-state.md             # append-only archive of migrated sections
    principle-lattice.md          # default-on; omit with --no-lattice
  inbox/                          # captures/decisions/ideas/investigations
    README.md                     #   (+ resolved/ subfolders, .gitkeep-held)
  tasks/                          # backlog/completed/incubating/paused/review
    README.md
  knowledge/
    README.md
  reminders/
    README.md
  forge/                          # handles/output/sessions, .gitkeep-held
    README.md
  projects/
    README.md                     # project work lives here, gitignored by the boundary
  instruments/
    README.md                     # iris installs under instruments/iris/
  scripts/
    README.md
    sync_orientation_rules.py     # orientation/rules sync utility
  .amore/
    house-install.json            # produced by init (not from the embed pack)
    rules/
      principle-lattice.md
    hooks/                        # stop gate + session-init (+ fixtures/tests)
      house-stop-gate.json
      house-session-init.json
      README.md
      bin/  fixtures/
    skills/                       # 6-skill pack + README
      forge-master/  auriga/  oeconomia/  prokope/  sortes/  isda/
```

**Iris companion (also installed by default):** init downloads the iris
release archive for your platform, verifies its published checksum, unpacks
the binaries into `instruments/iris/`, and **links them beside the `amore`
binary** so `iris` resolves on `PATH` wherever `amore` does, with no
manual step. After iris is linked, init runs **`iris qmd setup`** so the
house has managed semantic search (runtime under
`~/.amore/instruments/qmd/`, house index, and hybrid models). Skip that
step with **`--no-qmd`**; **`--no-iris`** implies the skip. Optional
companions use the same release channel when requested: `--with-lucerna`
and `--with-speculum` (both **off** by default). Network touch in `init`
is those companion fetches plus qmd package/model downloads on first
setup. Fully offline init: `--no-iris` (or `--no-qmd` if iris is kept)
and do not pass `--with-lucerna` or `--with-speculum`. A failed download
or setup never fails the house; the summary says what happened and
`iris qmd setup` (or `amore init --refresh`) finishes later. See
[iris.md](iris.md), [autonomy.md](autonomy.md), and [egress.md](egress.md).

**Also (not a house file):** init appends the absolute path of
`<house>/.amore/hooks` to the global always-trusted registry
`~/.amore/hooks-paths` (one absolute path per line; home is `$GROK_HOME` /
`$AMORE_HOME` when set). That is how project hooks are discovered without a
per-session trust prompt for that path.

**Manifest shape** (`.amore/house-install.json`):

```json
{
  "version": 1,
  "files": {
    "AGENTS.md": "<sha256 hex of content last written by init>",
    "…": "…"
  }
}
```

---

## 2. The ownership matrix

### Refresh semantics (every file, uniformly)

| Condition | Action |
|-----------|--------|
| Path missing | Write |
| On-disk bytes match planned content | Skip (unchanged) |
| On-disk differs, default | **Preserve** (never clobber) |
| `--refresh` and disk sha256 **equals** manifest sha | Rewrite (template upgrade of untouched file) |
| `--refresh` and disk sha256 **≠** manifest sha | **Preserve** (your edit wins) |
| `--force` | Rewrite (confirm unless `--yes`; non-TTY requires `--yes`) |
| Opt-out flag for that class | Not installed / listed as skipped |

**Rule of thumb:** your edits are **always** preserved on `--refresh`. Only
`--force` overwrites diverged files. Idempotent second run with no flags → all
skipped. Precedence for a diverged file: `--force` wins over `--refresh`;
without either, preserve.

### Ownership by class

Every row shares the refresh semantics above; what differs is who the
content belongs to and how to customize it safely.

| Class | Paths | Owner / customize |
|-------|-------|-------------------|
| House identity | `AGENTS.md` | Yours. Init expands `{{HOUSE_NAME}}`; edit orientation freely, edits preserved on `--refresh`. |
| Context surfaces | `context/current-state.md`, `context/previous-state.md` | Yours to keep current: rewrite `current-state` freely each session; migrate aged sections to `previous-state` verbatim, never edit it in place. Never `--force` just to "upgrade" these. |
| Lattice | `context/principle-lattice.md`, `.amore/rules/principle-lattice.md` | Yours to edit; tool ships the default. Omit both with `--no-lattice`. |
| Org scaffolds | `inbox/ tasks/ knowledge/ reminders/ forge/` READMEs + `.gitkeep` skeletons | Scaffold is tool-managed; **everything you add under them is yours** and never touched by init. Leave READMEs until you intentionally fork the schema docs. |
| House/projects boundary | `.gitignore`, `projects/README.md`, `instruments/README.md` | Tool-managed while untouched. The boundary keeps project repos out of the house repo (`projects/*` ignored, READMEs tracked). |
| Hooks pack | `.amore/hooks/**` (registrations, `bin/`, `fixtures/`) | Tool-managed pack; yours after you edit. Prefer config tweaks over forking scripts; `--no-hooks` drops the pack + registry line. |
| Skills pack | `.amore/skills/**` (6 skills + README) | Tool-managed pack; edit `SKILL.md` + support files freely, skill-local changes preserved on `--refresh`. `--no-skills` drops the tree. |
| House scripts | `scripts/README.md`, `scripts/sync_orientation_rules.py` | Tool-managed utilities; extend freely. (The pack's `scripts/tests/` fixtures are **not** installed; they exist for the template's own CI.) |
| Root index | `README.md` | Tool-managed while untouched; yours after you edit. |

### Init-produced (not in the embed / dry-run would-write list)

| Path | What | Notes |
|------|------|-------|
| `.amore/house-install.json` | Install manifest (`version` + `files` → sha256) | **Tool-managed**: refresh uses it as the source of truth for "untouched". Do not hand-edit hashes. |
| `~/.amore/hooks-paths` (global) | Always-trusted hooks directory registry | Re-run init (hooks enabled) re-registers if missing. Remove the project line to drop global trust. |
| `instruments/iris/` | The iris companion binaries | Fetched from the matching release, then linked beside the `amore` binary onto `PATH`; `--no-iris` skips (offline switch). |
| `~/.amore/instruments/qmd/` (global) | Managed semantic search runtime, models, and per-house indexes | Created by `iris qmd setup` (default during init). `--no-qmd` skips; finish later with `iris qmd setup`. |

---

## 3. The knobs

All flags are long-options on `amore init` (see `amore init --help`).

| Flag | Default | Effect |
|------|---------|--------|
| `--no-lattice` | lattice **on** | Omit every path equal to `context/principle-lattice.md` or ending in `/principle-lattice.md` (includes `.amore/rules/principle-lattice.md`). The shipped `AGENTS.md` template marks lattice-only orientation with HTML-comment markers so the lattice vs no-lattice reading is explicit in-source. Init drops lattice **files**; it does not rewrite the AGENTS body; the markers document which paragraphs belong to lattice mode. |
| `--no-skills` | skills **on** | Omit all of `.amore/skills/**`. Explicit `--skills` is a no-op when already default-on. |
| `--no-hooks` | hooks **on** | Do **not** write `.amore/hooks/**` (paths still appear in the plan as skipped) and skip global `hooks-paths` registration. Explicit `--hooks` is a no-op when already default-on. |
| `--no-iris` | iris **on** | Skip the companion install (and implies `--no-qmd`). This is the offline switch when no optional companions are requested. |
| `--no-qmd` | qmd setup **on** (when iris installs) | Skip automatic `iris qmd setup` after iris. Semantic search can be finished later with `iris qmd setup` from the house root. |
| `--dry-run` | off | Print the plan; write nothing (no files, no manifest, no hooks-paths, no download). |
| `--yes` / `-y` | off | Headless-safe; no prompts. **Required** for non-interactive `--force` overwrites. |
| `--force` | off | Overwrite user-modified files (confirm unless `--yes`). |
| `--force-new` | off | Allow creating a new house while the current directory sits inside an existing house (default refuses nested creates). |
| `--refresh` | off | Rewrite only files whose **on-disk sha256 still matches** the install-manifest hash (untouched since install). Diverged files are preserved. |

---

## 4. The hooks

Default install places two first-class hooks under `.amore/hooks/` and
registers that directory in `~/.amore/hooks-paths`.

### Stop gate (`house-stop-gate.json` + `bin/house_stop_gate.py`)

- **Event:** `Stop` (only `reason == "end_turn"` is gated; session-end observes release).
- **Job:** maintenance vigilance **once per operator turn** (state under
  `~/.amore/state/stop-gate/<sessionId>.json`, keyed by `promptId`, not the
  aggregate `stopHookActive` flag).
- **Block:** stdout `{"decision":"block","reason":"…"}` with the house checklist
  (`[HOUSE STOP GATE - native Stop hook]`).
- **Release (empty stdout, exit 0):**
  - Line-anchored **release phrases** (case-normalized plain lines):
    - `No maintenance needed`
    - `Maintenance complete`
    - `Maintenance not required`
    - `Gate released`
  - **Capture-write soft-ack:** a write/edit tool call this turn into
    `knowledge/`, `inbox/`, `tasks/`, `reminders/`, `context/`,
    `forge/{proposals,handles,output,sessions}`, `.amore/skills`, or
    `.grok/skills` releases without a phrase.
  - **Trivial suppression:** fewer than 3 work signals in the transcript → release.
  - **Non-org suppression:** workspace lacks an AGENTS-class marker
    (`AGENTS.md` / `Agents.md` / `AGENT.md` / `CLAUDE.md`) **and** a `tasks/`
    directory → never fires.
  - Already fired for this `promptId`, bad stdin, wrong event → fail-open release.
- **Disable:**
  1. Reinstall plan with `amore init --no-hooks` (hooks paths listed as skipped;
     registry not updated), or
  2. Remove the hook JSON files under `.amore/hooks/`, and/or
  3. Delete this project's absolute hooks path from `~/.amore/hooks-paths`.

### Session-init (`house-session-init.json` + `bin/house_session_init.py`)

- **Event:** `SessionStart` (passive).
- **Job:** when the cwd is a house and one or more `reminders/**/*.md` are due
  (`status` ∈ `{pending, snoozed}` and `remind-at` / `snoozed-until` ≤ now),
  emit `hookSpecificOutput.additionalContext` listing due items plus:

  `Orientation: read AGENTS.md → context/current-state.md → active task under tasks/ before starting work.`

- Silent (empty stdout, exit 0) when nothing is due, non-house cwd, wrong event,
  or on exception (fail-open). Python stdlib only; budget under 5s.

### Folder-trust note

Project hooks live **in the house** under `.amore/hooks/`, but init also
**registers them globally** by appending the absolute hooks directory to
`~/.amore/hooks-paths`. That registry is the always-trusted path list the
runner consults, so the pack runs for this house after init without a
separate per-path trust dance. Cloning the house to a new machine requires
running `amore init` (or `--refresh` with hooks enabled) again so the new
absolute path is registered.

---

## 5. Opt-out inventory

Exact effect of each `--no-*` opt-out on the default tree:

| Flag | Removes / skips | Still installed |
|------|-----------------|-----------------|
| `--no-lattice` | `context/principle-lattice.md`; `.amore/rules/principle-lattice.md` (any path ending in `/principle-lattice.md`) | Everything else, including `AGENTS.md` (markers retained as comments) |
| `--no-skills` | Entire `.amore/skills/**` tree (all 6 skills + support files) | Hooks, lattice, scaffolds, scripts, AGENTS |
| `--no-hooks` | Write of `.amore/hooks/**` (plan shows them **skipped**) **and** `hooks-paths` registration | Skills, lattice, scaffolds, scripts, AGENTS |
| `--no-iris` | The `instruments/iris/` companion download (and, implied, the qmd setup step); no network request at all when no optional companions are requested | Default tree otherwise unchanged |
| `--no-qmd` | The automatic `iris qmd setup` step (package install, house index, model downloads) | Iris itself still installs; finish search later with `iris qmd setup` |

Combining flags is supported (e.g. `amore init --no-skills --no-hooks --no-lattice --yes`).

---

## Quick verification

```sh
# Plan only: must list the content files and hooks-registry would-register
amore init --dry-run --yes

# After a real install
#   - tree present under the house directory
#   - .amore/house-install.json has version 1 and one sha per written file
#   - ~/.amore/hooks-paths contains the absolute …/.amore/hooks line
#   - instruments/iris/ holds the companion (unless --no-iris)
# Second init with no flags → all skipped (idempotent)
amore init --yes
```

Related product docs: hooks vocabulary in the in-tree user guide
(`10-hooks.md`), skills overview (`08-skills.md`). Companion:
[iris.md](iris.md).
