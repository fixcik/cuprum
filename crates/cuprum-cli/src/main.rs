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
    /// Export the triangulated board mesh (glTF/STL/OBJ).
    #[command(name = "3d")]
    Mesh {
        input: PathBuf,
        #[arg(short, long)]
        out: Option<PathBuf>,
        /// gltf | stl | obj (default: gltf/glb, or inferred from -o extension).
        #[arg(long)]
        format: Option<String>,
    },
    /// Measure DFM facts and gate against manufacturability limits.
    Check {
        input: PathBuf,
        #[arg(long)]
        profile: Option<PathBuf>,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result: anyhow::Result<i32> = match &cli.command {
        Command::Info { input } => commands::info::run(input, cli.json).map(|_| 0),
        Command::Render { input, out, max_px } => {
            commands::render::run(input, out.clone(), *max_px).map(|_| 0)
        }
        Command::Svg { input, out } => commands::svg::run(input, out.clone()).map(|_| 0),
        Command::Mesh { input, out, format } => {
            commands::mesh::run(input, out.clone(), format.clone()).map(|_| 0)
        }
        Command::Check { input, profile } => commands::check::run(input, profile.clone(), cli.json),
    };
    match result {
        Ok(code) => ExitCode::from(code as u8),
        Err(e) => {
            output::print_error(cli.json, &format!("{e:#}"));
            ExitCode::from(output::EXIT_ERR as u8)
        }
    }
}
