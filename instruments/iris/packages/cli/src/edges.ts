// iris edges — typed-edge verbs backed by @amore/vinculum.
// Structural derive and agentic update write straight into graph/edges.jsonl
// (no staging queue). Review after the fact via list / show / edit / remove.

import { isAbsolute, resolve } from 'node:path';
import { RegulaError } from '@amore/regula';
import {
  addressEdges,
  deriveAndReconcile,
  editEdgeById,
  filterEdges,
  listAddressedEdges,
  parseUpdateTier,
  readStore,
  removeEdgeById,
  runEdgesUpdate,
  showEdgeById,
  storeStats,
  UpdateError,
  AmoreBinaryMissingError,
  validateStore,
  type Edge,
  type EdgeFilter,
} from '@amore/vinculum';
import { type ParsedArgs, EXIT, str } from './contract';

/** Resolve --house override or fall back to the CLI org root. */
export function resolveHouseRoot(orgRoot: string, args: ParsedArgs): string {
  const house = str(args.flags, 'house');
  if (!house) return orgRoot;
  return isAbsolute(house) ? house : resolve(process.cwd(), house);
}

export function runEdgesDerive(orgRoot: string, args: ParsedArgs): Record<string, unknown> {
  const root = resolveHouseRoot(orgRoot, args);
  const r = deriveAndReconcile(root);
  return {
    house: root,
    derived: r.derived,
    added: r.added,
    removed: r.removed,
    preserved: r.preserved,
    suppressed: r.suppressed,
    byType: r.byType,
  };
}

function flagStr(args: ParsedArgs, name: string): string | undefined {
  const v = str(args.flags, name);
  return v || undefined;
}

function listFilterFromArgs(args: ParsedArgs): EdgeFilter {
  const recentRaw = flagStr(args, 'recent');
  let recent: number | undefined;
  if (recentRaw !== undefined) {
    const n = Number(recentRaw);
    if (!Number.isInteger(n) || n < 0) {
      throw new RegulaError('USAGE', '--recent must be a non-negative integer');
    }
    recent = n;
  }
  return {
    type: flagStr(args, 'type'),
    source: flagStr(args, 'source'),
    target: flagStr(args, 'target'),
    assertedBy: flagStr(args, 'asserted-by'),
    tier: flagStr(args, 'tier'),
    mechanism: flagStr(args, 'mechanism'),
    confidence: flagStr(args, 'confidence'),
    model: flagStr(args, 'model'),
    since: flagStr(args, 'since'),
    recent,
  };
}

export function runEdgesList(orgRoot: string, args: ParsedArgs): Record<string, unknown> {
  const root = resolveHouseRoot(orgRoot, args);
  const filter = listFilterFromArgs(args);
  const { edges, badLines, count } = listAddressedEdges(root, filter);
  return {
    house: root,
    count,
    edges: edges.map(({ id, edge }) => ({ id, ...edge })),
    badLines: badLines.length,
  };
}

/** Compact table for `edges list` when --json is not set. */
export function edgesListHuman(payload: Record<string, unknown>): string {
  const rows = (payload.edges as Array<Record<string, unknown>>) ?? [];
  if (rows.length === 0) return 'No edges.';
  const idW = Math.max(12, ...rows.map((r) => String(r.id ?? '').length));
  const typeW = Math.max(4, ...rows.map((r) => String(r.type ?? '').length));
  const srcW = Math.max(6, ...rows.map((r) => String(r.source ?? '').length));
  const tgtW = Math.max(6, ...rows.map((r) => String(r.target ?? '').length));
  const byW = Math.max(
    2,
    ...rows.map((r) => String((r.provenance as { asserted_by?: string })?.asserted_by ?? '').length),
  );
  const mechW = Math.max(
    4,
    ...rows.map((r) => {
      const p = r.provenance as { mechanism?: string; tier?: string; asserted_by?: string } | undefined;
      return (p?.mechanism ?? (p?.asserted_by === 'structural-v0' ? 'structural' : '')).length;
    }),
  );
  const head =
    'ID'.padEnd(idW) +
    '  ' +
    'TYPE'.padEnd(typeW) +
    '  ' +
    'SOURCE'.padEnd(srcW) +
    '  ' +
    'TARGET'.padEnd(tgtW) +
    '  ' +
    'MECH'.padEnd(mechW) +
    '  ' +
    'BY'.padEnd(byW);
  const lines = [head, '-'.repeat(head.length)];
  for (const r of rows) {
    const p = r.provenance as
      | { asserted_by?: string; mechanism?: string; tier?: string; model?: string }
      | undefined;
    const by = p?.asserted_by ?? '';
    const mech = p?.mechanism ?? (p?.asserted_by === 'structural-v0' ? 'structural' : '');
    lines.push(
      String(r.id ?? '').padEnd(idW) +
        '  ' +
        String(r.type ?? '').padEnd(typeW) +
        '  ' +
        String(r.source ?? '').padEnd(srcW) +
        '  ' +
        String(r.target ?? '').padEnd(tgtW) +
        '  ' +
        mech.padEnd(mechW) +
        '  ' +
        by.padEnd(byW),
    );
  }
  lines.push('');
  lines.push(`${rows.length} edge${rows.length === 1 ? '' : 's'}`);
  return lines.join('\n');
}

export function runEdgesShow(orgRoot: string, args: ParsedArgs): Record<string, unknown> {
  const root = resolveHouseRoot(orgRoot, args);
  const id = args.positional[0];
  if (!id) throw new RegulaError('USAGE', 'edges show requires <id>');
  const r = showEdgeById(root, id);
  if (!r.ok) {
    if (r.reason === 'ambiguous') {
      throw new RegulaError('CONFLICT', `ambiguous edge id prefix; matches: ${(r.matches ?? []).join(', ')}`);
    }
    throw new RegulaError('NOT_FOUND', `edge not found: ${id}`);
  }
  return { house: root, id: r.id, edge: r.edge };
}

export function edgesShowHuman(payload: Record<string, unknown>): string {
  const id = String(payload.id ?? '');
  const e = payload.edge as Edge;
  if (!e) return 'No edge.';
  const lines = [
    `id:          ${id}`,
    `type:        ${e.type}`,
    `source:      ${e.source}`,
    `target:      ${e.target}`,
    `directed:    ${e.directed}`,
    `confidence:  ${e.confidence}`,
    `asserted_by: ${e.provenance.asserted_by}`,
    `signal:      ${e.provenance.signal}`,
    `ts:          ${e.provenance.ts}`,
  ];
  if (e.provenance.tier) lines.push(`tier:        ${e.provenance.tier}`);
  if (e.provenance.mechanism) lines.push(`mechanism:   ${e.provenance.mechanism}`);
  if (e.provenance.model) lines.push(`model:       ${e.provenance.model}`);
  if (e.provenance.judge_confidence !== undefined) {
    lines.push(`judge_conf:  ${e.provenance.judge_confidence}`);
  }
  if (e.provenance.source_file) lines.push(`source_file: ${e.provenance.source_file}`);
  if (e.provenance.field) lines.push(`field:       ${e.provenance.field}`);
  if (e.provenance.line !== undefined) lines.push(`line:        ${e.provenance.line}`);
  if (e.evidence) {
    lines.push(`evidence:    ${e.evidence.quote}`);
    lines.push(`loc:         ${e.evidence.loc}`);
  }
  if (e.note) lines.push(`note:        ${e.note}`);
  if (e.label) lines.push(`label:       ${e.label}`);
  if (e.verify_key) {
    lines.push(`verify_key:  src=${e.verify_key.src_hash.slice(0, 18)}… tgt=${e.verify_key.tgt_hash.slice(0, 18)}…`);
  }
  lines.push(`refines_wikilink: ${e.refines_wikilink}`);
  return lines.join('\n');
}

/**
 * Agentic refresh entrypoint: `iris edges update [--tier 0|1|2] [--json]`.
 * Default tier 0. Tier 2 is the only model-calling path.
 */
export async function runEdgesUpdateCmd(orgRoot: string, args: ParsedArgs): Promise<Record<string, unknown>> {
  const root = resolveHouseRoot(orgRoot, args);
  let tier: 0 | 1 | 2;
  try {
    tier = parseUpdateTier(args.flags.tier as string | boolean | undefined);
  } catch (e) {
    if (e instanceof UpdateError) throw new RegulaError('USAGE', e.message);
    throw e;
  }
  try {
    const summary = await runEdgesUpdate({ orgRoot: root, tier });
    return summary as unknown as Record<string, unknown>;
  } catch (e) {
    if (e instanceof AmoreBinaryMissingError || (e instanceof UpdateError && e.code === 'AMORE_MISSING')) {
      // Clean nonzero + honest message (never a stack trace). Maps to ACTIONABLE exit.
      throw new RegulaError('INVALID', e instanceof Error ? e.message : String(e));
    }
    if (e instanceof UpdateError) {
      if (e.code === 'USAGE') throw new RegulaError('USAGE', e.message);
      throw new RegulaError('INVALID', e.message);
    }
    throw e;
  }
}

/** Human summary for edges update. */
export function edgesUpdateHuman(payload: Record<string, unknown>): string {
  const tier = payload.tier;
  const lines = [`edges update — tier ${tier}`];
  if (payload.structural && typeof payload.structural === 'object') {
    const s = payload.structural as Record<string, number>;
    lines.push(
      `structural: derived ${s.derived ?? 0}, added ${s.added ?? 0}, removed ${s.removed ?? 0}, suppressed ${s.suppressed ?? 0}`,
    );
  }
  if (payload.candidates && typeof payload.candidates === 'object') {
    const c = payload.candidates as { count?: number };
    lines.push(`candidates: ${c.count ?? 0}`);
  }
  if (payload.judge && typeof payload.judge === 'object') {
    const j = payload.judge as Record<string, unknown>;
    lines.push(
      `judge: model ${j.model ?? '(none)'}, accepted ${j.accepted ?? 0}, rejected ${j.rejected ?? 0}, quote-gate fails ${j.quoteGateFailed ?? 0}`,
    );
    lines.push(`landed: added ${j.added ?? 0}, updated ${j.updated ?? 0}, suppressed ${j.suppressed ?? 0}`);
  }
  lines.push(`totals: added ${payload.added ?? 0}, updated ${payload.updated ?? 0}, suppressed ${payload.suppressed ?? 0}`);
  return lines.join('\n');
}

/** Exit code for edges update — nonzero on failure is thrown; success including no-new-edges is 0. */
export function edgesUpdateExit(_payload: Record<string, unknown>): number {
  return EXIT.OK;
}

export function runEdgesRemove(orgRoot: string, args: ParsedArgs): Record<string, unknown> {
  const root = resolveHouseRoot(orgRoot, args);
  const id = args.positional[0];
  if (!id) throw new RegulaError('USAGE', 'edges remove requires <id>');
  const r = removeEdgeById(root, id);
  if (!r.ok) {
    if (r.reason === 'ambiguous') {
      throw new RegulaError('CONFLICT', `ambiguous edge id prefix; matches: ${(r.matches ?? []).join(', ')}`);
    }
    throw new RegulaError('NOT_FOUND', `edge not found: ${id}`);
  }
  return {
    house: root,
    id: r.id,
    removed: r.removed,
    remaining: r.remaining,
    edge: { source: r.edge.source, target: r.edge.target, type: r.edge.type },
    suppression: r.suppression,
  };
}

export function runEdgesEdit(orgRoot: string, args: ParsedArgs): Record<string, unknown> {
  const root = resolveHouseRoot(orgRoot, args);
  const id = args.positional[0];
  if (!id) throw new RegulaError('USAGE', 'edges edit requires <id>');
  const noteFlag = args.flags.note;
  const labelFlag = args.flags.label;
  const clearNote = args.flags['clear-note'] === true;
  const clearLabel = args.flags['clear-label'] === true;
  if (noteFlag === undefined && labelFlag === undefined && !clearNote && !clearLabel) {
    throw new RegulaError('USAGE', 'edges edit requires --note and/or --label (or --clear-note / --clear-label)');
  }
  const patch: { note?: string | null; label?: string | null } = {};
  if (clearNote) patch.note = null;
  else if (noteFlag !== undefined) patch.note = String(noteFlag);
  if (clearLabel) patch.label = null;
  else if (labelFlag !== undefined) patch.label = String(labelFlag);

  const r = editEdgeById(root, id, patch);
  if (!r.ok) {
    if (r.reason === 'ambiguous') {
      throw new RegulaError('CONFLICT', `ambiguous edge id prefix; matches: ${(r.matches ?? []).join(', ')}`);
    }
    throw new RegulaError('NOT_FOUND', `edge not found: ${id}`);
  }
  return { house: root, id: r.id, edge: r.edge };
}

export function runEdgesValidate(orgRoot: string, args: ParsedArgs): Record<string, unknown> {
  const root = resolveHouseRoot(orgRoot, args);
  const r = validateStore(root);
  return { house: root, ...r };
}

export function runEdgesStats(orgRoot: string, args: ParsedArgs): Record<string, unknown> {
  const root = resolveHouseRoot(orgRoot, args);
  return { house: root, ...storeStats(root) };
}

// re-export helpers used by tests / future formatters
export { addressEdges, filterEdges, readStore };
