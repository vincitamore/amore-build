# graph/

Typed edge store for the house knowledge graph.

## Model

Structural derivation writes straight into the served store. There is no approval
gate and no candidates queue for tier-0 edges. After edges land, review, edit,
and remove are after-the-fact stewardship verbs. Removing or annotating an edge
is durable across the next `iris edges derive`: suppressions keep removed edges
from returning, and overrides re-apply user notes and labels on top of deriver
output (user fields win).

## Files

| File | Role |
|------|------|
| `edges.jsonl` | Canonical served edges — one JSON object per line. The iris daemon merges this into `/api/graph?edges=semantic` or `edges=both`. |
| `suppressions.jsonl` | Durable remove records. Each line is a suppressed `(type, source, target)` so structural re-derive will not re-create that edge. |
| `overrides.jsonl` | Durable edit records for user-adjustable fields (`note`, `label`). On re-derive the deriver edge is kept and these fields are merged in. |

## Populate

Run structural derivation after authoring lifecycle fields and self-labels:

```
iris edges derive
```

Tier-0 derive reads deterministic facts from the house tree:

- task `blocked-by:` paths / wikilinks → `depends-on`
- inbox `resolution:` wikilinks → `resolved-by`
- body self-labels `[[target]] (type)` for the served type set
- frontmatter `supersedes:` / `superseded-by:`

Edges write straight into `edges.jsonl` (asserted). Re-running derive is safe:
new facts are added, vanished structural facts are dropped, hand-authored edges
are left alone, suppressions stay suppressed, and overrides re-apply.

## Edge identity

Each edge has a stable short id: the first twelve hex characters of
`sha256(type|source|target)` after undirected normalization. List and show print
that id; remove and edit accept the full id or a unique prefix of at least six
hex characters. The id is derived, not stored as a separate field on the edge
line, so it stays stable when the store is rewritten.

## Review verbs

```
iris edges list
iris edges list --type depends-on
iris edges list --source tasks/blocked.md
iris edges list --target tasks/blocker.md
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

`list` and `show` print a compact table or detail block by default. Pass `--json`
for the structured envelope every other iris verb uses.

### Remove

`iris edges remove <id>` deletes the edge from `edges.jsonl` (atomic rewrite) and
appends a suppression record with the edge key, id, and timestamp. On the next
derive, a structural edge with the same key is not re-written.

### Edit

`iris edges edit <id>` adjusts user-adjustable fields only: `note` and `label`.
The change is written into the served edge and into `overrides.jsonl`. On
re-derive the structural body may refresh from the house tree, then the override
is merged so the annotation remains.

### Merge rule

1. Derive structural edges from the house tree.
2. Drop any edge whose `(type, source, target)` is in `suppressions.jsonl`.
3. Leave non-structural edges untouched by structural reconcile.
4. Apply `overrides.jsonl` note/label onto matching keys (override wins).

## Graph view

When `edges.jsonl` contains at least one typed edge, the Graph member defaults
the typed-edge overlay on. When the file is missing or empty, the overlay
defaults off. The config modal toggle still overrides the auto default for the
session. Open the iris Graph member, or fetch
`/api/graph?edges=semantic&shape=v2`, to paint the fifteen relation types in six
families over the wiki link layout.
