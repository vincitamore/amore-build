import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { addDefaultParsers } from '@opentui/core';

// Register additional tree-sitter grammars beyond OpenTUI's bundled TS/JS/Zig/markdown,
// so the code view highlights the languages our projects actually use. Grammars (wasm)
// come from `tree-sitter-wasms`; highlight queries are compact, hand-written per grammar
// (keywords/strings/comments/numbers/types/functions — enough to read structure).
// PowerShell has no precompiled wasm here, so .ps1 renders plain until a grammar is sourced.

const require = createRequire(import.meta.url);
let wasmDir: string | null = null;
try {
  wasmDir = join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
} catch {
  wasmDir = null;
}

interface Lang {
  filetype: string;
  grammar: string;
  aliases?: string[];
  highlights: string;
}

const LANGS: Lang[] = [
  {
    filetype: 'rust',
    grammar: 'rust',
    aliases: ['rs'],
    highlights: `
(line_comment) @comment
(block_comment) @comment
(string_literal) @string
(raw_string_literal) @string
(char_literal) @string
(integer_literal) @number
(float_literal) @number
(boolean_literal) @constant
[ "fn" "let" "mut" "const" "static" "struct" "enum" "trait" "impl" "pub" "use" "mod" "if" "else" "match" "for" "while" "loop" "return" "break" "continue" "where" "as" "dyn" "move" "async" "await" "ref" "unsafe" "type" ] @keyword
(type_identifier) @type
(primitive_type) @type
(function_item name: (identifier) @function)
(call_expression function: (identifier) @function)
(macro_invocation macro: (identifier) @function)
(field_identifier) @property
`,
  },
  {
    filetype: 'python',
    grammar: 'python',
    aliases: ['py'],
    highlights: `
(comment) @comment
(string) @string
(integer) @number
(float) @number
[ "def" "class" "return" "if" "elif" "else" "for" "while" "import" "from" "as" "try" "except" "finally" "with" "lambda" "yield" "pass" "break" "continue" "raise" "global" "nonlocal" "assert" "del" "in" "is" "not" "and" "or" "async" "await" ] @keyword
[ (true) (false) (none) ] @constant
(function_definition name: (identifier) @function)
(call function: (identifier) @function)
(decorator) @function
`,
  },
  {
    filetype: 'bash',
    grammar: 'bash',
    aliases: ['sh', 'shell', 'zsh'],
    highlights: `
(comment) @comment
(string) @string
(raw_string) @string
[ "if" "then" "else" "elif" "fi" "for" "while" "do" "done" "case" "esac" "function" "in" "select" "until" ] @keyword
(command_name) @function
(variable_name) @variable
(expansion) @variable
(simple_expansion) @variable
`,
  },
  {
    filetype: 'go',
    grammar: 'go',
    aliases: [],
    highlights: `
(comment) @comment
(interpreted_string_literal) @string
(raw_string_literal) @string
(int_literal) @number
(float_literal) @number
[ "func" "var" "const" "type" "struct" "interface" "map" "chan" "package" "import" "if" "else" "for" "range" "return" "go" "defer" "select" "switch" "case" "default" "break" "continue" "fallthrough" ] @keyword
(type_identifier) @type
(function_declaration name: (identifier) @function)
(call_expression function: (identifier) @function)
`,
  },
  {
    filetype: 'c',
    grammar: 'c',
    aliases: ['h'],
    highlights: `
(comment) @comment
(string_literal) @string
(char_literal) @string
(number_literal) @number
[ "if" "else" "for" "while" "do" "switch" "case" "default" "break" "continue" "return" "struct" "union" "enum" "typedef" "const" "static" "extern" "sizeof" "goto" ] @keyword
(primitive_type) @type
(type_identifier) @type
(call_expression function: (identifier) @function)
`,
  },
  {
    filetype: 'lua',
    grammar: 'lua',
    aliases: [],
    highlights: `
(comment) @comment
(string) @string
(number) @number
[ "function" "local" "if" "then" "else" "elseif" "end" "for" "while" "do" "repeat" "until" "return" "break" "in" "and" "or" "not" "nil" "true" "false" ] @keyword
`,
  },
  {
    filetype: 'ruby',
    grammar: 'ruby',
    aliases: ['rb'],
    highlights: `
(comment) @comment
(string) @string
(integer) @number
(float) @number
[ "def" "class" "module" "if" "elsif" "else" "unless" "case" "when" "while" "until" "for" "do" "begin" "rescue" "ensure" "end" "return" "yield" "then" "in" "and" "or" "not" ] @keyword
(call method: (identifier) @function)
(method name: (identifier) @function)
`,
  },
  {
    filetype: 'json',
    grammar: 'json',
    aliases: ['jsonc'],
    highlights: `
(string) @string
(number) @number
(pair key: (string) @property)
[ (true) (false) (null) ] @constant
`,
  },
  {
    filetype: 'toml',
    grammar: 'toml',
    aliases: [],
    highlights: `
(comment) @comment
(string) @string
(integer) @number
(float) @number
(boolean) @constant
(bare_key) @property
(quoted_key) @property
`,
  },
  {
    filetype: 'yaml',
    grammar: 'yaml',
    aliases: ['yml'],
    highlights: `
(comment) @comment
(block_scalar) @string
(single_quote_scalar) @string
(double_quote_scalar) @string
(integer_scalar) @number
(float_scalar) @number
(boolean_scalar) @constant
(block_mapping_pair key: (flow_node) @property)
`,
  },
];

let registered = false;

/** Register the extra grammars (idempotent). Call once at startup, before any `<code>`. */
export function registerCodeGrammars(): void {
  if (registered || !wasmDir) return;
  registered = true;
  const parsers = LANGS.map((l) => ({
    filetype: l.filetype,
    aliases: l.aliases,
    wasm: join(wasmDir as string, `tree-sitter-${l.grammar}.wasm`),
    queries: { highlights: [l.highlights] },
  })).filter((p) => existsSync(p.wasm));
  if (parsers.length > 0) addDefaultParsers(parsers);
}
