// Small system helpers for Windows and Linux: the "Can I…?" alert only you can answer, opening things, the screen's
// work area, and hiding Buddy's own windows from screenshots while Hands Buddy looks (Windows only).
use tao::window::Window;

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }
#[cfg(windows)]
fn hwnd(w: &Window) -> isize { use tao::platform::windows::WindowExtWindows; w.hwnd() }

/// A Windows alert with Yes/No ("No" is the default). The AI can't answer it. Blocks: call it off the main thread.
#[cfg(windows)]
pub fn confirm(title: &str, text: &str, yes: &str) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    let body = format!("{text}\n\nYes = {yes}");
    let r = unsafe { MessageBoxW(std::ptr::null_mut(), wide(&body).as_ptr(), wide(title).as_ptr(), MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2 | MB_TOPMOST | MB_SETFOREGROUND | MB_TASKMODAL) };
    r == IDYES
}
/// A GTK alert with No (the default) and a button that says what you allow. GTK lives on the main thread, so the
/// alert is shown there and this waits for your answer. Blocks: call it off the main thread.
#[cfg(target_os = "linux")]
pub fn confirm(title: &str, text: &str, yes: &str) -> bool {
    use gtk::prelude::*;
    let (title, text, yes) = (title.to_string(), text.to_string(), yes.to_string());
    let (tx, rx) = std::sync::mpsc::channel();
    gtk::glib::MainContext::default().invoke(move || {
        let d = gtk::MessageDialog::new(None::<&gtk::Window>, gtk::DialogFlags::MODAL, gtk::MessageType::Question, gtk::ButtonsType::None, &title);
        d.set_title("The Stupid Buddy");
        d.set_secondary_text(Some(&text));
        d.add_button("No", gtk::ResponseType::No);
        d.add_button(&yes, gtk::ResponseType::Yes);
        d.set_default_response(gtk::ResponseType::No);
        d.set_keep_above(true);
        let answer = d.run() == gtk::ResponseType::Yes;
        d.close();
        let _ = tx.send(answer);
    });
    rx.recv().unwrap_or(false)
}

/// Opens a file, folder, link or app the way double-clicking it would. No command line is involved.
#[cfg(windows)]
pub fn shell_open(target: &str) -> bool {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let r = unsafe { ShellExecuteW(std::ptr::null_mut(), wide("open").as_ptr(), wide(target).as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
    r as isize > 32
}
/// Opens a file, folder or link with its usual app (xdg-open, no shell in between).
#[cfg(target_os = "linux")]
pub fn shell_open(target: &str) -> bool {
    match std::process::Command::new("xdg-open").arg(target).spawn() {
        Ok(mut child) => { std::thread::spawn(move || child.wait()); true }
        Err(_) => false,
    }
}

/// Shows a file selected in its folder.
#[cfg(windows)]
pub fn reveal(p: &std::path::Path) { let _ = std::process::Command::new("explorer").arg(format!("/select,{}", p.display())).spawn(); }
/// Shows a file selected in its folder (the file manager's FileManager1 interface, which Files on GNOME has),
/// else just opens the folder.
#[cfg(target_os = "linux")]
pub fn reveal(p: &std::path::Path) {
    use gtk::gio::{self, prelude::*};
    use gtk::glib::ToVariant;
    let uri = gio::File::for_path(p).uri().to_string();
    let shown = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE).and_then(|bus| bus.call_sync(
        Some("org.freedesktop.FileManager1"), "/org/freedesktop/FileManager1", "org.freedesktop.FileManager1", "ShowItems",
        Some(&(vec![uri], "").to_variant()), None, gio::DBusCallFlags::NONE, 3000, gio::Cancellable::NONE)).is_ok();
    if !shown { shell_open(&p.parent().unwrap_or(p).to_string_lossy()); }
}

/// The usable part of the screen the window is on (without the taskbar), in physical pixels: (left, top, right, bottom).
#[cfg(windows)]
pub fn work_area(w: &Window) -> (i32, i32, i32, i32) {
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    unsafe {
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        let m = MonitorFromWindow(hwnd(w) as _, MONITOR_DEFAULTTONEAREST);
        if GetMonitorInfoW(m, &mut info) == 0 { return (0, 0, 1920, 1040); }
        (info.rcWork.left, info.rcWork.top, info.rcWork.right, info.rcWork.bottom)
    }
}
/// The usable part of the screen the window is on (without GNOME's top bar and dock), in physical pixels.
#[cfg(target_os = "linux")]
pub fn work_area(w: &Window) -> (i32, i32, i32, i32) {
    use gtk::prelude::*;
    use tao::platform::unix::WindowExtUnix;
    let gw = w.gtk_window();
    let display = gw.display();
    let monitor = gw.window().and_then(|g| display.monitor_at_window(&g)).or_else(|| display.primary_monitor()).or_else(|| display.monitor(0));
    let Some(m) = monitor else { return (0, 0, 1920, 1040) };
    let (r, s) = (m.workarea(), m.scale_factor());
    (r.x() * s, r.y() * s, (r.x() + r.width()) * s, (r.y() + r.height()) * s)
}

/// Leave this window out of screenshots (true) or show it again (false).
#[cfg(windows)]
pub fn hide_from_capture(w: &Window, hide: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE};
    unsafe { SetWindowDisplayAffinity(hwnd(w) as _, if hide { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE }); }
}
#[cfg(target_os = "linux")]
pub fn hide_from_capture(_w: &Window, _hide: bool) {}   // only Hands Buddy needs it, and it isn't on Linux yet

/// Moves and resizes a window in one step (no in-between frame where it has the new size at the old place).
#[cfg(windows)]
pub fn set_frame(w: &Window, x: i32, y: i32, width: i32, height: i32) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
    unsafe { SetWindowPos(hwnd(w) as _, std::ptr::null_mut(), x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE) != 0 }
}
#[cfg(target_os = "linux")]
pub fn set_frame(_w: &Window, _x: i32, _y: i32, _width: i32, _height: i32) -> bool { false }   // main.rs sizes, then moves

/// Where the mouse pointer is on the screen (physical pixels). Main thread only (GTK).
#[cfg(windows)]
pub fn cursor(_w: &Window) -> Option<(i32, i32)> {
    let mut p = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
    (unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut p) } != 0).then_some((p.x, p.y))
}
#[cfg(target_os = "linux")]
pub fn cursor(w: &Window) -> Option<(i32, i32)> { w.cursor_position().ok().map(|p| (p.x.round() as i32, p.y.round() as i32)) }

/// Buddy is a small window that floats where you put it, and only X11 lets an app place its own windows and keep
/// them on top: on Wayland (GNOME's default) the ball couldn't be dragged, thrown or remembered. So GTK opens
/// Buddy through XWayland, which GNOME always runs, and falls back to Wayland if there's no X at all. Set before
/// GTK starts; a GDK_BACKEND you set yourself still wins. Apps Buddy opens aren't affected (no variable is set).
#[cfg(target_os = "linux")]
pub fn prefer_x11() {
    if std::env::var_os("GDK_BACKEND").is_none() { gtk::gdk::set_allowed_backends("x11,wayland"); }
}
