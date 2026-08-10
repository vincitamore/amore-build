import { describe, expect, test } from "bun:test";
import { scrubPayload, LENS_PAYLOAD_CAP_BYTES } from "./scrub";
import { matchSensitivePatterns, SENSITIVE_PATTERNS } from "./probes/sensitive-content";

describe("scrub redaction per class", () => {
  test("redacts secret-shaped keys with typed placeholders", () => {
    const input =
      "key xai-abcdefghijklmnopqrstuvwxyz012345 and sk-or-v1-abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const r = scrubPayload(input, { homeDir: "C:\\Users\\Synthetic" });
    expect(r.ok).toBe(true);
    expect(r.text).not.toContain("xai-abcdefghijklmnopqrstuvwxyz");
    expect(r.text).toContain("[REDACTED:xai-api-key]");
    expect(r.counts.secret).toBeGreaterThan(0);
  });

  test("redacts expanded bank shapes (SSH, GitHub fine-grained, env secrets)", () => {
    const input = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "github_pat_11AAAAAAA012345678901234567890",
      "AMORE_API_KEY=amore_test_secret_value_99",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
    ].join("\n");
    const r = scrubPayload(input, { homeDir: "/home/synthetic" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("[REDACTED:ssh-private-key]");
    expect(r.text).toContain("[REDACTED:github-fine-grained-pat]");
    expect(r.text).toContain("[REDACTED:amore-env-secret]");
    expect(r.text).toContain("[REDACTED:aws-env-secret]");
    expect(r.text).toContain("[REDACTED:openai-project-key]");
    expect(r.text).not.toContain("github_pat_11AAAAAAA");
    expect(r.text).not.toContain("amore_test_secret_value_99");
  });

  test("redacts email addresses", () => {
    const r = scrubPayload("contact me at alice@example.com please", {
      homeDir: "/home/synthetic",
    });
    expect(r.ok).toBe(true);
    expect(r.text).not.toContain("alice@example.com");
    expect(r.text).toContain("[REDACTED:email]");
    expect(r.counts.email).toBe(1);
  });

  test("redacts absolute home paths", () => {
    const home = "C:\\Users\\Synthetic";
    const r = scrubPayload(`open ${home}\\Documents\\secret-notes.md now`, {
      homeDir: home,
    });
    expect(r.ok).toBe(true);
    expect(r.text).not.toContain("Synthetic\\Documents");
    expect(r.text).toContain("[REDACTED:home-path]");
    expect(r.counts["home-path"]).toBeGreaterThan(0);
  });

  test("redacts password-style assignments", () => {
    const r = scrubPayload("password=supersecretvalue123 and token: anothersecret99", {
      homeDir: "/tmp",
    });
    expect(r.ok).toBe(true);
    expect(r.text).not.toContain("supersecretvalue123");
    expect(r.counts["password-assignment"]).toBeGreaterThan(0);
  });

  test("clean text passes with zero counts", () => {
    const r = scrubPayload("Please list files in src and summarize the module.", {
      homeDir: "/home/synthetic",
    });
    expect(r.ok).toBe(true);
    expect(r.counts.secret).toBe(0);
    expect(r.counts.email).toBe(0);
    expect(r.refuseReason).toBeNull();
  });

  test("baseline secret input still redacts legacy shapes byte-stable on placeholders", () => {
    // Unchanged legacy shapes must still scrub; shared bank expansion must not break them.
    const input =
      "key xai-abcdefghijklmnopqrstuvwxyz012345 and sk-or-v1-abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const r = scrubPayload(input, { homeDir: "C:\\Users\\Synthetic" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("[REDACTED:xai-api-key]");
    expect(r.text).toContain("[REDACTED:openrouter-api-key]");
    expect(r.text).toContain("[REDACTED:github-pat]");
  });
});

describe("shared sensitive bank residual rate (V9)", () => {
  /** Synthetic benign code / docs — env names, short placeholders, public examples. */
  const BENIGN_CORPUS = `
export const API_KEY = process.env.API_KEY;
const xai = process.env.XAI_API_KEY; // name only, no assignment value
// docs: set AMORE_API_KEY= in your shell
// example placeholder ghp_short
const akiaLike = "AKIA_PLACEHOLDER"; // too short / wrong charset for access-key
const skNote = "use sk- prefix for openai user keys";
const vercelDocs = "vercel_ token format in docs without body";
function loadConfig() {
  return { token: "", secret: undefined, key: null };
}
-----BEGIN CERTIFICATE-----
not a private key
-----END CERTIFICATE-----
const path = "C:\\\\Users\\\\Synthetic\\\\project\\\\src\\\\index.ts";
`.repeat(20);

  test("benign code corpus residual rate is zero", () => {
    const hits = matchSensitivePatterns(BENIGN_CORPUS);
    expect(hits).toEqual([]);
  });

  test("bank has no nested-quantifier catastrophe shapes (compile + single pass)", () => {
    // Each pattern must compile and finish on a long non-matching string quickly.
    const longBenign = "a".repeat(50_000) + " env=value " + "b".repeat(50_000);
    const t0 = performance.now();
    for (const p of SENSITIVE_PATTERNS) {
      const flags = p.re.flags.includes("g") ? p.re.flags : `${p.re.flags}g`;
      longBenign.match(new RegExp(p.re.source, flags));
    }
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(500);
  });
});

describe("scrub fail-closed", () => {
  test("oversize payload refuses and is never ok", () => {
    const big = "x".repeat(LENS_PAYLOAD_CAP_BYTES + 50);
    const r = scrubPayload(big, { maxBytes: 1024 });
    expect(r.ok).toBe(false);
    expect(r.refuseReason).toMatch(/exceeds lens cap/i);
    expect(r.bytes).toBeGreaterThan(1024);
  });

  test("explicit maxBytes enforces cap", () => {
    const r = scrubPayload("hello world this is a short payload", { maxBytes: 5 });
    expect(r.ok).toBe(false);
    expect(r.refuseReason).toMatch(/narrow the slice/i);
  });
});
