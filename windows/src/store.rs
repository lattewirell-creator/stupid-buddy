// Settings and AI keys for Windows and Linux (the Mac app's UserDefaults and Keychain): settings.json in
// %APPDATA%\The Stupid Buddy (Windows) or ~/.config/The Stupid Buddy (Linux). On Windows each key is
// keys\<provider>.bin sealed with Windows' per-user data protection (DPAPI), so only this Windows account can read
// it; on Linux keys live in the Secret Service (GNOME Keyring), never in a file. Keys never reach the web page.
use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;

pub fn base() -> PathBuf {
    let root = std::env::var_os("STUPID_BUDDY_DATA").map(PathBuf::from)
        .unwrap_or_else(|| dirs::config_dir().unwrap_or_default().join("The Stupid Buddy"));
    fs::create_dir_all(&root).ok();
    root
}
/// Write via a temporary file and rename, so a crash never leaves half a file.
fn atomic_write(path: &PathBuf, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path)
}

pub fn settings() -> Map<String, Value> {
    fs::read(base().join("settings.json")).ok().and_then(|d| serde_json::from_slice(&d).ok()).unwrap_or_default()
}
pub fn get(key: &str) -> Option<Value> { settings().get(key).cloned() }
pub fn set(key: &str, value: Value) {
    let mut s = settings();
    s.insert(key.into(), value);
    let _ = atomic_write(&base().join("settings.json"), &serde_json::to_vec_pretty(&s).unwrap_or_default());
}

/* ---------------- AI keys ---------------- */
#[cfg(windows)]
fn key_path(provider: &str) -> PathBuf {
    let dir = base().join("keys");
    fs::create_dir_all(&dir).ok();
    dir.join(format!("{provider}.bin"))
}
#[cfg(windows)]
pub fn save_key(provider: &str, key: &str) -> Result<(), String> {
    let sealed = dpapi(key.as_bytes(), true).ok_or("Windows couldn’t lock the key away, so it wasn’t saved.")?;
    atomic_write(&key_path(provider), &sealed).map_err(|_| "The key couldn’t be saved.".to_string())
}
#[cfg(windows)]
pub fn load_key(provider: &str) -> Option<String> {
    String::from_utf8(dpapi(&fs::read(key_path(provider)).ok()?, false)?).ok()
}
#[cfg(windows)]
pub fn remove_key(provider: &str) -> bool { fs::remove_file(key_path(provider)).is_ok() }
#[cfg(windows)]
fn dpapi(data: &[u8], seal: bool) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        if seal { CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
        else { CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
    };
    if ok == 0 || output.pbData.is_null() { return None; }
    let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as _) };
    Some(result)
}

// Linux: one Secret Service item per provider ("stupid-buddy" / provider), encrypted on its way over D-Bus. With
// no keyring running, keys aren't saved at all (and the page says why).
#[cfg(target_os = "linux")]
fn entry(provider: &str) -> Result<keyring::Entry, keyring::Error> { keyring::Entry::new("stupid-buddy", provider) }
#[cfg(target_os = "linux")]
pub fn save_key(provider: &str, key: &str) -> Result<(), String> {
    entry(provider).and_then(|e| e.set_password(key))
        .map_err(|_| "Buddy keeps keys only in your system’s keyring, and it couldn’t reach one. Is GNOME Keyring (or another Secret Service) running and unlocked?".into())
}
#[cfg(target_os = "linux")]
pub fn load_key(provider: &str) -> Option<String> { entry(provider).and_then(|e| e.get_password()).ok() }
#[cfg(target_os = "linux")]
pub fn remove_key(provider: &str) -> bool { entry(provider).and_then(|e| e.delete_credential()).is_ok() }

#[cfg(all(test, target_os = "linux"))]
mod tests {
    // Needs a Secret Service on the session bus (e.g. gnome-keyring-daemon): cargo test -- --ignored
    #[test]
    #[ignore]
    fn keyring_round_trip() {
        super::save_key("selftest", "sk-test-1234567890").unwrap();
        assert_eq!(super::load_key("selftest").as_deref(), Some("sk-test-1234567890"));
        assert!(super::remove_key("selftest"));
        assert!(super::load_key("selftest").is_none());
    }
}
