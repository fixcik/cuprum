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
    /// Composite colour PNG (top side).
    Render {
        input: PathBuf,
        #[arg(short, long)]
        out: Option<PathBuf>,
        /// Longest side, px.
        #[arg(long, default_value_t = 1024)]
        max_px: u32,
    },
    /// Composite SVG (top side).
    Svg {
        input: PathBuf,
        #[arg(short, long)]
        out: Option<PathBuf>,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match &cli.command {
        Command::Info { input } => commands::info::run(input, cli.json),
        Command::Render { input, out, max_px } => {
            commands::render::run(input, out.clone(), *max_px)
        }
        Command::Svg { input, out } => commands::svg::run(input, out.clone()),
    };
    match result {
        Ok(()) => ExitCode::from(output::EXIT_OK as u8),
        Err(e) => {
            output::print_error(cli.json, &format!("{e:#}"));
            ExitCode::from(output::EXIT_ERR as u8)
        }
    }
}
