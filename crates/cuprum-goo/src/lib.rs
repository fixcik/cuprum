//! Build a single-frame exposure `.goo` for the Saturn 4 Ultra 16K.
//!
//! The printer has no "show an image for N seconds" command, so we emit a
//! one-layer print whose single (bottom) layer IS the exposure mask, with
//! lift/retract = 0 (no peel motion).
//!
//! IMPORTANT (verified on hardware): the firmware ALWAYS drives Z down to the
//! screen to expose — you cannot keep the carriage parked high via the file
//! (`layer_position_z` is ignored for positioning; we tried 200 mm and it still
//! went to the screen). Safety for PCB exposure therefore comes from physically
//! removing the build PLATE (and vat): the plateless carriage descends but its
//! arm clears the board lying on the screen. The UV LCD exposes from below.
//!
//! We reuse the (MIT) `goo` crate for the hard parts (header layout with its
//! preview-image fields, RLE layer encoding). Because `LayerContent` is not
//! re-exported, we build the file via the crate's blessed `SliceConfig` ->
//! `EncodableLayer::finish` -> `GooFile::from_slice_result` path. Setting
//! `slice_height = 0` makes the layer Z position 0, and zero lift/retract
//! distances disable Z motion and the tilt-release peel.

use anyhow::{ensure, Result};
use goo::misc::{EncodableLayer, SliceResult};
use goo::serde::{DynamicSerializer, SizedString};
use goo::slice_config::{ExposureConfig, SliceConfig};
use goo::{GooFile, LayerEncoder};

/// Saturn 4 Ultra 16K native screen, from SDCP attributes (`Resolution`).
pub const SCREEN_W: u32 = 15120;
pub const SCREEN_H: u32 = 6230;
/// Marketing pixel pitch, micrometers — the ground truth for exposure geometry.
/// A ruler calibration on 2026-05-28 (10 grid divisions ≈ 97 mm X / 92 mm Y →
/// ~14.0 × 19.0 µm) confirmed these to within measurement error and ruled out the
/// SDCP `XYZsize`-derived pitch (14.48 × 20.69 µm). We keep the exact marketing
/// figures rather than the noisy measured ones.
pub const PITCH_X_UM: f32 = 14.0;
pub const PITCH_Y_UM: f32 = 19.0;

/// Physical exposure area in mm, derived from the marketing pitch above.
pub const SCREEN_X_MM: f32 = SCREEN_W as f32 * PITCH_X_UM / 1000.0; // 211.68
pub const SCREEN_Y_MM: f32 = SCREEN_H as f32 * PITCH_Y_UM / 1000.0; // 118.37
pub const SCREEN_Z_MM: f32 = 220.0;

/// Native (anisotropic) pixel pitch, pixels per millimeter: X ≈ 71.43, Y ≈ 52.63.
/// One output pixel == one LCD pixel at these values.
pub const SCREEN_PX_PER_MM_X: f32 = SCREEN_W as f32 / SCREEN_X_MM;
pub const SCREEN_PX_PER_MM_Y: f32 = SCREEN_H as f32 / SCREEN_Y_MM;

#[derive(Clone, Copy, Debug)]
pub struct ExposureParams {
    /// UV exposure time for the single layer, seconds.
    pub exposure_time_s: f32,
    /// UV LED intensity, 0..=255.
    pub light_pwm: u16,
}

impl Default for ExposureParams {
    fn default() -> Self {
        Self {
            exposure_time_s: 8.0,
            light_pwm: 255,
        }
    }
}

/// Build a single-layer exposure file from a full-screen grayscale mask.
///
/// `pixels` must be exactly `width * height` bytes, row-major, where 0 = LED off
/// (dark) and 255 = LED on (cured). For PCB masks this is pure black/white.
///
/// Every pixel must be covered by the RLE: the printer decodes each layer into
/// an uninitialized buffer, so an under-filled layer prints leftover garbage.
#[tracing::instrument(skip_all)]
pub fn single_layer_exposure(
    width: u32,
    height: u32,
    pixels: &[u8],
    params: ExposureParams,
) -> Result<GooFile> {
    let expected = width as usize * height as usize;
    ensure!(
        pixels.len() == expected,
        "pixel buffer is {} bytes, expected {width}x{height} = {expected}",
        pixels.len(),
    );

    // No Z motion and no tilt-release: lift/retract distances are zero. Speeds
    // stay non-zero so the crate's time estimate doesn't divide by zero.
    let exposure = ExposureConfig {
        exposure_time: params.exposure_time_s,
        lift_distance: 0.0,
        lift_speed: 60.0,
        retract_distance: 0.0,
        retract_speed: 60.0,
    };
    let config = SliceConfig {
        platform_resolution: [width, height],
        platform_size: [SCREEN_X_MM, SCREEN_Y_MM, SCREEN_Z_MM],
        slice_height: 0.0,
        exposure_config: exposure.clone(),
        first_exposure_config: exposure,
        first_layers: 1,
    };

    let mut encoder = LayerEncoder::new();
    encode_runs(&mut encoder, pixels);
    let mut layer = <LayerEncoder as EncodableLayer>::finish(encoder, 0, &config);
    layer.light_pwm = params.light_pwm;
    // layer_position_z stays 0 (slice_height=0). The firmware drives Z to the
    // screen to expose regardless; carriage clearance comes from removing the
    // build plate, not from this value. lift/retract are 0 (no peel motion).

    let mut file = GooFile::from_slice_result(SliceResult {
        layers: vec![layer],
        slice_config: &config,
    });
    file.header.z_size = SCREEN_Z_MM;
    file.header.light_pwm = params.light_pwm;
    file.header.bottom_light_pwm = params.light_pwm;
    file.header.transition_layers = 0;
    file.header.printer_name = SizedString::new(b"Saturn 4 Ultra 16K");
    file.header.printer_type = SizedString::new(b"Saturn4Ultra16K");
    file.header.software_info = SizedString::new(b"cuprum");

    Ok(file)
}

/// Coalesce a row-major buffer into RLE runs covering every pixel.
fn encode_runs(encoder: &mut LayerEncoder, pixels: &[u8]) {
    if pixels.is_empty() {
        return;
    }
    let mut current = pixels[0];
    let mut run: u64 = 0;
    for &p in pixels {
        if p == current {
            run += 1;
        } else {
            encoder.add_run(run, current);
            current = p;
            run = 1;
        }
    }
    encoder.add_run(run, current);
}

/// Serialize a `.goo` to bytes ready for upload.
#[tracing::instrument(skip_all)]
pub fn serialize(file: &GooFile) -> Vec<u8> {
    let mut ser = DynamicSerializer::new();
    file.serialize(&mut ser);
    ser.into_inner()
}

/// Place a board mask onto a full screen-sized buffer at a top-left pixel offset.
///
/// `mask` is row-major grayscale (`mask_w * mask_h` bytes). The screen background
/// is dark (0 = UV off). Pixels that fall outside the screen are clipped, so a
/// negative offset or an oversized board is safe (it just gets cropped). Returns
/// exactly `screen_w * screen_h` bytes, ready for `single_layer_exposure`.
pub fn place_on_screen(
    screen_w: u32,
    screen_h: u32,
    mask: &[u8],
    mask_w: u32,
    mask_h: u32,
    off_x: i32,
    off_y: i32,
) -> Vec<u8> {
    let mut buf = vec![0u8; screen_w as usize * screen_h as usize];
    blit_max(
        &mut buf, screen_w, screen_h, mask, mask_w, mask_h, off_x, off_y,
    );
    buf
}

/// Blit a mask into an existing screen buffer, taking the per-pixel max so
/// overlapping placements union their lit (white) areas. Out-of-bounds clipped.
#[allow(clippy::too_many_arguments)]
pub fn blit_max(
    buf: &mut [u8],
    screen_w: u32,
    screen_h: u32,
    mask: &[u8],
    mask_w: u32,
    mask_h: u32,
    off_x: i32,
    off_y: i32,
) {
    let (sw, sh) = (screen_w as usize, screen_h as usize);
    let (mw, mh) = (mask_w as usize, mask_h as usize);
    for my in 0..mh {
        let sy = my as i32 + off_y;
        if sy < 0 || sy as usize >= sh {
            continue;
        }
        let sy = sy as usize;
        for mx in 0..mw {
            let sx = mx as i32 + off_x;
            if sx < 0 || sx as usize >= sw {
                continue;
            }
            let dst = &mut buf[sy * sw + sx as usize];
            *dst = (*dst).max(mask[my * mw + mx]);
        }
    }
}

/// Flip a row-major buffer horizontally (mirror across the vertical axis). Used
/// to apply a whole-sheet emulsion-down mirror to the composed screen.
pub fn flip_x(buf: &mut [u8], width: u32, height: u32) {
    let w = width as usize;
    for y in 0..height as usize {
        buf[y * w..y * w + w].reverse();
    }
}

/// Rotate a row-major buffer 180°. The Saturn 4 Ultra displays the slice buffer
/// rotated 180° on the physical screen (verified with the calibration target: our
/// top-left origin lands at the screen's bottom-right corner). Pre-rotating cancels
/// that, so the exposed image matches the design/preview. For a row-major image a
/// 180° rotation is just the reversed pixel order: (x,y) -> (w-1-x, h-1-y) maps
/// linear index i -> N-1-i.
pub fn rotate180(buf: &[u8]) -> Vec<u8> {
    buf.iter().rev().copied().collect()
}

/// Top-left offset that centers a `mask_w * mask_h` board on the screen.
pub fn center_offset(screen_w: u32, screen_h: u32, mask_w: u32, mask_h: u32) -> (i32, i32) {
    (
        (screen_w as i32 - mask_w as i32) / 2,
        (screen_h as i32 - mask_h as i32) / 2,
    )
}

/// Generate a full-white mask (entire screen on). Brightest, easiest to confirm
/// the LCD/UV is firing (view with a phone camera — 405 nm reads as blue/violet).
pub fn full_white(width: u32, height: u32) -> Vec<u8> {
    vec![255u8; width as usize * height as usize]
}

/// Generate a test mask: black field with a centered white rectangle (50% area).
pub fn test_pattern(width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut buf = vec![0u8; w * h];
    let (x0, x1) = (w / 4, w * 3 / 4);
    let (y0, y1) = (h / 4, h * 3 / 4);
    for y in y0..y1 {
        buf[y * w + x0..y * w + x1].fill(255);
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;
    use goo::LayerDecoder;

    #[test]
    fn roundtrip_covers_every_pixel() {
        let (w, h) = (640u32, 400u32);
        let pixels = test_pattern(w, h);
        let file = single_layer_exposure(w, h, &pixels, ExposureParams::default()).unwrap();

        assert_eq!(file.header.layer_count, 1);
        assert_eq!(file.header.bottom_layers, 1);
        assert_eq!(file.header.x_resolution, w as u16);
        assert_eq!(file.header.lift_distance, 0.0);
        assert_eq!(file.header.bottom_lift_distance, 0.0);

        let layer = &file.layers[0];
        assert_eq!(layer.lift_distance, 0.0);
        assert_eq!(layer.retract_distance, 0.0);

        let total: u64 = LayerDecoder::new(&layer.data).map(|r| r.length).sum();
        assert_eq!(total, w as u64 * h as u64, "RLE must cover every pixel");
    }

    #[test]
    fn rejects_wrong_buffer_size() {
        assert!(single_layer_exposure(10, 10, &[0u8; 5], ExposureParams::default()).is_err());
    }

    #[test]
    fn place_centers_and_clips() {
        // 2x2 all-on mask centered on a 6x4 screen -> at offset (2,1).
        let mask = vec![255u8; 4];
        let (ox, oy) = center_offset(6, 4, 2, 2);
        assert_eq!((ox, oy), (2, 1));
        let buf = place_on_screen(6, 4, &mask, 2, 2, ox, oy);
        assert_eq!(buf.len(), 24);
        let on: usize = buf.iter().filter(|&&p| p == 255).count();
        assert_eq!(on, 4, "exactly the 2x2 mask is lit");
        assert_eq!(buf[6 + 2], 255);
        assert_eq!(buf[2 * 6 + 3], 255);

        // A negative offset crops the part that falls off-screen.
        let cropped = place_on_screen(6, 4, &mask, 2, 2, -1, -1);
        assert_eq!(cropped.iter().filter(|&&p| p == 255).count(), 1);
        assert_eq!(cropped[0], 255);
    }

    #[test]
    fn rotate180_reverses_and_is_involutive() {
        let src: Vec<u8> = (0..6).collect();
        let rot = rotate180(&src);
        assert_eq!(rot, vec![5, 4, 3, 2, 1, 0]);
        assert_eq!(rotate180(&rot), src, "rotating twice restores the original");
    }
}
