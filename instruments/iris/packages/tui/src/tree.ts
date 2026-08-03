// Build a nested folder tree from flat, path-bearing items (the KB-tree algorithm,
// mirrored from the Tauri client's buildFolderTree). Folders carry a recursive total
// count; files land as leaves on their containing folder.

export interface TreeLeaf {
  /** org-relative path (the doc id). */
  id: string;
  label: string;
}
export interface TreeFolder {
  /** Path relative to the type root, e.g. "architecture/sovereignty" ("" for root). */
  path: string;
  name: string;
  /** Files in this folder + all descendants. */
  total: number;
  folders: TreeFolder[];
  leaves: TreeLeaf[];
}

/**
 * Build the folder tree. `prefix` is the leading path segment to strip (e.g. "knowledge");
 * items whose path doesn't start with it are skipped. Folders + leaves are name-sorted.
 */
export function buildTree(items: { path: string; label: string }[], prefix: string): TreeFolder {
  const root: TreeFolder = { path: '', name: '', total: 0, folders: [], leaves: [] };
  const lookup = new Map<string, TreeFolder>([['', root]]);
  for (const it of items) {
    const parts = it.path.split('/');
    if (parts[0] !== prefix) continue;
    const segs = parts.slice(1, -1); // drop prefix + filename → folder segments
    let cur = root;
    cur.total += 1;
    let acc = '';
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      let child = lookup.get(acc);
      if (!child) {
        child = { path: acc, name: seg, total: 0, folders: [], leaves: [] };
        lookup.set(acc, child);
        cur.folders.push(child);
      }
      child.total += 1;
      cur = child;
    }
    cur.leaves.push({ id: it.path, label: it.label });
  }
  const sortRec = (f: TreeFolder) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name));
    f.leaves.sort((a, b) => a.label.localeCompare(b.label));
    f.folders.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

export type TreeVisible =
  | { kind: 'folder'; node: TreeFolder; depth: number; expanded: boolean }
  | { kind: 'leaf'; leaf: TreeLeaf; depth: number };

/** Flatten the tree to the rows currently visible given the expanded-folder set.
 * The type root is the implicit container and is ALWAYS open — its direct leaves render as
 * depth-0 rows, so articles living at the type root (knowledge/foo.md with no subfolder) are
 * reachable without any expansion. Subfolders are collapsible rows; a folder's own leaves
 * render only when the folder is expanded. */
export function flattenTree(root: TreeFolder, expanded: Set<string>): TreeVisible[] {
  const out: TreeVisible[] = [];
  // Root leaves first: the type root cannot be closed (you are inside it), so its own files
  // are the top-level content; folder rows follow.
  for (const leaf of root.leaves) out.push({ kind: 'leaf', leaf, depth: 0 });
  const walk = (folders: TreeFolder[], depth: number) => {
    for (const f of folders) {
      const isExp = expanded.has(f.path);
      out.push({ kind: 'folder', node: f, depth, expanded: isExp });
      if (isExp) {
        walk(f.folders, depth + 1);
        for (const leaf of f.leaves) out.push({ kind: 'leaf', leaf, depth: depth + 1 });
      }
    }
  };
  walk(root.folders, 0);
  return out;
}
