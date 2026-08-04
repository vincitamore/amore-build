# @amore/parity

>A **golden-master harness** for the daemon's HTTP surface. It records what the
> daemon actually answers, and later diffs a target daemon against that
> recording. Use it when changing the daemon and you want proof the read surface
> did not move underneath its clients.

## The discipline

A daemon's real contract is not the handler signatures — it is whatever its
clients already depend on, byte for byte. That is not something you can write
down once and keep true. So instead of asserting the contract, **record it**:
capture the running daemon's responses and treat the recording as the spec.

This is how the current Bun daemon was validated when it replaced an earlier
implementation (the legacy Rust/Axum daemon, archived at
`archive/instruments/vitrum-legacy/src-tauri/`), and it works the same way for
any later change: record before, replay after.

Two moves:

1. **`record`** fires a fixed set of representative requests (the *case matrix*,
   `src/cases.ts`) at a base daemon and freezes each response — status,
   content-type, and body (JSON pretty-printed with **sorted keys** for stable
   diffs; non-JSON stored raw) — under `golden/`.
2. **`replay`** re-fires those same requests at a *target* daemon and
   structural-diffs each response against its golden. All-pass ⇒ the target's
   read surface matches the recording. Any diff is a parity gap.

### Why goldens are ephemeral

The org tree is a **living corpus** — automation and the operator write
to it continuously. A recorded `/api/graph` body is only true *for the corpus
moment it was recorded in*: the moment the edge store regenerates or a document
is added, the recording is stale. So goldens are **not a tracked artifact** —
`golden/` is `.gitignored`. Re-recording is cheap (seconds); a stale golden that
"looks tracked" is a lie waiting to mislead.

What **is** tracked (the spec):

- `src/inventory.ts` — the discovered endpoint inventory (below).
- `src/cases.ts` — the case matrix + the ratified-divergence ignore paths.
- `src/manifest.ts` — the golden-record + run-manifest **schema** (its instances
  live under `golden/`, ephemeral).

### The record → replay-same-moment rule

Because goldens are moment-local, **record and replay must straddle the same
corpus moment.** The flow when validating a change:

```
parity record  --base   http://127.0.0.1:3853    # the daemon as it stands, now
parity replay  --target http://127.0.0.1:3853    # after your change, seconds later
```

Both daemons must read the **same** org tree at the **same** time. If minutes
pass and the corpus moves between record and replay, the graph/files/search
bodies will legitimately diverge — that is corpus drift, **not** a parity gap,
and it is why the flow is record-then-immediately-replay. The `smoke.test.ts`
self-test enforces the floor of this: record against the daemon, then
replay against *itself* — which must be 100%, because nothing has changed. (It
skips cleanly when no daemon answers.)

### What is *not* ignored

The ignore list (`IGNORE` in `src/cases.ts`) suppresses only **per-call**
non-determinism — a field that changes between two back-to-back calls to the
*same* daemon:

| Endpoint | Ignored path | Why |
|----------|--------------|-----|
| `/api/health` | `timestamp` | `chrono::Utc::now()` — advances every call |
| `/api/status` | `server.uptime`, `server.lastIndexed` | elapsed-seconds + per-request `Utc::now()` |

Everything else is compared. In particular, **corpus drift is never ignored** —
you cannot ignore the graph body, because the graph body *is* the surface being
spec'd. Drift is handled by temporal proximity (record→replay same moment), not
by an ignore path.

### Ratified order-canonicalization (2026-07-02)

Discovered while building the Bun daemon (milestone 2): the legacy daemon's
collection ordering is Rust **`HashMap` iteration order** — stable within one
process, **reseeded on every restart**. So the element order of
`/api/files.items`, `/api/search.items` (intra-score-tier), and
`/api/graph.nodes`/`.links` (doc-order segments) is not a contract any client
can rely on, and not a behavior any rewrite can reproduce. (Milestone 1's
self-replay never exercised this: same process ⇒ same hash order.)

The `CANON` table in `src/cases.ts` lists those arrays with a sort-key spec;
`replay` sorts **both** the golden body and the target body by that spec before
diffing (`src/canon.ts`). Element **content** is still fully compared — this
suppresses order only, never a value, a membership, or a count. Arrays not
listed (projects, trees, presets, `status.tags.top`, `status.recent`) remain
order-significant. `/api/search` rider: score-descending rank is real contract
but unrecoverable from the body (no score field), so the replay gate is
set-equality of the top-50; rank fidelity is exercised separately
(`packages/daemon/scripts/search-probe.ts`).

## Verbs

The CLI follows the house contract: `--json` emits an ok-first envelope; default
output is human-readable; ratified exit codes (`0` all-pass · `1` a case
diverged · `2` infra · `64` usage · `69` daemon unreachable · `124` timeout).
`parity commands --json` is the capability manifest.

| Verb | Purpose |
|------|---------|
| `parity commands [--json]` | Capability manifest (the verb table itself). |
| `parity inventory [--tier T] [--json]` | The discovered endpoint inventory + tier counts. |
| `parity cases [--json]` | The case matrix — one row per recorded request. |
| `parity record [--base URL] [--out DIR] [--json]` | Record every core case into `golden/` (default base `http://127.0.0.1:3853`). Read-only GETs against the daemon. |
| `parity replay --target URL [--golden DIR] [--max-diffs N] [--json]` | Re-fire the recorded cases at a target and diff bodies vs golden. Exit `0` all-pass / `1` any-fail. |

## Endpoint inventory (tiers)

Discovered — not invented — from the legacy router build
(`archive/instruments/vitrum-legacy/src-tauri/src/server/mod.rs` + `federation.rs`)
cross-referenced against every real `/api/` call site in the clients
(`packages/tui`, `packages/cli`). **114 registered routes:**

| Tier | Count | Meaning |
|------|-------|---------|
| **core** | 11 | A read with ≥1 real client consumer. **Recorded by default.** |
| **inventory** | 0 | Registered but no client consumer found. Not recorded (no observed contract). |
| **mutating** | 7 | Org-data writes (POST/PUT/PATCH/DELETE). Deferred to a later, fixture-based phase — side-effects need fixtures, not goldens. |
| **excluded** | 96 | Out of scope for the read-parity harness (one-word reason each). |

Excluded breakdown: `federation` 54 · `proxy` 20 (proxy/oraculum
pass-through) · `pty` 14 (terminal + PTY-daemon mgmt, dead) · `auth` 6 · `websocket` 1 · `debug` 1.

The 11 core endpoints (**22 cases**): `/api/health`, `/api/status`,
`/api/launch-presets`, `/api/files` (list), `/api/files/{*path}` (get +
backlinks), `/api/assets/{*path}` (non-JSON), `/api/search`, `/api/graph`
(wiki / semantic / both edge modes + scope), `/api/projects`,
`/api/projects/{name}/tree`, `/api/projects/{name}/file/{*path}`.

## Test

```
bun test              # differ units + inventory sanity + live smoke self-test
bunx tsc --noEmit     # typecheck
```

The smoke self-test records against `http://127.0.0.1:3853` and replays against
the same daemon (must be 100%); it **skips cleanly** when no daemon answers, so
the suite is green online or offline. Override the base with
`PARITY_SMOKE_BASE`.
