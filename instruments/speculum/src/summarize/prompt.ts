/**
 * Prompt that asks the model for a strict JSON title + summary over a digest.
 */

import type { SessionDigest } from "./digest";

export const TITLE_MAX_CHARS = 60;

/**
 * Compose the full prompt body (digest already scrubbed by the caller).
 * Instructs strict JSON only — no prose wrapper.
 */
export function renderSummarizePrompt(digestText: string): string {
  return [
    "You title an agent coding session from a compact transcript digest.",
    "",
    "Return STRICT JSON only, no markdown fences, no commentary:",
    '{"title":"...","summary":"..."}',
    "",
    "Rules for title:",
    `- At most ${TITLE_MAX_CHARS} characters`,
    "- Plain declarative register (what was worked on)",
    "- No quotation marks, no emoji, no trailing period",
    "- Prefer concrete nouns over vague words like 'fix' or 'update' alone",
    "",
    "Rules for summary:",
    "- Two or three short sentences",
    "- Cover goal, approach, and outcome when visible",
    "- No secrets, paths under home directories, or credentials",
    "",
    "DIGEST:",
    digestText.trimEnd(),
    "",
  ].join("\n");
}

export function renderSummarizePromptFromDigest(digest: SessionDigest): string {
  return renderSummarizePrompt(digest.text);
}
