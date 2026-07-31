# iris public port — Phase 1.5 D1

Ported 2026-07-30 from the private house tree into the public
`arcus-build` repo at `instruments/iris/` (operator ruling 7 —
canonical public dev home; added-path, thin-diff preserved).

## What was dropped (Mercury / qmd lineage — operator ruling 4)

Null surfaces must not ship. The following entry points were **removed
completely** (no stubs, no offline cards):

### Daemon

| Surface | Path / route |
|---------|----------------|
| Mercury state proxy | `packages/daemon/src/proxies/mercury.ts` (+ tests) |
| qmd semantic-search proxy | `packages/daemon/src/proxies/qmd.ts` (+ tests) |
| Mercury HTTP routes | `packages/daemon/src/routes/mercury.ts` — `/api/mercury/*` (+ tests) |
| qmd HTTP route | `packages/daemon/src/routes/qmd.ts` — `/api/qmd/search` (+ tests) |
| Router wiring | `server.ts` no longer dispatches mercury/qmd |
| Launch preset `mercury` | `launch-presets.ts` — replaced with a single generic `agent` preset |
| Parity inventory proxy rows | mercury/qmd endpoint rows removed from `packages/parity/src/inventory.ts` |

### CLI

| Surface | Notes |
|---------|-------|
| `iris mercury status\|log\|halt\|sleep\|wake\|dream\|engine` | Entire verb family removed from `commands.ts` |
| `search --mode lex\|vec\|hybrid` | Semantic modes removed; only `--mode index` (daemon fuzzy `/api/search`) remains |
| Help / glass copy | No mercury mention in the verb surface |

### TUI

| Surface | Notes |
|---------|-------|
| Mercury tab / member | `members/MercuryMember.tsx` + `mercury-smoke.tsx` deleted |
| Shell registration | `MEMBERS` no longer includes `Mercury`; keybind 1–8 renumbered (Graph is last) |
| `mercuryColor` theme helper | Removed from `theme.ts` |
| Dashboard mercury pulse / stat | Replaced with forge-review counts; no `/api/mercury/*` polls |
| Search overlay multi-backend | Index-only; Tab mode cycle + Ctrl+R rerank for qmd removed |
| `format-daemon-log-cell` test | Deleted (imported MercuryMember) |

### Classification / status reshape

| Change | Notes |
|--------|-------|
| `triggered-by: dream` | Public spelling for dream pipelines (was a longer lineage label) |
| `StatusSummary.forge` | Replaces `.mercury` field; CLI human text says `Forge: …` |
| `summarizeForgeReview` | Replaces `summarizeMercury` |

### Docs / lineage census deleted (not genericized)

- `packages/cli/spec/examen-collapse-census.md`
- `packages/cli/spec/iris-verb-census.md`
- `packages/daemon/spec/legacy-shapes.md`
- `packages/daemon/spec/mutating-shapes.md`
- `packages/daemon/spec/regula-api.md`

These were house-private investigation/census artifacts carrying personal paths
and residual surfaces; regenerating generic doctrine is out of D1 scope.

## Sanitization that ran

- Excluded from copy: `.git`, `node_modules`, build artifacts, `.env` / secrets
  (scan found **no runtime secrets** — no API keys/tokens; only test fixture
  names like `secret.txt` for path-escape guards).
- Tier-1 personal paths and usernames stripped (operator PII tokens, absolute
  home-directory path defaults, personal handles in patch drafts).
- Sibling-house narrative generalized in README / CLI help / comments
  (install tables and foreign-root incident wording).
- Cross-tree path examples in tests rewritten to neutral
  `outside` / `other-house` paths.
- Root README rewritten as a public product blurb (no sibling-house table).

## Kept by design

- Package names `@arcus/*` (product identity, not a leak)
- Env prefix `IRIS_*`, home `~/.iris`, default port **3853**
- Residual **athanor** CLI verb family (subprocess/forge-fs; not a Mercury/qmd
  surface — still a potential null surface if the adopter has no athanor
  instrument; left for a later product pass if desired)
- OpenTUI patches under `patches/` (Windows-proved; per-OS resolution is D2+)

## Known debts (NEXT units own these)

| Debt | Owner unit | Status |
|------|------------|--------|
| Foreign-root guard redesign — tiered trust (reads any root; mutations need house markers or opt-in) | **D2** | **DONE** (2026-07-30) — seam `@arcus/regula` `root-trust.ts`; CLI write verbs call `ensureMutationTrust`; daemon co-location guard removed (reads unflagged); opt-in via `--allow-foreign-root` / `IRIS_ALLOW_FOREIGN_ROOT=1` / `~/.iris/allowed-roots.json` |
| OpenTUI native dep per-OS resolution + `bun build --compile` distribution | **D3** | **DONE** (2026-07-30) — multi-tool CLI+daemon compile; optional dash artifact embeds OpenTUI native via `{ type: "file" }` (proved windows-x64); source build always documented |
| CI + release-asset lane (path-scoped matrix, package tar.gz/zip, Phase-3 seam) | **D5** | **DONE** (2026-07-30) — `.github/workflows/iris-ci.yml` + `iris-release-assets.yml`; all lanes strict (linux/darwin dash fail = job fail = D3 deferred proof) |
| Full regula org-verb surface in public multi-tool (`task\|inbox\|reminder\|knowledge`) | product / D3+D5 | **INCLUDED** (operator 2026-07-30) — one multi-tool artifact, no gating; CI smoke exercises `commands --json` + daemon health |
| Install UX remainder (wizard PATH step / end-user install docs) | product follow-on / Phase 3 | open — D5 ships CI proof + release-asset producer; attach-to-Release is Phase-3 `release.yml` |
| Patched UAF OpenTUI dll pin | ops / pin bump | open — tree carries `patches/@opentui__core@0.4.2.patch` + `patches/opentui-dll-native-fix/`; workspace resolves `@opentui/core@0.4.5` (`latest`). Re-pin + re-validate + redeploy via `deploy.sh` when the patched dll is required |
| Extra code-grammar wasms (`tree-sitter-wasms`) | product follow-on | open — source-only via `packages/tui/src/code-grammars.ts` (`createRequire`/`node_modules`); compiled dash ships OpenTUI default parsers only |
| Athanor residual verbs (optional null-surface cleanup) | product follow-on | open |
| `triggered-by: dream` migration for private trees still using the old label | house migrate when consuming public tree | open |

## Compile distribution (Phase 1.5 D3)

Ruling 7 release story: per-OS assets `iris-{os}-{arch}` (and optional `iris-dash-{os}-{arch}`).

### Recipe

```bash
cd instruments/iris
bun install
bun run scripts/build-compile.ts            # CLI + daemon only
bun run scripts/build-compile.ts --with-dash  # + OpenTUI dash artifact
# → dist/iris-{os}-{arch}[.exe]
# → dist/iris-dash-{os}-{arch}[.exe]   (with --with-dash)
```

Cross-compile (Bun): `--target bun-linux-x64` / `bun-darwin-arm64` / etc.

| Artifact | Entry | Embeds | Notes |
|----------|-------|--------|-------|
| `iris-{os}-{arch}` | `packages/cli/src/standalone.ts` | CLI verbs, `@arcus/regula`, Bun daemon | In-process routing (no sibling `.ts` spawns). `daemon` / `task list` / `status` / … |
| `iris-dash-{os}-{arch}` | `packages/tui/src/dash-standalone.ts` | OpenTUI + React dash | TTY required for interactive use. Auto-spawns daemon via sibling multi-tool or `$IRIS_DAEMON_BIN`. |

Source build (always documented; escape hatch):

```bash
bun packages/cli/src/iris.ts daemon --port 3853 <org_root>
bun packages/cli/src/iris.ts task list --json
bun packages/tui/src/index.tsx   # dash
```

### OpenTUI native surface — resolution

**Mechanism that works:** `@opentui/core-win32-x64` (and peer OS packages) export the native library via:

```js
// @opentui/core-win32-x64/index.bun.js
const module = await import("./opentui.dll", { with: { type: "file" } })
export default module.default
```

`bun build --compile` embeds that file into `$bunfs` and `bun:ffi` `dlopen`s the embedded path. No manual extract-to-cache required on the proved host (windows x64, Bun 1.3.14, `@opentui/core@0.4.5`).

**Why dash is a separate artifact (not gated out as impossible):** keeps the multi-tool lean (~99 MB vs ~110 MB dash); OpenTUI pulls React + renderer. Multi-tool `iris dash` will re-exec a sibling dash binary when present, else prints the build recipe (exit 64).

**Remainder (precisely scoped; CI/release now owned by D5):**

1. **linux/darwin dash CI proof** — same `{ type: "file" }` path for `libopentui.so` / `.dylib`; exercised by matrix in `iris-ci.yml` / `iris-release-assets.yml` (strict — fail the job, do not skip).
2. **Patched UAF dll** — tree still carries `patches/@opentui__core@0.4.2.patch` + `patches/opentui-dll-native-fix/`; workspace currently resolves `@opentui/core@0.4.5` (`latest`). Re-pin + re-validate the patch on version bumps; redeploy via `patches/opentui-dll-native-fix/deploy.sh` after install when the patched dll is required.
3. **Extra grammars** — `packages/tui/src/code-grammars.ts` resolves `tree-sitter-wasms` via `createRequire`/`node_modules` (source-only). Compiled dash ships OpenTUI's default parsers only.

### CI + release assets (Phase 1.5 D5)

| Workflow | Trigger | Role |
|----------|---------|------|
| `.github/workflows/iris-ci.yml` | push/PR path-scoped to `instruments/iris/**` (+ workflow files) | matrix ubuntu/windows/macos: setup-bun 1.3.x + cache → `bun install --frozen-lockfile` → `bun test` → `build-compile --with-dash` → assert both artifacts → smoke (`--help`, `commands --json`, daemon on distinct 39xx port + `/api/health` 200 + clean shutdown) |
| `.github/workflows/iris-release-assets.yml` | tag `v*` + `workflow_dispatch` | same matrix → package `tar.gz` (unix) / `zip` (windows) → `upload-artifact` stable names `iris-{os}-{arch}`; **no `contents: write`** |

**Phase-3 seam:** `release.yml` downloads these artifacts and attaches them to the GitHub Release. D5 does not publish releases.

**Regula:** full org-verb surface **INCLUDED** in the multi-tool (operator 2026-07-30) — not gated out of the public artifact.

### Gates (D3)

See dual-write handle/output for paste-of-record.

### Gates (D5)

See dual-write handle/output for paste-of-record.

## Gates (D1)

See dual-write handle/output for paste-of-record.
