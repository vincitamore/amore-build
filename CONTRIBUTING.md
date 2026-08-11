# Contributing

Issues and pull requests are welcome. A few project tenets to know before you
start: they keep the fork healthy and reviews fast.

## What this project is

Amore Build is a **permanent, engineered fork** of xAI's open-source
`grok-build` (Apache-2.0). It is its own product with its own roadmap; it is
not an upstream contribution queue and not an xAI project. See
`UPSTREAM.md` for the provenance and sync relationship.

## Tenets reviews enforce

1. **Thin diff over upstream.** New files and additive seams beat edits to
   upstream files. Crate names stay `xai-grok-*`: renaming crates is
   explicitly out of bounds (diff-hygiene ruling). Note that upstream accepts
   no external contributions, so a change that is really an upstream fix
   still lands here, but write it as the smallest possible delta in the
   upstream file, marked with a fork comment, so the next sync merge carries
   or supersedes it cleanly.
2. **`.amore` config-dir semantics.** Every repo-level config surface is
   `.amore/` first, with `.grok/` scanned as the legacy fallback (`.amore`
   wins when both exist). Home is `~/.amore`; env surface is `AMORE_*`
   primary with `GROK_*` legacy aliases (`XAI_API_KEY` unchanged: it names
   the provider).
3. **Updates come only from this fork's own releases.** A fork must never
   update itself back into upstream. The origin module
   (`self_update/origin.rs`) and verify group 11 pin the release host; the
   check path never reaches an xAI installer. Users upgrade from Amore Build
   GitHub Releases (installer today; `amore update --check` reports
   availability).
4. **Changelog doctrine.** Any user-visible change updates BOTH
   `crates/codegen/xai-grok-shell-base/assets/amore-changelog.md` and
   `amore-changelog.json` in the same commit: the welcome screen and
   `/release-notes` render from them, compiled in.
5. **Templates stay generic.** Everything under `templates/house/` teaches the
   *adopter's* house: no references to this repository's own development
   environment, maintainers, or private tooling. Reviewers check this by
   reading; a string blocklist cannot catch a section that describes the wrong
   house.
6. **No secrets, ever.** `~/.amore/auth.json`, API keys, tokens: never in a
   commit, a log, or a test fixture.

## Build & test

Prereqs: Rust via the repo-pinned toolchain (`rust-toolchain.toml`),
`protoc` on PATH; Bun 1.3.x only if you work under `instruments/iris/`.

```sh
cargo build --release -p xai-grok-pager-bin   # target/release/amore
cargo test --lib -p <crate-you-touched>       # per-crate gate; keep failures at zero
```

Windows hosts: the release link needs `/DEBUG:NONE` (MSVC PDB-writer limit) and
`/STACK:8388608` (startup stack reserve). Pass them through the environment,
**not as `-Clink-args` on the command line**, which no shell survives: git-bash's
MSYS rewrites `/DEBUG:NONE` as a path, and PowerShell splits it at the colon.
Both produce the same misleading error, `multiple input filenames provided (…
and NONE)`, which reads like a source problem and is not one.

```sh
RUSTFLAGS="-Clink-arg=/DEBUG:NONE -Clink-arg=/STACK:8388608" \
  cargo build --release -p xai-grok-pager-bin
```

Pager-shell tests use `--skip standalone_color_uses` (an upstream
brand-detection assumption). Drive built binaries from PowerShell/cmd, not
git-bash.

## CI

`ci.yml` runs build + smoke on Linux and Windows, and the test suites on both;
it must be green. Iris CI (`iris-ci.yml`) is scoped to
`instruments/iris/**`.

## Style

Match the code around you; keep upstream-file edits minimal and commented
with a short `// amore:` note where the diff touches shared seams.
