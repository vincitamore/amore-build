# graph/

Typed edge store for the house knowledge graph.

## Trust model

Derived edges land **live** in `edges.jsonl` with tier and provenance. There is
no approval queue. Review, edit, and remove are after-the-fact stewardship:
suppressions keep removed edges from returning, and overrides re-apply user
notes and labels (user fields win).

For model-judged edges, a mechanical **quote gate** requires the supporting
quote to appear verbatim in the named source file before ingest. That is
validity, not approval.

## Files

| File | Role |
|------|------|
| `edges.jsonl` | Canonical served edges — one JSON object per line. The iris daemon merges this into `/api/graph?edges=semantic` or `edges=both`. |
| `suppressions.jsonl` | Durable remove records. Each line is a suppressed `(type, source, target)` so re-derive and re-ingest will not re-create that edge. |
| `overrides.jsonl` | Durable edit records for user-adjustable fields (`note`, `label`). |

## Populate

### Tier 0 — structural (default, no model)

```
iris edges derive
iris edges update --tier 0
```

Reads deterministic facts from the house tree:

- task `blocked-by:` paths / wikilinks → `depends-on`
- inbox `resolution:` wikilinks → `resolved-by`
- body self-labels `[[target]] (type)` for the served type set
- frontmatter `supersedes:` / `superseded-by:`

### Tier 1 — candidate inventory (no model, no land)

```
iris edges update --tier 1 --json
```

Reports co-link, rare-tag, and unlabeled-wikilink candidates that tier 2 would
judge. Does not write edges.

### Tier 2 — model-assisted (explicit only)

```
iris edges update --tier 2
iris edges update --tier 2 --json
```

Runs gen → judge → quote-gated live ingest. Requires a working `amore` binary
(`AMORE_BIN` or on `PATH`). The model is whatever the user's amore configuration
selects; vinculum does not pin a provider or model id. Default tier when
`--tier` is omitted is **0** so ordinary runs never call a model.

## Edge identity

Each edge has a stable short id: the first twelve hex characters of
`sha256(type|source|target)` after undirected normalization. List and show print
that id; remove and edit accept the full id or a unique prefix of at least six
hex characters.

## Review verbs

```
iris edges list
iris edges list --type depends-on
iris edges list --mechanism judged
iris edges list --tier 2
iris edges list --recent 20
iris edges list --since 2026-08-01T00:00:00.000Z
iris edges list --asserted-by structural-v0
iris edges list --json
iris edges show <id>
iris edges edit <id> --note "why this edge stays"
iris edges edit <id> --label "blocker"
iris edges edit <id> --clear-note
iris edges remove <id>
iris edges stats
iris edges validate
```

`--recent <n>` keeps the N newest edges by provenance timestamp after other
filters. Judged edges show `mechanism: judged` and the model id from the amore
envelope when present.

### Remove

`iris edges remove <id>` deletes the edge from `edges.jsonl` and records a
suppression. On the next derive or tier-2 ingest, that key will not re-land.

### Edit

`iris edges edit <id>` adjusts `note` and `label` only. The change is written
into the served edge and into `overrides.jsonl`.

### Merge rule

1. Derive structural edges from the house tree (tier 0).
2. Drop any edge whose `(type, source, target)` is in `suppressions.jsonl`.
3. Leave non-structural edges untouched by structural reconcile.
4. Apply `overrides.jsonl` note/label onto matching keys (override wins).
5. Judged edges from tier 2 merge by the same key; suppressions still win.

## Graph view

When `edges.jsonl` contains at least one typed edge, the Graph member defaults
the typed-edge overlay on. When the file is missing or empty, the overlay
defaults off. The config modal toggle still overrides the auto default for the
session. Open the iris Graph member, or fetch
`/api/graph?edges=semantic&shape=v2`, to paint the fifteen relation types in six
families over the wiki link layout.
