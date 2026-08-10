/**
 * Typed event-link derivation over the events table.
 *
 * Deterministic:
 *   GENERATED  tool_use → tool_result (same tool_call_id)
 *   USED       prior tool activity → later tool_use sharing an artifact path
 *
 * Conservative heuristic:
 *   PRECEDENT_FOR  plan event → later tool_use with overlapping text tokens
 *
 * CAUSED / INFLUENCED are intentionally omitted here — too fuzzy without a
 * clearer corpus signal. Every row carries method (+ heuristic flag).
 */

export type LinkKind = "GENERATED" | "USED" | "PRECEDENT_FOR" | "CAUSED" | "INFLUENCED";

export interface LinkEvent {
  id: number;
  sessionId: string;
  ts: string;
  kind: string;
  text: string | null;
  toolName: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  toolCallId: string | null;
}

export interface DerivedLink {
  sourceEventId: number;
  targetEventId: number;
  kind: LinkKind;
  method: string;
  confidence: number;
  /** 1 when method is heuristic (non-deterministic). */
  heuristic: 0 | 1;
}

/** Common path-bearing keys in tool_input JSON. */
const PATH_KEYS = [
  "target_file",
  "target_directory",
  "path",
  "file",
  "file_path",
  "filepath",
  "filename",
  "dir",
  "directory",
  "cwd",
  "output",
  "dest",
  "destination",
];

/** Extract artifact-path strings from tool_input / tool_output blobs. */
export function extractArtifactIds(blob: string | null | undefined): string[] {
  if (!blob) return [];
  const out = new Set<string>();

  // JSON object path fields
  try {
    const parsed = JSON.parse(blob) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      for (const key of PATH_KEYS) {
        const v = obj[key];
        if (typeof v === "string" && v.length >= 2 && v.length <= 512) {
          out.add(normalizeArtifact(v));
        }
      }
    }
  } catch {
    // not JSON — fall through to path-like token scan
  }

  // Path-like tokens (forward/back slash or common file suffixes)
  const pathRe =
    /(?:^|[\s"'`=])((?:[A-Za-z]:)?(?:[\\/][\w.@[\]()+ -]+){1,}|\w[\w.-]*\.\w{1,8})/g;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(blob)) !== null) {
    const token = m[1]!.trim();
    if (token.length >= 3 && token.length <= 512) out.add(normalizeArtifact(token));
  }

  return Array.from(out).filter((s) => s.length >= 2);
}

function normalizeArtifact(s: string): string {
  return s.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

/**
 * Build typed links from an ordered event list (session_id, ts, id).
 * Pure function — no I/O. Caller persists.
 */
export function buildEventLinks(events: readonly LinkEvent[]): DerivedLink[] {
  const links: DerivedLink[] = [];
  const seen = new Set<string>();

  const push = (link: DerivedLink) => {
    if (link.sourceEventId === link.targetEventId) return;
    const key = `${link.sourceEventId}\0${link.targetEventId}\0${link.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };

  // Group by session for intra-session pairing only.
  const bySession = new Map<string, LinkEvent[]>();
  for (const ev of events) {
    let list = bySession.get(ev.sessionId);
    if (!list) {
      list = [];
      bySession.set(ev.sessionId, list);
    }
    list.push(ev);
  }

  for (const [, sessionEvents] of bySession) {
    sessionEvents.sort((a, b) => {
      if (a.ts < b.ts) return -1;
      if (a.ts > b.ts) return 1;
      return a.id - b.id;
    });

    // --- GENERATED via tool_call_id: tool_use → tool_result ---
    const uses = new Map<string, LinkEvent>();
    const results = new Map<string, LinkEvent>();
    for (const ev of sessionEvents) {
      if (!ev.toolCallId) continue;
      if (ev.kind === "tool_use" && !uses.has(ev.toolCallId)) {
        uses.set(ev.toolCallId, ev);
      }
      if (ev.kind === "tool_result") {
        results.set(ev.toolCallId, ev);
      }
    }
    for (const [callId, use] of uses) {
      const res = results.get(callId);
      if (!res) continue;
      push({
        sourceEventId: use.id,
        targetEventId: res.id,
        kind: "GENERATED",
        method: "tool_call_id",
        confidence: 1,
        heuristic: 0,
      });
    }

    // --- USED via shared artifact path: earlier tool activity → later tool_use ---
    // First tool_use that mentions artifact A is the generator; later tool_use that
    // mentions A is the consumer. Link generator (prefer its result) → consumer use.
    type ArtifactHit = { useId: number; resultId: number | null; order: number };
    const firstArtifact = new Map<string, ArtifactHit>();
    let order = 0;
    for (const ev of sessionEvents) {
      if (ev.kind !== "tool_use") continue;
      const arts = new Set([
        ...extractArtifactIds(ev.toolInput),
        ...extractArtifactIds(ev.toolOutput),
      ]);
      // Also fold matching result outputs for this call (paths often appear there).
      const res = ev.toolCallId ? results.get(ev.toolCallId) : undefined;
      if (res) {
        for (const a of extractArtifactIds(res.toolOutput)) arts.add(a);
        for (const a of extractArtifactIds(res.toolInput)) arts.add(a);
      }
      const thisOrder = order++;
      for (const art of arts) {
        const prior = firstArtifact.get(art);
        if (!prior) {
          firstArtifact.set(art, {
            useId: ev.id,
            resultId: res?.id ?? null,
            order: thisOrder,
          });
          continue;
        }
        if (prior.useId === ev.id) continue;
        // Consumer uses artifact generated by prior tool activity.
        const sourceId = prior.resultId ?? prior.useId;
        push({
          sourceEventId: sourceId,
          targetEventId: ev.id,
          kind: "USED",
          method: "artifact_path",
          confidence: 0.9,
          heuristic: 0,
        });
      }
    }

    // --- PRECEDENT_FOR: plan → later tool_use with overlapping tokens ---
    const plans = sessionEvents.filter((e) => e.kind === "plan" && e.text);
    const toolUses = sessionEvents.filter((e) => e.kind === "tool_use");
    for (const plan of plans) {
      const planTokens = significantTokens(plan.text ?? "");
      if (planTokens.size === 0) continue;
      for (const use of toolUses) {
        if (use.id <= plan.id) continue;
        if (use.ts < plan.ts) continue;
        const hay = `${use.toolName ?? ""} ${use.toolInput ?? ""}`.toLowerCase();
        let hits = 0;
        for (const t of planTokens) {
          if (hay.includes(t)) hits++;
        }
        // Require at least 2 shared tokens or one long path-like token match.
        const longHit = Array.from(planTokens).some((t) => t.length >= 8 && hay.includes(t));
        if (hits >= 2 || longHit) {
          push({
            sourceEventId: plan.id,
            targetEventId: use.id,
            kind: "PRECEDENT_FOR",
            method: "plan_text_match",
            confidence: longHit ? 0.7 : 0.55,
            heuristic: 1,
          });
        }
      }
    }
  }

  return links;
}

/** Lowercased tokens length ≥ 4, de-noised for plan text match. */
function significantTokens(text: string): Set<string> {
  const stop = new Set([
    "this",
    "that",
    "with",
    "from",
    "have",
    "will",
    "should",
    "would",
    "could",
    "about",
    "into",
    "then",
    "than",
    "them",
    "they",
    "their",
    "there",
    "when",
    "what",
    "which",
    "where",
    "your",
    "youre",
    "need",
    "just",
    "like",
    "also",
    "only",
    "some",
    "more",
    "make",
    "file",
    "files",
    "read",
    "write",
    "true",
    "false",
    "null",
    "type",
    "name",
    "text",
    "plan",
    "step",
    "task",
    "done",
    "todo",
  ]);
  const set = new Set<string>();
  const cleaned = text.toLowerCase().replace(/[^a-z0-9_./\\-]+/g, " ");
  for (const raw of cleaned.split(/\s+/)) {
    const t = raw.replace(/^[\./\\]+|[\./\\]+$/g, "");
    if (t.length < 4) continue;
    if (stop.has(t)) continue;
    set.add(t);
  }
  return set;
}
