// Hands Buddy on Windows (mac/Sources/Hands.swift): looks at the screen, clicks and types in other apps.
// main.rs asks you first for each task, shows the red bar and stops on Esc; here: the screenshot (Buddy's own
// windows left out), the clicks and keys, and two safety checks. It never types into a password field, and a
// click on something like Send, Buy or Delete needs your OK in a Windows alert. Runs on worker threads.
use crate::sys;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct State {
    pub active: Arc<AtomicBool>,
    /// The last screenshot: its pixels per screen pixel, and the screen's top-left.
    geo: Arc<Mutex<(f64, i32, i32)>>,
    /// Until when (ms since 1970) an Esc we pressed ourselves isn't you stopping Buddy.
    pub own_esc_until: Arc<AtomicU64>,
}
pub fn now_ms() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }

const RISKY: &str = r"(?i)\b(send|buy|pay|purchase|order|checkout|delete|remove|erase|trash|submit|post|publish|transfer|confirm|sign out|log out|uninstall)\b";

pub fn act(op: &str, m: &Map<String, Value>, s: &State) -> Result<Value, String> {
    if !s.active.load(Ordering::SeqCst) { return Err("Hands Buddy isn’t allowed to act right now.".into()); }
    let num = |k: &str| m.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let what = m.get("what").and_then(Value::as_str).unwrap_or("").to_string();
    let point = || { let (scale, ox, oy) = *s.geo.lock().unwrap(); let scale = if scale > 0.0 { scale } else { 1.0 }; (ox + (num("x") / scale).round() as i32, oy + (num("y") / scale).round() as i32) };
    match op {
        "hands.shot" => {
            let (image, w, h, scale, ox, oy) = imp::shot()?;
            *s.geo.lock().unwrap() = (scale, ox, oy);
            Ok(json!({ "image": image, "width": w, "height": h }))
        }
        "hands.click" | "hands.doubleClick" | "hands.rightClick" => {
            if regex::Regex::new(RISKY).unwrap().is_match(&what)
                && !sys::confirm(&format!("Click “{what}”?"), "Buddy wants to click something that might send, buy or delete. Only you can say yes.", "Click it") {
                return Err("You said no, so Buddy didn’t click it.".into());
            }
            if !s.active.load(Ordering::SeqCst) { return Err("Hands Buddy isn’t allowed to act right now.".into()); }
            let (x, y) = point();
            imp::click(x, y, op == "hands.rightClick", if op == "hands.doubleClick" { 2 } else { 1 });
            Ok(json!(format!("Clicked {}", if what.is_empty() { "there" } else { &what })))
        }
        "hands.type" => {
            if imp::focused_is_password() { return Err("That’s a password field. Buddy doesn’t type passwords; please type it yourself.".into()); }
            let text: String = m.get("text").and_then(Value::as_str).unwrap_or("").chars().take(2000).collect();
            imp::type_text(&text);
            Ok(json!("Typed"))
        }
        "hands.key" => {
            let keys = m.get("keys").and_then(Value::as_str).unwrap_or("").to_lowercase();
            if keys.ends_with("esc") || keys.ends_with("escape") { s.own_esc_until.store(now_ms() + 600, Ordering::SeqCst); }
            if !imp::press(&keys) { return Err("I don’t know that key.".into()); }
            Ok(json!(format!("Pressed {keys}")))
        }
        "hands.scroll" => {
            let (x, y) = point();
            imp::scroll(x, y, (num("amount") as i32).clamp(-30, 30));
            Ok(json!("Scrolled"))
        }
        "hands.openApp" => {
            let name = m.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
            if name.is_empty() || !imp::open_app(&name) { return Err(format!("I couldn’t find an app called {name}.")); }
            Ok(json!(format!("Opened {name}")))
        }
        _ => Err("unknown".into()),
    }
}

/// Is Esc held down right now? (polled while Hands Buddy works)
pub fn esc_down() -> bool { imp::esc_down() }
pub use imp::{focused_is_password, key_hit, snap};

#[cfg(windows)]
mod imp {
    use base64::Engine;
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SetCursorPos, SM_CXSCREEN, SM_CYSCREEN};

    /// The main screen as a JPEG, at most 1280 pixels wide: (base64, width, height, scale, left, top).
    pub fn shot() -> Result<(String, u32, u32, f64, i32, i32), String> {
        let (b64, w, h, scale) = snap(1280, None)?;
        Ok((b64, w, h, scale, 0, 0))
    }
    /// The main screen as a JPEG at most `max_w` wide, with a ring drawn where the pointer was (screen pixels), if given.
    pub fn snap(max_w: u32, mark: Option<(i32, i32)>) -> Result<(String, u32, u32, f64), String> {
        let img = capture()?;
        let (w, h) = img.dimensions();
        let scale = (max_w as f64 / w as f64).min(1.0);
        let (nw, nh) = (((w as f64) * scale).round() as u32, ((h as f64) * scale).round() as u32);
        let mut img = if scale < 1.0 { image::imageops::resize(&img, nw, nh, image::imageops::FilterType::Triangle) } else { img };
        if let Some((x, y)) = mark {
            let (cx, cy) = ((x as f64 * scale) as i64, (y as f64 * scale) as i64);
            for a in 0..360 {
                let t = (a as f64).to_radians();
                for r in [11.0, 12.0, 13.0] {
                    let (px, py) = (cx + (t.cos() * r) as i64, cy + (t.sin() * r) as i64);
                    if px >= 0 && py >= 0 && (px as u32) < nw && (py as u32) < nh { img.put_pixel(px as u32, py as u32, image::Rgb([230, 40, 40])); }
                }
            }
        }
        let mut jpg = vec![];
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 60).encode_image(&img).map_err(|e| e.to_string())?;
        Ok((base64::engine::general_purpose::STANDARD.encode(jpg), nw, nh, scale))
    }
    fn capture() -> Result<image::RgbImage, String> {
        unsafe {
            let (w, h) = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
            if w <= 0 || h <= 0 { return Err("no screen".into()); }
            let screen = GetDC(std::ptr::null_mut());
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(mem, bmp as _);
            BitBlt(mem, 0, 0, w, h, screen, 0, 0, SRCCOPY | CAPTUREBLT);
            let mut info: BITMAPINFO = zeroed();
            info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
            info.bmiHeader.biWidth = w;
            info.bmiHeader.biHeight = -h; // top row first
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB as _;
            let mut bgra = vec![0u8; (w * h * 4) as usize];
            let lines = GetDIBits(mem, bmp, 0, h as u32, bgra.as_mut_ptr() as _, &mut info, DIB_RGB_COLORS);
            SelectObject(mem, old);
            DeleteObject(bmp as _);
            DeleteDC(mem);
            ReleaseDC(std::ptr::null_mut(), screen);
            if lines == 0 { return Err("I couldn’t see the screen.".into()); }
            let rgb: Vec<u8> = bgra.chunks_exact(4).flat_map(|p| [p[2], p[1], p[0]]).collect();
            image::RgbImage::from_raw(w as u32, h as u32, rgb).ok_or_else(|| "no picture".to_string())
        }
    }
    /// Is this key (a virtual-key code) down now, or was it pressed since the last time we asked?
    pub fn key_hit(vk: i32) -> bool { unsafe { (GetAsyncKeyState(vk) as u16 & 0x8001) != 0 } }

    fn send(inputs: &[INPUT]) { unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), size_of::<INPUT>() as i32); } }
    fn mouse(flags: u32, data: i32) -> INPUT {
        let mut i: INPUT = unsafe { zeroed() };
        i.r#type = INPUT_MOUSE;
        i.Anonymous.mi = MOUSEINPUT { dx: 0, dy: 0, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 };
        i
    }
    fn key(vk: u16, scan: u16, flags: u32) -> INPUT {
        let mut i: INPUT = unsafe { zeroed() };
        i.r#type = INPUT_KEYBOARD;
        i.Anonymous.ki = KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 };
        i
    }
    pub fn click(x: i32, y: i32, right: bool, times: u32) {
        unsafe { SetCursorPos(x, y); }
        std::thread::sleep(std::time::Duration::from_millis(60));
        let (down, up) = if right { (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP) } else { (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP) };
        for _ in 0..times {
            send(&[mouse(down, 0)]);
            std::thread::sleep(std::time::Duration::from_millis(40));
            send(&[mouse(up, 0)]);
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
    }
    pub fn scroll(x: i32, y: i32, lines: i32) {
        unsafe { SetCursorPos(x, y); }
        send(&[mouse(MOUSEEVENTF_WHEEL, lines * 40)]); // 120 = one notch = three lines
    }
    pub fn type_text(text: &str) {
        for chunk in text.encode_utf16().collect::<Vec<u16>>().chunks(20) {
            let mut list = vec![];
            for &u in chunk { list.push(key(0, u, KEYEVENTF_UNICODE)); list.push(key(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)); }
            send(&list);
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
    /// "ctrl+c", "return", "alt+tab"… ("cmd" means Ctrl here, so Mac-style shortcuts work too).
    pub fn press(combo: &str) -> bool {
        let parts: Vec<&str> = combo.split('+').map(str::trim).collect();
        let Some((last, mods)) = parts.split_last() else { return false };
        let mut held = vec![];
        for m in mods {
            held.push(match *m { "cmd" | "command" | "ctrl" | "control" => VK_CONTROL, "shift" => VK_SHIFT, "alt" | "option" => VK_MENU, "win" | "windows" => VK_LWIN, _ => return false });
        }
        let vk: u16 = match *last {
            "return" | "enter" => VK_RETURN, "tab" => VK_TAB, "space" => VK_SPACE, "delete" | "backspace" => VK_BACK, "forwarddelete" | "del" => VK_DELETE,
            "escape" | "esc" => VK_ESCAPE, "left" => VK_LEFT, "right" => VK_RIGHT, "up" => VK_UP, "down" => VK_DOWN,
            "shift" => VK_SHIFT, "ctrl" | "control" | "cmd" | "command" => VK_CONTROL, "alt" | "option" => VK_MENU, "win" | "windows" => VK_LWIN,
            "pageup" => VK_PRIOR, "pagedown" => VK_NEXT, "home" => VK_HOME, "end" => VK_END,
            k if k.len() == 1 && k.as_bytes()[0].is_ascii_alphanumeric() => k.to_ascii_uppercase().as_bytes()[0] as u16,
            k if k.starts_with('f') && k[1..].parse::<u16>().map(|n| (1..=12).contains(&n)).unwrap_or(false) => VK_F1 + k[1..].parse::<u16>().unwrap() - 1,
            _ => return false,
        };
        let mut list: Vec<INPUT> = held.iter().map(|&m| key(m, 0, 0)).collect();
        list.push(key(vk, 0, 0));
        list.push(key(vk, 0, KEYEVENTF_KEYUP));
        list.extend(held.iter().rev().map(|&m| key(m, 0, KEYEVENTF_KEYUP)));
        send(&list);
        true
    }
    pub fn esc_down() -> bool { unsafe { (GetAsyncKeyState(VK_ESCAPE as i32) as u16 & 0x8000) != 0 } }
    /// Asks Windows' accessibility interface whether the field with the keyboard focus is a password field.
    pub fn focused_is_password() -> bool {
        uiautomation::UIAutomation::new().and_then(|a| a.get_focused_element()).and_then(|e| e.is_password()).unwrap_or(false)
    }
    /// An app by name: a Start menu shortcut that matches, else whatever Windows knows by that name (notepad, msedge…).
    pub fn open_app(name: &str) -> bool {
        let want = name.trim_end_matches(".exe").to_lowercase();
        let starts = [dirs::data_dir().map(|d| d.join("Microsoft/Windows/Start Menu/Programs")), std::env::var_os("ProgramData").map(|d| std::path::PathBuf::from(d).join("Microsoft/Windows/Start Menu/Programs"))];
        let mut best: Option<(usize, std::path::PathBuf)> = None;
        for dir in starts.into_iter().flatten() {
            for e in walkdir::WalkDir::new(dir).max_depth(4).into_iter().flatten() {
                let p = e.path();
                if p.extension().map(|x| x != "lnk").unwrap_or(true) { continue; }
                let stem = p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
                if stem.contains("uninstall") || !stem.contains(&want) { continue; }
                let rank = if stem == want { 0 } else if stem.starts_with(&want) { 1 } else { 2 };
                if best.as_ref().map(|(r, _)| rank < *r).unwrap_or(true) { best = Some((rank, p.to_path_buf())); }
            }
        }
        if let Some((_, lnk)) = best { return crate::sys::shell_open(&lnk.to_string_lossy()); }
        let alias = match want.as_str() { "edge" | "microsoft edge" => "msedge", "word" => "winword", "powerpoint" => "powerpnt", "calculator" => "calc", "file explorer" | "explorer" => "explorer", w => w };
        crate::sys::shell_open(alias)
    }
}

#[cfg(not(windows))]
mod imp {
    const NO: &str = "Hands Buddy in this build only works on Windows.";
    pub fn shot() -> Result<(String, u32, u32, f64, i32, i32), String> { Err(NO.into()) }
    pub fn snap(_max_w: u32, _mark: Option<(i32, i32)>) -> Result<(String, u32, u32, f64), String> { Err(NO.into()) }
    pub fn key_hit(_vk: i32) -> bool { false }
    pub fn click(_x: i32, _y: i32, _right: bool, _times: u32) {}
    pub fn scroll(_x: i32, _y: i32, _lines: i32) {}
    pub fn type_text(_text: &str) {}
    pub fn press(_combo: &str) -> bool { false }
    pub fn esc_down() -> bool { false }
    pub fn focused_is_password() -> bool { true }
    pub fn open_app(_name: &str) -> bool { false }
}
