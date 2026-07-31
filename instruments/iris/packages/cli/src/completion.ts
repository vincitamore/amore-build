import { COMMANDS, resolveCommand } from './commands';

const GROUPS = Array.from(new Set(COMMANDS.map((c) => c.name.split(' ')[0])));
const META = ['commands', 'completion', 'help'];

/**
 * Completion candidates for the partial `current` word given the already-typed
 * `prior` words. Pure + unit-tested; the shell scripts feed it COMP_WORDS.
 */
export function resolveCompletions(prior: string[], current: string): string[] {
  if (current.startsWith('-')) {
    const r = resolveCommand(prior.filter((w) => !w.startsWith('-')));
    const flags = new Set(['--json', '--quiet']);
    if (!('error' in r)) {
      for (const f of r.spec.booleanFlags) flags.add(`--${f}`);
      for (const f of Object.keys(r.spec.flags)) flags.add(`--${f}`);
    }
    return [...flags].filter((f) => f.startsWith(current)).sort();
  }
  const nonFlag = prior.filter((w) => !w.startsWith('-'));
  if (nonFlag.length === 0) {
    return [...GROUPS, ...META].filter((c) => c.startsWith(current)).sort();
  }
  if (nonFlag.length === 1) {
    const group = nonFlag[0];
    const subs = COMMANDS.filter((c) => c.name.startsWith(`${group} `)).map(
      (c) => c.name.split(' ')[1]
    );
    return subs.filter((s) => s.startsWith(current)).sort();
  }
  return [];
}

/** Emit a shell completion script that calls back into `iris __complete`. */
export function completionScript(shell: 'bash' | 'powershell'): string {
  if (shell === 'bash') {
    return `# iris bash completion — add to ~/.bashrc:  source <(iris completion bash)
_iris_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local prior=("\${COMP_WORDS[@]:1:COMP_CWORD-1}")
  local out
  out="$(iris __complete "\${prior[@]}" "$cur" 2>/dev/null)"
  COMPREPLY=( $(compgen -W "$out" -- "$cur") )
}
complete -F _iris_complete iris
`;
  }
  return `# iris PowerShell completion — add to $PROFILE:  iris completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName iris -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = @($commandAst.CommandElements | ForEach-Object { "$_" })
  $prior = if ($tokens.Count -gt 1) { $tokens[1..($tokens.Count - 1)] } else { @() }
  if ($wordToComplete -and $prior.Count -gt 0) { $prior = $prior[0..($prior.Count - 2)] }
  (& iris __complete @prior $wordToComplete 2>$null) -split "\`n" | Where-Object { $_ } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
}
