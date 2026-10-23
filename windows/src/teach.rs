// Teach Buddy a task (Windows; ui/agents.js turns the recording into a skill). While you do the task once, Buddy notes
// each click: what was under the pointer and in which window, with a small screenshot that rings the spot. When you
// stop typing for a moment it takes a screenshot too. The keys themselves are never recorded, and nothing is kept of a
// password field but the fact that you typed in one. Esc (or Stop) ends it; so does the 24th step.
use crate::hands;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MAX_STEPS: usize = 24;
const SHOT_WIDTH: u32 = 800;

#[derive(Clone, Default)]
pub struct Recorder { pub on: Arc<AtomicBool> }

impl Recorder {
    /// Starts watching on a worker thread; `done` gets the steps when it ends (Esc, `stop`, or MAX_STEPS).
    pub fn start(&self, done: impl FnOnce(Vec<Value>) + Send + 'static) -> Result<(), String> {
        if self.on.swap(true, Ordering::SeqCst) { return Err("Buddy is already watching.".into()); }
        let on = self.on.clone();
        std::thread::spawn(move || done(watch(&on)));
        Ok(())
    }
    pub fn stop(&self) { self.on.store(false, Ordering::SeqCst); }
}

fn watch(on: &AtomicBool) -> Vec<Value> {
    let t0 = Instant::now();
    let mut steps: Vec<Value> = vec![];
    let (mut left, mut right) = (false, false);
    // A burst of typing: when it was last active, and where it went, noted at its first key (by the time it ends
    // focus may have moved on, e.g. Tab or the click on Sign in). A password anywhere in it leaves no picture.
    let mut typing: Option<Burst> = None;
    let swapped = imp::buttons_swapped();
    // Clear the "pressed since last time" bits from before we started (the click on Teach, the Esc of a dialog).
    for vk in 1..255 { hands::key_hit(vk); }
    std::thread::sleep(Duration::from_millis(400));
    for vk in 1..255 { hands::key_hit(vk); }
    while on.load(Ordering::SeqCst) && steps.len() < MAX_STEPS {
        std::thread::sleep(Duration::from_millis(30));
        if hands::key_hit(0x1B) { break; }   // Esc
        let at = t0.elapsed().as_millis() as u64;
        let (l, r) = (hands::key_hit(0x01), hands::key_hit(0x02));
        let pressed = (l && !left) || (r && !right);
        let physical_right = r && !right;
        let button = if physical_right != swapped { "right" } else { "left" };   // left-handed mouse: the buttons are swapped
        left = l; right = r;
        if pressed {
            let after_password = typing.as_ref().map(|b| b.password).unwrap_or(false);
            if let Some(b) = typing.take() { steps.push(typed(at, b)); }
            let (x, y) = crate::sys::screen_cursor().unwrap_or((0, 0));
            let (what, window) = (imp::element_at(x, y), imp::window_title());
            // No picture right after a password, or of a click on another screen (only the main one is captured).
            let image = if after_password || !imp::on_main_screen(x, y) { String::new() } else { hands::snap(SHOT_WIDTH, Some((x, y))).map(|s| s.0).unwrap_or_default() };
            steps.push(json!({ "kind": "click", "button": button, "what": what, "window": window, "at": at, "image": image }));
            continue;
        }
        // Typing: any key other than the mouse buttons and the modifiers on their own.
        let keyed = (0x08..0xFF).filter(|vk| !matches!(vk, 0x10..=0x12 | 0x14 | 0x1B | 0x5B | 0x5C | 0xA0..=0xA5)).any(hands::key_hit);
        if keyed {
            match typing.as_mut() {
                // Asking Windows about the focused field is heavy, so while typing it's checked at most every 150 ms.
                Some(b) => { b.last = Instant::now(); if b.checked.elapsed() > Duration::from_millis(150) { b.password |= hands::focused_is_password(); b.checked = Instant::now(); } }
                None => typing = Some(Burst { last: Instant::now(), checked: Instant::now(), password: hands::focused_is_password(), what: imp::focused_name(), window: imp::window_title() }),
            }
        } else if typing.as_ref().map(|b| b.last.elapsed() > Duration::from_millis(1200)).unwrap_or(false) {
            steps.push(typed(at, typing.take().unwrap()));
        }
    }
    // Typing right before Esc still counts.
    if let Some(b) = typing.take() { if steps.len() < MAX_STEPS { steps.push(typed(t0.elapsed().as_millis() as u64, b)); } }
    on.store(false, Ordering::SeqCst);
    steps
}

struct Burst { last: Instant, checked: Instant, password: bool, what: String, window: String }

/// A pause after typing: where it went and what the screen shows now (the field's text, unless it was a password).
fn typed(at: u64, b: Burst) -> Value {
    let password = b.password || hands::focused_is_password();
    let image = if password { String::new() } else { hands::snap(SHOT_WIDTH, None).map(|s| s.0).unwrap_or_default() };
    json!({ "kind": "typed", "what": b.what, "window": b.window, "password": password, "at": at, "image": image })
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetSystemMetrics, GetWindowTextW, SM_CXSCREEN, SM_CYSCREEN, SM_SWAPBUTTON};
    pub fn buttons_swapped() -> bool { unsafe { GetSystemMetrics(SM_SWAPBUTTON) != 0 } }
    pub fn on_main_screen(x: i32, y: i32) -> bool { unsafe { x >= 0 && y >= 0 && x < GetSystemMetrics(SM_CXSCREEN) && y < GetSystemMetrics(SM_CYSCREEN) } }
    fn describe(e: &uiautomation::UIElement) -> String {
        let name = e.get_name().unwrap_or_default();
        let kind = e.get_localized_control_type().unwrap_or_default();
        match (name.trim().is_empty(), kind.trim().is_empty()) {
            (false, false) => format!("{} “{}”", kind.trim(), name.trim().chars().take(80).collect::<String>()),
            (false, true) => format!("“{}”", name.trim().chars().take(80).collect::<String>()),
            (true, false) => kind.trim().to_string(),
            _ => String::new(),
        }
    }
    /// What's under the pointer, as Windows' accessibility interface names it: "button “Send”", "edit “Search”"…
    pub fn element_at(x: i32, y: i32) -> String {
        uiautomation::UIAutomation::new().and_then(|a| a.element_from_point(uiautomation::types::Point::new(x, y))).map(|e| describe(&e)).unwrap_or_default()
    }
    pub fn focused_name() -> String {
        uiautomation::UIAutomation::new().and_then(|a| a.get_focused_element()).map(|e| describe(&e)).unwrap_or_default()
    }
    pub fn window_title() -> String {
        unsafe {
            let w = GetForegroundWindow();
            let mut buf = [0u16; 256];
            let n = GetWindowTextW(w, buf.as_mut_ptr(), buf.len() as i32);
            String::from_utf16_lossy(&buf[..n.max(0) as usize])
        }
    }
}
#[cfg(not(windows))]
mod imp {
    pub fn buttons_swapped() -> bool { false }
    pub fn on_main_screen(_x: i32, _y: i32) -> bool { true }
    pub fn element_at(_x: i32, _y: i32) -> String { String::new() }
    pub fn focused_name() -> String { String::new() }
    pub fn window_title() -> String { String::new() }
}
