// iris edges — structural typed-edge verbs backed by @amore/vinculum.
// Derive writes straight into graph/edges.jsonl (no staging queue). Review after
// the fact via list / show / edit / remove / validate / stats.

import { isAbsolute, resolve } from 'node:path';
import { RegulaError } from '@amore/regula';
import {
  addressEdges,
  deriveAndReconcile,
  editEdgeById,
  filterEdges,
  listAddressedEdges,
  readStore,
  removeEdgeById,
  showEdgeById,
  storeStats,
  validateStore,
  type Edge,
} from '@amore/vinculum';
import { type ParsedArgs, str } from './contract';

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

export function runEdgesList(orgRoot: string, args: ParsedArgs): Record<string, unknown> {
  const root = resolveHouseRoot(orgRoot, args);
  const filter = {
    type: flagStr(args, 'type'),
    source: flagStr(args, 'source'),
    target: flagStr(args, 'target'),
    assertedBy: flagStr(args, 'asserted-by'),
  };
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
  const byW = Math.max(2, ...rows.map((r) => String((r.provenance as { asserted_by?: string })?.asserted_by ?? '').length));
  const head =
    'ID'.padEnd(idW) +
    '  ' +
    'TYPE'.padEnd(typeW) +
    '  ' +
    'SOURCE'.padEnd(srcW) +
    '  ' +
    'TARGET'.padEnd(tgtW) +
    '  ' +
    'BY'.padEnd(byW);
  const lines = [head, '-'.repeat(head.length)];
  for (const r of rows) {
    const by = (r.provenance as { asserted_by?: string } | undefined)?.asserted_by ?? '';
    lines.push(
      String(r.id ?? '').padEnd(idW) +
        '  ' +
        String(r.type ?? '').padEnd(typeW) +
        '  ' +
        String(r.source ?? '').padEnd(srcW) +
        '  ' +
        String(r.target ?? '').padEnd(tgtW) +
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
