/**
 * Harvest → session_meta → applySessionFacets → title precedence.
 * Synthetic fixtures only.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { openDb } from "../store/db";
import { ingest } from "./index";
import { applySessionFacets } from "./facets";
import {
  agentChunk,
  cleanCorpus,
  CWD_DEC,
  CWD_ENC,
  makeUsage,
  turnCompleted,
  userChunk,
  writeCorpus,
  writeTripwireCorpus,
} from "../test/fixtures";

describe("session_meta harvest", () => {
  test("summary agent_name + generated_title land in session_meta and sessions facets", () => {
    const base = cleanCorpus()[0]!;
    const corpus = writeCorpus([
      {
        ...base,
        summaryExtra: {
          session_summary: "Summary tab title",
          agent_name: "grok-build-plan",
          generated_title: "Harness Title From Summary",
        },
      },
    ]);
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });

      const meta = db
        .query<
          {
            agent_name: string;
            generated_title: string;
            subagent_type: string;
            description: string;
          },
          [string]
        >(
          `SELECT agent_name, generated_title, subagent_type, description
           FROM session_meta WHERE session_id = ?`,
        )
        .get(base.id);
      expect(meta?.agent_name).toBe("grok-build-plan");
      expect(meta?.generated_title).toBe("Harness Title From Summary");
      expect(meta?.subagent_type).toBe("");
      expect(meta?.description).toBe("");

      const sess = db
        .query<
          {
            cwd_class: string;
            agent_name: string;
            title: string;
            title_source: string;
          },
          [string]
        >(
          `SELECT cwd_class, agent_name, title, title_source FROM sessions WHERE id = ?`,
        )
        .get(base.id);
      expect(sess?.cwd_class).toBe("operator");
      expect(sess?.agent_name).toBe("grok-build-plan");
      // harness generated_title beats session_titles (summary tab title)
      expect(sess?.title).toBe("Harness Title From Summary");
      expect(sess?.title_source).toBe("harness");
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("subagent meta fills subagent_type + description on the child row", () => {
    const corpus = writeTripwireCorpus();
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const childId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
      const meta = db
        .query<
          { subagent_type: string; description: string },
          [string]
        >(
          `SELECT subagent_type, description FROM session_meta WHERE session_id = ?`,
        )
        .get(childId);
      expect(meta?.subagent_type).toBe("explore");
      expect(meta?.description).toBe("synthetic child");

      const sess = db
        .query<
          { agent: string; subagent_type: string; description: string },
          [string]
        >(
          `SELECT agent, subagent_type, description FROM sessions WHERE id = ?`,
        )
        .get(childId);
      expect(sess?.agent).toBe("subagent");
      expect(sess?.subagent_type).toBe("explore");
      expect(sess?.description).toBe("synthetic child");
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("skipped-unchanged still refreshes session_meta from summary", () => {
    const base = cleanCorpus()[0]!;
    const corpus = writeCorpus([
      {
        ...base,
        summaryExtra: {
          agent_name: "first-agent",
          generated_title: "First Title",
          session_summary: "tab",
        },
      },
    ]);
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const summaryPath = join(corpus.root, base.cwdEnc, base.id, "summary.json");
      const raw = JSON.parse(readFileSync(summaryPath, "utf-8")) as Record<string, unknown>;
      raw.agent_name = "second-agent";
      raw.generated_title = "Second Title";
      writeFileSync(summaryPath, JSON.stringify(raw, null, 2), "utf-8");
      // Leave updates.jsonl mtime/size alone so ingest takes the skipped-unchanged path.

      const second = ingest(db, { sessionsDir: corpus.root });
      expect(second.sessionDirsSkippedUnchanged).toBe(1);

      const meta = db
        .query<{ agent_name: string; generated_title: string }, [string]>(
          `SELECT agent_name, generated_title FROM session_meta WHERE session_id = ?`,
        )
        .get(base.id);
      expect(meta?.agent_name).toBe("second-agent");
      expect(meta?.generated_title).toBe("Second Title");

      const sess = db
        .query<{ agent_name: string; title: string; title_source: string }, [string]>(
          `SELECT agent_name, title, title_source FROM sessions WHERE id = ?`,
        )
        .get(base.id);
      expect(sess?.agent_name).toBe("second-agent");
      expect(sess?.title).toBe("Second Title");
      expect(sess?.title_source).toBe("harness");
    } finally {
      db.close();
      corpus.cleanup();
    }
  });
});

describe("title precedence", () => {
  test("generated_titles > session_meta.generated_title > session_titles.title", () => {
    const base = cleanCorpus()[0]!;
    const corpus = writeCorpus([
      {
        ...base,
        summaryExtra: {
          session_summary: "Summary Title",
          generated_title: "Harness Title",
          agent_name: "grok-build-plan",
        },
      },
    ]);
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });

      // Arm 3 alone: summary (no harness title in a second session)
      const summaryOnlyId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
      const corpus2 = writeCorpus([
        {
          id: summaryOnlyId,
          cwdEnc: CWD_ENC,
          cwdDecoded: CWD_DEC,
          updates: [
            userChunk("hi"),
            agentChunk("yo"),
            turnCompleted(makeUsage()),
          ],
          summaryExtra: { session_summary: "Only Summary" },
        },
      ]);
      try {
        ingest(db, { sessionsDir: corpus2.root });
        const sOnly = db
          .query<{ title: string; title_source: string }, [string]>(
            `SELECT title, title_source FROM sessions WHERE id = ?`,
          )
          .get(summaryOnlyId);
        expect(sOnly?.title).toBe("Only Summary");
        expect(sOnly?.title_source).toBe("summary");
      } finally {
        corpus2.cleanup();
      }

      // Harness beats summary
      const harness = db
        .query<{ title: string; title_source: string }, [string]>(
          `SELECT title, title_source FROM sessions WHERE id = ?`,
        )
        .get(base.id);
      expect(harness?.title).toBe("Harness Title");
      expect(harness?.title_source).toBe("harness");

      // Model-generated beats harness
      db.prepare(
        `INSERT INTO generated_titles (session_id, title, summary, model_id, created_at, source_events)
         VALUES (?, ?, '', 'test-model', ?, 1)`,
      ).run(base.id, "Model Generated Title", new Date().toISOString());

      // Re-run rebuild path: re-ingest same corpus (full) keeps generated_titles
      ingest(db, { sessionsDir: corpus.root, full: true });
      const gen = db
        .query<{ title: string; title_source: string }, [string]>(
          `SELECT title, title_source FROM sessions WHERE id = ?`,
        )
        .get(base.id);
      expect(gen?.title).toBe("Model Generated Title");
      expect(gen?.title_source).toBe("generated");
    } finally {
      db.close();
      corpus.cleanup();
    }
  });
});

describe("applySessionFacets", () => {
  test("classifies distinct project_paths and is idempotent", () => {
    const operator = cleanCorpus()[0]!;
    const harnessPath = "C:\\Users\\Synthetic\\AppData\\Local\\Temp\\chat-mode-abc";
    const harnessEnc = encodeURIComponent(harnessPath);
    const harnessId = "cccccccc-dddd-eeee-ffff-000000000000";
    const corpus = writeCorpus([
      {
        ...operator,
        summaryExtra: { agent_name: "op-agent" },
      },
      {
        id: harnessId,
        cwdEnc: harnessEnc,
        cwdDecoded: harnessPath,
        updates: [
          userChunk("smoke"),
          agentChunk("ok"),
          turnCompleted(makeUsage()),
        ],
        summaryExtra: { agent_name: "harness-agent" },
      },
    ]);
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });

      const rows = db
        .query<{ id: string; cwd_class: string; agent_name: string }, []>(
          `SELECT id, cwd_class, agent_name FROM sessions ORDER BY id`,
        )
        .all();
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(operator.id)?.cwd_class).toBe("operator");
      expect(byId.get(operator.id)?.agent_name).toBe("op-agent");
      expect(byId.get(harnessId)?.cwd_class).toBe("harness");
      expect(byId.get(harnessId)?.agent_name).toBe("harness-agent");

      // Idempotent second pass
      applySessionFacets(db);
      const again = db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM sessions WHERE cwd_class IN ('operator','harness')`,
        )
        .get()?.n;
      expect(again).toBe(2);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });
});
