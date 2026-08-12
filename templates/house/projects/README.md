# projects/

The work itself lives here.

The rest of the house is *about* work - what is queued (`tasks/`), what arrived
unsorted (`inbox/`), what was learned (`knowledge/`), where things stand
(`context/`). This is where the actual subjects of that work sit: the codebases,
the documents, the things being built.

## Why the house has a projects folder at all

The house is the directory you launch the agent from, every time - not a
config overlay you drop into one repo. That is the whole point of the shape: the
agent starts in a place that already knows your tasks, your conventions and what
happened last session, and the projects are visible from there.

Working on a project from inside the house means the agent can move between it
and the surrounding context without being re-briefed - a task in `tasks/` can
name a file in `projects/`, a lesson learned goes to `knowledge/`, and the next
session finds all three still connected.

## How to put something here

Anything that works for you. Common shapes:

- **Clone or move a repository in.** `projects/` is git-ignored by the house,
  so a project keeps its own history, its own remote and its own log instead of
  being swallowed as an embedded checkout. Nothing to configure.
- **Start a new one in place.** `projects/<name>/`, and it inherits the house's
  conventions for free.
- **Symlink one that must live elsewhere.** Useful when a project has to stay at
  a path some other tool expects.

There is no required layout inside a project directory - the house has opinions
about *organizing work*, not about how your code is arranged.

## What does not belong here

- Long-lived reference material you are not actively changing → `knowledge/`
- Tools that operate on the house itself → `instruments/`
- A scratch file you have not decided about yet → `inbox/captures/`
