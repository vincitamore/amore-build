import { describe, expect, test } from "bun:test";
import { openDb } from "./store/db";
import { ingest } from "./ingest";
import { PROBES, runAllProbes } from "./probes";
import { detect } from "./probes/rage/detector";
import { detectFrustrationMarkers } from "./probes/frustration-markers";
import { detectOperatorCorrection } from "./probes/operator-correction";
import { detectAgentSelfCorrection } from "./probes/apology-rate";
import { computeFingerprint } from "./probes/stuck-loop";
import {
  matchSensitivePatterns,
  SENSITIVE_PATTERNS,
  sensitiveContent,
} from "./probes/sensitive-content";
import {
  agentChunk,
  cleanCorpus,
  CWD_DEC,
  CWD_ENC,
  makeUsage,
  toolCall,
  toolCallUpdate,
  turnCompleted,
  userChunk,
  writeCorpus,
  writeTripwireCorpus,
} from "./test/fixtures";
import { wilson95 } from "./stats";

describe("wilson95", () => {
  test("empty n", () => {
    expect(wilson95(0, 0)).toEqual({ lower: 0, upper: 1 });
  });
  test("zero successes", () => {
    const ci = wilson95(0, 10);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBeGreaterThan(0);
  });
  test("mid proportion", () => {
    const ci = wilson95(5, 10);
    expect(ci.lower).toBeLessThan(0.5);
    expect(ci.upper).toBeGreaterThan(0.5);
  });
});

describe("pure detectors", () => {
  test("rage detects strong words", () => {
    expect(detect("this is fucking broken").count).toBeGreaterThan(0);
    expect(detect("please list files").count).toBe(0);
  });

  test("frustration markers", () => {
    expect(detectFrustrationMarkers("why is this still failing??").length).toBeGreaterThan(0);
    expect(detectFrustrationMarkers("please continue").length).toBe(0);
  });

  test("operator correction", () => {
    expect(detectOperatorCorrection("Nope, you failed to read that.").length).toBeGreaterThan(0);
    expect(detectOperatorCorrection("Looks good, ship it.").length).toBe(0);
  });

  test("agent self-correction", () => {
    expect(detectAgentSelfCorrection("You're right. I was wrong.").length).toBeGreaterThan(0);
    expect(detectAgentSelfCorrection("Here is the file list.").length).toBe(0);
  });

  test("stuck-loop fingerprint for run_terminal_command", () => {
    const a = computeFingerprint("run_terminal_command", { command: "bun test" });
    const b = computeFingerprint("run_terminal_command", { command: "bun   test" });
    expect(a).toBe(b);
    expect(computeFingerprint("get_command_or_subagent_output", {})).toBeNull();
  });
});

describe("probes against corpora", () => {
  test("tripwire corpus fires each probe", () => {
    const corpus = writeTripwireCorpus();
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const results = runAllProbes(db);
      const byName = Object.fromEntries(results.map((r) => [r.probe, r]));

      expect(byName["rage-rate"]!.value).toBeGreaterThan(0);
      expect(byName["frustration-markers"]!.value).toBeGreaterThan(0);
      expect(byName["operator-correction"]!.value).toBeGreaterThan(0);
      expect(byName["apology-rate"]!.value).toBeGreaterThan(0);
      expect(byName["stuck-loop"]!.value).toBeGreaterThan(0);
      expect(byName["tool-mix"]!.value).toBeGreaterThan(0);
      expect(byName["sensitive-content"]!.value).toBeGreaterThan(0);
      expect(byName["stale-corpus"]!.value).toBeGreaterThan(0);

      for (const r of results) {
        expect(r.heuristic).toBe(true);
        expect(r.ciLow).toBeGreaterThanOrEqual(0);
        expect(r.ciHigh).toBeLessThanOrEqual(1);
        expect(r.n).toBeGreaterThanOrEqual(0);
      }
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("clean corpus stays quiet on language probes", () => {
    const corpus = writeCorpus(cleanCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      expect(PROBES["rage-rate"]!(db, {}).value).toBe(0);
      expect(PROBES["frustration-markers"]!(db, {}).value).toBe(0);
      expect(PROBES["operator-correction"]!(db, {}).value).toBe(0);
      expect(PROBES["apology-rate"]!(db, {}).value).toBe(0);
      expect(PROBES["stuck-loop"]!(db, {}).value).toBe(0);
      expect(PROBES["tool-mix"]!(db, {}).value).toBe(0);
      expect(PROBES["sensitive-content"]!(db, {}).value).toBe(0);
      // stale-corpus may be 0 or 1 depending on fixture timestamps (recent).
      expect(PROBES["stale-corpus"]!(db, {}).value).toBe(0);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });
});

describe("sensitive-content pattern bank", () => {
  test("matches expanded domain shapes", () => {
    const samples: Array<{ text: string; pattern: string }> = [
      { text: "-----BEGIN RSA PRIVATE KEY-----", pattern: "ssh-private-key" },
      { text: "-----BEGIN ENCRYPTED PRIVATE KEY-----", pattern: "ssh-encrypted-private-key" },
      { text: "xai-abcdefghijklmnopqrstuvwxyz012345", pattern: "xai-api-key" },
      { text: "sk-or-v1-abcdefghijklmnopqrstuvwxyz", pattern: "openrouter-api-key" },
      { text: "sk-proj-abcdefghijklmnopqrstuvwxyz012345", pattern: "openai-project-key" },
      { text: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", pattern: "github-pat" },
      { text: "ghs_abcdefghijklmnopqrstuvwxyz0123456789", pattern: "github-app-token" },
      { text: "gho_abcdefghijklmnopqrstuvwxyz0123456789", pattern: "github-oauth" },
      { text: "ghr_abcdefghijklmnopqrstuvwxyz0123456789", pattern: "github-refresh" },
      { text: "github_pat_11AAAAAAA012345678901234567890", pattern: "github-fine-grained-pat" },
      { text: "AKIAIOSFODNN7EXAMPLE", pattern: "aws-access-key" },
      { text: 'AMORE_API_KEY="amore_test_secret_value_99"', pattern: "amore-env-secret" },
      { text: "XAI_API_KEY=xai_env_secret_value_16", pattern: "xai-env-secret" },
      { text: "OPENROUTER_API_KEY=or_env_secret_value16", pattern: "openrouter-env-secret" },
      { text: "OPENAI_API_KEY=openai_env_secret_16", pattern: "openai-env-secret" },
      { text: "ANTHROPIC_API_KEY=anthropic_secret_16", pattern: "anthropic-env-secret" },
      { text: "GITHUB_TOKEN=ght_env_secret_value16", pattern: "github-env-secret" },
      {
        text: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        pattern: "aws-env-secret",
      },
      { text: "vercel_abcdefghijklmnopqrstuvwx", pattern: "vercel-token" },
    ];
    for (const s of samples) {
      const hits = matchSensitivePatterns(s.text);
      expect(hits.some((h) => h.pattern === s.pattern)).toBe(true);
    }
  });

  test("does not fire on short placeholders or bare env names", () => {
    const benign = [
      "process.env.XAI_API_KEY",
      "AMORE_API_KEY=",
      "ghp_short",
      "AKIA_SHORT",
      "sk-tooshort",
      "vercel_tiny",
      "github_pat_short",
    ];
    for (const b of benign) {
      expect(matchSensitivePatterns(b)).toEqual([]);
    }
  });

  test("bank weight table covers every pattern", () => {
    for (const p of SENSITIVE_PATTERNS) {
      expect(p.weight).toBeGreaterThanOrEqual(8);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.re).toBeInstanceOf(RegExp);
    }
  });
});

describe("sensitive-content tool_output side channel", () => {
  test("flags secrets only present in tool_result output", () => {
    const id = "cccccccc-dddd-eeee-ffff-000000000001";
    const secretOut = "file contents: ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const corpus = writeCorpus([
      {
        id,
        cwdEnc: CWD_ENC,
        cwdDecoded: CWD_DEC,
        modelId: "grok-4",
        updates: [
          userChunk("Please read .env.local and summarize."),
          agentChunk("Reading the file."),
          toolCall("t1", "read_file", { target_file: ".env.local" }),
          toolCallUpdate("t1", "read_file", secretOut),
          turnCompleted(makeUsage("grok-4", { inputTokens: 100, outputTokens: 20 })),
        ],
      },
    ]);
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const result = sensitiveContent(db, {});
      expect(result.value).toBe(1);
      expect(result.hits?.length).toBe(1);
      expect(result.hits![0]!.evidence).toMatch(/github-pat/);
      expect(result.hits![0]!.evidence).toMatch(/tool_output/);
      const data = result.data as {
        toolOutputOnlySessions: number;
        bySessionId: Array<{ channels: string[] }>;
      };
      expect(data.toolOutputOnlySessions).toBe(1);
      expect(data.bySessionId[0]!.channels).toContain("tool_output");
      expect(data.bySessionId[0]!.channels).not.toContain("text");
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("flags secrets in tool_use input (commands / writes)", () => {
    const id = "cccccccc-dddd-eeee-ffff-000000000002";
    const corpus = writeCorpus([
      {
        id,
        cwdEnc: CWD_ENC,
        cwdDecoded: CWD_DEC,
        modelId: "grok-4",
        updates: [
          userChunk("export the key for me"),
          agentChunk("running export"),
          toolCall("t1", "run_terminal_command", {
            command: "export XAI_API_KEY=xai_env_secret_value_16chars",
            description: "export key",
          }),
          toolCallUpdate("t1", "run_terminal_command", "ok"),
          turnCompleted(makeUsage("grok-4")),
        ],
      },
    ]);
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const result = sensitiveContent(db, {});
      expect(result.value).toBe(1);
      expect(result.hits![0]!.evidence).toMatch(/xai-env-secret/);
      expect(result.hits![0]!.evidence).toMatch(/tool_input/);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("clean tool output with env names only stays quiet", () => {
    const id = "cccccccc-dddd-eeee-ffff-000000000003";
    const corpus = writeCorpus([
      {
        id,
        cwdEnc: CWD_ENC,
        cwdDecoded: CWD_DEC,
        modelId: "grok-4",
        updates: [
          userChunk("read config"),
          toolCall("t1", "read_file", { target_file: "config.ts" }),
          toolCallUpdate(
            "t1",
            "read_file",
            'export const key = process.env.XAI_API_KEY;\n// AMORE_API_KEY=\n',
          ),
          turnCompleted(makeUsage("grok-4")),
        ],
      },
    ]);
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      expect(sensitiveContent(db, {}).value).toBe(0);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });
});
