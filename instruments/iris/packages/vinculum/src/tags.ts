// Narrow frontmatter tag extraction for rare-tag affinity (tier-1 gen).

/** Raw frontmatter block between opening --- fences, or null. */
export function frontmatterBlock(md: string): string | null {
  if (!md.startsWith('---')) return null;
  const end = md.indexOf('\n---', 3);
  if (end === -1) return null;
  return md.slice(md.indexOf('\n') + 1, end);
}

/** Extract frontmatter tags — inline `tags: [a, b]` or block `tags:\n  - a`. */
export function extractTags(md: string): string[] {
  const fm = frontmatterBlock(md);
  if (!fm) return [];
  const lines = fm.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^tags:\s*(.*)$/);
    if (!m) continue;
    const rest = m[1].trim();
    if (rest.startsWith('[')) {
      const inner = rest.replace(/^\[/, '').replace(/\].*$/, '');
      return inner
        .split(',')
        .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    }
    if (rest === '' || rest === '|') {
      const tags: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const bm = lines[j].match(/^\s+-\s+(.+)$/);
        if (!bm) break;
        tags.push(bm[1].trim().replace(/^['"]|['"]$/g, ''));
      }
      return tags;
    }
    return [rest.replace(/^['"]|['"]$/g, '')].filter(Boolean);
  }
  return [];
}
