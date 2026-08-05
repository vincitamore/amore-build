/**
 * Built-in agentic lenses. Each lens is a prompt template plus selection
 * guidance. Lenses send scrubbed local session content through the user's own
 * amore configuration; nothing is sent without an explicit lens command.
 */

export interface LensDefinition {
  name: string;
  /** One-line description for `speculum lenses`. */
  summary: string;
  /**
   * Egress note printed by the registry: lenses call the model the user's
   * amore config routes to, after local scrub.
   */
  egressNote: string;
  /** Preferred selection flags (documented; not enforced). */
  selectionHint: string;
  /** Prompt template with {{transcript}}, {{session_id}}, {{project}}. */
  template: string;
}

const EGRESS =
  "Sends scrubbed session content to the model configured by the local amore installation. Local scrub runs first; audit log records every send.";

export const LENSES: Record<string, LensDefinition> = {
  "session-postmortem": {
    name: "session-postmortem",
    summary:
      "What went wrong in this session and where the loop stalled (single-session diagnosis).",
    egressNote: EGRESS,
    selectionHint: "--session <id> (or --last-n 1)",
    template: `# Lens: session-postmortem

You are analyzing a single Amore Build agent session for the operator. The goal is a direct postmortem: what was attempted, where it stalled or failed, and the cheapest fix that would have unstuck the work.

## Session metadata

- Session ID: \`{{session_id}}\`
- Project: \`{{project}}\`

## Transcript

Tool calls are summarized (name + target). Full secret-shaped strings, emails, and absolute home paths have been redacted.

\`\`\`
{{transcript}}
\`\`\`

## Output (≤400 words)

### What was attempted

One short paragraph: the technical subject and the intended outcome.

### Where it stalled

Name the turn or tool loop where progress stopped. Quote a short phrase only when it earns its place. Prefer concrete blockers (wrong path, missing dep, thrash on the same command, unread error).

### Why it kept failing

Diagnose the actual blocker. Examples: same command with no state change; wrong file; environmental issue not escalated; assumption that should have been checked once.

### What would have unstuck it

The cheapest specific next move. Be concrete enough to apply on the next session.

### Outcome

Shipped / abandoned / blocked on X / ended in fatigue. One line.

## Tone

Direct. No throat-clearing. No "interesting analysis" hedge. Full sentences.
`,
  },

  "pattern-extraction": {
    name: "pattern-extraction",
    summary:
      "Recurring tool-use and correction patterns across the selected slice.",
    egressNote: EGRESS,
    selectionHint: "--last-n N  or  --since / --until  (optionally --project)",
    template: `# Lens: pattern-extraction

You are reading one or more Amore Build agent sessions to surface RECURRING patterns: tool thrash, operator corrections, and structural failure modes that appear more than once.

## Slice metadata

- Session: \`{{session_id}}\`
- Project: \`{{project}}\`

## Transcript

Session boundaries use \`=== [SESSION …] ===\` markers. Tool calls are summarized. Secrets, emails, and home paths are redacted.

\`\`\`
{{transcript}}
\`\`\`

## Output (≤600 words)

Honesty over padding. Omit a section if there is nothing real to say.

### Recurring tool-use patterns

Tools or fingerprints repeated without progress (same command, same file thrash, poll loops). Name the tool and the signature.

### Recurring corrections

Where the operator redirected or corrected the agent more than once on the same axis. Short quotes only when useful.

### Structural failure modes

Patterns that look like they will recur without a process or knowledge change.

### What matured

Repetition that improved (smooth now after early friction). Omit if nothing matured.

## Tone

Direct. Name technical things specifically. No assistant-mode openers.
`,
  },

  "usage-story": {
    name: "usage-story",
    summary:
      "Narrative read of the session arc and usage texture (tokens, turns, thrash).",
    egressNote: EGRESS,
    selectionHint: "--session <id>  or  --last-n N",
    template: `# Lens: usage-story

You are writing a short narrative read of how work unfolded in the selected Amore Build session slice. Focus on the arc of the collaboration and what the tool and turn texture imply, not raw accountancy.

## Slice metadata

- Session: \`{{session_id}}\`
- Project: \`{{project}}\`

## Transcript

\`\`\`
{{transcript}}
\`\`\`

## Output (≤350 words)

### Arc

How the session opened, where energy went, how it closed (or did not).

### Texture

Dense tool thrash vs sparse dialogue; recovery after correction; fatigue markers if present. Infer from the transcript; do not invent token totals not shown.

### Cost of thrash

Where repeated tool use or restarts burned turns without moving the outcome. One or two concrete moments.

### Takeaway

One paragraph the operator can skim later: what mattered, what did not.

## Tone

Full sentences. No first-person singular. No padding adverbs.
`,
  },
};

export function listLenses(): LensDefinition[] {
  return Object.values(LENSES);
}

export function getLens(name: string): LensDefinition | undefined {
  return LENSES[name];
}
