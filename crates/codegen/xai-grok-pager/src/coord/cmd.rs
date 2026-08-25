//! `amore coord` — roster and send.

use clap::{Args, Subcommand};

use super::send::send as coord_send;
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
                Ok(r) => {
                    println!(
                        "sent ({}) via {}",
                        r.disposition.as_str(),
                        r.via
                    );
                }
                Err(e) => {
                    anyhow::bail!("{e}");
                }
            }
        }
    }
    Ok(())
}
