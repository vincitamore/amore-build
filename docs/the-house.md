# The house: why you launch from one place

Every doc in this repo mentions the house. This page explains the working
method behind it, because the mechanics make more sense once you see the
philosophy, and the philosophy is most of what this fork adds.

## Two ways to run a coding agent

The usual way: `cd` into a project, launch the agent, work, quit. The
agent's world is the checkout. Context lives and dies with the session, or
at best persists in a per-repo config file. Every project is a separate
acquaintance. A lesson learned refactoring one codebase is gone when you
open the next one, and anything that spans projects (a deploy convention, a
security posture, a half-finished migration across three repos) has no
place to exist at all.

The house inverts this. The agent gets a residence: one directory, created
once with `amore init`, that you launch from every time, whatever you are
working on. Projects are what you reach into from there. The question stops
being "what does the agent know about this repo" and becomes "where did we
leave off."

## What a house holds

- **Orientation surfaces** the agent reads at session start: `AGENTS.md`
  (identity, structure, disciplines) and `context/current-state.md` (where
  the last session left off; the session that changes reality updates it
  before ending).
- **Org schemas** with frontmatter as the single source of truth: `tasks/`
  with a status lifecycle, `inbox/` for captures and open questions,
  `knowledge/` for distilled lessons, `reminders/` with due dates, `forge/`
  for multi-agent pipeline records.
- **A principle lattice** under `.amore/rules/`, injected as session
  context: the standing doctrine every judgment fires through, independent
  of which project is on the bench.
- **Skills and hooks**: orchestration skills for multi-agent work, a
  session-init hook that surfaces due reminders on arrival, and a stop gate
  that asks the agent whether it left the tree in order before ending a
  turn.

## What the house keeps

The point of the house is time. A per-repo agent starts every session from
zero; a house session starts mid-relationship. Current-state says what is
in flight. Tasks carry campaigns that span weeks. Knowledge holds every
lesson that survived contact with real work, searchable and cross-linked.
Reminders fire when due, whatever else the session is about.

Cross-project doctrine becomes possible because it finally has a place to
live. A gotcha found deploying one service gets banked in `knowledge/` and
applies to the next service, because the bank belongs to the house, not to
either repo. After months of this the house is the most valuable tree you
own: not the code (the code has its own repos) but the record of how you
and the agent actually work.

## Where projects live

`projects/` inside the house is gitignored by design. A repo cloned there
keeps its own history, its own remotes, its own log. The house repo tracks
everything *around* the work: the decisions, the running context, the
lessons, the conventions. Projects can also sit beside the house as sibling
directories; the house reaches them by relative path. Either way the
boundary holds: **the house tracks the house.** Nothing stops a project
from carrying its own `.amore/` config for anyone who visits it the
ordinary way: the two models compose.

## Where this comes from

None of this is speculative design. It is the distillation of a working
method practiced daily for months: an operator and an agent running
everything (infrastructure, code, research, publishing) from single
long-lived houses, one per collaboration. The template `amore init` plants
is the transferable part of that practice: the schemas that survived use,
the hooks that earned their keep, the disciplines that kept the trees
honest. The parts that were personal stayed home.

## The shape of a day

Launch `amore` in the house. The session-init hook surfaces anything due.
The agent orients from `AGENTS.md` and current-state, picks up the active
task, and pivots into whatever project the work needs. On the way out:
lessons get banked to `knowledge/`, state gets written to current-state,
and the stop gate asks whether the tree is in order before the session
ends. The next session, tomorrow or in a month, starts where this one
stopped.

Continuity lives in the architecture, not in anyone's memory.
