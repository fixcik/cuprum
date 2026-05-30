use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use clap::{Parser, Subcommand};

use cuprum_core::cal;
use cuprum_core::gerber;
use cuprum_core::goo::{self, ExposureParams, SCREEN_H, SCREEN_W};
use cuprum_core::sdcp::{self, Session};

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Parser)]
#[command(name = "cuprum", about = "UV exposure on Elegoo Saturn 4 Ultra 16K")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Find printers on the LAN via SDCP discovery.
    Discover,
    /// Parse a Gerber file and summarize its apertures/operations.
    GerberInfo {
        /// Path to a .gbr file.
        file: PathBuf,
    },
    /// Render a Gerber file to a PNG preview (no printer involved).
    Render {
        /// Path to a .gbr file.
        file: PathBuf,
        /// Output PNG path.
        #[arg(short, long, default_value = "out/preview.png")]
        out: PathBuf,
        /// Square resolution, px/mm (for visual preview). Omit to use the
        /// printer's native anisotropic pitch (exposure-ready, ~69x48 px/mm).
        #[arg(long)]
        dpi: Option<f32>,
        /// Mirror horizontally (emulsion-down contact).
        #[arg(long, default_value_t = false)]
        mirror: bool,
        /// Invert black/white (positive vs negative resist).
        #[arg(long, default_value_t = false)]
        invert: bool,
    },
    /// Render a Gerber and compose it into a full-screen exposure .goo
    /// (no printer involved — produces a file for `upload` + `expose`).
    Prepare {
        /// Path to a .gbr file.
        file: PathBuf,
        /// Output .goo path.
        #[arg(short, long, default_value = "out/board.goo")]
        out: PathBuf,
        /// Exposure time, seconds.
        #[arg(short, long, default_value_t = 8.0)]
        time: f32,
        /// UV LED intensity, 0..=255.
        #[arg(long, default_value_t = 255)]
        pwm: u16,
        /// Mirror horizontally (emulsion-down contact).
        #[arg(long, default_value_t = false)]
        mirror: bool,
        /// Invert black/white (positive vs negative resist).
        #[arg(long, default_value_t = false)]
        invert: bool,
        /// Board top-left offset on the screen, X pixels (default: centered).
        #[arg(long)]
        off_x: Option<i32>,
        /// Board top-left offset on the screen, Y pixels (default: centered).
        #[arg(long)]
        off_y: Option<i32>,
        /// Also save the full-screen mask as a PNG preview here.
        #[arg(long)]
        preview: Option<PathBuf>,
        /// Skip the printer's 180° screen-orientation correction (debug only).
        #[arg(long, default_value_t = false)]
        no_rotate: bool,
    },
    /// Render a Gerber and expose it in one shot: compose -> upload -> start.
    /// FIRES THE UV SCREEN (build plate must be removed). No local .goo written.
    Print {
        /// Path to a .gbr file.
        file: PathBuf,
        /// Exposure time, seconds.
        #[arg(short, long, default_value_t = 8.0)]
        time: f32,
        /// UV LED intensity, 0..=255.
        #[arg(long, default_value_t = 255)]
        pwm: u16,
        /// Mirror horizontally (emulsion-down contact).
        #[arg(long, default_value_t = false)]
        mirror: bool,
        /// Invert black/white (positive vs negative resist).
        #[arg(long, default_value_t = false)]
        invert: bool,
        /// Board top-left offset on the screen, X pixels (default: centered).
        #[arg(long)]
        off_x: Option<i32>,
        /// Board top-left offset on the screen, Y pixels (default: centered).
        #[arg(long)]
        off_y: Option<i32>,
        /// Skip the printer's 180° screen-orientation correction (debug only).
        #[arg(long, default_value_t = false)]
        no_rotate: bool,
        /// Optionally also save the full-screen mask PNG preview here.
        #[arg(long)]
        preview: Option<PathBuf>,
    },
    /// Generate a pixel-pitch calibration target .goo (corner fiducials at a
    /// known pixel span + a 10 mm ruler). Expose it, measure with calipers.
    Calibrate {
        #[arg(short, long, default_value = "out/calibrate.goo")]
        out: PathBuf,
        /// Exposure time, seconds.
        #[arg(short, long, default_value_t = 8.0)]
        time: f32,
        /// UV LED intensity, 0..=255.
        #[arg(long, default_value_t = 255)]
        pwm: u16,
        /// Inset of the corner fiducials from each screen edge, pixels.
        #[arg(long, default_value_t = 200)]
        margin: u32,
        /// Also save the mask as a PNG preview here.
        #[arg(long)]
        preview: Option<PathBuf>,
        /// Skip the printer's 180° screen-orientation correction (debug only).
        #[arg(long, default_value_t = false)]
        no_rotate: bool,
    },
    /// Generate a single-layer exposure .goo from a built-in test pattern.
    GenGoo {
        #[arg(short, long, default_value = "out/test.goo")]
        out: PathBuf,
        /// Exposure time, seconds.
        #[arg(short, long, default_value_t = 8.0)]
        time: f32,
        /// UV LED intensity, 0..=255.
        #[arg(long, default_value_t = 255)]
        pwm: u16,
        /// Use a full-white screen instead of the centered-rectangle test pattern.
        #[arg(long, default_value_t = false)]
        full: bool,
    },
    /// Upload a .goo to the printer (transfer only — does NOT start a print).
    Upload {
        #[arg(short, long, default_value = "out/test.goo")]
        file: PathBuf,
        #[arg(long, default_value = "192.168.1.123")]
        ip: String,
        #[arg(long)]
        name: Option<String>,
    },
    /// Stop/abort any running print (safe to run when idle).
    Stop,
    /// Start exposure of an already-uploaded file and monitor it.
    /// FIRES THE UV SCREEN. Ctrl-C aborts (sends stop).
    Expose {
        /// Filename as stored on the printer.
        #[arg(short, long, default_value = "test.goo")]
        file: String,
        /// How long to watch status before exiting, seconds.
        #[arg(long, default_value_t = 30)]
        watch_secs: u64,
    },
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Discover => discover(),
        Command::GerberInfo { file } => gerber_info(file),
        Command::Render { file, out, dpi, mirror, invert } => render(file, out, dpi, mirror, invert),
        Command::Prepare { file, out, time, pwm, mirror, invert, off_x, off_y, preview, no_rotate } => {
            prepare(file, out, time, pwm, mirror, invert, off_x, off_y, preview, no_rotate)
        }
        Command::Print { file, time, pwm, mirror, invert, off_x, off_y, no_rotate, preview } => {
            print_gerber(file, time, pwm, mirror, invert, off_x, off_y, no_rotate, preview)
        }
        Command::Calibrate { out, time, pwm, margin, preview, no_rotate } => {
            calibrate(out, time, pwm, margin, preview, no_rotate)
        }
        Command::GenGoo { out, time, pwm, full } => gen_goo(out, time, pwm, full),
        Command::Upload { file, ip, name } => upload(file, ip, name),
        Command::Stop => stop(),
        Command::Expose { file, watch_secs } => expose(file, watch_secs),
    }
}

fn discover() -> Result<()> {
    println!("broadcasting M99999 (waiting {}s)...", DISCOVERY_TIMEOUT.as_secs());
    let devices = sdcp::discover(DISCOVERY_TIMEOUT)?;
    if devices.is_empty() {
        println!("no printers responded");
        return Ok(());
    }
    for d in &devices {
        println!("- {} @ {} (mainboard {})", d.data.name, d.data.mainboard_ip, d.data.mainboard_id);
    }
    Ok(())
}

fn gerber_info(file: PathBuf) -> Result<()> {
    let commands = gerber::parse_file(&file)?;
    println!("{}", gerber::summarize(&commands));
    Ok(())
}

fn render(file: PathBuf, out: PathBuf, dpi: Option<f32>, mirror: bool, invert: bool) -> Result<()> {
    let commands = gerber::parse_file(&file)?;
    let base = match dpi {
        Some(d) => gerber::RenderOptions::square(d),
        None => gerber::RenderOptions::default(),
    };
    let opts = gerber::RenderOptions {
        mirror_x: mirror,
        invert,
        ..base
    };
    let pixmap = gerber::render(commands, &opts)?;
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    pixmap
        .save_png(&out)
        .map_err(|e| anyhow::anyhow!("save png: {e}"))?;
    println!(
        "rendered {} -> {} ({}x{} px @ {:.2}x{:.2} px/mm, mirror={mirror} invert={invert})",
        file.display(),
        out.display(),
        pixmap.width(),
        pixmap.height(),
        opts.px_per_mm_x,
        opts.px_per_mm_y,
    );
    Ok(())
}

/// Render a Gerber, compose it onto the full screen buffer, optionally save a
/// preview (the pre-rotation design, matching what ends up on the screen), and
/// apply the printer's 180° orientation correction. Returns the final
/// SCREEN_W*SCREEN_H mask ready for `single_layer_exposure`. Shared by `prepare`
/// (writes a .goo) and `print` (uploads + exposes).
#[allow(clippy::too_many_arguments)]
fn compose_gerber_screen(
    file: &Path,
    mirror: bool,
    invert: bool,
    off_x: Option<i32>,
    off_y: Option<i32>,
    no_rotate: bool,
    preview: Option<&Path>,
) -> Result<Vec<u8>> {
    // Render at the printer's native anisotropic pitch: one mask pixel == one
    // screen pixel, so compositing is a straight copy with no resampling.
    let commands = gerber::parse_file(file)?;
    let opts = gerber::RenderOptions { mirror_x: mirror, invert, ..Default::default() };
    let pixmap = gerber::render(commands, &opts)?;
    let (bw, bh) = (pixmap.width(), pixmap.height());
    let mask = gerber::to_grayscale(&pixmap);

    let (cx, cy) = goo::center_offset(SCREEN_W, SCREEN_H, bw, bh);
    let (ox, oy) = (off_x.unwrap_or(cx), off_y.unwrap_or(cy));
    if bw > SCREEN_W || bh > SCREEN_H {
        println!(
            "warning: board {bw}x{bh}px exceeds screen {SCREEN_W}x{SCREEN_H}px — it will be cropped"
        );
    }
    let screen = goo::place_on_screen(SCREEN_W, SCREEN_H, &mask, bw, bh, ox, oy);
    println!("board {bw}x{bh}px @ offset ({ox},{oy}), mirror={mirror} invert={invert}");

    if let Some(preview) = preview {
        if let Some(parent) = preview.parent() {
            std::fs::create_dir_all(parent)?;
        }
        gerber::save_gray_png(preview, SCREEN_W, SCREEN_H, &screen)?;
        println!("preview -> {}", preview.display());
    }

    // Pre-rotate 180° to cancel the printer's screen orientation (see rotate180).
    Ok(if no_rotate { screen } else { goo::rotate180(&screen) })
}

#[allow(clippy::too_many_arguments)]
fn prepare(
    file: PathBuf,
    out: PathBuf,
    time: f32,
    pwm: u16,
    mirror: bool,
    invert: bool,
    off_x: Option<i32>,
    off_y: Option<i32>,
    preview: Option<PathBuf>,
    no_rotate: bool,
) -> Result<()> {
    let screen = compose_gerber_screen(&file, mirror, invert, off_x, off_y, no_rotate, preview.as_deref())?;
    let params = ExposureParams { exposure_time_s: time, light_pwm: pwm };
    let goo_file = goo::single_layer_exposure(SCREEN_W, SCREEN_H, &screen, params)?;
    let bytes = goo::serialize(&goo_file);
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&out, &bytes)?;
    println!(
        "wrote {} ({:.1} KiB): {time}s @ pwm {pwm}",
        out.display(),
        bytes.len() as f64 / 1024.0,
    );
    println!("next: cuprum upload --file {} && cuprum expose --file {}",
        out.display(),
        out.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn print_gerber(
    file: PathBuf,
    time: f32,
    pwm: u16,
    mirror: bool,
    invert: bool,
    off_x: Option<i32>,
    off_y: Option<i32>,
    no_rotate: bool,
    preview: Option<PathBuf>,
) -> Result<()> {
    let screen = compose_gerber_screen(&file, mirror, invert, off_x, off_y, no_rotate, preview.as_deref())?;
    let params = ExposureParams { exposure_time_s: time, light_pwm: pwm };
    let goo_file = goo::single_layer_exposure(SCREEN_W, SCREEN_H, &screen, params)?;
    let bytes = goo::serialize(&goo_file);

    // Discover once: same device drives the HTTP upload and the WS exposure.
    let device = sdcp::discover_one(DISCOVERY_TIMEOUT)?;
    println!("printer: {} @ {}", device.data.name, device.data.mainboard_ip);

    let filename = "cuprum-gerber.goo";
    println!("uploading {:.1} KiB as {filename} (no local file)...", bytes.len() as f64 / 1024.0);
    let outcome = sdcp::upload_file(&device.data.mainboard_ip, filename, &bytes)?;
    println!("uploaded {} bytes (md5 {})", outcome.size, outcome.md5);

    let mut session = Session::connect(&device)?;
    // The HTTP upload returns before the printer finishes ingesting the file;
    // starting too early gets rejected (Cmd 128 Ack=1, "busy"). Wait for idle.
    session.wait_until_idle(Duration::from_secs(20))?;
    println!("=== FIRING UV: start print of {filename} ({time}s @ pwm {pwm}) ===");
    session.start_print_checked(filename, 5)?;
    let _ = session.skip_preheat();
    // Briefly drain so skip_preheat flushes over the socket, then exit — the
    // printer runs the exposure autonomously, no need to hold the terminal.
    let drain = Instant::now() + Duration::from_secs(2);
    while Instant::now() < drain {
        if let Some(msg) = session.try_recv()? {
            print_message(&msg);
        }
    }
    println!("exposure started — exiting. UV turns off after {time}s; `cuprum stop` aborts.");
    Ok(())
}

fn calibrate(
    out: PathBuf,
    time: f32,
    pwm: u16,
    margin: u32,
    preview: Option<PathBuf>,
    no_rotate: bool,
) -> Result<()> {
    use cuprum_core::goo::{SCREEN_PX_PER_MM_X, SCREEN_PX_PER_MM_Y};
    let (mask, info) =
        cal::calibration_mask(SCREEN_W, SCREEN_H, margin, SCREEN_PX_PER_MM_X, SCREEN_PX_PER_MM_Y);

    if let Some(preview) = preview {
        if let Some(parent) = preview.parent() {
            std::fs::create_dir_all(parent)?;
        }
        gerber::save_gray_png(&preview, SCREEN_W, SCREEN_H, &mask)?;
        println!("preview -> {}", preview.display());
    }

    // Pre-rotate 180° to cancel the printer's screen orientation (see rotate180).
    let mask = if no_rotate { mask } else { goo::rotate180(&mask) };
    let params = ExposureParams { exposure_time_s: time, light_pwm: pwm };
    let goo_file = goo::single_layer_exposure(SCREEN_W, SCREEN_H, &mask, params)?;
    let bytes = goo::serialize(&goo_file);
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&out, &bytes)?;
    println!(
        "wrote {} ({:.1} KiB): {time}s @ pwm {pwm}",
        out.display(),
        bytes.len() as f64 / 1024.0,
    );
    println!("--- calibration ---");
    println!(
        "left<->right fiducial centers: {} px  (expected {:.2} mm at current pitch)",
        info.span_x_px, info.expected_x_mm
    );
    println!(
        "top<->bottom fiducial centers: {} px  (expected {:.2} mm at current pitch)",
        info.span_y_px, info.expected_y_mm
    );
    println!("measure center-to-center with calipers, then:");
    println!("  px_per_mm_x = {} / measured_x_mm", info.span_x_px);
    println!("  px_per_mm_y = {} / measured_y_mm", info.span_y_px);
    Ok(())
}

fn gen_goo(out: PathBuf, time: f32, pwm: u16, full: bool) -> Result<()> {
    let params = ExposureParams { exposure_time_s: time, light_pwm: pwm };
    let kind = if full { "full-white" } else { "test pattern" };
    println!("building {kind} {SCREEN_W}x{SCREEN_H}...");
    let pixels = if full {
        goo::full_white(SCREEN_W, SCREEN_H)
    } else {
        goo::test_pattern(SCREEN_W, SCREEN_H)
    };
    let file = goo::single_layer_exposure(SCREEN_W, SCREEN_H, &pixels, params)?;
    let bytes = goo::serialize(&file);
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&out, &bytes)?;
    println!(
        "wrote {} ({:.1} KiB): 1 layer, {time}s @ pwm {pwm}, Z/tilt disabled",
        out.display(),
        bytes.len() as f64 / 1024.0,
    );
    Ok(())
}

fn upload(file: PathBuf, ip: String, name: Option<String>) -> Result<()> {
    let data = std::fs::read(&file)?;
    let filename = name.unwrap_or_else(|| {
        file.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "cuprum.goo".to_string())
    });
    println!(
        "uploading {} ({:.1} KiB) to {ip} as {filename}...",
        file.display(),
        data.len() as f64 / 1024.0,
    );
    let outcome = sdcp::upload_file(&ip, &filename, &data)?;
    println!(
        "ok: {} bytes, md5 {} — file is on the printer (no print started)",
        outcome.size, outcome.md5
    );
    Ok(())
}

fn connect_first() -> Result<Session> {
    let device = sdcp::discover_one(DISCOVERY_TIMEOUT)?;
    println!("printer: {} @ {}", device.data.name, device.data.mainboard_ip);
    Session::connect(&device)
}

fn stop() -> Result<()> {
    let mut session = connect_first()?;
    session.stop_print()?;
    println!("stop sent; reading acks for 2s...");
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if let Some(msg) = session.try_recv()? {
            print_message(&msg);
        }
    }
    Ok(())
}

fn expose(file: String, watch_secs: u64) -> Result<()> {
    let mut session = connect_first()?;
    println!("=== FIRING UV: start print of {file} ===");
    session.start_print(&file)?;
    // No resin tank present -> skip preheat so the printer doesn't hang heating.
    let _ = session.skip_preheat();
    watch_exposure(&mut session, watch_secs)
}

/// Watch print status for `watch_secs`, printing updates; Ctrl-C sends STOP.
fn watch_exposure(session: &mut Session, watch_secs: u64) -> Result<()> {
    let abort = Arc::new(AtomicBool::new(false));
    {
        let abort = abort.clone();
        ctrlc::set_handler(move || abort.store(true, Ordering::SeqCst))?;
    }
    let deadline = Instant::now() + Duration::from_secs(watch_secs);
    while Instant::now() < deadline {
        if abort.load(Ordering::SeqCst) {
            println!("\nCtrl-C -> sending STOP");
            let _ = session.stop_print();
            break;
        }
        if let Some(msg) = session.try_recv()? {
            print_message(&msg);
        }
    }
    println!("done watching (Ctrl-C any time to abort; or run `cuprum stop`)");
    Ok(())
}

fn print_message(msg: &serde_json::Value) {
    let topic = msg.get("Topic").and_then(|t| t.as_str()).unwrap_or("?");
    if let Some(status) = msg.get("Status") {
        let cur = &status["CurrentStatus"];
        let print = &status["PrintInfo"];
        println!(
            "[status] CurrentStatus={cur} PrintInfo.Status={} layer={}/{} err={}",
            print["Status"], print["CurrentLayer"], print["TotalLayer"], print["ErrorNumber"]
        );
    } else if let Some(data) = msg.get("Data") {
        let cmd = &data["Cmd"];
        let ack = &data["Data"]["Ack"];
        println!("[resp] {topic} Cmd={cmd} Ack={ack}");
    } else {
        println!("[msg] {topic}");
    }
}
