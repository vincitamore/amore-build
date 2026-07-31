# Arcus Build

<pre>
⠀⠀⠀⠀⢀⣀⣤⣤⣶⣶⣶⣶⣶⣤⣤⣀⡀⠀⠀⠀⠀
⠀⢀⣴⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣦⡀⠀
⣶⣿⣿⣿⣿⣿⣿⣿⡿⠿⠿⠿⢿⣿⣿⣿⣿⣿⣿⣿⣶
⣿⣿⣿⣿⡿⠛⠉⠀⠀⠀⠀⠀⠀⠀⠉⠛⢿⣿⣿⣿⣿
⣿⣿⡿⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⢿⣿⣿
⣿⡿⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢿⣿
⣿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⣿
</pre>

**a terminal coding agent that is not a wrapper around one model**

Arcus Build (`arcus`) is a terminal AI coding agent: a full-screen TUI that
understands your codebase, edits files, runs shell commands, searches the web,
and drives long-running multi-agent work — interactively, headlessly for
scripting/CI, or embedded in editors via ACP.

It is a **permanent engineered fork** of xAI's open-source
[`grok-build`](https://github.com/xai-org/grok-build) (Apache-2.0). **Not an
xAI product, and not affiliated with any model vendor.** Upstream provenance
and sync cadence:
[`UPSTREAM.md`](UPSTREAM.md).

![Arcus Build — the welcome screen](docs/assets/welcome.png)

---

## Install

### Build from source

Requirements:

- **Rust** — pinned by [`rust-toolchain.toml`](rust-toolchain.toml); `rustup`
  installs it on first build.
- **[DotSlash](https://dotslash-cli.com)** — so hermetic tools under
  [`bin/`](bin/) (notably [`bin/protoc`](bin/protoc)) can download and run.
  Put `dotslash` on your `PATH` **before** building.
- **protoc** — resolved via DotSlash, or a `protoc` on `PATH` / `$PROTOC`.

```sh
git clone https://github.com/vincitamore/arcus-build.git
cd arcus-build

cargo install dotslash   # once, if needed
cargo run -p xai-grok-pager-bin              # build + launch the TUI
cargo build -p xai-grok-pager-bin --release  # release binary
```

The composition-root crate is `xai-grok-pager-bin`; the public binary name is
**`arcus`** (argv0 also tolerates `arcus-build`, `grok`, and `agent`). After a
release build the artifact is typically
`target/release/arcus` (or `arcus.exe` on Windows).

### Release assets

Prebuilt assets ship with **`v0.1.0`** (and later tags) on the project's
[GitHub Releases page](https://github.com/vincitamore/arcus-build/releases).
Install the binary for your OS/arch and put it on
`PATH`.

> **PATH note:** crates.io already publishes a Lua linter named `arcus`.
> That is a different tool. `arcus doctor` (and `arcus doctor --json`, field
> `pathCollision`) detects when another `arcus` on `PATH` would shadow Arcus
> Build — it reports the collision; it does not claim the two packages
> "conflict" as installs.

Home defaults to **`~/.arcus`** (override with `$ARCUS_HOME`; legacy
`$GROK_HOME` still works). Project config lives under **`.arcus/`** (`.grok/`
is kept as a legacy fallback; `.arcus` wins when both exist).

---

## Quickstart

The shipped default is **GLM-5.2** over OpenRouter, but nothing here is bound
to it: any OpenAI-compatible endpoint works, and the identity the model is
given does not name a model at all (see below). Native xAI grok is the
**second rail** (subagent freight + first-party catalog).

### Guided path (recommended)

On first interactive launch with no credentials resolved, Arcus opens a
setup wizard. You can also run it anytime:

```sh
arcus setup            # interactive wizard when on a TTY
arcus setup --headless # print steps without prompts
arcus setup --reset    # clear wizard state
arcus setup --force    # re-run past done/skipped
```

Hard guards: the auto first-run wizard **never** fires headless (`-p` / piped),
in CI, when `[agent] setup_on_first_run = false`, or after state is
done/skipped under `~/.arcus`. Team managed config is a separate path:
`arcus setup --managed` (legacy `arcus setup --json` still works).

### Manual paths (condensed)

Config: `~/.arcus/config.toml`. Prefer `env_key` over a literal `api_key`.
**Every** custom `[model.*]` block **must** set `system_prompt_label` —
an unlabeled model falls through the resolver chain to a default and will
confidently answer to the wrong name.

Give that label the **harness and the role, not the model**. Upstream renders
it as `You are <label>`, so a label naming the model becomes false the moment
you point the entry at a different one — and the block it lives in is
per-model already, so the model name is never the thing missing.

| Path | Model id (wire) | Base URL | Env |
|------|-----------------|----------|-----|
| **OpenRouter** (lowest friction) | `z-ai/glm-5.2` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| **Z.ai direct** | `glm-5.2` | `https://api.z.ai/api/paas/v4` | `ZAI_API_KEY` |
| **Any OpenAI-compatible host** | host-specific | your `/v1` base | host token env |

Minimal OpenRouter sketch:

```toml
[models]
default = "glm-openrouter"

[model.glm-openrouter]
model = "z-ai/glm-5.2"
base_url = "https://openrouter.ai/api/v1"
name = "GLM-5.2 (OpenRouter)"
env_key = "OPENROUTER_API_KEY"
system_prompt_label = "Arcus Build"
context_window = 1048576
# Reasoning tokens count against this. Too tight truncates mid-thought.
max_completion_tokens = 32768
```

Full recipes, pricing stamps, alternate hosts, and verify commands:
[`docs/setup-glm.md`](docs/setup-glm.md). Multi-provider sample:
[`examples/config.multi-provider.toml`](examples/config.multi-provider.toml).

```sh
export OPENROUTER_API_KEY="sk-or-..."   # your key
arcus -m glm-openrouter -p "Reply with exactly: ARCUS-OR-OK"
```

---

## Grok native (second rail)

Native grok subagent freight and first-party xAI models ride a **separate**
credential rail from your BYOK model:

```sh
arcus login                 # browser OAuth (PKCE) against xAI
arcus login --device-auth   # device-code for headless / remote
# or:
export XAI_API_KEY="xai-..." # console key; no OAuth required
```

BYOK primary + grok freight = **two meters, two credentials**. BYOK models
never require OAuth; session JWT is never sent to foreign hosts. Details:
[`docs/authentication.md`](docs/authentication.md).

---

## The cooperation harness

```sh
arcus init              # plant the house tree in a git repo
arcus init --dry-run    # plan only
arcus init --refresh    # rewrite files still matching the install manifest
```

`arcus init` installs the embedded pack (`templates/house/`): root
`AGENTS.md`, folder schemas (`context/`, `inbox/`, `tasks/`, `knowledge/`,
`reminders/`, `forge/`), skills, hooks, and
`.arcus/house-install.json`. **Lattice is default-on** (`--no-lattice`
opt-out); skills and hooks default-on (`--no-skills` / `--no-hooks`);
iris pointer note is opt-in (`--with-iris`). Ownership-aware: never
silently overwrites user edits; `--refresh` only rewrites files whose on-disk
hash still matches the manifest; `--force` overwrites (confirm, or `--yes`).

What got installed and what you own: [`docs/onboarding.md`](docs/onboarding.md).

---

## Iris companion

**Iris** is the optional companion instrument for house dash / regula
surfaces (tasks, inbox, reminders, knowledge). It is not bundled inside
`arcus init` by default — install and run it separately when you want that
UI. Pointer and install story: [`docs/iris.md`](docs/iris.md).

---

## Documentation

| Doc | What |
|-----|------|
| [`docs/setup-glm.md`](docs/setup-glm.md) | BYOK model paths (OpenRouter / Z.ai / any OpenAI-compatible host) |
| [`docs/authentication.md`](docs/authentication.md) | OAuth + BYOK dual rail, `auth.json` anti-copy rule |
| [`docs/onboarding.md`](docs/onboarding.md) | `arcus init` tree, ownership, refresh |
| [`docs/iris.md`](docs/iris.md) | Iris companion |
| [`UPSTREAM.md`](UPSTREAM.md) | Fork provenance and sync policy |
| [`examples/config.multi-provider.toml`](examples/config.multi-provider.toml) | Multi-provider config sample |

Deep feature reference ships in-tree with the pager crate:
[`crates/codegen/xai-grok-pager/docs/user-guide/`](crates/codegen/xai-grok-pager/docs/user-guide/)
(slash commands, theming, MCP, skills, hooks, headless, sandboxing, …). Some
paths there still use upstream brand spellings (`grok` / `~/.grok`); the fork
home is `~/.arcus` and the public binary is `arcus`.

Product env surface: **`ARCUS_*` primary** with silent `GROK_*` legacy
aliases (`ARCUS_HOME`, `ARCUS_DEFAULT_MODEL`, `ARCUS_SYSTEM_PROMPT_LABEL`,
`ARCUS_AUTH_*`, …). Provider keys (`XAI_API_KEY`, other vendor keys) stay
unaliased. Auto-update is hard-off in this fork (no in-app xAI reinstall
hints).

---

## License

First-party code is **Apache License 2.0** — see [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE). Third-party and vendored code remains under its original
licenses; start at [`THIRD-PARTY-NOTICES`](THIRD-PARTY-NOTICES) and
[`third_party/NOTICE`](third_party/NOTICE).
