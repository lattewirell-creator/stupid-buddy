// Settings and AI keys for the Windows version (the Mac app's UserDefaults and Keychain):
// %APPDATA%\The Stupid Buddy\settings.json, and keys\<provider>.bin sealed with Windows' per-user data
// protection (DPAPI), so only this Windows account can read them. Keys never reach the web page.
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
fn key_path(provider: &str) -> PathBuf {
    let dir = base().join("keys");
    fs::create_dir_all(&dir).ok();
    dir.join(format!("{provider}.bin"))
}
pub fn save_key(provider: &str, key: &str) -> bool {
    match protect(key.as_bytes()) { Some(sealed) => atomic_write(&key_path(provider), &sealed).is_ok(), None => false }
}
pub fn load_key(provider: &str) -> Option<String> {
    String::from_utf8(unprotect(&fs::read(key_path(provider)).ok()?)?).ok()
}
pub fn remove_key(provider: &str) -> bool { fs::remove_file(key_path(provider)).is_ok() }

#[cfg(windows)]
fn protect(data: &[u8]) -> Option<Vec<u8>> { dpapi(data, true) }
#[cfg(windows)]
fn unprotect(data: &[u8]) -> Option<Vec<u8>> { dpapi(data, false) }
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
// Development builds on a Mac (checking the code compiles): plain files.
#[cfg(not(windows))]
fn protect(data: &[u8]) -> Option<Vec<u8>> { Some(data.to_vec()) }
#[cfg(not(windows))]
fn unprotect(data: &[u8]) -> Option<Vec<u8>> { Some(data.to_vec()) }
