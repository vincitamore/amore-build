# {{HOUSE_NAME}}

> Cooperation harness for long-running multi-session agent work on
> **Arcus Build** (fork of Grok Build). One continuous working tree —
> continuity lives in architecture, not in any single model's memory.

## Identity

This house is **{{HOUSE_NAME}}**. Customize after init: house name, project
facts, stack notes the next session must know. **Self-updating for structure,
never for state** — new folder/schema/discipline → edit here; task/inbox/
knowledge state → [[context/current-state]]. When this file accretes past
utility, compress.

## Harness of record

Project config lives at **`.arcus/`** (highest-precedence skill and hook root;
`.grok` and peer tool dirs remain fallbacks). User-tier skills sit at
`$GROK_HOME/skills` (default `~/.arcus/skills`). Native multi-agent surfaces
(`spawn_subagent`, monitors, workflows) are the freight path — harness docs
own tool spellings.

### Hooks (installed by init — first-class)

`arcus-build init` plants project-tier hooks under `.arcus/hooks/`:

| Hook | Event | Role |
|------|-------|------|
| **Stop gate** | `Stop` (turn end) | Maintenance vigilance — durable work uncaptured? |
| **Session init** | `SessionStart` | Orientation pointer + surface due reminders |

**Stop gate release.** Fires at most once per operator turn on org workspaces
(this tree has `AGENTS.md` + `tasks/`). Releases when any of:

1. **Release phrase** — next assistant message contains exactly one of these as
   its own plain-text line (not inside a tool call, not mid-paragraph):
   `No maintenance needed` · `Maintenance complete` ·
   `Maintenance not required` · `Gate released`
2. **Capture-write soft-ack** — this turn already wrote under a capture path
   (`knowledge/`, `inbox/`, `tasks/`, `reminders/`, `context/`,
   `forge/{handles,output,sessions}/`, `.arcus/skills/`). Manufacturing a
   low-value capture to satisfy the gate is worse than releasing honestly.
3. Trivial sessions, non-org workspaces, and non-`end_turn` fires never block.

If in doubt whether real maintenance is owed, **release**.

**Disable:** `arcus-build init --no-hooks`, or remove/rename the registration
under `.arcus/hooks/`. Hooks are tool-owned — `init --refresh` may restore
them; keep a local note if you intentionally disable.

**What the gate asks you to consider:** insight → `knowledge/`; decisions /
investigations / ideas → `inbox/`; new work → `tasks/`; time-bound →
`reminders/`; focus shift → `context/current-state.md`; resolved inbox →
terminal fields + move to `inbox/<type>/resolved/` same-breath; durable work
not on origin → commit (push per operator policy).

## Orientation

1. **This file** — identity, structure, disciplines.
2. **`context/current-state.md`** — where the last session left off; the session
   that changes reality updates it before ending.
3. **The active task** it points to (under `tasks/`).

At arrival: run this ladder, then surface **due reminders**. The SessionStart
hook points at this ladder and lists due items — a prompt, not a substitute
for reading the surfaces.

<!-- IF NO-LATTICE: begin remove — lattice orientation paragraph -->
The principle lattice (`context/principle-lattice.md`) ships **default-on**
with this house and is the normative lens every judgment fires through. Keep it
local; regenerate derived orientation material after lattice edits (see
`scripts/sync-orientation-rules.py` when present).
<!-- IF NO-LATTICE: end remove -->

<!-- IF NO-LATTICE: begin insert — no-lattice fallback (optional one-liner)
Session discipline and the schemas below are the whole normative floor when no
lattice is installed.
IF NO-LATTICE: end insert -->

## Context-surface discipline

Adding a session-start surface requires **(a)** a single sentence naming the
role no existing file can carry, and **(b)** an explicit decision —
unconditional, or conditional with a named trigger. Unconditional surfaces cap
at five;
<!-- IF NO-LATTICE: begin remove — lattice slot note -->
the lattice rides orientation and does not consume a slot.
<!-- IF NO-LATTICE: end remove -->
Do not invent new always-on briefings. Prefer extending `current-state`, a
skill, or a conditional surface with a named trigger.

## Multi-house note

If you run more than one house tree, **never replicate dynamic state** across
them (tasks, inbox, current-state). Cite a live item in another tree by path;
do not quote it as this house's state. Port patterns by regenerating doctrine
into this house's `knowledge/` — regenerate, don't paraphrase.

## Skills

House skills live at `.arcus/skills/<name>/SKILL.md`. Metadata rides the
system prompt at session start; bodies load on demand (`read_file`,
`skill://<name>`). Subagents inherit the discovered list. User-tier skills under
`~/.arcus/skills` apply across projects.

Bundled skills (tool-owned; refreshable by `arcus-build init --refresh` —
fork to a new directory name to customize without losing edits):

| Skill | Purpose |
|-------|---------|
| `forge-master` | Dynamic pipeline orchestration — topology, dual-write, manifests |
| `auriga` | Budget-aware campaigns over large enumerated action spaces |
| `oeconomia` | Delegation economy — explicit model/tier choices, priced dispatches |
| `prokope` | Goal-loop engineering for long-horizon, multi-session campaigns |
| `sortes` | External decorrelation draws for review/ideation fan-outs |
| `isda` | Irreducible Semantic Density Analysis — text compressibility |
| `sentinel` | Base discipline for session-hosted bounded watches |

**Authoring:** frontmatter `name` + `description` only; description = TRIGGER +
SKIP + disambiguation; progressive disclosure; assets under the skill dir via
`skill://<name>/<path>`. Layout follows the Agent Skills convention
(SKILL.md + optional `bin/`, `references/`, `examples/`).

## Working relationship

- Collaborative thinking, not service delivery. Disagree when warranted; a
  clear position delivered straight beats a hedge.
- Continuity lives in the tree: write what the next session needs into tasks,
  current-state, and knowledge.
- Match energy — technical when technical, philosophical when reaching.
- No servility, no padding, no invented facts. If you don't know, say so and
  name what would settle it.
- Evidence before assertion, at the tier claimed — **absence claims carry the
  same bar as presence claims** (enumerate fully before concluding "none").

## Data handling

- **The tree is not the session.** No credentials, keys, or tokens committed to
  git, whatever the session may see. Personal information in committed
  artifacts gets care, not paranoia.
- Push / remote policy is the operator's. When in doubt, ask.
- Do not copy auth files between machines or install directories — each
  install authenticates independently.

## Folder structure and schemas

Frontmatter is the single source of truth.

```
{{HOUSE_ROOT_LABEL}}/
├── AGENTS.md              # This file (user-owned after init)
├── context/               # current-state; principle-lattice (default-on)
├── inbox/                 # captures/ decisions/ investigations/ ideas/ (+ resolved/)
├── tasks/                 # active/blocked at root; review/ backlog/ incubating/ paused/ completed/
├── knowledge/             # distilled insights across sessions
├── reminders/             # time-based obligations (see reminders/README.md)
├── forge/                 # pipeline products (see forge/README.md)
│   └── handles/ output/ sessions/
├── scripts/               # house utilities (lint, orientation sync, …)
└── .arcus/               # skills/, hooks/ (stop gate + session init)
```

Empty containers carry `.gitkeep`. Optional later: `instruments/` — not required.

### Tasks (`tasks/**/*.md`)

```yaml
type: task
status: active | blocked | review | backlog | incubating | paused | complete
created: YYYY-MM-DD
completed: null
tags: []
blocked-by: []            # when status: blocked
paused: null              # date, when status: paused
paused-reason: null
trigger-to-unpause: null  # named falsifiable trigger, when paused
```

Folders follow status: `active`/`blocked` at `tasks/` root; `tasks/review/`,
`tasks/backlog/`, `tasks/incubating/`, `tasks/paused/`, `tasks/completed/`.
Add a status value only when the corpus demands it; record the admission here.

### Knowledge (`knowledge/**/*.md`)

```yaml
type: knowledge
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: []
```

New folder at 3+ clustered articles; singletons stay at root; search before
writing; Problem/Fix/Related preferred; tag generously — tags are graph edges.
A `knowledge/README.md` index is admitted when scanning gets expensive
(~25 articles).

### Inbox (`inbox/**/*.md`)

```yaml
type: inbox
created: YYYY-MM-DD
source: capture | operator | session
status: open | resolved | dropped | superseded
resolved: null        # date the resolving work shipped
resolution: ""        # one line + wikilink to where it landed
```

Lifecycle (decisions / investigations / ideas): terminal status sets
`resolved:` + `resolution:`, file moves to `inbox/<type>/resolved/` — active
folder is the open queue. **Resolutions land in the same breath as the
resolving work.** `captures/` has no lifecycle; triage it to empty.

### Reminders (`reminders/**/*.md`)

Schema in [[reminders/README]] (`type: reminder`,
`status: pending | snoozed | ongoing | completed | dismissed`, `remind-at`,
repeat fields). The **arriving session** (and SessionStart hook) checks for due
items (`remind-at` / `snoozed-until` ≤ now, status `pending` / `snoozed`) and
surfaces them.

### Forge (`forge/**/*.md`)

Directives in [[forge/README]]. Threshold: 3+ parallel agents or 2+ pipeline
layers; below that, forge-lite (one `forge/output/<topic>.md`, summary on top).
Keep handles/sessions campaign-scoped; prune at completion.

## Conventions

**Checkboxes:** `[ ]` todo · `[x]` done · `[/]` in-progress · `[>]` blocked ·
`[?]` needs-input · `[!]` urgent · `[-]` cancelled.

**Cross-linking:** every document carries at least one meaningful `[[wikilink]]`.
Path-style, extension omitted (`[[tasks/completed/example-task]]`).

**Tags:** maximize interconnectedness — domain, principle, status where relevant.

**Index files:** `README.md` folder indexes carry `type: index` in frontmatter.

## Session discipline

- **Arrive:** orientation (this file → current-state → active task), surface due
  reminders, then work. SessionStart assists; you still own the read.
- **Work:** keep the task file current; capture reusable insight to `knowledge/`;
  file open questions and decisions to `inbox/`, resolving same-breath.
- **Evidence bar:** an absence claim is a claim — enumerate fully (never
  truncate a listing between search and conclusion), filter by predicate and
  count, re-run when the claim goes durable.
- **Leave:** update [[context/current-state]] (standing reality only; keep it
  short enough to re-read every session), commit with a message the next
  session can orient from, push per operator policy.
- **Honesty over polish:** "I could not do X, here is where I stopped and why"
  beats papering over a gap.
- Answer mechanical steps directly; spend depth where the problem needs it.
- At turn end the stop gate may fire — release or capture honestly (Hooks).

## Self-update rule

This file updates for **structure**, never for **state**. Structure = folders,
schemas, disciplines, skill catalog, hook contract. State lives in
`context/current-state.md`, `tasks/`, `inbox/`, and `knowledge/`. When doctrine
here drifts from how the house runs, fix this file same-session.

