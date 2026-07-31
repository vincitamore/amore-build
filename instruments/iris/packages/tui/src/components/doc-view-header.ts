/**
 * DocView panel header label — full basename (with extension) for copy-paste.
 * Document H1/title stays separate (e.g. PDF export via extractTitle).
 */

/** Basename of a path, accepting Windows and POSIX separators. */
export function pathBaseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/**
 * Header label shown in the DocView panel chrome.
 * Prefer full file name over markdown H1 so operators can copy-paste paths.
 */
export function docViewHeaderLabel(
  path: string,
  opts: { depth?: number; editing?: boolean } = {},
): string {
  const file = pathBaseName(path);
  const prefix = (opts.depth ?? 0) > 0 ? "‹ " : "";
  const edit = opts.editing ? "Edit · " : "";
  return `${prefix}${edit}${file}`;
}
