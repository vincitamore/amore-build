//! Per-OS spawn chain: open a **new** terminal window running `iris dash`.
//!
//! Construction is pure ([`build_spawn_plan`] / [`spawn_plan_for_bin`]); the
//! live spawn ([`spawn_iris_dash`]) never panics and never blocks the UI
//! thread on child wait — it fire-and-forgets the first successful kickoff.

use std::path::Path;
use std::process::{Command, Stdio};

/// A concrete OS spawn attempt (program + args), for tests and the live chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnPlan {
    pub program: String,
    pub args: Vec<String>,
    /// Human label for diagnostics (e.g. "wt", "cmd-start", "osascript").
    pub label: &'static str,
}

/// Build the ordered spawn-plan chain for `bin` on the current OS.
#[must_use]
pub fn spawn_plan_for_bin(bin: &Path) -> Vec<SpawnPlan> {
    build_spawn_plan(bin, host_os_tag())
}

/// Host OS tag used by [`build_spawn_plan`] (overridable in tests).
#[must_use]
pub fn host_os_tag() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// Pure per-OS plan construction. `os` is `"windows" | "macos" | "linux"`.
#[must_use]
pub fn build_spawn_plan(bin: &Path, os: &str) -> Vec<SpawnPlan> {
    let bin_s = bin.display().to_string();
    match os {
        "windows" => windows_plans(&bin_s),
        "macos" => macos_plans(&bin_s),
        _ => linux_plans(&bin_s),
    }
}

fn windows_plans(bin: &str) -> Vec<SpawnPlan> {
    // 1) Windows Terminal new tab/window
    // 2) cmd /c start (new console)
    // 3) PowerShell Start-Process
    vec![
        SpawnPlan {
            label: "wt",
            program: "wt.exe".into(),
            args: vec![
                "new-tab".into(),
                "--".into(),
                bin.into(),
                "dash".into(),
            ],
        },
        SpawnPlan {
            label: "cmd-start",
            program: "cmd.exe".into(),
            args: vec![
                "/c".into(),
                "start".into(),
                "".into(), // window title
                bin.into(),
                "dash".into(),
            ],
        },
        SpawnPlan {
            label: "powershell",
            program: "powershell.exe".into(),
            args: vec![
                "-NoProfile".into(),
                "-Command".into(),
                format!(
                    "Start-Process -FilePath {} -ArgumentList @('dash')",
                    ps_single_quote(bin)
                ),
            ],
        },
    ]
}

fn macos_plans(bin: &str) -> Vec<SpawnPlan> {
    // Terminal.app via osascript; iTerm2 optional bonus.
    let term_script = format!(
        "tell application \"Terminal\"\n  do script {} \n  activate\nend tell",
        applescript_string(&format!("{} dash", shell_quote(bin)))
    );
    let iterm_script = format!(
        "tell application \"iTerm\"\n  create window with default profile command {}\n  activate\nend tell",
        applescript_string(&format!("{} dash", shell_quote(bin)))
    );
    vec![
        SpawnPlan {
            label: "osascript-terminal",
            program: "osascript".into(),
            args: vec!["-e".into(), term_script],
        },
        SpawnPlan {
            label: "osascript-iterm",
            program: "osascript".into(),
            args: vec!["-e".into(), iterm_script],
        },
    ]
}

fn linux_plans(bin: &str) -> Vec<SpawnPlan> {
    let mut plans = Vec::new();
    if let Ok(term) = std::env::var("TERMINAL") {
        if !term.trim().is_empty() {
            plans.push(SpawnPlan {
                label: "env-TERMINAL",
                program: term,
                args: vec!["-e".into(), bin.into(), "dash".into()],
            });
        }
    }
    // Probe chain: x-terminal-emulator, gnome-terminal, konsole, xterm.
    plans.push(SpawnPlan {
        label: "x-terminal-emulator",
        program: "x-terminal-emulator".into(),
        args: vec!["-e".into(), bin.into(), "dash".into()],
    });
    plans.push(SpawnPlan {
        label: "gnome-terminal",
        program: "gnome-terminal".into(),
        args: vec!["--".into(), bin.into(), "dash".into()],
    });
    plans.push(SpawnPlan {
        label: "konsole",
        program: "konsole".into(),
        args: vec!["-e".into(), bin.into(), "dash".into()],
    });
    plans.push(SpawnPlan {
        label: "xterm",
        program: "xterm".into(),
        args: vec!["-e".into(), bin.into(), "dash".into()],
    });
    plans
}

fn ps_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn shell_quote(s: &str) -> String {
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.' | ':' | '\\'))
    {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Fire-and-forget: try each plan until one `spawn()` succeeds.
///
/// Does not wait on the child. Stdio nulled; TTY-detached where the helper
/// applies. Never panics.
pub fn spawn_iris_dash(bin: &Path) -> Result<(), String> {
    let plans = spawn_plan_for_bin(bin);
    let mut errors: Vec<String> = Vec::new();
    for plan in &plans {
        match try_spawn(plan) {
            Ok(()) => return Ok(()),
            Err(e) => errors.push(format!("{}: {e}", plan.label)),
        }
    }
    Err(format!(
        "could not open terminal for iris dash ({})",
        errors.join("; ")
    ))
}

fn try_spawn(plan: &SpawnPlan) -> Result<(), String> {
    let mut cmd = Command::new(&plan.program);
    cmd.args(&plan.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    xai_tty_utils::detach_std_command(&mut cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_CONSOLE — prefer a real new console for cmd/start path.
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        if plan.label == "cmd-start" || plan.label == "powershell" {
            cmd.creation_flags(CREATE_NEW_CONSOLE | DETACHED_PROCESS);
        } else {
            cmd.creation_flags(DETACHED_PROCESS);
        }
    }
    match cmd.spawn() {
        Ok(_child) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn windows_chain_orders_wt_cmd_powershell() {
        let bin = PathBuf::from(r"C:\tools\iris.exe");
        let plans = build_spawn_plan(&bin, "windows");
        assert_eq!(plans.len(), 3);
        assert_eq!(plans[0].label, "wt");
        assert_eq!(plans[0].program, "wt.exe");
        assert!(plans[0].args.iter().any(|a| a == "dash"));
        assert!(plans[0].args.iter().any(|a| a.contains("iris")));
        assert_eq!(plans[1].label, "cmd-start");
        assert_eq!(plans[1].program, "cmd.exe");
        assert_eq!(plans[2].label, "powershell");
        assert!(plans[2].args.iter().any(|a| a.contains("Start-Process")));
    }

    #[test]
    fn macos_chain_has_terminal_and_iterm() {
        let bin = PathBuf::from("/usr/local/bin/iris");
        let plans = build_spawn_plan(&bin, "macos");
        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0].label, "osascript-terminal");
        assert_eq!(plans[0].program, "osascript");
        assert!(
            plans[0]
                .args
                .iter()
                .any(|a| a.contains("Terminal") && a.contains("dash"))
        );
        assert_eq!(plans[1].label, "osascript-iterm");
        assert!(plans[1].args.iter().any(|a| a.contains("iTerm")));
    }

    #[test]
    fn linux_chain_includes_probe_terminals() {
        let bin = PathBuf::from("/usr/bin/iris");
        let plans = build_spawn_plan(&bin, "linux");
        let labels: Vec<_> = plans.iter().map(|p| p.label).collect();
        assert!(labels.contains(&"x-terminal-emulator"));
        assert!(labels.contains(&"gnome-terminal"));
        assert!(labels.contains(&"konsole"));
        assert!(labels.contains(&"xterm"));
        for p in &plans {
            assert!(
                p.args.iter().any(|a| a == "dash"),
                "plan {} missing dash: {:?}",
                p.label,
                p.args
            );
        }
    }

    #[test]
    fn gnome_terminal_uses_double_dash_separator() {
        let bin = PathBuf::from("/opt/iris");
        let plans = build_spawn_plan(&bin, "linux");
        let gnome = plans
            .iter()
            .find(|p| p.label == "gnome-terminal")
            .expect("gnome");
        assert_eq!(gnome.args[0], "--");
        assert_eq!(gnome.args[1], "/opt/iris");
        assert_eq!(gnome.args[2], "dash");
    }
}
