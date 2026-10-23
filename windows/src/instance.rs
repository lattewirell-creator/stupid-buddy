// One Buddy at a time on Linux, and summoning it from anywhere: the running Buddy listens on a small socket in
// $XDG_RUNTIME_DIR (only you can reach it). `stupid-buddy --summon` (a keyboard shortcut, say Super+Space) hands
// "summon" to it and quits; Buddy opens, ready to type ("summon voice" with --voice: ready to listen).
// Starting Buddy again from the app grid opens it the same way; `--background` (login) only makes sure it runs.
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

fn socket() -> PathBuf {
    match dirs::runtime_dir() {
        Some(dir) => dir.join("stupid-buddy.sock"),
        None => std::env::temp_dir().join(format!("stupid-buddy-{}.sock", unsafe { libc::getuid() })),
    }
}

/// What this start asks for, from its arguments: "summon", "summon voice", "background" or "show" (a plain start).
pub fn wish(args: &[String]) -> String {
    let has = |a: &str| args.iter().any(|x| x == a);
    if has("--summon") || has("--voice") { if has("--voice") { "summon voice".into() } else { "summon".into() } }
    else if has("--background") { "background".into() } else { "show".into() }
}

/// If Buddy already runs, hands it the wish (with the desktop's startup id, so it may take the focus) and returns
/// true: this copy should quit.
pub fn hand_over(wish: &str) -> bool {
    let Ok(mut s) = UnixStream::connect(socket()) else { return false };
    let id = std::env::var("DESKTOP_STARTUP_ID").unwrap_or_default();
    s.write_all(format!("{wish} {id}\n").as_bytes()).is_ok()
}

/// Listens for later starts; on(wish, startup id) runs on a listener thread for each one.
pub fn listen(on: impl Fn(String, String) + Send + 'static) {
    let path = socket();
    let _ = std::fs::remove_file(&path);   // left over from a Buddy that didn't quit cleanly (hand_over found no one)
    let Ok(listener) = UnixListener::bind(&path) else { crate::log("Couldn’t open the summon socket."); return };
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut line = String::new();
            let _ = stream.take(512).read_to_string(&mut line);
            let mut words = line.trim().splitn(2, ' ');
            let wish = words.next().unwrap_or("show");
            let rest = words.next().unwrap_or("").trim();
            let (wish, id) = if wish == "summon" && rest.starts_with("voice") { ("summon voice".to_string(), rest[5..].trim().to_string()) } else { (wish.to_string(), rest.to_string()) };
            on(wish, id);
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn wishes() {
        let w = |a: &[&str]| super::wish(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(w(&["--summon"]), "summon");
        assert_eq!(w(&["--summon", "--voice"]), "summon voice");
        assert_eq!(w(&["--background"]), "background");
        assert_eq!(w(&[]), "show");
    }
}
