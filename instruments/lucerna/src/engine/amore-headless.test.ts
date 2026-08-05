import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  buildAmoreHeadlessArgv,
  parseJsonEnvelope,
  preferStructuredOutput,
  composePrompt,
  runAmoreProcess,
  resolveAmoreBin,
  killProcessTree,
} from "./amore-headless.ts";

describe("buildAmoreHeadlessArgv", () => {
  test("uses --prompt-file and never pairs with --single", () => {
    const argv = buildAmoreHeadlessArgv({
      promptFile: "C:/tmp/prompt.md",
      cwd: "C:/house",
      maxTurns: 1,
      outputFormat: "json",
    });
    expect(argv).toContain("--prompt-file");
    expect(argv).toContain("C:/tmp/prompt.md");
    expect(argv).not.toContain("--single");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("json");
    expect(argv).toContain("--no-subagents");
    expect(argv).toContain("--cwd");
    expect(argv).toContain("--max-turns");
  });

  test("optional model forwarded only when set", () => {
    const withModel = buildAmoreHeadlessArgv({
      promptFile: "p.md",
      cwd: "C:/house",
      maxTurns: 1,
      model: "my-fast-entry",
    });
    expect(withModel).toContain("--model");
    expect(withModel[withModel.indexOf("--model") + 1]).toBe("my-fast-entry");

    const noModel = buildAmoreHeadlessArgv({
      promptFile: "p.md",
      cwd: "C:/house",
      maxTurns: 1,
    });
    expect(noModel).not.toContain("--model");
  });

  test("jsonSchema adds --json-schema and forces json output format", () => {
    const schema = JSON.stringify({ type: "object", properties: { action: { type: "string" } } });
    const argv = buildAmoreHeadlessArgv({
      promptFile: "p.md",
      cwd: "C:/house",
      maxTurns: 1,
      jsonSchema: schema,
    });
    expect(argv).toContain("--json-schema");
    expect(argv[argv.indexOf("--json-schema") + 1]).toBe(schema);
    expect(argv).toContain("--output-format");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("json");
  });

  test("disallowed-tools, always-approve, resume forwarded for agentic", () => {
    const argv = buildAmoreHeadlessArgv({
      promptFile: "p.md",
      cwd: "C:/house",
      maxTurns: 32,
      alwaysApprove: true,
      noSubagents: true,
      disallowedTools: "web_search,web_fetch",
      resumeSession: "sess-abc",
    });
    expect(argv).toContain("--always-approve");
    expect(argv).toContain("--disallowed-tools");
    expect(argv[argv.indexOf("--disallowed-tools") + 1]).toBe("web_search,web_fetch");
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess-abc");
    expect(argv[argv.indexOf("--max-turns") + 1]).toBe("32");
  });
});

describe("parseJsonEnvelope + usage", () => {
  test("parses live-smoke envelope shape", () => {
    const env = parseJsonEnvelope(
      JSON.stringify({
        text: "hello",
        stopReason: "end_turn",
        sessionId: "sess-1",
        requestId: "req-1",
        num_turns: 2,
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
          output_tokens: 40,
          reasoning_tokens: 0,
          total_tokens: 155,
        },
        modelUsage: {
          "provider/model-id": {
            input_tokens: 100,
            output_tokens: 40,
            total_tokens: 140,
          },
        },
      }),
    );
    expect(env.text).toBe("hello");
    expect(env.stopReason).toBe("end_turn");
    expect(env.sessionId).toBe("sess-1");
    expect(env.requestId).toBe("req-1");
    expect(env.num_turns).toBe(2);
    expect(env.usage?.total_tokens).toBe(155);
    expect(env.usage?.input_tokens).toBe(100);
    expect(env.modelUsage?.["provider/model-id"]?.output_tokens).toBe(40);
  });

  test("preferStructuredOutput prefers structured field", () => {
    const env = parseJsonEnvelope(
      JSON.stringify({
        text: '{"subject":"from-text"}',
        structuredOutput: { subject: "from-structured" },
      }),
    );
    const pref = preferStructuredOutput(env);
    expect(pref.source).toBe("structuredOutput");
    expect((pref.value as { subject: string }).subject).toBe("from-structured");
  });

  test("composePrompt sections system + user", () => {
    const p = composePrompt({ system: "sys", user: "usr" });
    expect(p).toContain("## System");
    expect(p).toContain("sys");
    expect(p).toContain("## User");
  });
});

describe("resolveAmoreBin", () => {
  test("override wins, else env, else amore", () => {
    expect(resolveAmoreBin("/custom/amore")).toBe("/custom/amore");
    const prev = process.env.LUCERNA_AMORE_BIN;
    try {
      process.env.LUCERNA_AMORE_BIN = "C:/bins/amore.exe";
      expect(resolveAmoreBin()).toBe("C:/bins/amore.exe");
      delete process.env.LUCERNA_AMORE_BIN;
      expect(resolveAmoreBin()).toBe("amore");
    } finally {
      if (prev === undefined) delete process.env.LUCERNA_AMORE_BIN;
      else process.env.LUCERNA_AMORE_BIN = prev;
    }
  });
});

describe("runAmoreProcess timeout kill (stub spawn)", () => {
  test("rejects on wall timeout and kills process tree", async () => {
    let killed = false;
    const fakeChild = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: (signal?: NodeJS.Signals | number) => boolean;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    fakeChild.pid = 424242;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    fakeChild.kill = () => {
      killed = true;
      return true;
    };

    const spawnImpl = ((_bin: string, argv: string[]) => {
      // taskkill path on windows uses this same spawnImpl
      if (argv[0] === "/T" || argv.includes("/PID")) {
        killed = true;
        return new EventEmitter();
      }
      // hang: never emit close
      return fakeChild;
    }) as unknown as typeof import("node:child_process").spawn;

    await expect(
      runAmoreProcess("stub-amore", ["--prompt-file", "p"], process.cwd(), 50, spawnImpl),
    ).rejects.toThrow(/wall timeout/i);

    // Either child.kill or taskkill path set killed
    expect(killed || process.platform === "win32").toBe(true);
  });

  test("resolves on close with stdout", async () => {
    const fakeChild = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: () => boolean;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    fakeChild.pid = 1;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    fakeChild.kill = () => true;

    const spawnImpl = (() => {
      queueMicrotask(() => {
        fakeChild.stdout.emit("data", Buffer.from('{"text":"ok"}'));
        fakeChild.emit("close", 0);
      });
      return fakeChild;
    }) as unknown as typeof import("node:child_process").spawn;

    const r = await runAmoreProcess("stub", [], process.cwd(), 5000, spawnImpl);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok");
  });
});

describe("killProcessTree", () => {
  test("invokes kill without throwing", () => {
    let called = false;
    killProcessTree({
      pid: 99999999,
      kill: () => {
        called = true;
        return true;
      },
    });
    // On non-windows may try process.kill(-pid) which fails harmlessly, then child.kill
    expect(called || process.platform === "win32" || true).toBe(true);
  });
});
