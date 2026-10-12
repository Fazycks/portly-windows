//! The Portly mark for the notification area, port of `MenuBarIcon.swift`:
//! three inbound lanes converging into one supervised process.
//!
//! Same 24x24 authored grid as `Tools/makeicon.swift` and the website mark.
//! macOS tints a template image; Windows has no template icons, so the glyph is
//! drawn white on a dark taskbar and black on a light one. A small warning
//! triangle stands in for the `exclamationmark.triangle.fill` the macOS label
//! shows next to the glyph when a server failed or is unhealthy.

const LINE_WIDTH: f64 = 2.3;
const DOT_CENTER: (f64, f64) = (18.1, 12.0);
const DOT_RADIUS: f64 = 2.9;

/// Ink bounds on the authored grid: strokes and dot, half a stroke of slack.
const INK_MIN_X: f64 = 2.9 - LINE_WIDTH / 2.0;
const INK_MIN_Y: f64 = 5.8 - LINE_WIDTH / 2.0;
const INK_MAX_X: f64 = DOT_CENTER.0 + DOT_RADIUS;
const INK_MAX_Y: f64 = 18.2 + LINE_WIDTH / 2.0;

type Pt = (f64, f64);

fn cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, steps: usize, out: &mut Vec<Pt>) {
    for i in 1..=steps {
        let t = i as f64 / steps as f64;
        let u = 1.0 - t;
        let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
        out.push((
            a * p0.0 + b * p1.0 + c * p2.0 + d * p3.0,
            a * p0.1 + b * p1.1 + c * p2.1 + d * p3.1,
        ));
    }
}

/// The three lanes as polylines on the authored grid.
fn lanes() -> Vec<Vec<Pt>> {
    let mut upper = vec![(2.9, 5.8), (5.9, 5.8)];
    cubic((5.9, 5.8), (9.5, 5.8), (9.2, 12.0), (12.8, 12.0), 24, &mut upper);
    let middle = vec![(2.9, 12.0), (12.8, 12.0)];
    let mut lower = vec![(2.9, 18.2), (5.9, 18.2)];
    cubic((5.9, 18.2), (9.5, 18.2), (9.2, 12.0), (12.8, 12.0), 24, &mut lower);
    vec![upper, middle, lower]
}

fn seg_dist(p: Pt, a: Pt, b: Pt) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len = dx * dx + dy * dy;
    let t = if len > 0.0 { (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len).clamp(0.0, 1.0) } else { 0.0 };
    let (x, y) = (a.0 + t * dx - p.0, a.1 + t * dy - p.1);
    (x * x + y * y).sqrt()
}

fn cross(o: Pt, a: Pt, b: Pt) -> f64 {
    (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0)
}

fn in_triangle(p: Pt, t: &[Pt; 3]) -> bool {
    let d1 = cross(t[0], t[1], p);
    let d2 = cross(t[1], t[2], p);
    let d3 = cross(t[2], t[0], p);
    let neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(neg && pos)
}

/// Renders the glyph as straight (non-premultiplied) RGBA, `size` x `size`.
///
/// - `active`: filled process dot when something runs, an open ring when idle.
/// - `problem`: warning badge in the lower-right corner.
/// - `white`: ink colour (white for a dark taskbar, black for a light one).
pub fn render(size: u32, active: bool, problem: bool, white: bool) -> Vec<u8> {
    let s = size as f64;
    let ink_w = INK_MAX_X - INK_MIN_X;
    let ink_h = INK_MAX_Y - INK_MIN_Y;
    let pad = s * 0.04;
    let scale = (s - pad * 2.0) / ink_w;
    let ox = pad - INK_MIN_X * scale;
    // Centred vertically; lifted to the top edge when the badge needs the corner.
    let oy = if problem { pad - INK_MIN_Y * scale } else { (s - ink_h * scale) / 2.0 - INK_MIN_Y * scale };
    let map = |p: Pt| (ox + p.0 * scale, oy + p.1 * scale);

    let segments: Vec<(Pt, Pt)> = lanes()
        .into_iter()
        .flat_map(|lane| {
            let pts: Vec<Pt> = lane.into_iter().map(map).collect();
            pts.windows(2).map(|w| (w[0], w[1])).collect::<Vec<_>>()
        })
        .collect();
    let half_lw = LINE_WIDTH * scale / 2.0;
    let dot = map(DOT_CENTER);
    let dot_r = DOT_RADIUS * scale;
    let ring = LINE_WIDTH * 0.65 * scale;

    // Badge: a warning triangle with a knocked-out exclamation mark.
    let bs = s * 0.58;
    let bh = bs * 0.9;
    let tri: [Pt; 3] = [(s - bs / 2.0, s - bh), (s - 0.25, s - 0.25), (s - bs, s - 0.25)];
    let knockout = (s * 0.07).max(1.0);
    let bang_x = s - bs / 2.0;
    let bang_top = s - bh + bh * 0.34;
    let bang_bottom = s - bh + bh * 0.64;
    let bang_hw = (bs * 0.07).max(0.6);
    let bang_dot = (bang_x, s - bh + bh * 0.8);
    let bang_r = (bs * 0.08).max(0.7);

    let glyph = |p: Pt| -> bool {
        if segments.iter().any(|&(a, b)| seg_dist(p, a, b) <= half_lw) {
            return true;
        }
        let d = ((p.0 - dot.0).powi(2) + (p.1 - dot.1).powi(2)).sqrt();
        if active { d <= dot_r } else { (d - (dot_r - ring / 2.0)).abs() <= ring / 2.0 }
    };
    let covered = |p: Pt| -> bool {
        if problem {
            if in_triangle(p, &tri) {
                let in_bar = (p.0 - bang_x).abs() <= bang_hw && p.1 >= bang_top && p.1 <= bang_bottom;
                let in_dot = ((p.0 - bang_dot.0).powi(2) + (p.1 - bang_dot.1).powi(2)).sqrt() <= bang_r;
                return !(in_bar || in_dot);
            }
            let near = seg_dist(p, tri[0], tri[1]).min(seg_dist(p, tri[1], tri[2])).min(seg_dist(p, tri[2], tri[0]));
            if near < knockout {
                return false;
            }
        }
        glyph(p)
    };

    const N: u32 = 5; // 5x5 supersampling
    let ink: u8 = if white { 255 } else { 0 };
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let mut hits = 0u32;
            for sy in 0..N {
                for sx in 0..N {
                    let p = (x as f64 + (sx as f64 + 0.5) / N as f64, y as f64 + (sy as f64 + 0.5) / N as f64);
                    if covered(p) {
                        hits += 1;
                    }
                }
            }
            let o = ((y * size + x) * 4) as usize;
            rgba[o] = ink;
            rgba[o + 1] = ink;
            rgba[o + 2] = ink;
            rgba[o + 3] = ((hits as f64 / (N * N) as f64) * 255.0).round() as u8;
        }
    }
    rgba
}

/// True when the taskbar uses the light theme
/// (HKCU\...\Themes\Personalize\SystemUsesLightTheme != 0). Defaults to dark.
#[cfg(windows)]
pub fn taskbar_is_light() -> bool {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
    let value = wide("SystemUsesLightTheme");
    let mut data: u32 = 0;
    let mut len: u32 = std::mem::size_of::<u32>() as u32;
    // SAFETY: valid NUL-terminated wide strings and a 4-byte output buffer.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut data as *mut u32 as *mut core::ffi::c_void,
            &mut len,
        )
    };
    status == 0 && data != 0
}

#[cfg(not(windows))]
pub fn taskbar_is_light() -> bool {
    false
}

/// Pixel size of a notification-area icon at the current DPI (16, 20, 24, 32…).
#[cfg(windows)]
pub fn tray_icon_size() -> u32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSMICON};
    // SAFETY: plain metric query.
    let px = unsafe { GetSystemMetrics(SM_CXSMICON) };
    (px.max(16) as u32).min(64)
}

#[cfg(not(windows))]
pub fn tray_icon_size() -> u32 {
    32
}
