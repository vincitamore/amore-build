//! `amore coord` — roster and send.

use clap::{Args, Subcommand};

use std::io::Read;

use super::msg::Envelope;
use super::send::{inject as coord_inject, send as coord_send, SendResult};
use super::{format_roster, roster};

#[derive(Debug, Clone, Args)]
pub struct CoordArgs {
    #[command(subcommand)]
    pub command: CoordCommand,
}

#[derive(Debug, Clone, Subcommand)]
pub enum CoordCommand {
    /// Print the seat roster (Peers line).
    Roster {
        #[arg(long)]
        json: bool,
    },
    /// Send an addressed message. Target is seat, seat/harness, or a session id.
    Send {
        target: String,
        /// Message text. Remaining args join with spaces.
        #[arg(trailing_var_arg = true, allow_hyphen_values = true, required = true)]
        message: Vec<String>,
    },
    /// Post a JSON envelope from stdin to a local socket. Does not rewrite `from`.
    Inject,
}

pub fn run(args: CoordArgs) -> anyhow::Result<()> {
    match args.command {
        CoordCommand::Roster { json } => {
            let entries = roster();
            if json {
                println!("{}", serde_json::to_string_pretty(&entries)?);
            } else {
                println!("{}", format_roster(&entries, Some(std::process::id())));
            }
        }
        CoordCommand::Send { target, message } => {
            let text = message.join(" ");
            match coord_send(&target, &text) {
                Ok(r) => print_send_result(&r),
                Err(e) => {
                    anyhow::bail!("{e}");
                }
            }
        }
        CoordCommand::Inject => {
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf)?;
            let env: Envelope = serde_json::from_str(buf.trim())
                .map_err(|e| anyhow::anyhow!("inject envelope: {e}"))?;
            match coord_inject(env) {
                Ok(r) => print_send_result(&r),
                Err(e) => anyhow::bail!("{e}"),
            }
        }
    }
    Ok(())
}

fn print_send_result(r: &SendResult) {
    println!("{}", r.format_line());
}

#[cfg(test)]
mod tests {
    use super::super::msg::Disposition;
    use super::super::send::SendResult;

    #[test]
    fn degraded_inbox_line_is_not_sent() {
        let r = SendResult {
            disposition: Disposition::Inbox,
            via: "ssh user@host".into(),
            degrade: Some("pin mismatch".into()),
        };
        let line = r.format_line();
        assert_eq!(line, "degraded (inbox) after tailnet: pin mismatch");
        assert!(!line.contains("sent (inbox)"), "{line}");
    }

    #[test]
    fn live_success_line_stays_sent() {
        let r = SendResult::new(Disposition::Woken, "tls:100.64.0.2:3856");
        assert_eq!(r.format_line(), "sent (woken) via tls:100.64.0.2:3856");
    }
}
