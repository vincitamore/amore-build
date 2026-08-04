# Arcus Build

**a terminal coding agent that is not a wrapper around one model**

Arcus Build (`arcus`) is a terminal AI coding agent: a full-screen TUI that
understands your codebase, edits files, runs shell commands, searches the web,
and drives long-running multi-agent work — interactively, headlessly for
scripting/CI, or embedded in editors via ACP. Bring any OpenAI-compatible
model; plant a **cooperation harness** in your repo with `arcus init`; drive
the org tree it plants with the **iris** companion dash.

It is a **permanent engineered fork** of xAI's open-source
[`grok-build`](https://github.com/xai-org/grok-build) (Apache-2.0). **Not an
xAI product, and not affiliated with any model vendor.** Upstream provenance
and sync cadence: [`UPSTREAM.md`](UPSTREAM.md).

![Arcus Build — the welcome screen](docs/assets/welcome-shimmer.gif)

---

## Install

### Installing the released binary

Prebuilt binaries are published for macOS, Linux, and Windows:

```sh
curl -fsSL https://amore.build/download/arcus-install-sh | bash   # macOS / Linux / Git Bash
irm https://amore.build/download/arcus-install-ps1 | iex          # Windows PowerShell
arcus --version
```

The installers fetch the newest [GitHub Release](https://github.com/vincitamore/arcus-build/releases)
asset for your platform, verify its published sha256, and install the binary
(`~/.local/bin` on unix, `%USERPROFILE%\arcus\bin` on Windows — override with
`ARCUS_INSTALL_DIR`, pin a tag with `ARCUS_VERSION`). They are
[`scripts/install.sh`](scripts/install.sh) and
[`scripts/install.ps1`](scripts/install.ps1) in this repository if you prefer
to read before you run.

See the [changelog](crates/codegen/xai-grok-shell-base/assets/arcus-changelog.md)
for the latest fixes, features, and improvements in each release (also
rendered in-product on the welcome screen and by `/release-notes`).

> **PATH note:** crates.io already publishes a Lua linter named `arcus`.
> That is a different tool. `arcus doctor` (and `arcus doctor --json`, field
> `pathCollision`) detects when another `arcus` on `PATH` would shadow Arcus
> Build.

### Build from source

Requirements:

- **Rust** — pinned by [`rust-toolchain.toml`](rust-toolchain.toml); `rustup`
  installs it on first build.
- **protoc** — on your `PATH`, or pointed at by `$PROTOC`. Any recent release
  works; this is what CI uses on every platform.

Optionally, [DotSlash](https://dotslash-cli.com) can run the pinned tool under
[`bin/`](bin/) instead. It is not required, and not available on Windows — the
build falls back to `protoc` on `PATH` by design.

```sh
git clone https://github.com/vincitamore/arcus-build.git
cd arcus-build

cargo run -p xai-grok-pager-bin              # build + launch the TUI
cargo build -p xai-grok-pager-bin --release  # release binary
```

The composition-root crate is `xai-grok-pager-bin`; the public binary name is
**`arcus`** (argv0 also tolerates `arcus-build`, `grok`, and `agent`). After a
release build the artifact is typically
`target/release/arcus` (or `arcus.exe` on Windows).

Home defaults to **`~/.arcus`** (override with `$ARCUS_HOME`; legacy
`$GROK_HOME` still works). Project config lives under **`.arcus/`** (`.grok/`
is kept as a legacy fallback; `.arcus` wins when both exist).

---

## Quickstart

Arcus Build is **model-agnostic by design**: every model is a config entry
pointed at an OpenAI-compatible endpoint, and the identity the model is given
does not name a model at all (see below) — so entries can be swapped and
compared without the harness caring which one is behind them. The wizard's
recommended default is **DeepSeek V4 Flash** over OpenRouter (the
maintainer's daily driver); GLM-5.2 recipes ship alongside, and any
OpenAI-compatible host works. Native xAI grok is the **second rail**
(subagent freight + first-party catalog).

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
| **DeepSeek V4 Flash via OpenRouter** (recommended) | `deepseek/deepseek-v4-flash-0731` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| **DeepSeek direct** | `deepseek-v4-flash` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| **GLM-5.2** (OpenRouter / Z.ai direct) | `z-ai/glm-5.2` / `glm-5.2` | OpenRouter / `https://api.z.ai/api/paas/v4` | `OPENROUTER_API_KEY` / `ZAI_API_KEY` |
| **Any OpenAI-compatible host** | host-specific | your `/v1` base | host token env |

Minimal sketch (the wizard writes exactly this):

```toml
[models]
default = "deepseek-openrouter"

[model.deepseek-openrouter]
model = "deepseek/deepseek-v4-flash-0731"
base_url = "https://openrouter.ai/api/v1"
name = "DeepSeek V4 Flash (OpenRouter)"
env_key = "OPENROUTER_API_KEY"
system_prompt_label = "Arcus Build"
context_window = 1048576
# Reasoning tokens draw from this too — it is the provider's reported
# ceiling, not a target; a lower cap truncates the reasoning pass invisibly.
max_completion_tokens = 65536
```

Full recipes, pricing stamps, alternate hosts, and verify commands:
[`docs/setup-models.md`](docs/setup-models.md). Multi-provider sample:
[`examples/config.multi-provider.toml`](examples/config.multi-provider.toml).

```sh
export OPENROUTER_API_KEY="sk-or-..."   # your key
arcus -m deepseek-openrouter -p "Reply with exactly: ARCUS-DS-OK"
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
never require OAuth, and a model's own key always wins over the session.
Details: [`docs/authentication.md`](docs/authentication.md).

---

## The cooperation harness

```sh
arcus init              # create a house: orientation surfaces, schemas, skills, hooks, iris
arcus init --dry-run    # plan only
arcus init --refresh    # rewrite files still matching the install manifest
```

`arcus init` **creates a house** — a working tree for long-horizon
collaboration with the agent: root `AGENTS.md`, folder schemas (`context/`,
`inbox/`, `tasks/`, `knowledge/`, `reminders/`, `forge/`), a 6-skill
orchestration pack, session hooks, the iris companion, and
`.arcus/house-install.json` recording ownership. **Lattice is default-on**
(`--no-lattice` opt-out); skills and hooks default-on (`--no-skills` /
`--no-hooks`); iris default-on (`--no-iris` opts out and makes init fully
offline). Ownership-aware: never silently overwrites user edits; `--refresh`
only rewrites files whose on-disk hash still matches the manifest; `--force`
overwrites (confirm, or `--yes`).

What got installed and what you own: [`docs/onboarding.md`](docs/onboarding.md).

---

## Iris companion

**Iris** is the house's knowledge/org instrument: a live file index daemon,
org CRUD verbs (`task` / `inbox` / `reminder` / `knowledge`), and an
interactive dash over the tree `arcus init` plants — Dashboard, Tasks,
Inbox, Reminders, Knowledge, Files, Forge, and Graph tabs. `arcus init`
installs it into the house by default; it is never required to run Arcus
Build itself. Local-first: the daemon binds loopback only, and there is no
telemetry. Full story (with a screenshot of every tab):
[`docs/iris.md`](docs/iris.md).

![Iris dash — the Dashboard tab](docs/assets/iris/dashboard.png)

---

## Documentation

| Doc | What |
|-----|------|
| [`docs/setup-models.md`](docs/setup-models.md) | BYOK model recipes (DeepSeek / GLM / any OpenAI-compatible host) |
| [`docs/authentication.md`](docs/authentication.md) | OAuth + BYOK dual rail, `auth.json` anti-copy rule |
| [`docs/onboarding.md`](docs/onboarding.md) | `arcus init` house tree, ownership, refresh |
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
