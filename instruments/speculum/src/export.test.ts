/**
 * Export platform (WU-12): envelope, pure renderers, containsSensitive flag.
 */

import { describe, expect, test } from "bun:test";
import { openDb } from "./store/db";
import { ingest } from "./ingest";
import {
  buildExportDocument,
  windowContainsSensitive,
} from "./commands/export";
import {
  renderCsv,
  renderExport,
  renderJson,
  renderMarkdown,
  SENSITIVE_EXPORT_WARNING,
} from "./export";
import type { ProbeResult } from "./probes/types";
import type { SessionExportData } from "./export";
import {
  cleanCorpus,
  writeCorpus,
  writeTripwireCorpus,
} from "./test/fixtures";
import { SPECULUM_VERSION } from "./version";

const FIXED_NOW = () => new Date("2026-08-10T12:00:00.000Z");

describe("export envelope", () => {
  test("scan export JSON round-trips with envelope fields and hit eventIds", () => {
    const corpus = writeTripwireCorpus();
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });

      const doc = buildExportDocument(db, {
        surface: "scan",
        dbPath: ":memory:",
        auditPath: "/tmp/lens-audit.jsonl",
        now: FIXED_NOW,
      });

      expect(doc.exportedAt).toBe("2026-08-10T12:00:00.000Z");
      expect(doc.speculumVersion).toBe(SPECULUM_VERSION);
      expect(doc.surface).toBe("scan");
      expect(doc.window).toEqual({
        since: null,
        until: null,
        project: null,
      });
      expect(doc.source.db).toBe(":memory:");
      expect(doc.source.auditPath).toBe("/tmp/lens-audit.jsonl");
      expect(doc.containsSensitive).toBe(true);

      const probes = doc.data as ProbeResult[];
      expect(Array.isArray(probes)).toBe(true);
      expect(probes.length).toBeGreaterThan(0);

      const sens = probes.find((p) => p.probe === "sensitive-content");
      expect(sens).toBeDefined();
      expect(sens!.hits?.length).toBeGreaterThan(0);
      for (const h of sens!.hits!) {
        expect(typeof h.eventId).toBe("number");
      }

      const raw = renderJson(doc);
      const parsed = JSON.parse(raw) as typeof doc;
      expect(parsed.exportedAt).toBe(doc.exportedAt);
      expect(parsed.speculumVersion).toBe(SPECULUM_VERSION);
      expect(parsed.surface).toBe("scan");
      expect(parsed.containsSensitive).toBe(true);
      expect(parsed.source.db).toBe(":memory:");
      expect(parsed.source.auditPath).toBe("/tmp/lens-audit.jsonl");
      expect(parsed.window.since).toBeNull();
      expect(Array.isArray(parsed.data)).toBe(true);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("status export carries envelope; clean corpus is not sensitive", () => {
    const corpus = writeCorpus(cleanCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });

      const doc = buildExportDocument(db, {
        surface: "status",
        dbPath: ":memory:",
        auditPath: "/tmp/audit.jsonl",
        now: FIXED_NOW,
      });

      expect(doc.containsSensitive).toBe(false);
      expect(doc.surface).toBe("status");
      const data = doc.data as { counts: { sessions: number } };
      expect(data.counts.sessions).toBeGreaterThan(0);

      const raw = renderExport(doc, "json");
      const parsed = JSON.parse(raw);
      expect(parsed.containsSensitive).toBe(false);
      expect(parsed.speculumVersion).toBe(SPECULUM_VERSION);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("usage export projects models and envelope", () => {
    const corpus = writeTripwireCorpus();
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const doc = buildExportDocument(db, {
        surface: "usage",
        dbPath: ":memory:",
        auditPath: "/tmp/audit.jsonl",
        now: FIXED_NOW,
      });
      expect(doc.surface).toBe("usage");
      expect(doc.containsSensitive).toBe(true);
      const data = doc.data as { totals: { turns: number }; models: unknown[] };
      expect(data.totals.turns).toBeGreaterThan(0);
      expect(data.models.length).toBeGreaterThan(0);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("session export lists events with sensitive flags", () => {
    const corpus = writeTripwireCorpus();
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const sessionId = "11111111-2222-3333-4444-555555555555";
      const doc = buildExportDocument(db, {
        surface: "session",
        sessionId,
        dbPath: ":memory:",
        auditPath: "/tmp/audit.jsonl",
        now: FIXED_NOW,
      });
      expect(doc.window.sessionId).toBe(sessionId);
      expect(doc.containsSensitive).toBe(true);
      const data = doc.data as SessionExportData;
      expect(data.sessionId).toBe(sessionId);
      expect(data.events.length).toBeGreaterThan(0);
      expect(data.events.some((e) => e.sensitive === 1)).toBe(true);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });
});

describe("export renderers", () => {
  test("csv and md render scan docs; md warns when sensitive", () => {
    const corpus = writeTripwireCorpus();
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const doc = buildExportDocument(db, {
        surface: "scan",
        probe: "sensitive-content",
        dbPath: ":memory:",
        auditPath: "/tmp/audit.jsonl",
        now: FIXED_NOW,
      });

      expect(doc.containsSensitive).toBe(true);

      const csv = renderCsv(doc);
      expect(csv).toContain("# containsSensitive,true");
      expect(csv).toContain("# surface,scan");
      expect(csv).toContain("hitEventId");
      expect(csv).toContain("sensitive-content");

      const md = renderMarkdown(doc);
      expect(md).toContain("Speculum export — scan");
      expect(md).toContain(SENSITIVE_EXPORT_WARNING);
      expect(md).toContain("sensitive-content");
      expect(md).toContain("eventId=");

      const clean = writeCorpus(cleanCorpus());
      const db2 = openDb(":memory:");
      try {
        ingest(db2, { sessionsDir: clean.root });
        const cleanDoc = buildExportDocument(db2, {
          surface: "scan",
          dbPath: ":memory:",
          auditPath: "/tmp/audit.jsonl",
          now: FIXED_NOW,
        });
        expect(cleanDoc.containsSensitive).toBe(false);
        const cleanMd = renderMarkdown(cleanDoc);
        expect(cleanMd).not.toContain(SENSITIVE_EXPORT_WARNING);
        expect(cleanMd).toContain("containsSensitive | false");
      } finally {
        db2.close();
        clean.cleanup();
      }
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("status/usage csv and md projections are non-empty", () => {
    const corpus = writeTripwireCorpus();
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });

      const status = buildExportDocument(db, {
        surface: "status",
        dbPath: ":memory:",
        auditPath: "/tmp/a.jsonl",
        now: FIXED_NOW,
      });
      expect(renderCsv(status)).toContain("counts.sessions");
      expect(renderMarkdown(status)).toContain("## Status");

      const usage = buildExportDocument(db, {
        surface: "usage",
        dbPath: ":memory:",
        auditPath: "/tmp/a.jsonl",
        now: FIXED_NOW,
      });
      expect(renderCsv(usage)).toContain("tokens.total");
      expect(renderMarkdown(usage)).toContain("## Usage");
    } finally {
      db.close();
      corpus.cleanup();
    }
  });
});

describe("windowContainsSensitive", () => {
  test("flips with window scope", () => {
    const corpus = writeTripwireCorpus();
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      expect(windowContainsSensitive(db, {})).toBe(true);
      // Old-only window should miss recent secrets.
      expect(
        windowContainsSensitive(db, {
          since: "2019-01-01T00:00:00.000Z",
          until: "2020-12-31T23:59:59.999Z",
        }),
      ).toBe(false);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });
});
