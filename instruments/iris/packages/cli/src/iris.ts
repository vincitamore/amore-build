#!/usr/bin/env bun
/**
 * iris — house control surface for the Arcus org tree.
 *
 *   iris                 → open the dash (the span)
 *   iris dash            → same
 *   iris status […]      → regula status (and other regula verbs via passthrough)
 *   iris regula <verb>   → explicit regula passthrough
 *   iris daemon [--port] → start the iris daemon (default port 3853)
 *   iris --help
 *
 * Defaults are house-native: org root walks for AGENTS.md|AGENT.md|CLAUDE.md beside
 * tasks/; daemon :3853.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(HERE, "index.ts");
const GLASS_ENTRY = join(HERE, "glass.ts");
// packages/cli/src -> packages/daemon/src/index.ts
const DAEMON_ENTRY = join(HERE, "..", "..", "daemon", "src", "index.ts");
const DEFAULT_PORT = 3853;

function help(): void {
  process.stdout.write(
    [
      "iris — Arcus house control surface (Ἶρις: the messenger, whose path is the arc)",
      "",
      "  iris                 open the OpenTUI dash (the span)",
      "  iris dash            same",
      "  iris status […]      org orientation (regula status)",
      "  iris <regula-verb>   any regula verb (task, inbox, …)",
      "  iris regula <verb>   explicit regula passthrough",
      "  iris daemon [--port N]  start house iris daemon (default 3853)",
      "  iris --help",
      "",
      "Org root: $IRIS_ORG_ROOT or walk-up for (AGENTS.md|AGENT.md|CLAUDE.md)+tasks/.",
      "Daemon default port 3853 (reads any root; no foreign-root flag required).",
      "Mutations: house markers, or --allow-foreign-root / IRIS_ALLOW_FOREIGN_ROOT=1.",
      "",
    ].join("\n"),
  );
}

function runBun(entry: string, args: string[], opts: { inherit?: boolean } = {}): never {
  const r = spawnSync(process.execPath, [entry, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(r.status ?? 1);
}

const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === "dash") {
  const rest = argv[0] === "dash" ? argv.slice(1) : [];
  // Ensure dash dials house port unless operator overrode
  if (!process.env.IRIS_PORT) process.env.IRIS_PORT = String(DEFAULT_PORT);
  runBun(GLASS_ENTRY, rest);
}

if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
  help();
  process.exit(0);
}

if (argv[0] === "daemon") {
  const args = argv.slice(1);
  let port = String(DEFAULT_PORT);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = args[++i];
    } else if (args[i]?.startsWith("--port=")) {
      port = args[i].slice("--port=".length);
    } else {
      out.push(args[i]);
    }
  }
  // Prefer source entry; fall back to compiled multi-tool re-exec (IRIS_DAEMON_BIN
  // or same-path sibling) is for release installs — source tree always has DAEMON_ENTRY.
  if (!existsSync(DAEMON_ENTRY)) {
    process.stderr.write(
      `iris daemon: missing ${DAEMON_ENTRY}\n` +
        `(use the compiled binary: iris-{os}-{arch} daemon … — see PORTING.md §Compile)\n`,
    );
    process.exit(64);
  }
  // org root: optional positional still supported by daemon
  const orgArgs = out.length ? out : [];
  if (!process.env.IRIS_PORT) process.env.IRIS_PORT = port;
  const child = spawn(
    process.execPath,
    [DAEMON_ENTRY, ...orgArgs, "--port", port],
    { stdio: "inherit", env: process.env },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
  // keep event loop
  await new Promise(() => {});
}

// regula passthrough
const regulaArgs = argv[0] === "regula" ? argv.slice(1) : argv;
if (!process.env.IRIS_PORT) process.env.IRIS_PORT = String(DEFAULT_PORT);
runBun(CLI_ENTRY, regulaArgs);
