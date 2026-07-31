# Building iris

Iris is a Bun workspace. Everything here works from a clone — the compiled
release assets are a convenience, not a prerequisite.

## Prerequisites

- [Bun](https://bun.sh) 1.3.x
- A terminal that supports truecolor for the dash (any modern terminal)

## Run from source

No build step is required to use it:

```bash
cd instruments/iris
bun install

bun packages/cli/src/iris.ts daemon --port 3853 <org_root>
bun packages/cli/src/iris.ts task list --json
bun packages/tui/src/index.tsx          # the dash
```

## Tests

```bash
bun test
```

## Compiled artifacts

`bun build --compile` produces standalone binaries with no Bun runtime
dependency:

```bash
bun run scripts/build-compile.ts              # CLI + daemon
bun run scripts/build-compile.ts --with-dash  # also builds the dash artifact

# → dist/iris-{os}-{arch}[.exe]
# → dist/iris-dash-{os}-{arch}[.exe]   (with --with-dash)
```

Cross-compilation uses Bun's target flags — `--target bun-linux-x64`,
`bun-darwin-arm64`, and so on.

| Artifact | Entry point | Contains |
|---|---|---|
| `iris-{os}-{arch}` | `packages/cli/src/standalone.ts` | CLI verbs, the org write-core, the daemon. Routes in-process — it never spawns sibling `.ts` files. |
| `iris-dash-{os}-{arch}` | `packages/tui/src/dash-standalone.ts` | The OpenTUI/React dash. Needs a TTY. Starts a daemon via the sibling multi-tool, or `$IRIS_DAEMON_BIN`. |

### Why the dash is a separate binary

The dash pulls in React and the OpenTUI renderer, which costs roughly 10 MB over
the CLI-only artifact. Keeping them separate means the multi-tool stays lean for
the common case. `iris dash` re-execs a sibling dash binary when it finds one,
and otherwise prints this build recipe and exits 64.

### How the native terminal library is embedded

`@opentui/core-{platform}` exports its native library as a file import:

```js
const module = await import("./opentui.dll", { with: { type: "file" } })
export default module.default
```

`bun build --compile` embeds that file into the virtual filesystem, and
`bun:ffi` opens it from the embedded path. Nothing has to be extracted to a
cache directory at runtime.

### Known limitation

The compiled dash ships OpenTUI's default tree-sitter parsers only. Additional
grammars resolve through `node_modules` at runtime
(`packages/tui/src/code-grammars.ts`), so they are available in a source run but
not in the compiled artifact.
