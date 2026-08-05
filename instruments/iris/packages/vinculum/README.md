# @amore/vinculum

Typed edge store and derivation for the house graph layer. Structural (tier-0)
and model-assisted (tier-1 gen, tier-2 judge) paths write into `graph/edges.jsonl`
at the house root. The iris daemon merges that file into
`/api/graph?edges=semantic|both`; this package only writes.

## Trust model

Derived edges at every tier land **live** in `graph/edges.jsonl`, each carrying
tier and provenance (mechanism, model when judged, timestamp, and for
model-judged edges a supporting quote). Review, edit, suppression, and removal
are **after-the-fact** stewardship verbs. There is no before-the-fact approval
queue.

Mechanical **validity** checks block ingest: schema validation, and for judged
edges the **quote gate** (the supporting quote must appear verbatim in the named
source file). A failed quote is dropped with a logged reason; it is invalid, not
merely unreviewed.

## Derivation ladder

| Tier | Command | Model? | Lands edges? |
|------|---------|--------|--------------|
| 0 | `iris edges derive` or `iris edges update --tier 0` | No | Yes — structural facts |
| 1 | `iris edges update --tier 1` | No | No — candidate inventory only |
| 2 | `iris edges update --tier 2` | Yes (amore) | Yes — after quote gate |

Default for `update` when `--tier` is omitted: **0** (never surprise a user with
a model call). Tier 2 is the only model-calling path; it requires an explicit
`--tier 2` (or an explicitly enabled autonomous action that shells that argv).

### Tier 0 — structural

Walks durable docs (`tasks/`, `inbox/`, `knowledge/`, `context/`) and emits
deterministic edges:

| Source | Edge type |
|--------|-----------|
| Task `blocked-by:` path / wikilink | `depends-on` |
| Inbox `resolution:` wikilink | `resolved-by` |
| Body self-label `[[target]] (type)` | that type (served 15-type set) |
| Frontmatter `supersedes:` / `superseded-by:` | `supersedes` |

Provenance: `asserted_by: structural-v0`, `tier: structural`,
`mechanism: structural`.

### Tier 1 — candidate generation (no model)

Pure heuristics over the org tree. Emits **candidates** in memory for the judge;
candidates alone never land as edges.

- **Co-link:** docs that share a wikilink neighbor (local graph, no daemon)
- **Rare-tag affinity:** docs sharing low-frequency frontmatter tags
- **Unlabeled-wikilink typing:** direct wikilinks without a self-label type

### Tier 2 — judge via amore

Batches candidates into judge briefs, spawns the user's `amore` binary headless
with `--prompt-file` and `--json-schema`, and parses `structuredOutput` from the
JSON envelope. Per-candidate verdicts: accept/reject, edge type, confidence, and
a supporting quote naming its source file.

Binary resolution: `AMORE_BIN` environment variable, else `amore` on `PATH`.
Missing binary at `--tier 2` exits nonzero with an honest message (no stack
trace). The model id stored on edges is the id **reported by the envelope**,
never a hardcoded product default. Zero provider SDKs and zero API keys in this
package — the model path is the user's own amore configuration.

Passing edges land with `tier: "2"`, `mechanism: judged`, the envelope model id,
timestamp, and quote + source.

## Edge identity

Stable short id = first 12 hex chars of `sha256(type|source|target)` after
normalization. Used by `list` / `show` / `remove` / `edit`.

## CLI

```
iris edges derive [--house <dir>]
iris edges update [--tier 0|1|2] [--json] [--house <dir>]
iris edges list [--type] [--source] [--target] [--asserted-by]
                [--tier structural|0|2] [--mechanism structural|judged]
                [--confidence asserted|inferred] [--model <id>]
                [--recent <n>] [--since <iso>] [--json]
iris edges show <id>
iris edges edit <id> --note "..." | --label "..." | --clear-note | --clear-label
iris edges remove <id>
iris edges validate
iris edges stats
```

### `edges update` summary (`--json`)

Machine-readable payload includes `added`, `updated`, `suppressed`, `byTier`,
and when tier ≥ 1 a `candidates` block; when tier 2 a `judge` block (model,
accepted, rejected, quote-gate fails). Exit 0 on success including the
no-new-edges case; nonzero on spawn failure or bad argv.

### Review filters

After a tier-2 run, inspect judged edges with:

```
iris edges list --mechanism judged --recent 20
iris edges list --tier 2
iris edges show <id>
```

`--recent <n>` keeps the N most recent edges by `provenance.ts` (after other
filters). Removal, suppression, and override stay the shipped stewardship verbs;
there is no approval queue.

## Store

| File | Role |
|------|------|
| `graph/edges.jsonl` | Served edges (structural + judged) |
| `graph/suppressions.jsonl` | Durable removes (re-derive / re-ingest will not re-create) |
| `graph/overrides.jsonl` | Durable note/label edits (merged on re-derive) |
