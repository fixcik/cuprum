//! Pixel-pitch calibration target.
//!
//! The screen pitch derived from firmware (Resolution / XYZsize) disagrees with
//! the marketing 14×19 µm figure, so geometry can't be trusted until measured.
//! This builds a full-screen mask whose features have *exactly known pixel spans*,
//! so a physical measurement reads the pitch back directly — no dependence on the
//! assumed constant:
//!
//!   px_per_mm_x = span_x_px / (measured X distance between fiducial centers, mm)
//!   px_per_mm_y = span_y_px / (measured Y distance, mm)
//!
//! Four crosshair fiducials sit at the corners of an inset rectangle; measure
//! center-to-center with calipers. A ruler of tick marks every 10 mm (placed
//! using the *current* constants) overlays a sanity check: lay a physical ruler
//! against the exposed marks and watch for drift if the constants are off.

/// What was drawn, so the caller can tell the user exactly what to measure.
#[derive(Clone, Copy, Debug)]
pub struct CalInfo {
    /// Horizontal pixel span between the left and right fiducial centers.
    pub span_x_px: u32,
    /// Vertical pixel span between the top and bottom fiducial centers.
    pub span_y_px: u32,
    /// Distance those spans *should* measure at the current constants, mm.
    pub expected_x_mm: f32,
    pub expected_y_mm: f32,
}

/// Build a full-screen calibration mask (row-major grayscale, 0 = off / 255 = on).
///
/// `margin` is the inset of the corner fiducials from each screen edge, in pixels.
/// `px_per_mm_x/y` are the *current* constants, used only for the 10 mm ruler ticks.
pub fn calibration_mask(
    screen_w: u32,
    screen_h: u32,
    margin: u32,
    px_per_mm_x: f32,
    px_per_mm_y: f32,
) -> (Vec<u8>, CalInfo) {
    let (sw, sh) = (screen_w as usize, screen_h as usize);
    let mut buf = vec![0u8; sw * sh];

    // Fiducial crosshairs at the corners of an inset rectangle.
    let m = margin.min(screen_w / 2).min(screen_h / 2);
    let left = m;
    let right = screen_w - m;
    let top = m;
    let bottom = screen_h - m;
    let arm = 120i32; // half-length of each crosshair arm, px
    let thick = 12u32; // line thickness, px
    for &cx in &[left, right] {
        for &cy in &[top, bottom] {
            cross(&mut buf, sw, sh, cx as i32, cy as i32, arm, thick);
        }
    }
    // A center fiducial too, as an extra reference.
    cross(&mut buf, sw, sh, (screen_w / 2) as i32, (screen_h / 2) as i32, arm, thick);

    // Ruler ticks every 10 mm along the top and left edges (uses current pitch).
    let step_x = (px_per_mm_x * 10.0).round() as i32;
    let step_y = (px_per_mm_y * 10.0).round() as i32;
    if step_x > 0 {
        let mut i = 0;
        let mut x = left as i32;
        while x <= right as i32 {
            let major = i % 5 == 0; // taller every 50 mm
            let len = if major { 90 } else { 45 };
            fill_rect(&mut buf, sw, sh, x - 3, top as i32, 6, len);
            x += step_x;
            i += 1;
        }
    }
    if step_y > 0 {
        let mut i = 0;
        let mut y = top as i32;
        while y <= bottom as i32 {
            let major = i % 5 == 0;
            let len = if major { 90 } else { 45 };
            fill_rect(&mut buf, sw, sh, left as i32, y - 3, len, 6);
            y += step_y;
            i += 1;
        }
    }

    let info = CalInfo {
        span_x_px: right - left,
        span_y_px: bottom - top,
        expected_x_mm: (right - left) as f32 / px_per_mm_x,
        expected_y_mm: (bottom - top) as f32 / px_per_mm_y,
    };
    (buf, info)
}

/// Draw a filled axis-aligned rectangle (lit), clipped to the buffer.
fn fill_rect(buf: &mut [u8], sw: usize, sh: usize, x: i32, y: i32, w: i32, h: i32) {
    let x0 = x.max(0) as usize;
    let y0 = y.max(0) as usize;
    let x1 = ((x + w).max(0) as usize).min(sw);
    let y1 = ((y + h).max(0) as usize).min(sh);
    for yy in y0..y1 {
        buf[yy * sw + x0..yy * sw + x1].fill(255);
    }
}

/// Draw a `+` crosshair centered at (cx, cy): a horizontal and vertical bar.
fn cross(buf: &mut [u8], sw: usize, sh: usize, cx: i32, cy: i32, arm: i32, thick: u32) {
    let t = thick as i32;
    fill_rect(buf, sw, sh, cx - arm, cy - t / 2, 2 * arm, t); // horizontal
    fill_rect(buf, sw, sh, cx - t / 2, cy - arm, t, 2 * arm); // vertical
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans_match_inset_and_buffer_is_sized() {
        let (buf, info) = calibration_mask(15120, 6230, 200, 69.08, 48.34);
        assert_eq!(buf.len(), 15120 * 6230);
        assert_eq!(info.span_x_px, 15120 - 400);
        assert_eq!(info.span_y_px, 6230 - 400);
        // Expected mm = span / pitch.
        assert!((info.expected_x_mm - (15120 - 400) as f32 / 69.08).abs() < 1e-3);
        // Something was actually drawn.
        assert!(buf.iter().any(|&p| p == 255));
    }

    #[test]
    fn fill_rect_clips_out_of_bounds() {
        let mut buf = vec![0u8; 10 * 10];
        fill_rect(&mut buf, 10, 10, -5, -5, 8, 8); // mostly off the top-left
        assert_eq!(buf[0], 255);
        assert_eq!(buf[3 * 10 + 3], 0); // (3,3) is outside the 3x3 visible part
    }
}
