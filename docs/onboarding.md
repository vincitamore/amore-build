# Onboarding: what `arcus init` installs

After `arcus init` in a git repository, you have a **cooperation harness** —
orientation surfaces, folder schemas, hooks, skills, and an install manifest
that records ownership. This page answers: **what got installed, what Arcus
owns vs what you own, and what happens on `--refresh`.**

Binary spelling: **`arcus`** (argv0 also tolerates `arcus-build`). Run from
the target repo root (or any subdirectory — init walks up to the `.git` root).

```sh
arcus init              # default: lattice + skills + hooks on; iris off
arcus init --dry-run    # plan only
arcus init --refresh    # upgrade untouched files only
```

---

## 1. The installed tree

Default run writes the embedded `templates/house/**` pack (files only; empty
directories are created as parents of written files) and stamps the install
manifest. Ground truth for the content set: `arcus init --dry-run --yes`
lists every path under **would-write** (currently **133** files).

```
<repo>/
  AGENTS.md
  README.md
  context/
    README.md
    current-state.md
    principle-lattice.md          # default-on; omit with --no-lattice
  inbox/
    README.md                     # captures/ created when you add files
  tasks/
    README.md
  knowledge/
    README.md
  reminders/
    README.md
  forge/
    README.md
  scripts/                        # house_lint, orientation sync, test fixtures
    …
  .arcus/
    house-install.json            # produced by init (not from the embed pack)
    rules/
      principle-lattice.md
    hooks/                        # stop gate + session-init (+ fixtures/tests)
      house-stop-gate.json
      house-session-init.json
      README.md
      bin/
        house_stop_gate.py
        house-stop-gate.cmd
        house_session_init.py
        house-session-init.cmd
        run_branch_tests.py
      fixtures/
        stop-gate/…
        session-init/…
    skills/                       # 7-skill pack
      README.md
      forge-master/
      auriga/
      oeconomia/
      prokope/
      sortes/                     # lenses + bin
      isda/
      sentinel/
```

**Also (not a repo file):** init appends the absolute path of
`<repo>/.arcus/hooks` to the global always-trusted registry
`~/.arcus/hooks-paths` (one absolute path per line; home is `$GROK_HOME` /
`$ARCUS_HOME` when set). That is how project hooks are discovered without a
per-session trust prompt for that path.

**Manifest shape** (`.arcus/house-install.json`):

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

### Refresh semantics (every row)

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
skipped.

### Rows (default content install = 133 files)

Columns: **path** · **what** · **owner** · **refresh** · **customize safely**.

| Path | What | Owner | Refresh | Customize safely |
|------|------|-------|---------|------------------|
| `.arcus/hooks/bin/house_session_init.py` | Session-init decision script | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/bin/house_stop_gate.py` | Stop-gate decision script | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/bin/house-session-init.cmd` | Windows shim for session-init | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/bin/house-stop-gate.cmd` | Windows shim for stop gate | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/bin/run_branch_tests.py` | Hooks pack branch-test runner | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/fixtures/session-init/01-no-reminders-silent.json` | Hook branch-test fixture envelope | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/fixtures/session-init/02-due-reminder-context.json` | Hook branch-test fixture envelope | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/fixtures/session-init/03-malformed-frontmatter-skipped.json` | Hook branch-test fixture envelope | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/fixtures/session-init/04-non-house-silent.json` | Hook branch-test fixture envelope | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/fixtures/session-init/05-future-not-due-silent.json` | Hook branch-test fixture envelope | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/fixtures/stop-gate/01-first-fire-block.json` | Hook branch-test fixture envelope | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/fixtures/stop-gate/02-fired-state-release.json` | Hook branch-test fixture envelope | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/fixtures/stop-gate/03-release-phrase-release.json` | Hook branch-test fixture envelope | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/fixtures/stop-gate/04-capture-write-release.json` | Hook branch-test fixture envelope | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/fixtures/stop-gate/05-trivial-suppression.json` | Hook branch-test fixture envelope | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/fixtures/stop-gate/06-non-org-release.json` | Hook branch-test fixture envelope | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/fixtures/stop-gate/07-session-end-release.json` | Hook branch-test fixture envelope | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/house-session-init.json` | SessionStart hook registration (reminders + orientation) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/house-stop-gate.json` | Stop-event hook registration (maintenance gate) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/hooks/README.md` | Hooks pack overview | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Prefer config tweaks over forking scripts. Reinstall via arcus init --refresh, or --no-hooks to drop pack install. |
| `.arcus/rules/principle-lattice.md` | Rules-slot copy of the principle lattice | Yours to edit; tool ships default rules-slot lattice | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit freely. --refresh upgrades only if still byte-identical to last install hash. |
| `.arcus/skills/auriga/SKILL.md` | Skill definition | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/forge-master/SKILL.md` | Skill definition | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/isda/examples.md` | isda skill support material | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/isda/isda_preprocess.py` | isda skill support material | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/isda/reference.md` | isda skill support material | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/isda/SKILL.md` | Skill definition | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/isda/theory.md` | isda skill support material | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/oeconomia/SKILL.md` | Skill definition | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/prokope/SKILL.md` | Skill definition | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/README.md` | Skills pack index (7-skill set) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sentinel/SKILL.md` | Skill definition | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/bin/pick.ts` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/absurd-falsifiable.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/average-first.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/black-box-load.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/change-the-engine.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/construct-the-missing.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/coordinate-invention.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/counterexample-first.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/deform-to-solvable.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/equivalent-forms.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/exhibit-threshold.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/extremal-reframe.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/false-closure.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/find-the-action.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/formal-statement-first.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/foundation-rewrite.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/generative-minimum.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/honest-baseline.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/humble-pole.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/inherited-partition.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/invariance-class.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/local-global-glue.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/multiplicative-bridge.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/nearest-open-rung.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/obstacle-fanout.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/obstruction-anatomy.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/positivity-certificate.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/prior-scope.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/random-model-first.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/range-disjunction.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/README.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/selection-from-continuum.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/solved-analogue.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/strengthen-to-prove.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/transformative-representation.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/transport-vs-essential.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/two-ways-to-count.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/warrant-scale.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/win-either-way.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/win-zone-boundary.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses-ideation/work-backward.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/access-control.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/api-contract-drift.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/boundary-values.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/cardinality.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/concurrency-interleaving.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/configuration-reality.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/cyclicity.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/default-values.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/dependency-direction.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/duplication-drift.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/error-paths.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/idempotency-retry.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/mutation-visibility.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/naming-truth.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/negative-space.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/observability.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/permission-least.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/resource-lifetime.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/resource-pressure.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/reversibility.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/state-completeness.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/structural-correctness.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/symmetry.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/temporal-ordering.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/trust-boundaries.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/lenses/units-and-encodings.md` | sortes skill support (lenses / bin) | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `.arcus/skills/sortes/SKILL.md` | Skill definition | Tool-managed pack; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit SKILL.md and support files; skill-local changes preserved on --refresh. |
| `AGENTS.md` | House identity, orientation ladder, schemas, session discipline | Yours to customize (identity placeholders); tool ships the scaffold | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Replace {{HOUSE_NAME}} / identity; edit orientation. Edits preserved on --refresh. |
| `context/current-state.md` | Dynamic session handoff surface (where work left off) | Yours to keep current every session | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Rewrite freely each session; never use --force just to upgrade this file. |
| `context/principle-lattice.md` | Normative judgment lattice (default-on) | Yours to edit; tool ships default lattice | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit principles in place. Untouched copies upgrade on --refresh; edits preserved. |
| `context/README.md` | Context-surface index | Tool-managed while untouched; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit freely. --refresh upgrades only if still byte-identical to last install hash. |
| `forge/README.md` | Forge pipeline products index | Scaffold tool-managed; pipeline products you create are yours | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Write handles/outputs/sessions under forge/; leave README as contract. |
| `inbox/README.md` | Inbox scaffold index (captures/decisions/investigations/ideas) | Scaffold tool-managed; contents you add are yours | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Add items under schema folders; leave README until you intentionally fork schema docs. |
| `knowledge/README.md` | Knowledge scaffold index | Scaffold tool-managed; contents you add are yours | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Add distilled notes; leave README until you intentionally fork schema docs. |
| `README.md` | Root house index / layout map | Tool-managed while untouched; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Edit freely. --refresh upgrades only if still byte-identical to last install hash. |
| `reminders/README.md` | Reminders scaffold index | Scaffold tool-managed; contents you add are yours | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Add time-bound items; leave README until you intentionally fork schema docs. |
| `scripts/house_lint.test.ts` | House lint tests | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/house_lint.ts` | House lint utility | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/README.md` | House scripts index | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/sync_orientation_rules.py` | Orientation/rules sync utility | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/clean-house/AGENTS.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/clean-house/context/principle-lattice.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/clean-house/inbox/captures/note.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/clean-house/inbox/README.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/clean-house/knowledge/example.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/clean-house/knowledge/README.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/clean-house/reminders/example-pending.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/clean-house/reminders/README.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/clean-house/tasks/example-active.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/clean-house/tasks/README.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/dirty-house/AGENTS.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/dirty-house/inbox/README.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/dirty-house/knowledge/README.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/dirty-house/reminders/README.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/dirty-house/tasks/README.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/dirty-house/tasks/wrong-status.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/sync-tree/AGENTS.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/sync-tree/context/principle-lattice.md` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `scripts/tests/fixtures/sync-tree/tasks/.gitkeep` | House-tooling test fixture | Tool-managed utilities; yours after you edit | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Extend utilities; fixture trees under scripts/tests/ are for lint/sync tests. |
| `tasks/README.md` | Tasks scaffold index | Scaffold tool-managed; contents you add are yours | Untouched (disk sha256 == manifest) -> rewrite; your edits always preserved unless --force | Add task files; leave README until you intentionally fork schema docs. |

### Init-produced (not in the embed / dry-run would-write list)

| Path | What | Owner | Refresh | Customize safely |
|------|------|-------|---------|------------------|
| `.arcus/house-install.json` | Install manifest (`version` + `files` → sha256) | **Tool-managed** — rewritten when init writes or seeds | Not a template path; refresh uses it as the source of truth for "untouched" | Do not hand-edit hashes. Delete only if you intend to forget ownership history. |
| `~/.arcus/hooks-paths` (global) | Always-trusted hooks directory registry | Tool-managed line for this project's `.arcus/hooks` | Re-run init (hooks enabled) re-registers if missing | Remove the project line to drop global trust; or `arcus init --no-hooks` skips registration on (re)install plans that opt out |

Optional opt-in (not in default 133):

| Path | Flag | What |
|------|------|------|
| `.arcus/iris-companion.note.md` | `--with-iris` | Pointer note only — Iris is **not** installed by init |

---

## 3. The knobs

All flags are long-options on `arcus init` (see `arcus init --help`).

| Flag | Default | Effect |
|------|---------|--------|
| `--no-lattice` | lattice **on** | Omit every path equal to `context/principle-lattice.md` or ending in `/principle-lattice.md` (includes `.arcus/rules/principle-lattice.md`). The shipped `AGENTS.md` template marks lattice-only orientation with HTML-comment markers so the lattice vs no-lattice reading is explicit in-source: `<!-- IF NO-LATTICE: begin remove — … -->` … `<!-- IF NO-LATTICE: end remove -->`, and the optional insert block `<!-- IF NO-LATTICE: begin insert — …` / `IF NO-LATTICE: end insert -->`. Init drops lattice **files**; it does not currently rewrite the AGENTS body — the markers document which paragraphs belong to lattice mode. |
| `--no-skills` | skills **on** | Omit all of `.arcus/skills/**`. Explicit `--skills` is a no-op when already default-on. |
| `--no-hooks` | hooks **on** | Do **not** write `.arcus/hooks/**` (paths still appear in the plan as skipped) and skip global `hooks-paths` registration. Explicit `--hooks` is a no-op when already default-on. |
| `--with-iris` | iris **off** | Plant `.arcus/iris-companion.note.md` (pointer only). `--no-iris` is the explicit default. |
| `--dry-run` | off | Print the plan; write nothing (no files, no manifest, no hooks-paths). |
| `--yes` / `-y` | off | Headless-safe; no prompts. **Required** for non-interactive `--force` overwrites. |
| `--force` | off | Overwrite user-modified files (confirm unless `--yes`). |
| `--refresh` | off | Rewrite only files whose **on-disk sha256 still matches** the install-manifest hash (untouched since install). Diverged files are preserved. |

Order of precedence for a diverged file: `--force` wins over `--refresh`; without either, preserve.

---

## 4. The hooks

Default install places two first-class hooks under `.arcus/hooks/` and
registers that directory in `~/.arcus/hooks-paths`.

### Stop gate (`house-stop-gate.json` + `bin/house_stop_gate.py`)

- **Event:** `Stop` (only `reason == "end_turn"` is gated; session-end observes release).
- **Job:** maintenance vigilance **once per operator turn** (state under
  `~/.arcus/state/stop-gate/<sessionId>.json`, keyed by `promptId` — not the
  aggregate `stopHookActive` flag).
- **Block:** stdout `{"decision":"block","reason":"…"}` with the house checklist
  (`[HOUSE STOP GATE — native Stop hook]`).
- **Release (empty stdout, exit 0):**
  - Line-anchored **release phrases** (case-normalized plain lines):
    - `No maintenance needed`
    - `Maintenance complete`
    - `Maintenance not required`
    - `Gate released`
  - **Capture-write soft-ack:** a write/edit tool call this turn into
    `knowledge/`, `inbox/`, `tasks/`, `reminders/`, `context/`,
    `forge/{proposals,handles,output,sessions}`, `.arcus/skills`, or
    `.grok/skills` releases without a phrase.
  - **Trivial suppression:** fewer than 3 work signals in the transcript → release.
  - **Non-org suppression:** workspace lacks an AGENTS-class marker
    (`AGENTS.md` / `Agents.md` / `AGENT.md` / `CLAUDE.md`) **and** a `tasks/`
    directory → never fires.
  - Already fired for this `promptId`, bad stdin, wrong event → fail-open release.
- **Disable:**
  1. Reinstall plan with `arcus init --no-hooks` (hooks paths listed as skipped;
     registry not updated), or
  2. Remove the hook JSON files under `.arcus/hooks/`, and/or
  3. Delete this project's absolute hooks path from `~/.arcus/hooks-paths`.

### Session-init (`house-session-init.json` + `bin/house_session_init.py`)

- **Event:** `SessionStart` (passive).
- **Job:** when the cwd is a house and one or more `reminders/**/*.md` are due
  (`status` ∈ `{pending, snoozed}` and `remind-at` / `snoozed-until` ≤ now),
  emit `hookSpecificOutput.additionalContext` listing due items plus:

  `Orientation: read AGENTS.md → context/current-state.md → active task under tasks/ before starting work.`

- Silent (empty stdout, exit 0) when nothing is due, non-house cwd, wrong event,
  or on exception (fail-open). Python stdlib only; budget under 5s.

### Folder-trust note

Project hooks live **in the repo** under `.arcus/hooks/`, but init also
**registers them globally** by appending the absolute hooks directory to
`~/.arcus/hooks-paths`. That registry is the always-trusted path list the
runner consults — so the pack runs for this project after init without a
separate per-path trust dance. Cloning the house to a new machine requires
running `arcus init` (or `--refresh` with hooks enabled) again so the new
absolute path is registered.

---

## 5. Opt-out inventory

Exact effect of each `--no-*` / default-off opt-in on the default tree:

| Flag | Removes / skips | Still installed |
|------|-----------------|-----------------|
| `--no-lattice` | `context/principle-lattice.md`; `.arcus/rules/principle-lattice.md` (any path ending in `/principle-lattice.md`) | Everything else, including `AGENTS.md` (markers retained as comments) |
| `--no-skills` | Entire `.arcus/skills/**` tree (all 7 skills + support files) | Hooks, lattice, scaffolds, scripts, AGENTS |
| `--no-hooks` | Write of `.arcus/hooks/**` (plan shows them **skipped**) **and** `hooks-paths` registration | Skills, lattice, scaffolds, scripts, AGENTS |
| `--with-iris` | *(opt-in)* adds `.arcus/iris-companion.note.md` only | Default tree unchanged otherwise |
| `--no-iris` | Explicit default; no iris note | Default tree |

Combining flags is supported (e.g. `arcus init --no-skills --no-hooks --no-lattice --yes`).

---

## Quick verification

```sh
# Plan only — must list the content files and hooks-registry would-register
arcus init --dry-run --yes

# After a real install
#   - tree present under the git root
#   - .arcus/house-install.json has version 1 and one sha per written file
#   - ~/.arcus/hooks-paths contains the absolute …/.arcus/hooks line
# Second init with no flags → all skipped (idempotent)
arcus init --yes
```

Related product docs: hooks vocabulary in the in-tree user guide
(`10-hooks.md`), skills overview (`08-skills.md`). Optional companion:
[iris.md](iris.md).
