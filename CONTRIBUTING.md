# Contributing

Issues and pull requests are welcome. A few project tenets to know before you
start — they keep the fork healthy and reviews fast.

## What this project is

Arcus Build is a **permanent, engineered fork** of xAI's open-source
`grok-build` (Apache-2.0). It is its own product with its own roadmap; it is
not an upstream contribution queue and not an xAI project. See
`UPSTREAM.md` for the provenance and sync relationship.

## Tenets reviews enforce

1. **Thin diff over upstream.** New files and additive seams beat edits to
   upstream files. Crate names stay `xai-grok-*` — renaming crates is
   explicitly out of bounds (diff-hygiene ruling). If a change can be an
   upstream PR, propose it upstream instead.
2. **`.arcus` config-dir semantics.** Every repo-level config surface is
   `.arcus/` first, with `.grok/` scanned as the legacy fallback (`.arcus`
   wins when both exist). Home is `~/.arcus`; env surface is `ARCUS_*`
   primary with `GROK_*` legacy aliases (`XAI_API_KEY` unchanged — it names
   the provider).
3. **Auto-update and upstream reinjection stay off.** A fork must never
   update itself back into upstream.
4. **Changelog doctrine.** Any user-visible change updates BOTH
   `crates/codegen/xai-grok-shell-base/assets/arcus-changelog.md` and
   `arcus-changelog.json` in the same commit — the welcome screen and
   `/release-notes` render from them, compiled in.
5. **Templates stay generic.** Everything under `templates/house/` teaches the
   *adopter's* house — no references to this repository's own development
   environment, maintainers, or private tooling. CI enforces a forbid list
   (`scripts/forbid_check.py`).
6. **No secrets, ever.** `~/.arcus/auth.json`, API keys, tokens — never in a
   commit, a log, or a test fixture.

## Build & test

Prereqs: Rust via the repo-pinned toolchain (`rust-toolchain.toml`),
`protoc` on PATH; Bun 1.3.x only if you work under `instruments/iris/`.

```sh
cargo build --release -p xai-grok-pager-bin   # target/release/arcus
cargo test --lib -p <crate-you-touched>       # per-crate gate; keep failures at zero
```

Windows hosts: the release link may need
`cargo rustc -p xai-grok-pager-bin --release -- -Clink-args=/DEBUG:NONE -Clink-args=/STACK:8388608`
(MSVC PDB-writer limit + startup stack reserve), and pager-shell tests use
`--skip standalone_color_uses` (an upstream brand-detection assumption).
Drive built binaries from PowerShell/cmd — not git-bash.

## CI

`ci.yml` (Linux + Windows build/test) and the forbid-grep run on every PR.
Both must be green; `docs`-only changes still run the forbid lane. Iris CI
 (`iris-ci.yml`) is scoped to `instruments/iris/**`.

## Style

Match the code around you; keep upstream-file edits minimal and commented
with a short `// arcus:` note where the diff touches shared seams.
