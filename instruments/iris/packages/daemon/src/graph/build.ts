// ─────────────────────────────────────────────────────────────────────────────
// graph/build.ts — `buildGraph`, the /api/graph node/link/scope/cluster builder.
//
// Ports the `graph` handler + helpers from src-tauri/src/server/routes.rs
// (spec §8). Regime A output — key order is struct-declaration order, reproduced
// here by inserting keys in that exact order (ordered object literals with
// spread-omitted optionals).
//
// Determinism note: legacy iterates a `HashMap` for the doc/leaf node + link
// order (hash-random, not parity-gated). We iterate `index.docs` (insertion =
// walk order). Deterministic sub-orders that ARE parity-gated — placeholder
// nodes (sorted), cluster nodes + `clusters[]` (sorted keys) — are sorted by
// UTF-8 byte order to match Rust's BTreeSet/BTreeMap.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  OrgIndex,
  IndexedDoc,
  GraphParams,
  GraphResponse,
  GraphNode,
  GraphLink,
  ClusterSummary,
  ResolvedScopeWire,
} from '../contract.ts';
import { byteCompare, topFolder } from './util.ts';
import { parseEdgesMode, loadTypedEdges, mergeTypedEdges } from './edges.ts';
import { forgeSplit, docSubtype, fileNodeCandidate, type FileNodeInfo } from './shape-v2.ts';

// ── Scope parsing ────────────────────────────────────────────────────────────

/**
 * Split a `scope` string `<kind>` or `<kind>:<value>` on the FIRST ':'.
 * None / empty / "workspace" → `["workspace", undefined]`. A bare kind with no
 * ':' → `[kind, undefined]`.
 */
function parseScope(raw: string | undefined): [string, string | undefined] {
  const s = raw?.trim();
  if (!s || s === 'workspace') return ['workspace', undefined];
  const idx = s.indexOf(':');
  if (idx === -1) return [s, undefined];
  return [s.slice(0, idx), s.slice(idx + 1)];
}

// ── Placeholder + file-node synthesis (computed once per request) ─────────────

interface GraphExtras {
  /** Distinct placeholder ids, sorted (BTreeSet order). */
  placeholderTargets: string[];
  /** (sourceDocPath, placeholderId) edges, in scan order. */
  placeholderEdges: Array<[string, string]>;
  /** v2 only: minted file nodes, sorted by id, with in-edge counts. */
  fileNodes: Array<FileNodeInfo & { linkCount: number }>;
  /** v2 only: (sourceDocPath, fileNodeId) edges, in scan order. */
  fileEdges: Array<[string, string]>;
}

/**
 * Detect dangling outbound wikilinks (`resolve` → missing) among the scoped
 * docs. Resolved / skip targets mint no node here (resolved edges come from
 * backlinks; skip = scheme/cross-tree). In v2, a missing target that names an
 * on-disk non-.md file becomes a `file` node instead of a placeholder.
 */
function computeExtras(scopedDocs: IndexedDoc[], index: OrgIndex, orgRoot: string, isV2: boolean): GraphExtras {
  const targetSet = new Set<string>();
  const placeholderEdges: Array<[string, string]> = [];
  const fileNodeMap = new Map<string, FileNodeInfo>();
  const fileEdges: Array<[string, string]> = [];

  for (const d of scopedDocs) {
    for (const rawLink of d.links) {
      const res = index.resolve(rawLink, d.path);
      if (res.kind === 'resolved' || res.kind === 'skip') continue;
      // res.kind === 'missing'
      if (isV2) {
        const file = fileNodeCandidate(rawLink, d.path, orgRoot);
        if (file) {
          fileNodeMap.set(file.id, file);
          fileEdges.push([d.path, file.id]);
          continue;
        }
      }
      const placeholderId = `placeholder:${rawLink}`;
      targetSet.add(placeholderId);
      placeholderEdges.push([d.path, placeholderId]);
    }
  }

  const placeholderTargets = [...targetSet].sort(byteCompare);

  // linkCount for a file node = number of in-edges pointing at it.
  const fileInDegree = new Map<string, number>();
  for (const [, fid] of fileEdges) fileInDegree.set(fid, (fileInDegree.get(fid) ?? 0) + 1);
  const fileNodes = [...fileNodeMap.values()]
    .sort((a, b) => byteCompare(a.id, b.id))
    .map((f) => ({ ...f, linkCount: fileInDegree.get(f.id) ?? 0 }));

  return { placeholderTargets, placeholderEdges, fileNodes, fileEdges };
}

// ── Node minters (ordered object literals — Regime A struct order) ────────────

function docNode(d: IndexedDoc, groupBy: string, isV2: boolean): GraphNode {
  let type = d.docType;
  let group = d.docType; // legacy: group is always the doc type for doc nodes
  let subtype: string | undefined;

  if (isV2) {
    if (d.docType === 'forge') {
      const split = forgeSplit(d.path);
      type = split;
      if (groupBy === 'type') group = split;
    }
    subtype = docSubtype(d);
  }

  return {
    id: d.path,
    label: d.title,
    kind: 'doc',
    type,
    ...(d.status !== null ? { status: d.status } : {}),
    linkCount: d.links.length + d.backlinks.length,
    folder: topFolder(d.path),
    tags: d.tags,
    ...(d.pipeline !== undefined ? { pipeline: d.pipeline } : {}),
    group,
    ...(d.updated !== null ? { updated: d.updated } : {}),
    ...(subtype !== undefined ? { subtype } : {}),
  };
}

function placeholderNode(id: string): GraphNode {
  const raw = id.startsWith('placeholder:') ? id.slice('placeholder:'.length) : id;
  const label = raw.slice(raw.lastIndexOf('/') + 1);
  return {
    id,
    label,
    kind: 'placeholder',
    type: 'placeholder',
    linkCount: 0,
    folder: '',
    tags: [],
    group: 'placeholder',
  };
}

function fileNode(f: FileNodeInfo & { linkCount: number }): GraphNode {
  return {
    id: f.id,
    label: f.label,
    kind: 'file',
    type: 'file',
    linkCount: f.linkCount,
    folder: f.folder,
    tags: [],
    group: 'file',
  };
}

function wikiLink(source: string, target: string): GraphLink {
  return { source, target };
}

// ── Doc-only graph (group_by=type, and the unknown-group_by fallback) ─────────

function buildDocOnly(
  scopedDocs: IndexedDoc[],
  extras: GraphExtras,
  groupBy: string,
  isV2: boolean,
): { nodes: GraphNode[]; links: GraphLink[]; clusters: ClusterSummary[] } {
  const nodeSet = new Set(scopedDocs.map((d) => d.path));

  const nodes: GraphNode[] = scopedDocs.map((d) => docNode(d, groupBy, isV2));
  for (const f of extras.fileNodes) nodes.push(fileNode(f)); // v2 only (empty otherwise)
  for (const pid of extras.placeholderTargets) nodes.push(placeholderNode(pid));

  const links: GraphLink[] = [];
  for (const d of scopedDocs) {
    for (const backlink of d.backlinks) {
      if (nodeSet.has(backlink)) links.push(wikiLink(backlink, d.path));
    }
  }
  for (const [source, pid] of extras.placeholderEdges) links.push(wikiLink(source, pid));
  for (const [source, fid] of extras.fileEdges) links.push(wikiLink(source, fid)); // v2 only

  return { nodes, links, clusters: [] };
}

// ── Grouped graph (group_by=folder|project|tag) ───────────────────────────────

/**
 * Cluster key for a doc under folder/project grouping. Returns the key when the
 * doc has ≥1 folder segment beyond `scopePrefix`; null when it is a direct leaf.
 * (`cluster_folder_key`.)
 */
function clusterFolderKey(docPath: string, scopePrefix: string): string | null {
  let rest: string;
  if (scopePrefix.length === 0) {
    rest = docPath;
  } else {
    if (!docPath.startsWith(scopePrefix)) return null;
    rest = docPath.slice(scopePrefix.length).replace(/^\/+/, '');
  }
  if (rest.length === 0) return null;
  const slash = rest.indexOf('/');
  if (slash === -1) return null; // no second segment — a direct leaf
  const next = rest.slice(0, slash);
  if (next.length === 0) return null;
  return scopePrefix.length === 0 ? next : `${scopePrefix.replace(/\/+$/, '')}/${next}`;
}

function linkTotal(d: IndexedDoc): number {
  return d.links.length + d.backlinks.length;
}

function buildGrouped(
  scopedDocs: IndexedDoc[],
  groupBy: string,
  scopePrefix: string,
  extras: GraphExtras,
  isV2: boolean,
): { nodes: GraphNode[]; links: GraphLink[]; clusters: ClusterSummary[] } {
  const clusterId = (key: string) => `cluster:${groupBy}:${key}`;

  const docToCluster = new Map<string, string>();
  const clusterMembers = new Map<string, IndexedDoc[]>();
  const leafDocs: IndexedDoc[] = [];

  if (groupBy === 'folder') {
    for (const d of scopedDocs) {
      const key = clusterFolderKey(d.path, scopePrefix);
      if (key !== null) {
        docToCluster.set(d.path, clusterId(key));
        (clusterMembers.get(key) ?? clusterMembers.set(key, []).get(key)!).push(d);
      } else {
        leafDocs.push(d);
      }
    }
  } else if (groupBy === 'tag') {
    for (const d of scopedDocs) {
      if (d.tags.length === 0) continue;
      for (const tag of d.tags) {
        (clusterMembers.get(tag) ?? clusterMembers.set(tag, []).get(tag)!).push(d);
      }
    }
  } else if (groupBy === 'project') {
    for (const d of scopedDocs) {
      const key = clusterFolderKey(d.path, 'projects');
      if (key !== null) {
        docToCluster.set(d.path, clusterId(key));
        (clusterMembers.get(key) ?? clusterMembers.set(key, []).get(key)!).push(d);
      } else {
        leafDocs.push(d);
      }
    }
  } else {
    // Unknown group_by → doc-only graph.
    return buildDocOnly(scopedDocs, extras, groupBy, isV2);
  }

  const nodes: GraphNode[] = [];
  const clusters: ClusterSummary[] = [];

  // Cluster nodes FIRST, in sorted key order (BTreeMap).
  const sortedKeys = [...clusterMembers.keys()].sort(byteCompare);
  for (const key of sortedKeys) {
    const members = clusterMembers.get(key)!;
    const cid = clusterId(key);
    // Representatives: top 3 by (links+backlinks) desc, stable.
    const reps = members
      .map((d, i) => ({ d, i }))
      .sort((a, b) => linkTotal(b.d) - linkTotal(a.d) || a.i - b.i)
      .slice(0, 3)
      .map((x) => x.d.path);
    const totalLinkCount = members.reduce((sum, d) => sum + linkTotal(d), 0);
    const label =
      groupBy === 'folder' || groupBy === 'project'
        ? key.slice(key.lastIndexOf('/') + 1)
        : key;
    const nodeType =
      groupBy === 'folder' || groupBy === 'project' ? 'folder-cluster' : 'tag-cluster';
    nodes.push({
      id: cid,
      label,
      kind: 'cluster',
      type: nodeType,
      linkCount: totalLinkCount,
      folder: topFolder(key),
      tags: [],
      group: key,
      memberCount: members.length,
    });
    clusters.push({ id: cid, label, groupKey: key, memberCount: members.length, representatives: reps });
  }

  // Then leaf docs (doc nodes).
  for (const d of leafDocs) nodes.push(docNode(d, groupBy, isV2));

  // Then dangling nodes — suppressed in tag mode (tag co-occurrence is the only
  // relation there).
  if (groupBy !== 'tag') {
    for (const f of extras.fileNodes) nodes.push(fileNode(f)); // v2 only
    for (const pid of extras.placeholderTargets) nodes.push(placeholderNode(pid));
  }

  const links: GraphLink[] = [];
  if (groupBy === 'tag') {
    // Tag co-occurrence: an edge per tag pair sharing a doc, weight = count.
    const pairCount = new Map<string, { a: string; b: string; n: number }>();
    for (const d of scopedDocs) {
      if (d.tags.length < 2) continue;
      const tags = [...new Set([...d.tags].sort(byteCompare))]; // sort + dedup
      for (let i = 0; i < tags.length; i++) {
        for (let j = i + 1; j < tags.length; j++) {
          const k = `${tags[i]} ${tags[j]}`;
          const cur = pairCount.get(k);
          if (cur) cur.n += 1;
          else pairCount.set(k, { a: tags[i], b: tags[j], n: 1 });
        }
      }
    }
    for (const { a, b, n } of pairCount.values()) {
      links.push({
        source: `cluster:tag:${a}`,
        target: `cluster:tag:${b}`,
        ...(n > 1 ? { weight: n } : {}),
      });
    }
  } else {
    // Aggregate doc→doc wikilinks (from backlinks) into cluster/leaf routes.
    const agg = new Map<string, { source: string; target: string; n: number }>();
    const scopedIds = new Set(scopedDocs.map((d) => d.path));
    const bump = (source: string, target: string) => {
      const k = `${source} ${target}`;
      const cur = agg.get(k);
      if (cur) cur.n += 1;
      else agg.set(k, { source, target, n: 1 });
    };
    for (const d of scopedDocs) {
      for (const backlink of d.backlinks) {
        if (!scopedIds.has(backlink)) continue;
        const sRoute = docToCluster.get(backlink) ?? backlink;
        const tRoute = docToCluster.get(d.path) ?? d.path;
        if (sRoute === tRoute) continue;
        bump(sRoute, tRoute);
      }
    }
    for (const [source, pid] of extras.placeholderEdges) {
      bump(docToCluster.get(source) ?? source, pid);
    }
    for (const [source, fid] of extras.fileEdges) {
      // v2 only — dangling file targets route through their source's cluster.
      bump(docToCluster.get(source) ?? source, fid);
    }
    for (const { source, target, n } of agg.values()) {
      links.push({ source, target, ...(n > 1 ? { weight: n } : {}) });
    }
  }

  return { nodes, links, clusters };
}

// ── Scope filtering ───────────────────────────────────────────────────────────

function scopeDocs(
  index: OrgIndex,
  scopeKind: string,
  scopeValue: string | undefined,
  depth: number,
): IndexedDoc[] {
  const allDocs = [...index.docs.values()];
  switch (scopeKind) {
    case 'workspace':
      return allDocs;
    case 'folder': {
      const prefix = scopeValue ?? '';
      const prefixSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
      return allDocs.filter((d) => d.path === prefix || d.path.startsWith(prefixSlash));
    }
    case 'seed': {
      if (scopeValue === undefined) return []; // no seed id → empty node set
      const seed = scopeValue;
      // Undirected adjacency over links ∪ backlinks across the whole corpus.
      const adj = new Map<string, string[]>();
      for (const d of allDocs) adj.set(d.path, [...d.links, ...d.backlinks]);
      const visited = new Set<string>([seed]);
      let frontier: string[] = [seed];
      for (let hop = 0; hop < depth; hop++) {
        const next: string[] = [];
        for (const node of frontier) {
          const neighbors = adj.get(node);
          if (!neighbors) continue;
          for (const n of neighbors) {
            if (!visited.has(n)) {
              visited.add(n);
              next.push(n);
            }
          }
        }
        if (next.length === 0) break;
        frontier = next;
      }
      return allDocs.filter((d) => visited.has(d.path));
    }
    case 'tag': {
      if (scopeValue === undefined) return []; // no tag name → empty node set
      return allDocs.filter((d) => d.tags.includes(scopeValue));
    }
    default:
      return []; // unknown kind → empty node set (graceful, echoed in scope)
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function buildGraph(index: OrgIndex, params: GraphParams, orgRoot: string): GraphResponse {
  const [scopeKind, scopeValue] = parseScope(params.scope);
  const groupBy = params.groupBy?.trim() || 'type';
  const depth = params.depth ?? 1;
  const isV2 = params.shape === 'v2';

  const scopedDocs = scopeDocs(index, scopeKind, scopeValue, depth);

  // Folder cluster-key prefix: for folder scope, cluster by the next segment
  // beyond the scoped path; otherwise the top segment.
  const scopePrefix =
    scopeKind === 'folder' && scopeValue !== undefined ? scopeValue.replace(/\/+$/, '') : '';

  const extras = computeExtras(scopedDocs, index, orgRoot, isV2);

  const built =
    groupBy === 'type'
      ? buildDocOnly(scopedDocs, extras, groupBy, isV2)
      : buildGrouped(scopedDocs, groupBy, scopePrefix, extras, isV2);

  const { nodes, clusters } = built;
  let links = built.links;

  // Typed semantic-edge merge (loaded per request; wiki short-circuits the read).
  const edgesMode = parseEdgesMode(params.edges);
  if (edgesMode !== 'wiki') {
    const nodeIds = new Set(nodes.map((n) => n.id));
    const typedEdges = loadTypedEdges(orgRoot);
    links = mergeTypedEdges(links, typedEdges, nodeIds, edgesMode);
  }

  const scope: ResolvedScopeWire = {
    kind: scopeKind,
    ...(scopeValue !== undefined ? { value: scopeValue } : {}),
    ...(scopeKind === 'seed' ? { depth } : {}),
    groupBy,
    nodeCount: nodes.length,
    linkCount: links.length,
  };

  return { nodes, links, scope, clusters };
}
