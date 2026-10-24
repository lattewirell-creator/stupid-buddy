// Start Buddy when you log in, so your agents run on time even if you haven't opened him (Settings → Agents).
// Windows: a value under HKCU\…\Run (no administrator needed). Linux: ~/.config/autostart/stupid-buddy.desktop.
#[cfg(windows)]
mod imp {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const NAME: &str = "The Stupid Buddy";
    const NO_WINDOW: u32 = 0x0800_0000;
    fn reg(args: &[&str]) -> bool { Command::new("reg").args(args).creation_flags(NO_WINDOW).output().map(|o| o.status.success()).unwrap_or(false) }
    pub fn get() -> Option<bool> { Some(reg(&["query", KEY, "/v", NAME])) }
    pub fn set(on: bool) -> Result<bool, String> {
        let ok = if on {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            reg(&["add", KEY, "/v", NAME, "/t", "REG_SZ", "/d", &format!("\"{}\"", exe.display()), "/f"])
        } else { !reg(&["query", KEY, "/v", NAME]) || reg(&["delete", KEY, "/v", NAME, "/f"]) };
        if ok { Ok(on) } else { Err("Windows didn’t let Buddy change that.".into()) }
    }
}
#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    fn file() -> Option<std::path::PathBuf> { std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config/autostart/stupid-buddy.desktop")) }
    pub fn get() -> Option<bool> { file().map(|f| f.exists()) }
    pub fn set(on: bool) -> Result<bool, String> {
        let f = file().ok_or("No home folder.")?;
        if on {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(f.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::write(&f, format!("[Desktop Entry]\nType=Application\nName=The Stupid Buddy\nExec=\"{}\"\nIcon=stupid-buddy\nX-GNOME-Autostart-enabled=true\n", exe.display())).map_err(|e| e.to_string())?;
        } else if f.exists() { std::fs::remove_file(&f).map_err(|e| e.to_string())?; }
        Ok(on)
    }
}
#[cfg(target_os = "macos")]
mod imp {
    pub fn get() -> Option<bool> { None }
    pub fn set(_on: bool) -> Result<bool, String> { Err("Not on this computer.".into()) }
}
pub use imp::{get, set};
