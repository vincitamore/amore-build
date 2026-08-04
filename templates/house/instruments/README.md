# instruments/

Tools that act on the house itself.

The distinction from `projects/` is what a thing points at. A project is work
you are doing. An instrument is something that reads, indexes, checks or
maintains the house around it — its subject *is* this tree.

Keeping them apart is worth the one extra folder: instruments tend to be
long-lived, boring and shared across everything, while projects come and go. Mixed
together, the instruments get lost among the work.

## iris

`amore init` installs **iris** here — the companion instrument for this
house. It provides:

- a **daemon** that indexes the house and watches it for changes, serving
  wikilink resolution, backlinks and fuzzy search
- a **CLI** for the org verbs — creating and moving tasks, inbox items,
  reminders and knowledge notes with their frontmatter kept correct by
  construction
- a **dash**, an interactive terminal view of the whole tree

Run `iris` with no arguments to open the dash, or `iris --help` for the
verbs. It operates only on directories on your machine.

If you would rather not have it, `amore init --no-iris` skips the install,
and removing this directory later breaks nothing else.

## Adding your own

Anything that maintains the house belongs here — a linter for your own
conventions, an importer that files things into `inbox/`, a report that runs
over `tasks/`. `scripts/` is the right place for one-file utilities; reach for
`instruments/` when a tool grows its own directory, dependencies or state.
