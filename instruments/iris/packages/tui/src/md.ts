import { SyntaxStyle } from '@opentui/core';
import type { Palette } from './theme';

/**
 * Build a markdown SyntaxStyle from the active palette so the built-in `<markdown>`
 * renderer styles headings/emphasis/code/links/quotes in-theme (and conceals the raw
 * `#`/`**`/`` ` `` markers). Create it after the renderer is up (e.g. via useMemo in a
 * mounted component) — it allocates against the native render lib.
 */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/** Tree-sitter filetype for a path, or undefined when unsupported (renders plain).
 *  Bundled: typescript/javascript/zig/markdown. Registered via code-grammars.ts:
 *  rust/python/bash/go/c/lua/ruby/json/toml/yaml. PowerShell has no grammar yet. */
export function filetypeOf(path: string): string | undefined {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'zig':
      return 'zig';
    case 'rs':
      return 'rust';
    case 'py':
      return 'python';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash';
    case 'go':
      return 'go';
    case 'c':
    case 'h':
      return 'c';
    case 'lua':
      return 'lua';
    case 'rb':
      return 'ruby';
    case 'json':
    case 'jsonc':
      return 'json';
    case 'toml':
      return 'toml';
    case 'yaml':
    case 'yml':
      return 'yaml';
    default:
      return undefined;
  }
}

/** SyntaxStyle for source code — maps common tree-sitter scopes to the active palette. */
export function codeSyntax(p: Palette): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    text: { fg: p.foreground },
    keyword: { fg: p.primary, bold: true },
    'keyword.control': { fg: p.primary, bold: true },
    'keyword.function': { fg: p.primary, bold: true },
    string: { fg: p.success },
    'string.special': { fg: p.success },
    comment: { fg: p.muted, italic: true },
    function: { fg: p.info },
    'function.method': { fg: p.info },
    'function.builtin': { fg: p.info },
    type: { fg: p.secondary },
    'type.builtin': { fg: p.secondary },
    constant: { fg: p.warning },
    'constant.builtin': { fg: p.warning },
    number: { fg: p.warning },
    boolean: { fg: p.warning },
    operator: { fg: p.foreground },
    property: { fg: p.foreground },
    variable: { fg: p.foreground },
    'variable.parameter': { fg: p.foreground },
    'variable.builtin': { fg: p.secondary },
    punctuation: { fg: p.muted },
    'punctuation.bracket': { fg: p.muted },
    'punctuation.delimiter': { fg: p.muted },
    tag: { fg: p.primary },
    attribute: { fg: p.secondary },
  });
}
