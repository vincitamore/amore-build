// iris edges — structural typed-edge verbs backed by @amore/vinculum.
// Derive writes straight into graph/edges.jsonl (no staging queue). Review after
// the fact via list / remove / validate / stats.

import { isAbsolute, resolve } from 'node:path';
import { RegulaError } from '@amore/regula';
import {
  deriveAndReconcile,
  filterEdges,
  readStore,
  removeEdge,
  storeStats,
  validateStore,
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
    byType: r.byType,
  };
}

export function runEdgesList(orgRoot: string, args: ParsedArgs): Record<string, unknown> {
  const root = resolveHouseRoot(orgRoot, args);
  const type = str(args.flags, 'type');
  const { edges, badLines } = readStore(root);
  const filtered = filterEdges(edges, { type });
  return {
    house: root,
    count: filtered.length,
    edges: filtered,
    badLines: badLines.length,
  };
}

export function runEdgesRemove(orgRoot: string, args: ParsedArgs): Record<string, unknown> {
  const root = resolveHouseRoot(orgRoot, args);
  const source = args.positional[0];
  const target = args.positional[1];
  const type = args.positional[2];
  if (!source || !target || !type) {
    throw new RegulaError('USAGE', 'edges remove requires <src> <dst> <type>');
  }
  const r = removeEdge(root, source, target, type);
  return { house: root, source, target, type, ...r };
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
