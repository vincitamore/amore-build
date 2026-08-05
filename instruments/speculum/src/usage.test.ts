import { describe, expect, test } from "bun:test";
import { openDb } from "./store/db";
import { ingest } from "./ingest";
import { buildUsageReport } from "./commands/usage";
import { writeTripwireCorpus } from "./test/fixtures";

describe("usage aggregation", () => {
  test("sums tokens and turns per model", () => {
    const corpus = writeTripwireCorpus();
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const report = buildUsageReport(db);

      expect(report.totals.turns).toBeGreaterThan(0);
      // parent (2000/400/800/100) + child (100/20/100/50) + old (50/10/100/50)
      expect(report.totals.tokens.input).toBe(2150);
      expect(report.totals.tokens.output).toBe(430);
      expect(report.totals.tokens.cachedRead).toBe(1000);
      expect(report.totals.tokens.reasoning).toBe(200);

      const grok4 = report.models.find((m) => m.model === "grok-4");
      const grok3 = report.models.find((m) => m.model === "grok-3");
      expect(grok4).toBeDefined();
      expect(grok3).toBeDefined();
      expect(grok4!.tokens.input).toBe(2000 + 100);
      expect(grok3!.tokens.input).toBe(50);

      expect(report.note.toLowerCase()).toContain("no price");
    } finally {
      db.close();
      corpus.cleanup();
    }
  });
});
