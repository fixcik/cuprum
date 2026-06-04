mod commands;
mod output;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "cuprum",
    about = "Cuprum CAM toolbox (gerber/.cuprum → previews, DFM, 3D)"
)]
struct Cli {
    /// Machine-readable JSON output.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Summarise a gerber file/dir or a .cuprum project.
    Info { input: PathBuf },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match &cli.command {
        Command::Info { input } => commands::info::run(input, cli.json),
    };
    match result {
        Ok(()) => ExitCode::from(output::EXIT_OK as u8),
        Err(e) => {
            output::print_error(cli.json, &format!("{e:#}"));
            ExitCode::from(output::EXIT_ERR as u8)
        }
    }
}
