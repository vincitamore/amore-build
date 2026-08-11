import { describe, expect, test } from "bun:test";
import { openDb } from "../store/db";
import { ingest } from "./index";
import {
  ANNOTATION_METHOD,
  dominantPhaseClass,
  durationSec,
  errorDensity,
  rebuildSessionAnnotations,
} from "./annotations";
import type { PhaseSpan } from "../probes/session-phase";
import {
  agentChunk,
  cleanCorpus,
  CWD_DEC,
  CWD_ENC,
  makeUsage,
  toolCall,
  toolCallUpdate,
  turnCompleted,
  updateLine,
  userChunk,
  writeCorpus,
  writeTripwireCorpus,
} from "../test/fixtures";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("annotation pure helpers", () => {
  test("errorDensity uses max(1, turn_count)", () => {
    expect(errorDensity(3, 10)).toBe(0.3);
    expect(errorDensity(5, 0)).toBe(5);
    expect(errorDensity(0, 0)).toBe(0);
    expect(errorDensity(0, 4)).toBe(0);
  });

  test("durationSec is ended_at − started_at", () => {
    const a = "2026-06-01T12:00:00.000Z";
    const b = "2026-06-01T12:01:30.000Z";
    expect(durationSec(a, b)).toBe(90);
    expect(durationSec(b, a)).toBe(0);
    expect(durationSec("not-a-date", b)).toBe(0);
  });

  test("dominantPhaseClass picks most frequent, ties by priority", () => {
    const base = {
      sessionId: "s",
      projectPath: "/p",
      startTs: "t0",
      endTs: "t1",
      eventIds: [1],
      detail: "x",
    };
    expect(dominantPhaseClass([])).toBe("");
    expect(
      dominantPhaseClass([
        { ...base, kind: "burst" },
        { ...base, kind: "burst" },
        { ...base, kind: "stall" },
      ] as PhaseSpan[]),
    ).toBe("burst");
    // Tie: error-cluster outranks stall.
    expect(
      dominantPhaseClass([
        { ...base, kind: "stall" },
        { ...base, kind: "error-cluster" },
      ] as PhaseSpan[]),
    ).toBe("error-cluster");
  });
});

describe("rebuildSessionAnnotations", () => {
  test("annotations exist for every session after ingest", () => {
    const corpus = writeTripwireCorpus();
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const sessions =
        db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()?.n ?? 0;
      const annotations =
        db
          .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM session_annotations")
          .get()?.n ?? 0;
      expect(sessions).toBeGreaterThan(0);
      expect(annotations).toBe(sessions);

      const emptyMethod =
        db
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM session_annotations WHERE method = '' OR method IS NULL`,
          )
          .get()?.n ?? 0;
      expect(emptyMethod).toBe(0);

      const methods = db
        .query<{ method: string }, []>(`SELECT method FROM session_annotations`)
        .all();
      expect(methods.every((m) => m.method === ANNOTATION_METHOD)).toBe(true);
      expect(methods.every((m) => m.method.length > 0)).toBe(true);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("density and usage rollup arithmetic match sessions + usage", () => {
    const id = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    const t0 = Date.parse("2026-06-01T10:00:00.000Z");
    const corpus = writeCorpus([
      {
        id,
        cwdEnc: CWD_ENC,
        cwdDecoded: CWD_DEC,
        modelId: "grok-4",
        updates: [
          updateLine(id, userChunk("hello"), iso(t0)),
          updateLine(id, agentChunk("hi"), iso(t0 + 30_000)),
          updateLine(
            id,
            toolCall("tc1", "read_file", { target_file: "a.ts" }),
            iso(t0 + 40_000),
          ),
          updateLine(id, toolCallUpdate("tc1", "read_file", "ok"), iso(t0 + 50_000)),
          updateLine(
            id,
            turnCompleted(
              makeUsage("grok-4", {
                inputTokens: 400,
                outputTokens: 80,
                totalTokens: 480,
              }),
            ),
            iso(t0 + 60_000),
          ),
          updateLine(
            id,
            turnCompleted(
              makeUsage("grok-4", {
                inputTokens: 100,
                outputTokens: 20,
                totalTokens: 120,
              }),
            ),
            iso(t0 + 90_000),
          ),
        ],
      },
    ]);
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });

      const sess = db
        .query<
          {
            turn_count: number;
            tool_error_count: number;
            started_at: string;
            ended_at: string;
          },
          [string]
        >(
          `SELECT turn_count, tool_error_count, started_at, ended_at FROM sessions WHERE id = ?`,
        )
        .get(id);
      expect(sess).toBeTruthy();

      const ann = db
        .query<
          {
            error_density: number;
            input_tokens: number;
            output_tokens: number;
            total_tokens: number;
            duration_sec: number;
            method: string;
            probe_hits: string;
          },
          [string]
        >(
          `SELECT error_density, input_tokens, output_tokens, total_tokens,
                  duration_sec, method, probe_hits
           FROM session_annotations WHERE session_id = ?`,
        )
        .get(id);
      expect(ann).toBeTruthy();
      expect(ann!.method).toBe(ANNOTATION_METHOD);
      expect(ann!.error_density).toBe(
        errorDensity(sess!.tool_error_count, sess!.turn_count),
      );
      expect(ann!.input_tokens).toBe(500);
      expect(ann!.output_tokens).toBe(100);
      expect(ann!.total_tokens).toBe(600);
      expect(ann!.duration_sec).toBe(
        durationSec(sess!.started_at, sess!.ended_at),
      );
      // Valid JSON object.
      const hits = JSON.parse(ann!.probe_hits) as Record<string, number>;
      expect(typeof hits).toBe("object");
      expect(hits).not.toBeNull();
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("tripwire corpus surfaces rage and stuck-loop probe hits", () => {
    const corpus = writeTripwireCorpus();
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const parentId = "11111111-2222-3333-4444-555555555555";
      const ann = db
        .query<{ probe_hits: string; method: string }, [string]>(
          `SELECT probe_hits, method FROM session_annotations WHERE session_id = ?`,
        )
        .get(parentId);
      expect(ann).toBeTruthy();
      expect(ann!.method.length).toBeGreaterThan(0);
      const hits = JSON.parse(ann!.probe_hits) as Record<string, number>;
      expect(hits.rage ?? 0).toBeGreaterThanOrEqual(1);
      expect(hits["stuck-loop"] ?? 0).toBeGreaterThanOrEqual(1);
      expect(hits["operator-correction"] ?? 0).toBeGreaterThanOrEqual(1);
      expect(hits.apology ?? 0).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("phase_class is burst for a planted short-delta session", () => {
    const id = "phase-ann-burst-session";
    const project = "C:\\Users\\Synthetic\\ann-phase";
    const db = openDb(":memory:");
    try {
      const t0 = Date.parse("2026-06-01T15:00:00.000Z");
      db.run(
        `INSERT INTO sessions (id, project_path, agent, started_at, ended_at,
           turn_count, user_msg_count, tool_call_count, tool_error_count)
         VALUES (?, ?, 'primary', ?, ?, 6, 0, 6, 0)`,
        [id, project, iso(t0), iso(t0 + 25_000)],
      );
      for (let i = 0; i < 6; i++) {
        db.run(
          `INSERT INTO events (session_id, project_path, agent, ts, kind, text,
             tool_error, is_boilerplate, sensitive, raw)
           VALUES (?, ?, 'primary', ?, 'tool_use', NULL, 0, 0, 0, '{}')`,
          [id, project, iso(t0 + i * 5_000)],
        );
      }

      rebuildSessionAnnotations(db);

      const row = db
        .query<{ phase_class: string; method: string }, [string]>(
          `SELECT phase_class, method FROM session_annotations WHERE session_id = ?`,
        )
        .get(id);
      expect(row?.phase_class).toBe("burst");
      expect(row?.method).toBe(ANNOTATION_METHOD);
    } finally {
      db.close();
    }
  });

  test("re-ingest is idempotent for annotations", () => {
    const corpus = writeCorpus(cleanCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const first = db
        .query<
          {
            session_id: string;
            phase_class: string;
            error_density: number;
            probe_hits: string;
            input_tokens: number;
            output_tokens: number;
            total_tokens: number;
            duration_sec: number;
            method: string;
          },
          []
        >(`SELECT * FROM session_annotations ORDER BY session_id`)
        .all();

      // Full rebuild path.
      ingest(db, { sessionsDir: corpus.root, full: true });
      const second = db
        .query<
          {
            session_id: string;
            phase_class: string;
            error_density: number;
            probe_hits: string;
            input_tokens: number;
            output_tokens: number;
            total_tokens: number;
            duration_sec: number;
            method: string;
          },
          []
        >(`SELECT * FROM session_annotations ORDER BY session_id`)
        .all();

      expect(second.length).toBe(first.length);
      expect(second).toEqual(first);

      // Explicit second rebuild without re-ingest.
      rebuildSessionAnnotations(db);
      const third = db
        .query<
          {
            session_id: string;
            phase_class: string;
            error_density: number;
            probe_hits: string;
            input_tokens: number;
            output_tokens: number;
            total_tokens: number;
            duration_sec: number;
            method: string;
          },
          []
        >(`SELECT * FROM session_annotations ORDER BY session_id`)
        .all();
      expect(third).toEqual(first);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("clean corpus has annotation row with empty/zero hits and non-empty method", () => {
    const corpus = writeCorpus(cleanCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const row = db
        .query<{ probe_hits: string; method: string; input_tokens: number }, []>(
          `SELECT probe_hits, method, input_tokens FROM session_annotations LIMIT 1`,
        )
        .get();
      expect(row).toBeTruthy();
      expect(row!.method.length).toBeGreaterThan(0);
      expect(row!.input_tokens).toBe(500);
      const hits = JSON.parse(row!.probe_hits) as Record<string, number>;
      expect(Object.keys(hits).length).toBe(0);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });
});
