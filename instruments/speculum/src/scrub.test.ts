import { describe, expect, test } from "bun:test";
import { scrubPayload, LENS_PAYLOAD_CAP_BYTES } from "./scrub";

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
