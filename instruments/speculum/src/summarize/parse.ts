/**
 * Defensive parse of a model reply into { title, summary }.
 * Malformed replies fail closed — never write a garbage title.
 */

import { TITLE_MAX_CHARS } from "./prompt";

export interface ParsedTitle {
  title: string;
  summary: string;
}

export type ParseResult =
  | { ok: true; value: ParsedTitle }
  | { ok: false; reason: string };

const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

function stripWrappingQuotes(s: string): string {
  let t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith("`") && t.endsWith("`"))
  ) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

function sanitizeTitle(raw: string): string | null {
  let t = stripWrappingQuotes(raw);
  t = t.replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
  // Drop surrounding smart quotes if any remain.
  t = t.replace(/^[\u201C\u201D\u2018\u2019"]+|[\u201C\u201D\u2018\u2019"]+$/g, "").trim();
  // No internal double-quote decoration for picker display.
  t = t.replace(/"/g, "").trim();
  // Trailing period is common model noise on titles.
  if (t.endsWith(".") && t.length > 1) t = t.slice(0, -1).trim();
  if (!t) return null;
  if (t.length > TITLE_MAX_CHARS) {
    t = t.slice(0, TITLE_MAX_CHARS).trim();
    // Avoid mid-word cut when possible.
    const sp = t.lastIndexOf(" ");
    if (sp >= 20) t = t.slice(0, sp).trim();
  }
  if (!t) return null;
  return t;
}

function sanitizeSummary(raw: string): string {
  let s = raw.trim();
  s = s.replace(EMOJI_RE, "").replace(/\r\n/g, "\n").trim();
  // Soft cap — summary is local display, not a prompt payload.
  if (s.length > 800) s = s.slice(0, 797).trimEnd() + "…";
  return s;
}

/**
 * Extract a JSON object from model text (raw JSON or fenced / prose-wrapped).
 */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty model text");

  // Strip common markdown fences.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("no JSON object in model text");
  }
}

/**
 * Parse model envelope text into a title/summary pair.
 * Returns ok:false with a reason on any structural or empty-title failure.
 */
export function parseTitleReply(modelText: string): ParseResult {
  if (typeof modelText !== "string" || !modelText.trim()) {
    return { ok: false, reason: "empty model reply" };
  }

  let obj: unknown;
  try {
    obj = extractJsonObject(modelText);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `failed to parse JSON: ${msg}` };
  }

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { ok: false, reason: "reply JSON is not an object" };
  }

  const rec = obj as Record<string, unknown>;
  if (typeof rec.title !== "string") {
    return { ok: false, reason: "missing or non-string title" };
  }
  // summary may be absent; treat as empty string.
  if (rec.summary !== undefined && typeof rec.summary !== "string") {
    return { ok: false, reason: "summary must be a string when present" };
  }

  const title = sanitizeTitle(rec.title);
  if (!title) {
    return { ok: false, reason: "title empty after sanitization" };
  }

  const summary = sanitizeSummary(
    typeof rec.summary === "string" ? rec.summary : "",
  );

  return { ok: true, value: { title, summary } };
}
