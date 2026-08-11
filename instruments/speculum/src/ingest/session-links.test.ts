/**
 * session_links rebuild: shared_artifact across sessions + resumed_from
 * from recorded summary parent_session_id. Synthetic fixtures only.
 */

import { describe, expect, test } from "bun:test";
import { openDb } from "../store/db";
import { ingest } from "./index";
import {
  rebuildSessionLinks,
  listSessionLinks,
  extractSharedArtifactLinks,
  isPlausibleArtifact,
  ARTIFACT_UBIQUITY_MAX,
  SHARED_ARTIFACT_METHOD,
} from "./session-links";
import { rebuildEventLinksAndDecisions } from "../decisions";
import {
  agentChunk,
  toolCall,
  toolCallUpdate,
  turnCompleted,
  makeUsage,
  updateLine,
  userChunk,
  writeCorpus,
  CWD_ENC,
  CWD_DEC,
  type FixtureSession,
} from "../test/fixtures";

const GEN = "aaaaaaaa-bbbb-cccc-dddd-111111111111";
const CON = "aaaaaaaa-bbbb-cccc-dddd-222222222222";
const OTHER = "aaaaaaaa-bbbb-cccc-dddd-333333333333";
const PRIOR = "bbbbbbbb-cccc-dddd-eeee-111111111111";
const RESUMED = "bbbbbbbb-cccc-dddd-eeee-222222222222";

function crossSessionArtifactCorpus() {
  const t = (n: number) => `2026-07-10T10:00:${String(n).padStart(2, "0")}.000Z`;
  return [
    {
      id: GEN,
      cwdEnc: CWD_ENC,
      cwdDecoded: CWD_DEC,
      modelId: "grok-4",
      updates: [
        updateLine(GEN, userChunk("write notes"), t(0)),
        updateLine(GEN, agentChunk("writing"), t(1)),
        updateLine(
          GEN,
          toolCall("g1", "write_file", {
            file_path: "shared/notes.md",
            content: "hello",
          }),
          t(2),
        ),
        updateLine(GEN, toolCallUpdate("g1", "write_file", "wrote shared/notes.md"), t(3)),
        updateLine(GEN, turnCompleted(makeUsage()), t(4)),
      ],
    },
    {
      id: CON,
      cwdEnc: CWD_ENC,
      cwdDecoded: CWD_DEC,
      modelId: "grok-4",
      updates: [
        updateLine(CON, userChunk("read notes"), t(10)),
        updateLine(CON, agentChunk("reading"), t(11)),
        updateLine(
          CON,
          toolCall("c1", "read_file", { target_file: "shared/notes.md" }),
          t(12),
        ),
        updateLine(CON, toolCallUpdate("c1", "read_file", "hello"), t(13)),
        updateLine(CON, turnCompleted(makeUsage()), t(14)),
      ],
    },
  ];
}

function sameSessionOnlyCorpus() {
  const id = OTHER;
  const t = (n: number) => `2026-07-11T10:00:${String(n).padStart(2, "0")}.000Z`;
  return [
    {
      id,
      cwdEnc: CWD_ENC,
      cwdDecoded: CWD_DEC,
      modelId: "grok-4",
      updates: [
        updateLine(id, userChunk("write then read"), t(0)),
        updateLine(
          id,
          toolCall("s1", "write_file", { file_path: "local-only.md", content: "x" }),
          t(1),
        ),
        updateLine(id, toolCallUpdate("s1", "write_file", "ok"), t(2)),
        updateLine(id, toolCall("s2", "read_file", { target_file: "local-only.md" }), t(3)),
        updateLine(id, toolCallUpdate("s2", "read_file", "x"), t(4)),
        updateLine(id, turnCompleted(makeUsage()), t(5)),
      ],
    },
  ];
}

function resumedCorpus() {
  const t = (n: number) => `2026-07-12T10:00:${String(n).padStart(2, "0")}.000Z`;
  return [
    {
      id: PRIOR,
      cwdEnc: CWD_ENC,
      cwdDecoded: CWD_DEC,
      modelId: "grok-4",
      updates: [
        updateLine(PRIOR, userChunk("start"), t(0)),
        updateLine(PRIOR, agentChunk("ok"), t(1)),
        updateLine(PRIOR, turnCompleted(makeUsage()), t(2)),
      ],
    },
    {
      id: RESUMED,
      cwdEnc: CWD_ENC,
      cwdDecoded: CWD_DEC,
      modelId: "grok-4",
      summaryExtra: {
        parent_session_id: PRIOR,
        session_kind: "subagent_resume",
        fork_context_source: "resumed",
      },
      updates: [
        updateLine(RESUMED, userChunk("continue"), t(10)),
        updateLine(RESUMED, agentChunk("continuing"), t(11)),
        updateLine(RESUMED, turnCompleted(makeUsage()), t(12)),
      ],
    },
  ];
}

/**
 * ARTIFACT_UBIQUITY_MAX + 1 sessions all mention the same commons path.
 * Expect: zero shared_artifact edges for that path.
 */
function ubiquitousArtifactCorpus(): FixtureSession[] {
  const n = ARTIFACT_UBIQUITY_MAX + 1;
  const sessions: FixtureSession[] = [];
  for (let i = 0; i < n; i++) {
    const id = `cccccccc-dddd-eeee-ffff-${String(i).padStart(12, "0")}`;
    const t = (sec: number) =>
      `2026-07-13T${String(10 + i).padStart(2, "0")}:00:${String(sec).padStart(2, "0")}.000Z`;
    sessions.push({
      id,
      cwdEnc: CWD_ENC,
      cwdDecoded: CWD_DEC,
      modelId: "grok-4",
      updates: [
        updateLine(id, userChunk(`touch package.json #${i}`), t(0)),
        updateLine(
          id,
          toolCall(`u${i}`, "read_file", { target_file: "package.json" }),
          t(1),
        ),
        updateLine(id, toolCallUpdate(`u${i}`, "read_file", "{}"), t(2)),
        updateLine(id, turnCompleted(makeUsage()), t(3)),
      ],
    });
  }
  return sessions;
}

describe("isPlausibleArtifact", () => {
  // Live junk from fix-round-1 excluded top list + sub-threshold samples.
  const MUST_REJECT = [
    "/ntriggered-by",
    "/n/n",
    "/npipeline",
    "/n-",
    "e.g",
    "/n2.",
    "/n/n---/n/n",
    "/n3.",
    "/n/n-",
    "/n)",
    "/n(",
    "/n4.",
    "/n5.",
    "2.1",
    "1.2",
    "0.8",
    "console.log",
    "json.stringif",
    "math.max",
    "db.close",
    "date.now",
    "grok-4.5",
    "/ counter-evidence",
    "/n  -",
    "/ open questions/n/n1.",
    "/n        backgroundcolor",
    "/n        db/n          .query",
    "/ngit -c",
    "/ search",
    "/n/nthe",
    "/ntry",
    "g.width",
    "color.sky500",
    "layoutnotes.push",
    "subprocess.complete",
    "activeelement.tagname",
    "rows.map",
    "array.map",
    "knowledge",
    "inbox",
    "..",
    "/tmp",
  ];

  // Genuine paths from the operator corpus (and fixtures).
  const MUST_KEEP = [
    "package.json",
    "readme.md",
    "agents.md",
    "schema.sql",
    "context/current-state.md",
    "shared/notes.md",
    "c:/users/alexmoyer/documents/amore-build/instruments/speculum/src/store/schema.sql",
    "c:/users/alexmoyer/documents/amore/knowledge/infrastructure/git-forge-operations.md",
    "c:/users/alexmoyer/documents/amore/.amore/skills/amore-build/skill.md",
    "../external/knowledge/readme.md",
    ".amore/skills/tui/skill.md",
    "instruments/speculum/src",
    "c:/users/alexmoyer/documents/amore-build/instruments/speculum/src",
    "search3.py",
    "registry.tsx",
    "where.exe",
    "handle.exe",
  ];

  test("rejects live junk classes (escaped newlines, prose, code refs)", () => {
    for (const junk of MUST_REJECT) {
      expect(isPlausibleArtifact(junk)).toBe(false);
    }
  });

  test("keeps genuine corpus paths (extension or multi-segment)", () => {
    for (const path of MUST_KEEP) {
      expect(isPlausibleArtifact(path)).toBe(true);
    }
  });

  test("method banner records plausible + ubiquity rule", () => {
    expect(SHARED_ARTIFACT_METHOD).toContain("plausible");
    expect(SHARED_ARTIFACT_METHOD).toContain(`ubiquity<=${ARTIFACT_UBIQUITY_MAX}`);
  });
});

describe("session_links", () => {
  test("cross-session artifact pair produces exactly one shared_artifact edge", () => {
    const corpus = writeCorpus(crossSessionArtifactCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      // Ensure sessionsDir is visible for any disk reads; artifact path is DB-only.
      const stats = rebuildSessionLinks(db, { sessionsDir: corpus.root });
      expect(stats.sharedArtifact).toBe(1);
      expect(stats.resumedFrom).toBe(0);

      const links = listSessionLinks(db, { kind: "shared_artifact" });
      expect(links.length).toBe(1);
      const edge = links[0]!;
      expect(edge.sourceSession).toBe(GEN);
      expect(edge.targetSession).toBe(CON);
      expect(edge.kind).toBe("shared_artifact");
      expect(edge.method).toBe(SHARED_ARTIFACT_METHOD);
      expect(edge.method).toContain("plausible");
      expect(edge.method).toContain(`ubiquity<=${ARTIFACT_UBIQUITY_MAX}`);
      expect(edge.heuristic).toBe(1);
      expect(edge.confidence).toBeGreaterThan(0);
      expect(edge.evidence.toLowerCase()).toContain("notes.md");
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("artifact spanning more than ubiquity max generates zero pair edges", () => {
    const corpus = writeCorpus(ubiquitousArtifactCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const stats = rebuildSessionLinks(db, { sessionsDir: corpus.root });
      expect(stats.sharedArtifact).toBe(0);
      const links = listSessionLinks(db, { kind: "shared_artifact" });
      expect(links.length).toBe(0);
      // No evidence line should mention the commons basename.
      expect(links.every((l) => !l.evidence.includes("package.json"))).toBe(true);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("implausible identities never produce shared_artifact edges", () => {
    // Two sessions both "mention" console.log / escaped-newline junk via tool
    // input strings that extractArtifactIds will pick up as path-like tokens.
    const a = "dddddddd-eeee-ffff-aaaa-111111111111";
    const b = "dddddddd-eeee-ffff-aaaa-222222222222";
    const t = (n: number) => `2026-07-14T10:00:${String(n).padStart(2, "0")}.000Z`;
    const corpus = writeCorpus([
      {
        id: a,
        cwdEnc: CWD_ENC,
        cwdDecoded: CWD_DEC,
        modelId: "grok-4",
        updates: [
          updateLine(
            a,
            toolCall("j1", "search", {
              path: "console.log",
              query: "see /ntriggered-by and e.g stuff",
            }),
            t(0),
          ),
          updateLine(a, toolCallUpdate("j1", "search", "hits"), t(1)),
          updateLine(a, turnCompleted(makeUsage()), t(2)),
        ],
      },
      {
        id: b,
        cwdEnc: CWD_ENC,
        cwdDecoded: CWD_DEC,
        modelId: "grok-4",
        updates: [
          updateLine(
            b,
            toolCall("j2", "search", {
              path: "console.log",
              query: "also /ntriggered-by",
            }),
            t(10),
          ),
          updateLine(b, toolCallUpdate("j2", "search", "hits"), t(11)),
          updateLine(b, turnCompleted(makeUsage()), t(12)),
        ],
      },
    ]);
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const stats = rebuildSessionLinks(db, { sessionsDir: corpus.root });
      expect(stats.sharedArtifact).toBe(0);
      const links = listSessionLinks(db, { kind: "shared_artifact" });
      expect(links.length).toBe(0);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("same-session artifact links never produce session_links rows", () => {
    const corpus = writeCorpus(sameSessionOnlyCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      rebuildEventLinksAndDecisions(db);
      // Intra-session USED should exist; session_links must stay empty.
      const used =
        db
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM event_links WHERE kind = 'USED'`,
          )
          .get()?.n ?? 0;
      expect(used).toBeGreaterThanOrEqual(1);

      const stats = rebuildSessionLinks(db, { sessionsDir: corpus.root });
      expect(stats.total).toBe(0);
      expect(listSessionLinks(db).length).toBe(0);
      expect(extractSharedArtifactLinks(db).length).toBe(0);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("resumed fixture produces resumed_from edge (method=recorded)", () => {
    const corpus = writeCorpus(resumedCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const stats = rebuildSessionLinks(db, { sessionsDir: corpus.root });
      expect(stats.resumedFrom).toBe(1);

      const links = listSessionLinks(db, { kind: "resumed_from" });
      expect(links.length).toBe(1);
      const edge = links[0]!;
      expect(edge.sourceSession).toBe(PRIOR);
      expect(edge.targetSession).toBe(RESUMED);
      expect(edge.method).toBe("recorded");
      expect(edge.heuristic).toBe(0);
      expect(edge.confidence).toBe(1);
      expect(edge.evidence).toContain(PRIOR);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("rebuild is idempotent in count shape", () => {
    const corpus = writeCorpus([
      ...crossSessionArtifactCorpus(),
      ...resumedCorpus(),
    ]);
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const a = rebuildSessionLinks(db, { sessionsDir: corpus.root });
      const b = rebuildSessionLinks(db, { sessionsDir: corpus.root });
      expect(b.total).toBe(a.total);
      expect(b.sharedArtifact).toBe(a.sharedArtifact);
      expect(b.resumedFrom).toBe(a.resumedFrom);
      expect(listSessionLinks(db).length).toBe(a.total);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("--session filter on listSessionLinks", () => {
    const corpus = writeCorpus(crossSessionArtifactCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      rebuildSessionLinks(db, { sessionsDir: corpus.root });
      const forGen = listSessionLinks(db, { sessionId: GEN });
      expect(forGen.length).toBe(1);
      const forMissing = listSessionLinks(db, {
        sessionId: "00000000-0000-0000-0000-000000000000",
      });
      expect(forMissing.length).toBe(0);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });
});
