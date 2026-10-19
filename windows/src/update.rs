// Updates for the Windows version: checks GitHub Releases at start and every 12 hours (and from Settings →
// Check for updates). When there's a newer Buddy it asks you first, then downloads
// StupidBuddy-<version>-windows-setup.exe and runs it only if its Ed25519 signature (the .sig next to it, made
// with scripts/sign-update.mjs) checks out against the public key built in here. The installer runs quietly and
// starts Buddy again.
use crate::{store, sys};
use base64::Engine;
use serde_json::{json, Value};
use std::io::Read;
use std::time::Duration;

const REPO: &str = "lattewirell-creator/stupid-buddy";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// ~/.stupid-buddy-signing/update-key.pub (its private half signs releases and never leaves the publishing Mac).
const PUBLIC_KEY: &str = "sJ3dQgznhjTGtb9/qzPskN89ZsC/5skjDIFPGSqfxRE=";

/// Is version a newer than b? ("0.8.0" vs "0.7.1")
pub fn newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| v.trim_start_matches('v').split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (x, y) = (parse(a), parse(b));
    for i in 0..x.len().max(y.len()) { let (p, q) = (*x.get(i).unwrap_or(&0), *y.get(i).unwrap_or(&0)); if p != q { return p > q; } }
    false
}
pub fn verify(data: &[u8], signature_b64: &str) -> bool {
    let b64 = base64::engine::general_purpose::STANDARD;
    let (Ok(key), Ok(sig)) = (b64.decode(PUBLIC_KEY), b64.decode(signature_b64.trim())) else { return false };
    let (Ok(key), Ok(sig)) = (<[u8; 32]>::try_from(key.as_slice()), <[u8; 64]>::try_from(sig.as_slice())) else { return false };
    let Ok(key) = ed25519_dalek::VerifyingKey::from_bytes(&key) else { return false };
    key.verify_strict(data, &ed25519_dalek::Signature::from_bytes(&sig)).is_ok()
}

fn agent() -> ureq::Agent { ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(300))).build().into() }
pub struct Found { pub version: String, setup: String, sig: String }
fn latest() -> Option<Found> {
    let mut r = agent().get(&format!("https://api.github.com/repos/{REPO}/releases/latest")).header("User-Agent", "TheStupidBuddy-Updater").header("Accept", "application/vnd.github+json").call().ok()?;
    let rel: Value = serde_json::from_str(&r.body_mut().read_to_string().ok()?).ok()?;
    let version = rel["tag_name"].as_str()?.trim_start_matches('v').to_string();
    let assets = rel["assets"].as_array()?;
    let url = |suffix: &str| assets.iter().find(|a| a["name"].as_str().map(|n| n.ends_with(suffix)).unwrap_or(false)).and_then(|a| a["browser_download_url"].as_str()).map(String::from);
    Some(Found { version, setup: url("-windows-setup.exe")?, sig: url("-windows-setup.exe.sig")? })
}
fn download(url: &str, limit: u64) -> Option<Vec<u8>> {
    if !url.starts_with("https://github.com/") && !url.starts_with("https://objects.githubusercontent.com/") { return None; }
    let r = agent().get(url).header("User-Agent", "TheStupidBuddy-Updater").call().ok()?;
    let mut data = Vec::new();
    r.into_body().into_reader().take(limit).read_to_end(&mut data).ok()?;
    Some(data)
}

/// What a check ended with: Install(path) means the verified installer is saved and should run now.
pub enum Outcome { Install(std::path::PathBuf), Message(String), Quiet }

/// Runs on a worker thread. manual: from Settings (always checks, and says when there's nothing new).
/// current: the version to compare with (VERSION, or an old one in the self-test).
pub fn check(manual: bool, current: &str, dry_run: bool) -> Outcome {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if !manual && now.saturating_sub(store::get("lastUpdateCheck").and_then(|v| v.as_u64()).unwrap_or(0)) < 12 * 3600 { return Outcome::Quiet; }
    store::set("lastUpdateCheck", json!(now));
    let Some(f) = latest() else { return if manual { Outcome::Message("Couldn’t check for updates. Check your connection and try again later.".into()) } else { Outcome::Quiet } };
    if !newer(&f.version, current) { return if manual { Outcome::Message(format!("You have the newest Buddy ({current}).")) } else { Outcome::Quiet }; }
    if !dry_run && (store::get("skipVersion").and_then(|v| v.as_str().map(String::from)).as_deref() == Some(f.version.as_str()) && !manual) { return Outcome::Quiet; }
    if !dry_run && !sys::confirm("Update The Stupid Buddy?", &format!("Buddy {} is out (you have {current}). It downloads now, installs by itself and Buddy starts again in a few seconds. Your settings and keys stay on this PC.", f.version), "Update now") {
        store::set("skipVersion", json!(f.version));   // don't ask again for this version (Settings → Check for updates still can)
        return Outcome::Message("Okay, not now.".into());
    }
    let Some(setup) = download(&f.setup, 200 * 1024 * 1024) else { return Outcome::Message("The update couldn’t be downloaded. Try again later.".into()) };
    let Some(sig) = download(&f.sig, 4096).and_then(|d| String::from_utf8(d).ok()) else { return Outcome::Message("The update’s signature couldn’t be downloaded, so it wasn’t installed.".into()) };
    if !verify(&setup, &sig) { return Outcome::Message("The downloaded update failed its signature check, so it wasn’t installed.".into()); }
    if dry_run { return Outcome::Message(format!("verified {} ({} bytes)", f.version, setup.len())); }
    let path = std::env::temp_dir().join(format!("StupidBuddy-{}-windows-setup.exe", f.version));
    if std::fs::write(&path, &setup).is_err() { return Outcome::Message("The update couldn’t be saved. Check free disk space.".into()); }
    Outcome::Install(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions() { assert!(newer("0.8.0", "0.7.0")); assert!(newer("1.0", "0.9.9")); assert!(!newer("0.7.0", "0.7.0")); assert!(!newer("v0.6.9", "0.7.0")); }
    #[test]
    fn signatures() {
        // Signed with the real release key by scripts/sign-update.mjs.
        let sig = "p+Q99q21kp3bO1MV3vMFROs2VbuaSR3Cbr/rME0ROcvgK5NAdFaWtYVNIL2CaYtS54aTzbWFwfWFrhX88mj7Ag==";
        assert!(verify(b"stupid buddy update test", sig));
        assert!(!verify(b"stupid buddy update test!", sig));
        assert!(!verify(b"stupid buddy update test", "bm9wZQ=="));
    }
}
