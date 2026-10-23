// Talking to Buddy on Linux. WebKitGTK has no speech recognition, so the app records you itself: PipeWire's
// pw-record (or parec, or arecord) streams 16 kHz mono sound, which stops when you stop talking (a short silence),
// press the mic again, or after 30 seconds. The recording goes to the AI service you picked, if it can listen:
// Groq's Whisper (it hears which language you speak, Swedish and English alike) or Gemini. Answers can be read
// aloud with speech-dispatcher (spd-say); speak() is the one place to plug in a better voice later.
// Runs on worker threads.
use crate::store;
use base64::Engine;
use serde_json::{json, Value};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const RATE: u32 = 16_000;
/// Stop now (the mic button pressed again or let go).
static STOP: AtomicBool = AtomicBool::new(false);
/// Only one recording at a time.
static BUSY: Mutex<()> = Mutex::new(());

/// Which AI services can turn speech into text.
pub fn can_listen(provider: &str) -> bool { matches!(provider, "groq" | "gemini") }
pub fn stop() { STOP.store(true, Ordering::SeqCst); }

/// Records until you stop, then returns what you said. level(0–1) is called about ten times a second (the mic
/// button glows with it).
pub fn listen(provider: &str, level: impl Fn(f64)) -> Result<String, String> {
    if !can_listen(provider) { return Err("nostt".into()); }
    let Some(key) = store::load_key(provider) else { return Err("nokey".into()) };
    let Ok(_one) = BUSY.try_lock() else { return Err("I’m already listening.".into()) };
    STOP.store(false, Ordering::SeqCst);
    let pcm = record(level)?;
    transcribe(provider, &key, &wav(&pcm))
}

/// The first recorder that's installed, writing raw 16-bit 16 kHz mono sound to its output.
/// STUPID_BUDDY_RECORDER="command args…" replaces it (for testing with a sound file).
fn recorder() -> Option<Command> {
    if let Ok(custom) = std::env::var("STUPID_BUDDY_RECORDER") {
        let mut parts = custom.split_whitespace();
        let mut c = Command::new(parts.next()?);
        c.args(parts);
        return Some(c);
    }
    let have = |cmd: &str| std::env::var_os("PATH").map(|p| std::env::split_paths(&p).any(|d| d.join(cmd).is_file())).unwrap_or(false);
    let (cmd, args): (&str, &[&str]) = if have("pw-record") { ("pw-record", &["--rate", "16000", "--channels", "1", "--format", "s16", "--media-role", "Communication", "-"]) }
        else if have("parec") { ("parec", &["--format=s16le", "--rate=16000", "--channels=1"]) }
        else if have("arecord") { ("arecord", &["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw"]) }
        else { return None };
    let mut c = Command::new(cmd);
    c.args(args);
    Some(c)
}

/// Raw samples until a stop: you pressed the button, 1.5 s of quiet after you spoke, 8 s of only quiet, or 30 s.
fn record(level: impl Fn(f64)) -> Result<Vec<i16>, String> {
    let mut child = recorder().ok_or("I can’t find a way to record here (pw-record, parec or arecord).")?
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| "The microphone recorder didn’t start.".to_string())?;
    let mut out = child.stdout.take().ok_or("no sound")?;
    let (mut pcm, mut buf, mut pending) = (Vec::<i16>::new(), vec![0u8; 3200], Vec::<u8>::new());   // 0.1 s per read
    let (start, mut heard, mut quiet_since, mut floor, mut header_checked) = (Instant::now(), false, Instant::now(), 0.0f64, false);
    loop {
        if STOP.load(Ordering::SeqCst) { break; }
        let n = match out.read(&mut buf) { Ok(0) | Err(_) => break, Ok(n) => n };
        pending.extend_from_slice(&buf[..n]);
        // Some recorders write a WAV header first: skip to the sound.
        if !header_checked {
            if pending.len() < 12 { continue; }
            if pending.starts_with(b"RIFF") {
                let Some(at) = pending.windows(4).position(|w| w == b"data") else { continue };
                if pending.len() < at + 8 { continue; }
                pending.drain(..at + 8);
            }
            header_checked = true;
        }
        let whole = pending.len() / 2 * 2;
        let chunk: Vec<i16> = pending[..whole].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        pending.drain(..whole);
        let rms = (chunk.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / chunk.len().max(1) as f64).sqrt() / 32768.0;
        pcm.extend_from_slice(&chunk);
        level((rms * 8.0).min(1.0));
        // The room's own noise in the first moments sets what counts as talking.
        if start.elapsed() < Duration::from_millis(300) { floor = floor.max(rms); continue; }
        let loud = rms > (floor * 2.5).max(0.012);
        if loud { heard = true; quiet_since = Instant::now(); }
        if heard && quiet_since.elapsed() > Duration::from_millis(1500) { break; }
        if !heard && start.elapsed() > Duration::from_secs(8) { break; }
        if start.elapsed() > Duration::from_secs(30) { break; }
    }
    let _ = child.kill();
    let _ = child.wait();
    level(0.0);
    if STOP.load(Ordering::SeqCst) && pcm.len() < RATE as usize / 2 { return Err("stopped".into()); }
    if !heard { return Err("I didn’t hear anything. Is the microphone on?".into()); }
    Ok(pcm)
}

/// A WAV file around the samples.
fn wav(pcm: &[i16]) -> Vec<u8> {
    let data = (pcm.len() * 2) as u32;
    let mut w = Vec::with_capacity(44 + data as usize);
    for part in [&b"RIFF"[..], &(36 + data).to_le_bytes(), b"WAVEfmt ", &16u32.to_le_bytes(), &1u16.to_le_bytes(), &1u16.to_le_bytes(),
        &RATE.to_le_bytes(), &(RATE * 2).to_le_bytes(), &2u16.to_le_bytes(), &16u16.to_le_bytes(), b"data", &data.to_le_bytes()] { w.extend_from_slice(part); }
    for s in pcm { w.extend_from_slice(&s.to_le_bytes()); }
    w
}

fn transcribe(provider: &str, key: &str, wav: &[u8]) -> Result<String, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(60))).build().into();
    let (status, body) = match provider {
        // Whisper: no language given, so it hears which one you speak.
        "groq" => {
            let (ty, form) = multipart(&[("model", None, b"whisper-large-v3-turbo"), ("response_format", None, b"json"), ("file", Some("speech.wav"), wav)]);
            let r = agent.post("https://api.groq.com/openai/v1/audio/transcriptions").header("Authorization", &format!("Bearer {key}")).header("Content-Type", &ty).send(&form[..]);
            read(r)?
        }
        // Gemini listens to sound sent along with a message.
        _ => {
            let audio = base64::engine::general_purpose::STANDARD.encode(wav);
            let req = json!({ "model": "gemini-2.5-flash", "messages": [{ "role": "user", "content": [
                { "type": "text", "text": "Write down exactly what is said in this recording, in the language it is spoken in. Reply with only those words." },
                { "type": "input_audio", "input_audio": { "data": audio, "format": "wav" } } ] }] });
            let r = agent.post("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions").header("Authorization", &format!("Bearer {key}")).header("Content-Type", "application/json").send(req.to_string().as_bytes());
            read(r)?
        }
    };
    if status == 401 || status == 403 { return Err("badkey".into()); }
    if status == 429 { return Err("ratelimit".into()); }
    let v: Value = serde_json::from_str(&body).map_err(|_| "I couldn’t understand that. Try again?".to_string())?;
    let text = v["text"].as_str().or(v["choices"][0]["message"]["content"].as_str()).unwrap_or("").trim().to_string();
    if status >= 400 || text.is_empty() { return Err("I couldn’t make out the words. Try again?".into()); }
    Ok(text)
}
fn read(r: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Result<(u16, String), String> {
    let r = r.map_err(|_| "offline".to_string())?;
    let status = r.status().as_u16();
    Ok((status, r.into_body().read_to_string().map_err(|_| "offline".to_string())?))
}
/// A multipart/form-data body: (field, file name, contents). Returns (content type, body).
fn multipart(parts: &[(&str, Option<&str>, &[u8])]) -> (String, Vec<u8>) {
    let boundary = format!("buddy{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(7));
    let mut body = Vec::new();
    for (name, file, data) in parts {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"").as_bytes());
        if let Some(f) = file { body.extend_from_slice(format!("; filename=\"{f}\"\r\nContent-Type: audio/wav").as_bytes()); }
        body.extend_from_slice(b"\r\n\r\n");
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

/// Reads text aloud (cutting off anything still being read). Swedish text gets a Swedish voice.
/// Swap this for a better local voice later; nothing else needs to change.
pub fn speak(text: &str) -> Result<Value, String> {
    let have = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).any(|d| d.join("spd-say").is_file())).unwrap_or(false);
    if !have { return Err("Reading aloud needs speech-dispatcher (spd-say).".into()); }
    let text = say_text(text);
    let lang = language(&text);
    if std::env::var_os("STUPID_BUDDY_DRYRUN").is_some() { crate::log(&format!("RUN spd-say -C ; spd-say -l {lang} -- {text}")); return Ok(json!(true)); }
    let _ = Command::new("spd-say").arg("-C").status();
    let mut child = Command::new("spd-say").args(["-l", lang, "--", &text]).spawn().map_err(|_| "spd-say didn’t start.".to_string())?;
    std::thread::spawn(move || child.wait());
    Ok(json!(true))
}
/// The answer as it should sound: no Markdown marks, and only its first ~400 characters (whole sentences).
fn say_text(md: &str) -> String {
    let mut plain = String::new();
    for line in md.lines().map(|l| l.trim_start_matches(|c: char| "#-*•>".contains(c) || c.is_whitespace()).replace(['*', '`', '_'], "")).filter(|l| !l.trim().is_empty()) {
        if !plain.is_empty() { if !plain.ends_with(['.', '!', '?', ':']) { plain.push('.'); } plain.push(' '); }
        plain.push_str(line.trim());
    }
    if plain.chars().count() <= 400 { return plain; }
    let cut: String = plain.chars().take(400).collect();
    match cut.rfind(['.', '!', '?']) { Some(i) if i > 80 => cut[..=i].to_string(), _ => cut }
}
fn language(text: &str) -> &'static str {
    let t = format!(" {} ", text.to_lowercase());
    let swedish = t.contains(['å', 'ä', 'ö']) || [" och ", " jag ", " det ", " är ", " inte ", " du ", " en ", " att "].iter().filter(|w| t.contains(*w)).count() >= 2;
    if swedish { "sv" } else { "en" }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wav_header() {
        let w = wav(&[0, 1, -1]);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(&w[36..40], b"data");
        assert_eq!(u32::from_le_bytes([w[40], w[41], w[42], w[43]]), 6);
        assert_eq!(w.len(), 50);
    }
    #[test]
    fn form() {
        let (ty, body) = multipart(&[("model", None, b"whisper"), ("file", Some("a.wav"), b"RIFF")]);
        let b = String::from_utf8_lossy(&body);
        let boundary = ty.split("boundary=").nth(1).unwrap();
        assert!(b.contains("name=\"model\"\r\n\r\nwhisper\r\n"));
        assert!(b.contains("filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n"));
        assert!(b.ends_with(&format!("--{boundary}--\r\n")));
    }
    /// A pretend microphone: half a second of quiet, a second of tone, then quiet until stopped. Recording should
    /// stop by itself about 1.5 s after the tone.
    #[test]
    fn stops_after_talking() {
        let dir = std::env::temp_dir().join(format!("buddy-voice-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tone: Vec<u8> = (0..16_000).flat_map(|i| (((i as f64 * 0.06).sin() * 9000.0) as i16).to_le_bytes()).collect();
        std::fs::write(dir.join("tone.raw"), tone).unwrap();
        let script = dir.join("mic.sh");
        std::fs::write(&script, format!("#!/bin/sh\nfor i in 1 2 3 4 5; do head -c 3200 /dev/zero; sleep 0.1; done\ncat '{}'\nwhile :; do head -c 3200 /dev/zero; sleep 0.1; done\n", dir.join("tone.raw").display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("STUPID_BUDDY_RECORDER", &script);
        let t0 = Instant::now();
        let pcm = record(|_| {}).unwrap();
        assert!(t0.elapsed() < Duration::from_secs(5), "didn't stop by itself");
        assert!(pcm.len() >= 16_000, "lost the tone");
    }
    #[test]
    fn speech() {
        assert_eq!(language("Klart! Jag har satt en timer på fem minuter."), "sv");
        assert_eq!(language("Done! I set a timer for five minutes."), "en");
        assert_eq!(say_text("**Done!**\n- Volume 40%\n- Wi-Fi on"), "Done! Volume 40%. Wi-Fi on");
    }
}
