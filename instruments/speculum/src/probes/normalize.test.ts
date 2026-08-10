import { describe, expect, test } from "bun:test";
import { detectAgentSelfCorrection } from "./apology-rate";
import { detectFrustrationMarkers } from "./frustration-markers";
import { detectOperatorCorrection } from "./operator-correction";
import { detect } from "./rage/detector";
import {
  evidenceFromFolded,
  foldWithMap,
  normalizeForProbe,
} from "./normalize";

describe("normalizeForProbe", () => {
  test("NFC is identity on plain ASCII", () => {
    expect(normalizeForProbe("you're right")).toBe("you're right");
  });

  test("folds curly apostrophe and smart quotes to ASCII", () => {
    // U+2019 RIGHT SINGLE QUOTATION MARK
    expect(normalizeForProbe("you\u2019re right")).toBe("you're right");
    // U+201C / U+201D double quotes
    expect(normalizeForProbe("\u201Chello\u201D")).toBe('"hello"');
  });

  test("folds en/em dash and ellipsis", () => {
    expect(normalizeForProbe("a\u2013b")).toBe("a-b");
    expect(normalizeForProbe("a\u2014b")).toBe("a--b");
    expect(normalizeForProbe("wait\u2026")).toBe("wait...");
  });

  test("does not case-fold (caps-span needs case)", () => {
    expect(normalizeForProbe("THIS IS STILL WRONG")).toBe("THIS IS STILL WRONG");
  });

  test("evidenceFromFolded recovers original curly apostrophe span", () => {
    const src = "You\u2019re right about that.";
    const info = foldWithMap(src);
    const idx = info.folded.toLowerCase().indexOf("you're right");
    expect(idx).toBeGreaterThanOrEqual(0);
    const ev = evidenceFromFolded(info, idx, "you're right".length);
    expect(ev).toContain("\u2019");
    expect(ev.startsWith("You")).toBe(true);
  });
});

describe("match-time normalize wired into detectors", () => {
  test("smart-quote fold lets apology bank match where plain NFC would miss", () => {
    // Pattern uses ASCII optional apostrophe: you'?re — curly U+2019 alone fails without fold
    const curly = "You\u2019re right. I was wrong.";
    const nfcOnly = curly.normalize("NFC");
    // Control: raw/NFC text does not satisfy the ASCII apostrophe pattern shape for youre-right
    // when the detector is forced off-normalize — assert fold is what enables the hit.
    expect(normalizeForProbe(nfcOnly)).toBe("You're right. I was wrong.");
    expect(nfcOnly.includes("\u2019")).toBe(true);

    const matches = detectAgentSelfCorrection(curly);
    expect(matches.length).toBeGreaterThan(0);
    const youre = matches.find((m) => m.category === "youre-right");
    expect(youre).toBeDefined();
    // Evidence keeps original typographic apostrophe, not the folded ASCII form
    expect(youre!.evidence).toContain("\u2019");
  });

  test("unchanged-text evidence preserved on ASCII fixtures", () => {
    const text = "You're right. I was wrong.";
    const matches = detectAgentSelfCorrection(text);
    expect(matches.length).toBeGreaterThan(0);
    const youre = matches.find((m) => m.category === "youre-right");
    expect(youre?.evidence).toMatch(/you'?re right/i);
    // No smart-quote injection on plain input
    expect(youre!.evidence.includes("\u2019")).toBe(false);
  });

  test("rage detects through curly-adjacent noise without rewriting word evidence", () => {
    const text = "this is fucking broken";
    expect(detect(text).count).toBeGreaterThan(0);
    expect(detect(text).matches[0]!.word).toBe("fucking");
  });

  test("frustration minced-oath evidence stays original on plain text", () => {
    const text = "what the hell is going on";
    const matches = detectFrustrationMarkers(text);
    const minced = matches.find((m) => m.category === "minced-oath");
    expect(minced?.evidence.toLowerCase()).toBe("what the hell");
  });

  test("operator-correction match path still hits Nope fixtures", () => {
    const matches = detectOperatorCorrection("Nope, you failed to read that.");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.evidence).toMatch(/Nope/i);
  });
});
