// Judge brief construction — batches tier-1 candidates into a prompt + schema
// for amore headless. File-handoff shape: write prompt to temp (spawn path),
// parse structuredOutput from the envelope.

import { readNodeContent } from './hash';
import type { CandidatePair, GenRun } from './gen';
import { EDGE_TYPE_NAMES } from './schema';

export const JUDGE_ASSERTED_BY = 'judge-v1';

/** Max body chars per endpoint included in a brief (keep prompts bounded). */
export const BRIEF_EXCERPT_CHARS = 1200;

/** Max candidates per judge batch. */
export const DEFAULT_BATCH_SIZE = 12;

export interface BriefCandidate {
  id: string;
  a: string;
  b: string;
  score: number;
  linked: boolean;
  channels: CandidatePair['channels'];
  excerptA: string;
  excerptB: string;
}

export interface JudgeBrief {
  unit: string;
  houseRoot: string;
  edgeTypes: readonly string[];
  candidates: BriefCandidate[];
}

export interface JudgeVerdict {
  candidate_id: string;
  verdict: 'accept' | 'reject';
  /** Required when accept. */
  type?: string;
  source?: string;
  target?: string;
  /** Calibrated 0–1 confidence. */
  confidence?: number;
  /** Verbatim supporting quote from one endpoint. */
  quote?: string;
  /** Org-relative path of the file that contains the quote. */
  quote_source?: string;
  rationale?: string;
}

export interface JudgeOutput {
  verdicts: JudgeVerdict[];
}

/** JSON Schema passed to amore --json-schema (stringified at spawn). */
export const JUDGE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidate_id', 'verdict'],
        properties: {
          candidate_id: { type: 'string' },
          verdict: { type: 'string', enum: ['accept', 'reject'] },
          type: { type: 'string', enum: [...EDGE_TYPE_NAMES] },
          source: { type: 'string' },
          target: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          quote: { type: 'string' },
          quote_source: { type: 'string' },
          rationale: { type: 'string' },
        },
      },
    },
  },
} as const;

function excerpt(orgRoot: string, path: string, max = BRIEF_EXCERPT_CHARS): string {
  const content = readNodeContent(orgRoot, path);
  if (content === null) return `(missing: ${path})`;
  const t = content.replace(/\r\n/g, '\n');
  if (t.length <= max) return t;
  return t.slice(0, max) + '\n…';
}

export function buildBriefUnits(
  orgRoot: string,
  run: GenRun,
  opts: { batchSize?: number } = {},
): JudgeBrief[] {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const units: JudgeBrief[] = [];
  const list = run.candidates;
  for (let i = 0; i < list.length; i += batchSize) {
    const slice = list.slice(i, i + batchSize);
    const n = units.length + 1;
    units.push({
      unit: `unit-${String(n).padStart(2, '0')}`,
      houseRoot: orgRoot,
      edgeTypes: EDGE_TYPE_NAMES,
      candidates: slice.map((c) => ({
        id: c.id,
        a: c.a,
        b: c.b,
        score: c.score,
        linked: c.linked,
        channels: c.channels,
        excerptA: excerpt(orgRoot, c.a),
        excerptB: excerpt(orgRoot, c.b),
      })),
    });
  }
  return units;
}

/** Human + machine prompt for one judge unit (written to --prompt-file). */
export function formatJudgePrompt(brief: JudgeBrief): string {
  const lines: string[] = [];
  lines.push('# Graph edge judge');
  lines.push('');
  lines.push(
    'You judge candidate document pairs for typed semantic edges in a personal knowledge house.',
  );
  lines.push('Abstain (reject) is the default. Same-topic nearness is not a typed relation.');
  lines.push('There is no similar-to type. Emit accept only with a VERBATIM quote from one endpoint.');
  lines.push('Copy exact characters from the excerpt or file (no paraphrase, no ellipsis elision).');
  lines.push(`Allowed edge types: ${brief.edgeTypes.join(', ')}.`);
  lines.push('');
  lines.push('Direction matters for directed types (source → target):');
  lines.push('- depends-on: blocked depends on blocker');
  lines.push('- builds-on: builder builds on foundation');
  lines.push('- supersedes: new supersedes retired old');
  lines.push('- resolved-by: open item resolved by shipped work');
  lines.push('- motivates: decision motivates the implementing task');
  lines.push('- refines / generalizes / exemplifies / addressed-by: per type reading');
  lines.push('');
  lines.push(`Unit: ${brief.unit}`);
  lines.push(`House root: ${brief.houseRoot}`);
  lines.push('');
  lines.push('## Candidates');
  lines.push('');
  for (const c of brief.candidates) {
    lines.push(`### ${c.id}`);
    lines.push(`- a: ${c.a}`);
    lines.push(`- b: ${c.b}`);
    lines.push(`- score: ${c.score}`);
    lines.push(`- linked: ${c.linked}`);
    lines.push(`- channels: ${JSON.stringify(c.channels)}`);
    lines.push('');
    lines.push(`#### Excerpt ${c.a}`);
    lines.push('```');
    lines.push(c.excerptA);
    lines.push('```');
    lines.push('');
    lines.push(`#### Excerpt ${c.b}`);
    lines.push('```');
    lines.push(c.excerptB);
    lines.push('```');
    lines.push('');
  }
  lines.push('## Output');
  lines.push('');
  lines.push(
    'Return structured JSON with a `verdicts` array. For each candidate, one verdict object:',
  );
  lines.push(
    '`candidate_id`, `verdict` (accept|reject), and when accept: `type`, `source`, `target`,',
  );
  lines.push('`confidence` (0–1), `quote` (verbatim), `quote_source` (org-relative path of the quoted file).');
  lines.push('Reject candidates you would not defend with the quote alone.');
  lines.push('');
  return lines.join('\n');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse structuredOutput (or equivalent) into JudgeOutput.
 * Malformed items are dropped; empty/malformed root throws.
 */
export function parseJudgeOutput(raw: unknown): JudgeOutput {
  if (!isRecord(raw) || !Array.isArray(raw.verdicts)) {
    throw new Error('judge output must be an object with a verdicts array');
  }
  const verdicts: JudgeVerdict[] = [];
  for (const item of raw.verdicts) {
    if (!isRecord(item)) continue;
    const id = typeof item.candidate_id === 'string' ? item.candidate_id : '';
    const verdict = item.verdict === 'accept' || item.verdict === 'reject' ? item.verdict : null;
    if (!id || !verdict) continue;
    const v: JudgeVerdict = { candidate_id: id, verdict };
    if (typeof item.type === 'string') v.type = item.type;
    if (typeof item.source === 'string') v.source = item.source.replace(/\\/g, '/');
    if (typeof item.target === 'string') v.target = item.target.replace(/\\/g, '/');
    if (typeof item.confidence === 'number' && Number.isFinite(item.confidence)) {
      v.confidence = Math.min(1, Math.max(0, item.confidence));
    }
    if (typeof item.quote === 'string') v.quote = item.quote;
    if (typeof item.quote_source === 'string') v.quote_source = item.quote_source.replace(/\\/g, '/');
    if (typeof item.rationale === 'string') v.rationale = item.rationale;
    verdicts.push(v);
  }
  return { verdicts };
}
