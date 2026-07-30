# dioptra public port — Phase 1.5 D1

Ported 2026-07-30 from the private house tree into the public
`selene-build` repo at `instruments/dioptra/` (operator ruling 7 —
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
| `dioptra mercury status\|log\|halt\|sleep\|wake\|dream\|engine` | Entire verb family removed from `commands.ts` |
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
- `packages/cli/spec/dioptra-verb-census.md`
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

- Package names `@selene/*` (product identity, not a leak)
- Env prefix `DIOPTRA_*`, home `~/.dioptra`, default port **3852**
- Residual **athanor** CLI verb family (subprocess/forge-fs; not a Mercury/qmd
  surface — still a potential null surface if the adopter has no athanor
  instrument; left for a later product pass if desired)
- OpenTUI patches under `patches/` (Windows-proved; per-OS resolution is D2+)

## Known debts (NEXT units own these)

| Debt | Owner unit | Status |
|------|------------|--------|
| Foreign-root guard redesign — tiered trust (reads any root; mutations need house markers or opt-in) | **D2** | **DONE** (2026-07-30) — seam `@selene/regula` `root-trust.ts`; CLI write verbs call `ensureMutationTrust`; daemon co-location guard removed (reads unflagged); opt-in via `--allow-foreign-root` / `DIOPTRA_ALLOW_FOREIGN_ROOT=1` / `~/.dioptra/allowed-roots.json` |
| OpenTUI native dep per-OS resolution + dll redeploy story | D3 (was D2 pre-reassign) | open |
| Install story (`bun build --compile` / release assets / wizard step) | D5 | open |
| Athanor residual verbs (optional null-surface cleanup) | product follow-on | open |
| `triggered-by: dream` migration for private trees still using the old label | house migrate when consuming public tree | open |

## Gates (D1)

See dual-write handle/output for paste-of-record.
