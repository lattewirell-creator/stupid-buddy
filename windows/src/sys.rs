// Small Windows helpers: the "Can I…?" alert only you can answer, opening things, the screen's work area,
// and hiding Buddy's own windows from screenshots while Hands Buddy looks.
#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }

/// A Windows alert with Yes/No ("No" is the default). The AI can't answer it. Blocks: call it off the main thread.
#[cfg(windows)]
pub fn confirm(title: &str, text: &str, yes: &str) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    let body = format!("{text}\n\nYes = {yes}");
    let r = unsafe { MessageBoxW(std::ptr::null_mut(), wide(&body).as_ptr(), wide(title).as_ptr(), MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2 | MB_TOPMOST | MB_SETFOREGROUND | MB_TASKMODAL) };
    r == IDYES
}
#[cfg(not(windows))]
pub fn confirm(title: &str, text: &str, _yes: &str) -> bool { eprintln!("[confirm] {title}: {text} → no (not Windows)"); false }

/// Opens a file, folder, link or app the way double-clicking it would. No command line is involved.
#[cfg(windows)]
pub fn shell_open(target: &str) -> bool {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let r = unsafe { ShellExecuteW(std::ptr::null_mut(), wide("open").as_ptr(), wide(target).as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
    r as isize > 32
}
#[cfg(not(windows))]
pub fn shell_open(target: &str) -> bool { std::process::Command::new("open").arg(target).status().map(|s| s.success()).unwrap_or(false) }

/// The usable part of the screen the window is on (without the taskbar), in physical pixels: (left, top, right, bottom).
#[cfg(windows)]
pub fn work_area(hwnd: isize) -> (i32, i32, i32, i32) {
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    unsafe {
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        let m = MonitorFromWindow(hwnd as _, MONITOR_DEFAULTTONEAREST);
        if GetMonitorInfoW(m, &mut info) == 0 { return (0, 0, 1920, 1040); }
        (info.rcWork.left, info.rcWork.top, info.rcWork.right, info.rcWork.bottom)
    }
}
#[cfg(not(windows))]
pub fn work_area(_hwnd: isize) -> (i32, i32, i32, i32) { (0, 25, 1440, 900) }

/// Leave this window out of screenshots (true) or show it again (false).
#[cfg(windows)]
pub fn hide_from_capture(hwnd: isize, hide: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE};
    unsafe { SetWindowDisplayAffinity(hwnd as _, if hide { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE }); }
}
#[cfg(not(windows))]
pub fn hide_from_capture(_hwnd: isize, _hide: bool) {}

/// Moves and resizes a window in one step (no in-between frame where it has the new size at the old place).
#[cfg(windows)]
pub fn set_frame(hwnd: isize, x: i32, y: i32, w: i32, h: i32) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
    unsafe { SetWindowPos(hwnd as _, std::ptr::null_mut(), x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE) != 0 }
}
#[cfg(not(windows))]
pub fn set_frame(_hwnd: isize, _x: i32, _y: i32, _w: i32, _h: i32) -> bool { false }

/// Where the mouse pointer is on the screen (physical pixels).
#[cfg(windows)]
pub fn cursor() -> Option<(i32, i32)> {
    let mut p = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
    (unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut p) } != 0).then_some((p.x, p.y))
}
#[cfg(not(windows))]
pub fn cursor() -> Option<(i32, i32)> { None }

#[cfg(windows)]
pub fn hwnd(w: &tao::window::Window) -> isize { use tao::platform::windows::WindowExtWindows; w.hwnd() }
#[cfg(not(windows))]
pub fn hwnd(_w: &tao::window::Window) -> isize { 0 }
