# @selene/daemon

> The dioptra **Bun index/read daemon** — the rework of the legacy Rust/Axum daemon's
> core read surface. Parses through `@selene/regula` (one parser for the whole schema);
> serves the org index, wikilink graph, backlinks, and search over HTTP. It is the
> primary read daemon; the legacy Rust daemon it replaced was archived 2026-07-03, after
> the Bun daemon passed the full core parity matrix (22/22) via the `@selene/parity`
> golden-master harness.

## Charter

- **Scope (this milestone):** the 11 core read endpoints — `/api/health`, `/api/status`,
  `/api/launch-presets`, `/api/files` (list), `/api/files/{*path}`, `/api/assets/{*path}`,
  `/api/search`, `/api/graph`, `/api/projects`, `/api/projects/{name}/tree`,
  `/api/projects/{name}/file/{*path}`. Mutating endpoints come in a later,
  fixture-gated phase (they will route through regula verbs). Federation is a
  **sidecar process boundary** (amore-stack) and lands last — keep seams clean,
  spend zero energy on it.
- **Authority split preserved:** regula owns parse/schema/lifecycle; this daemon owns
  enumeration, wikilinks, link-map/backlinks, graph, search — the layers regula
  deliberately does not carry (see `spec/regula-api.md` §10).
- **Second-system guard:** a module exists only when an endpoint needs it. The golden
  master keeps the rework honest against real behavior, not imagined elegance.

## The parity discipline (how this shipped)

The migration is complete — the legacy daemon is archived (2026-07-03) and no longer
runs. The flows below are the historical record of how each endpoint shipped, retained
because the deferred mutating tier reuses the same record/replay machinery.

The legacy daemon's HTTP surface **was** the spec. An endpoint shipped when
`parity replay --target http://127.0.0.1:3848` passed it against goldens recorded
from legacy (`:3847`) **in the same corpus moment**.

Two discoveries (2026-07-02, during the shape survey) collapsed what would have
been a dual-mode daemon into something much simpler:

1. **The worktree contamination in the live legacy graph is persisted-index
   residue, not walk behavior.** Legacy's own `should_exclude` skips dot-dirs —
   `.claude/**` never survives a fresh walk; the observed worktree nodes entered
   via the file watcher (which bypasses the walk filter) and are immortalized by
   the mtime cache (`.vitrum-index.json`: the walk adds, never evicts). So this
   daemon's unconditional `.claude/worktrees/**` exclusion **matches legacy's
   code**; the parity ritual just requires restarting legacy first so its index
   is residue-free (parity against contract, not accident).
2. **Legacy's array ordering is `HashMap` hash-order** (per-process random) —
   handled harness-side by ratified order-canonicalization (see
   `packages/parity/README.md`), not by this daemon imitating randomness. This
   daemon orders deterministically (path-asc) where legacy is hash-random.

The only *deliberate* divergences are the graph shape improvements — carried on
a per-request param, so the default response stays parity-exact:

| `/api/graph?shape=` | Behavior |
|---------------------|----------|
| absent / `legacy` / other | legacy-exact shape — **the parity gate** and what clients get until they repoint |
| `v2` | the ratified shape below |

Unit tests pin that `shape` absent produces zero v2 artifacts. The param's
`legacy` default flips only when the clients' graph views adopt the v2 vocabulary.

## Graph shape v2 (the ratified improvements, 2026-07-02)

1. **`.claude/worktrees/**` excluded from index scope** (unconditional in default
   mode) — transient worktrees are transient git checkouts, not org sources.
2. **`kind: "file"` nodes** for non-md wikilink targets that exist on disk
   (e.g. `governance.ts`) — the graph sees code the docs cite, instead of minting
   placeholders.
3. **Forge node split: `pipeline` vs `dream`** — by the `forge/dreams/**` path
   boundary (distinct lifecycles + review obligations).
4. **`subtype` field** (optional) on inbox/task nodes — inbox: the type subfolder;
   task: the status. Coarse kinds stay coarse; legends stay coarse by default.

## Layout

```
spec/           agent-authored contract digests (legacy-shapes.md, regula-api.md)
src/
  contract.ts   shared data model + module seams (the one file every module imports)
  core/         enumerate → parse (regula) → wikilinks → link map → resolver
  graph/        node/link construction, edges.jsonl overlay, shape v2
  routes/       one file per endpoint family + Bun.serve wiring
  index.ts      entry: org-root resolution, flags (--port, --legacy-compat), boot
```

## Run

```
bun src/index.ts <org_root> --port 3850   # 3850 is the operating port the CLI + TUI dial
bun test          # fixture-org unit tests
bunx tsc --noEmit # typecheck
```

Parity gate (historical — legacy live on :3847 — **freshly restarted so its index
carries no watcher residue** — this daemon on :3848, same corpus moment):

```
cd ../parity
bun src/index.ts record --base http://127.0.0.1:3847
bun src/index.ts replay --target http://127.0.0.1:3848
```
