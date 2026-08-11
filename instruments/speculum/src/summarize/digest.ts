/**
 * Compact session digest for title generation.
 *
 * Strips bloat before any model call: first non-boilerplate user head,
 * a small set of salient later turns (assistant text heads + tool names only),
 * and the final assistant tail. Hard-capped so the digest is the only payload.
 */

import { createHash } from "node:crypto";
import type { Db } from "../store/db";

/** Hard cap on rendered digest bytes (UTF-8). Never silently exceeded. */
export const DIGEST_CAP_BYTES = 8 * 1024;

const FIRST_USER_HEAD_CHARS = 600;
const ASSISTANT_HEAD_CHARS = 220;
const FINAL_ASSISTANT_TAIL_CHARS = 400;
const MAX_SALIENCE = 10;

export interface DigestEvent {
  id: number;
  kind: string;
  ts: string;
  text: string | null;
  toolName: string | null;
  isBoilerplate: boolean;
}

export interface SessionDigest {
  sessionId: string;
  projectPath: string;
  /** Rendered digest text (pre-scrub). */
  text: string;
  /** UTF-8 byte length of text. */
  bytes: number;
  /** Events that contributed content to the digest. */
  sourceEvents: number;
  /** SHA-256 hex of the rendered digest text (audit / dry-run). */
  hash: string;
  /** True when at least one content-bearing turn was found. */
  hasContent: boolean;
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

function head(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1)}…`;
}

function tail(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  return `…${t.slice(t.length - (n - 1))}`;
}

/** SHA-256 hex of a UTF-8 string. */
export function digestHash(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Load ordered events for one session (primary agent only — digest stays
 * on the operator-facing primary transcript).
 */
export function loadSessionEvents(db: Db, sessionId: string): DigestEvent[] {
  const rows = db
    .query<
      {
        id: number;
        kind: string;
        ts: string;
        text: string | null;
        tool_name: string | null;
        is_boilerplate: number;
      },
      [string]
    >(
      `SELECT id, kind, ts, text, tool_name, is_boilerplate
       FROM events
       WHERE session_id = ? AND agent = 'primary'
       ORDER BY ts, id`,
    )
    .all(sessionId);

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    ts: r.ts,
    text: r.text,
    toolName: r.tool_name,
    isBoilerplate: r.is_boilerplate === 1,
  }));
}

export function projectPathForSession(db: Db, sessionId: string): string {
  const row = db
    .query<{ project_path: string }, [string]>(
      `SELECT project_path FROM sessions WHERE id = ?`,
    )
    .get(sessionId);
  return row?.project_path ?? "";
}

/**
 * Pure digest builder from an in-memory event list. Deterministic for a
 * fixed input. Caps at DIGEST_CAP_BYTES by dropping mid-salience lines first,
 * then trimming assistant heads, never expanding tool payloads.
 */
export function buildDigestFromEvents(
  sessionId: string,
  projectPath: string,
  events: DigestEvent[],
  capBytes: number = DIGEST_CAP_BYTES,
): SessionDigest {
  const firstUser = events.find(
    (e) => e.kind === "user" && !e.isBoilerplate && (e.text ?? "").trim().length > 0,
  );

  let lastAssistantIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "assistant" && (e.text ?? "").trim().length > 0) {
      lastAssistantIdx = i;
      break;
    }
  }
  const lastAssistant = lastAssistantIdx >= 0 ? events[lastAssistantIdx]! : null;

  // Salient mid-session turns: assistant heads + tool names only, between
  // first user and final assistant (exclusive of those anchors).
  const mid: DigestEvent[] = [];
  const startIdx = firstUser ? events.indexOf(firstUser) + 1 : 0;
  const endIdx = lastAssistantIdx >= 0 ? lastAssistantIdx : events.length;
  for (let i = startIdx; i < endIdx; i++) {
    const e = events[i]!;
    if (e.kind === "assistant" && (e.text ?? "").trim().length > 0) {
      mid.push(e);
    } else if (e.kind === "tool_use" && e.toolName) {
      mid.push(e);
    }
  }

  const selectedMid = selectSalient(mid, MAX_SALIENCE);
  const usedIds = new Set<number>();
  if (firstUser) usedIds.add(firstUser.id);
  if (lastAssistant) usedIds.add(lastAssistant.id);
  for (const e of selectedMid) usedIds.add(e.id);

  const lines: string[] = [
    `SESSION ${sessionId}`,
    `PROJECT ${projectPath || "(unknown)"}`,
    "",
  ];

  if (firstUser?.text) {
    lines.push("[USER first]");
    lines.push(head(firstUser.text, FIRST_USER_HEAD_CHARS));
    lines.push("");
  }

  if (selectedMid.length > 0) {
    lines.push("[TURNS]");
    for (const e of selectedMid) {
      if (e.kind === "tool_use") {
        lines.push(`- tool: ${e.toolName}`);
      } else {
        lines.push(`- assistant: ${head(e.text ?? "", ASSISTANT_HEAD_CHARS)}`);
      }
    }
    lines.push("");
  }

  if (lastAssistant?.text) {
    lines.push("[FINAL ASSISTANT]");
    lines.push(tail(lastAssistant.text, FINAL_ASSISTANT_TAIL_CHARS));
    lines.push("");
  }

  let text = lines.join("\n").trimEnd() + "\n";
  text = enforceCap(text, selectedMid, capBytes);

  const hasContent = usedIds.size > 0;
  return {
    sessionId,
    projectPath,
    text,
    bytes: utf8Bytes(text),
    sourceEvents: usedIds.size,
    hash: digestHash(text),
    hasContent,
  };
}

/** Evenly sample up to max items, preserving order (deterministic). */
function selectSalient(items: DigestEvent[], max: number): DigestEvent[] {
  if (items.length <= max) return items.slice();
  if (max <= 0) return [];
  if (max === 1) return [items[0]!];

  const out: DigestEvent[] = [];
  const last = max - 1;
  for (let i = 0; i < max; i++) {
    const idx =
      i === last
        ? items.length - 1
        : Math.round((i * (items.length - 1)) / last);
    const item = items[idx]!;
    if (out.length === 0 || out[out.length - 1]!.id !== item.id) {
      out.push(item);
    }
  }
  // If collisions dropped us below max, fill with unused mid items by order.
  if (out.length < max) {
    const have = new Set(out.map((e) => e.id));
    for (const e of items) {
      if (have.has(e.id)) continue;
      out.push(e);
      have.add(e.id);
      if (out.length >= max) break;
    }
    out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id));
  }
  return out;
}

/**
 * If over cap, drop salience lines from the middle of [TURNS], then hard-slice.
 * Prefer losing mid context over losing the first user or final assistant.
 */
function enforceCap(
  text: string,
  _selectedMid: DigestEvent[],
  capBytes: number,
): string {
  if (utf8Bytes(text) <= capBytes) return text;

  const lines = text.split("\n");
  const turnStart = lines.findIndex((l) => l === "[TURNS]");
  const finalStart = lines.findIndex((l) => l === "[FINAL ASSISTANT]");

  if (turnStart >= 0) {
    const turnEnd = finalStart >= 0 ? finalStart : lines.length;
    // Drop tool/assistant lines from the middle of the turns block.
    let turnLines = lines.slice(turnStart + 1, turnEnd).filter((l) => l.startsWith("- "));
    while (turnLines.length > 0 && utf8Bytes(rebuild(lines, turnStart, turnEnd, turnLines)) > capBytes) {
      const mid = Math.floor(turnLines.length / 2);
      turnLines = turnLines.filter((_, i) => i !== mid);
    }
    text = rebuild(lines, turnStart, turnEnd, turnLines);
  }

  if (utf8Bytes(text) <= capBytes) return text;

  // Last resort: hard cut at a UTF-8 safe boundary near the cap.
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= capBytes) return text;
  let cut = capBytes;
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString("utf-8") + "\n…\n";
}

function rebuild(
  lines: string[],
  turnStart: number,
  turnEnd: number,
  turnLines: string[],
): string {
  const head = lines.slice(0, turnStart + 1);
  const tail = lines.slice(turnEnd);
  const body =
    turnLines.length > 0
      ? [...turnLines, ""]
      : []; // empty turns section collapses to blank after header
  // If no turn lines left, omit the [TURNS] header too.
  if (turnLines.length === 0) {
    return [...lines.slice(0, turnStart), ...tail].join("\n");
  }
  return [...head, ...body, ...tail].join("\n");
}

/** Build a digest for one session from the derived index. */
export function buildSessionDigest(db: Db, sessionId: string): SessionDigest {
  const events = loadSessionEvents(db, sessionId);
  const projectPath = projectPathForSession(db, sessionId);
  return buildDigestFromEvents(sessionId, projectPath, events);
}
