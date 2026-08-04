# @amore/regula

> *regula* — Latin: the Rule. As a monastic Rule governs the life of an order, this
> package governs the life of an org-system document: which lifecycle transitions are
> legal, and where a file must live.

**regula is the single write/schema/lifecycle authority for the org system.** It is
shared by the iris **CLI** (the agent surface) and the iris **TUI** (the operator
surface) so that a mutation — "complete this task", "resolve this inbox item" — is done
*correctly by construction* from one place, rather than re-encoded per client.

It exists to remove a duplication: the schema and lifecycle logic was previously
re-implemented in the examen MCP (TypeScript) and the iris client (TypeScript)
independently — two write-encoders of the same schema. regula is the one encoder both
now defer to; examen retired once the CLI reached parity (its code is archived).

## Division of authority

- **regula** owns *writes* — schema, legal status transitions, folder placement, lint.
- **The iris daemon** owns *reads* — the index, graph, backlinks, search.

The CLI is hybrid: it mutates through regula (direct-file, daemon-independent) and reads
the index over the daemon's HTTP API.

## Canonical source

In amore, the orient surface is **`AGENTS.md`** (schemas + house doctrine). The
task/inbox/knowledge/reminder domains encode the house AGENTS.md surface — amore admitted `review`/`incubating` to close the
last gap on 2026-07-30. This package is a faithful machine-readable encoding of those
schemas, not a competing definition. When the schema surface changes, regula changes
with it.

## Layout

- `src/schema.ts` — the pure spine: document types, status domains, and placement rules
  as total functions with no I/O.
- `src/index.ts` — public entry.
- verbs (create / update / complete / resolve / lint …) build on the spine.

## Test

```
bun test
```
