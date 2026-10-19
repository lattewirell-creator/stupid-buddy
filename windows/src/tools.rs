// What the helpers can do with files and the web (mac/Sources/Tools.swift). Every path must be inside a folder
// you allowed (Desktop, Documents and Downloads to start); moving, renaming, replacing and deleting ask you first,
// in a Windows alert the AI can't answer. Deleting goes to the Recycle Bin. Everything here runs on a worker thread.
use crate::{store, sys};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

type Out = Result<Value, String>;

fn home() -> PathBuf { dirs::home_dir().unwrap_or_default() }
/// "~/Downloads/a.txt" style, the way the helpers write paths (also on Windows).
pub fn short(p: &Path) -> String {
    let h = home();
    match p.strip_prefix(&h) {
        Ok(rel) if rel.as_os_str().is_empty() => "~".into(),
        Ok(rel) => format!("~/{}", rel.to_string_lossy().replace('\\', "/")),
        Err(_) => p.to_string_lossy().replace('\\', "/"),
    }
}
fn same(a: &Path, b: &Path) -> bool { a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase() }
fn inside(p: &Path, root: &Path) -> bool {
    let (p, r) = (p.to_string_lossy().to_lowercase(), root.to_string_lossy().to_lowercase());
    p == r || p.starts_with(&format!("{}{}", r.trim_end_matches(['\\', '/']), std::path::MAIN_SEPARATOR))
}

/// Folders the helpers may touch.
pub fn roots() -> Vec<PathBuf> {
    let saved: Option<Vec<String>> = store::get("roots").and_then(|v| serde_json::from_value(v).ok());
    let list: Vec<PathBuf> = match saved {
        Some(s) => s.into_iter().map(PathBuf::from).collect(),
        // Known folders, so a Desktop or Documents moved into OneDrive is found too.
        None => [dirs::desktop_dir(), dirs::document_dir(), dirs::download_dir()].into_iter().flatten().collect(),
    };
    list.into_iter().map(|p| dunce::canonicalize(&p).unwrap_or(p)).collect()
}
/// A path the helpers asked for, if it's inside an allowed folder ("~" works, / or \ both work).
fn allowed(raw: Option<&Value>) -> Option<PathBuf> {
    let s = raw?.as_str()?.trim();
    if s.is_empty() || s.contains('\0') { return None; }
    let s = s.replace('\\', "/");
    let p = if let Some(rest) = s.strip_prefix('~') { home().join(rest.trim_start_matches('/')) }
        else if Path::new(&s).is_absolute() { PathBuf::from(&s) } else { home().join(&s) };
    // Resolve "." and ".." by hand, then the real path of the nearest part that exists.
    let mut clean = PathBuf::new();
    for c in p.components() {
        match c { Component::ParentDir => { clean.pop(); } Component::CurDir => {} other => clean.push(other.as_os_str()) }
    }
    let mut existing = clean.clone();
    let mut rest = vec![];
    while !existing.exists() {
        rest.push(existing.file_name()?.to_os_string());
        if !existing.pop() { return None; }
    }
    let mut real = dunce::canonicalize(&existing).ok()?;
    for part in rest.into_iter().rev() { real.push(part); }
    roots().iter().any(|r| inside(&real, r)).then_some(real)
}
fn outside() -> Out {
    Err(format!("That’s outside the folders I’m allowed to use ({}). You can allow more folders in settings.", roots().iter().map(|r| short(r)).collect::<Vec<_>>().join(", ")))
}
/// A path inside the allowed folders that doesn't exist: say so, and list what's really there to help.
fn missing(p: &Path) -> Out {
    let dir = p.parent().unwrap_or(p);
    let names: Vec<String> = fs::read_dir(dir).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| !n.starts_with('.') && n != "desktop.ini").take(40).collect()).unwrap_or_default();
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    Err(format!("There’s no “{name}” in {}.{}", short(dir), if names.is_empty() { String::new() } else { format!(" What’s there: {}", names.join(", ")) }))
}
fn name(p: &Path) -> String { p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default() }
fn said_no() -> Out { Err("You said no, so I didn’t do it.".into()) }
fn str_of<'a>(m: &'a Map<String, Value>, k: &str) -> &'a str { m.get(k).and_then(Value::as_str).unwrap_or("") }

pub fn handle(op: &str, m: &Map<String, Value>) -> Out {
    match op {
        "files.roots" => Ok(json!(roots().iter().map(|r| short(r)).collect::<Vec<_>>())),
        "files.addRoot" => {
            if let Some(dir) = rfd::FileDialog::new().set_title("Choose a folder your helpers may use").pick_folder() {
                let mut list = roots();
                let dir = dunce::canonicalize(&dir).unwrap_or(dir);
                if !list.iter().any(|r| same(r, &dir)) { list.push(dir); }
                store::set("roots", json!(list.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>()));
            }
            Ok(json!(roots().iter().map(|r| short(r)).collect::<Vec<_>>()))
        }
        "files.list" => list(m),
        "files.read" => read(m),
        "files.search" => search(m),
        "files.mkdir" => {
            let Some(p) = allowed(m.get("path")) else { return outside() };
            fs::create_dir_all(&p).map_err(|e| e.to_string())?;
            Ok(json!(format!("Made the folder {}", short(&p))))
        }
        "files.move" => {
            let (Some(from), Some(to0)) = (allowed(m.get("from")), allowed(m.get("to"))) else { return outside() };
            if !from.exists() { return missing(&from); }
            let to = if to0.is_dir() { to0.join(name(&from)) } else { to0 };
            if to.exists() { return Err(format!("{} already exists; I won’t overwrite it.", short(&to))); }
            let rename = from.parent() == to.parent();
            let ok = if rename { sys::confirm(&format!("Rename “{}”?", name(&from)), &format!("New name: {}", name(&to)), "Rename") }
                else { sys::confirm(&format!("Move “{}”?", name(&from)), &format!("From {}\nTo {}", short(from.parent().unwrap_or(&from)), short(to.parent().unwrap_or(&to))), "Move") };
            if !ok { return said_no(); }
            if let Some(parent) = to.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
            fs::rename(&from, &to).map_err(|e| e.to_string())?;
            Ok(json!(format!("Done: {}", short(&to))))
        }
        "files.moveMany" => move_many(m),
        "files.trash" => {
            let Some(p) = allowed(m.get("path")) else { return outside() };
            if !p.exists() { return missing(&p); }
            if !sys::confirm(&format!("Move “{}” to the Recycle Bin?", name(&p)), "You can get it back from the Recycle Bin.", "Move to Recycle Bin") { return said_no(); }
            trash::delete(&p).map_err(|e| e.to_string())?;
            Ok(json!(format!("Moved to the Recycle Bin: {}", name(&p))))
        }
        "files.write" => {
            let Some(p) = allowed(m.get("path")) else { return outside() };
            let text = str_of(m, "text");
            if text.len() >= 5_000_000 { return Err("That’s too much text for one file.".into()); }
            if p.exists() && !sys::confirm(&format!("Replace “{}”?", name(&p)), "It already exists. The old version will be gone.", "Replace") { return said_no(); }
            if let Some(parent) = p.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
            fs::write(&p, text).map_err(|e| e.to_string())?;
            Ok(json!(format!("Saved {}", short(&p))))
        }
        "files.reveal" => {
            let Some(p) = allowed(m.get("path")) else { return outside() };
            let _ = std::process::Command::new("explorer").arg(format!("/select,{}", p.display())).spawn();
            Ok(json!(true))
        }
        "files.open" => {
            let Some(p) = allowed(m.get("path")) else { return outside() };
            if !p.exists() { return missing(&p); }
            sys::shell_open(&p.to_string_lossy());
            Ok(json!(format!("Opened {}", name(&p))))
        }
        "web.search" => web_search(m),
        "web.fetch" => web_fetch(m),
        "web.open" => {
            let url = str_of(m, "url");
            if !(url.starts_with("https://") || url.starts_with("http://")) { return Err("bad link".into()); }
            // The Stupid Browser if it's installed, otherwise the usual browser.
            let browser = dirs::data_local_dir().unwrap_or_default().join("Programs").join("The Stupid Browser").join("StupidBrowser.exe");
            if !(browser.exists() && std::process::Command::new(&browser).arg(url).spawn().is_ok()) { sys::shell_open(url); }
            Ok(json!(format!("Opened {}", host(url))))
        }
        "clipboard.write" => {
            arboard::Clipboard::new().and_then(|mut c| c.set_text(str_of(m, "text").to_string())).map_err(|_| "I couldn’t copy that.".to_string())?;
            Ok(json!("Copied"))
        }
        _ => Err(format!("unknown tool {op}")),
    }
}

fn list(m: &Map<String, Value>) -> Out {
    let Some(p) = allowed(m.get("path")) else { return outside() };
    if !p.exists() { return missing(&p); }
    let entries: Vec<_> = fs::read_dir(&p).map_err(|_| format!("I can’t open {}.", short(&p)))?.flatten()
        .filter(|e| { let n = e.file_name().to_string_lossy().to_string(); !n.starts_with('.') && n != "desktop.ini" && !hidden(&e.path()) }).collect();
    let items: Vec<Value> = entries.iter().take(400).map(|e| {
        let md = e.metadata().ok();
        let modified = md.as_ref().and_then(|m| m.modified().ok()).map(date).unwrap_or_default();
        json!({ "name": e.file_name().to_string_lossy(), "folder": md.as_ref().map(|m| m.is_dir()).unwrap_or(false), "size": md.as_ref().map(|m| m.len()).unwrap_or(0), "modified": modified })
    }).collect();
    Ok(json!({ "path": short(&p), "count": entries.len(), "items": items }))
}
#[cfg(windows)]
fn hidden(p: &Path) -> bool { use std::os::windows::fs::MetadataExt; fs::metadata(p).map(|m| m.file_attributes() & 0x6 != 0).unwrap_or(false) }
#[cfg(not(windows))]
fn hidden(_p: &Path) -> bool { false }
/// YYYY-MM-DD from a file time (no date library needed).
fn date(t: std::time::SystemTime) -> String {
    let days = t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0) as i64;
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", yoe + era * 400 + if mo <= 2 { 1 } else { 0 }, mo, d)
}

fn read(m: &Map<String, Value>) -> Out {
    let Some(p) = allowed(m.get("path")) else { return outside() };
    if !p.exists() { return missing(&p); }
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
    if size > 40_000_000 { return Err("That file is too big for me to read.".into()); }
    let text = match ext.as_str() {
        "pdf" => { let path = p.clone(); std::panic::catch_unwind(move || pdf_extract::extract_text(&path).ok()).ok().flatten() }
        "docx" => docx(&p),
        "html" | "htm" => fs::read(&p).ok().map(|d| page_text(&String::from_utf8_lossy(&d))),
        "rtf" => fs::read_to_string(&p).ok().map(|s| plain(&Regex::new(r"\\[a-z]+-?\d* ?|[{}]").unwrap().replace_all(&s, ""))),
        "doc" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "zip" | "exe" | "png" | "jpg" | "jpeg" | "gif" | "mp3" | "mp4" => None,
        _ => fs::read(&p).ok().map(|d| String::from_utf8(d.clone()).unwrap_or_else(|_| d.iter().map(|&b| b as char).collect())),
    };
    let Some(t) = text else { return Err(format!("I can’t read that kind of file ({ext}).")) };
    let cut = t.chars().count() > 60_000;
    Ok(json!({ "path": short(&p), "text": t.chars().take(60_000).collect::<String>(), "cut": cut }))
}
/// The words of a Word document (its text lives in word/document.xml inside the zip).
fn docx(p: &Path) -> Option<String> {
    let mut z = zip::ZipArchive::new(fs::File::open(p).ok()?).ok()?;
    let mut xml = String::new();
    std::io::Read::read_to_string(&mut z.by_name("word/document.xml").ok()?, &mut xml).ok()?;
    let xml = xml.replace("</w:p>", "\n").replace("<w:tab/>", "\t");
    Some(plain(&xml))
}

/// Finds files whose name contains the words, inside the allowed folders.
fn search(m: &Map<String, Value>) -> Out {
    let q = str_of(m, "query").trim().to_lowercase();
    if q.is_empty() || q.len() > 200 { return Err("What should I look for?".into()); }
    let mut out = vec![];
    let mut seen = 0;
    'roots: for r in roots() {
        let walk = walkdir::WalkDir::new(&r).max_depth(8).into_iter()
            .filter_entry(|e| { let n = e.file_name().to_string_lossy(); e.depth() == 0 || !(n.starts_with('.') || n == "node_modules" || n == "$RECYCLE.BIN") });
        for e in walk.flatten() {
            seen += 1;
            if seen > 200_000 { break 'roots; }
            if e.depth() > 0 && e.file_name().to_string_lossy().to_lowercase().contains(&q) {
                out.push(short(e.path()));
                if out.len() >= 60 { break 'roots; }
            }
        }
    }
    Ok(json!(out))
}

/// Several moves at once, asked once ("tidy my Downloads").
fn move_many(m: &Map<String, Value>) -> Out {
    let list = m.get("moves").and_then(Value::as_array).cloned().unwrap_or_default();
    if list.is_empty() || list.len() > 300 { return Err("No moves given.".into()); }
    let mut plan: Vec<(PathBuf, PathBuf)> = vec![];
    for item in &list {
        let (Some(from), Some(to0)) = (allowed(item.get("from")), allowed(item.get("to"))) else { continue };
        if !from.exists() { continue; }
        let looks_like_folder = to0.extension().is_none() && from.extension().is_some();
        let to = if to0.is_dir() || looks_like_folder { to0.join(name(&from)) } else { to0 };
        if !to.exists() { plan.push((from, to)); }
    }
    if plan.is_empty() { return Err("None of those files could be moved (missing, outside allowed folders, or already there).".into()); }
    let mut preview = plan.iter().take(12).map(|(a, b)| format!("• {} → {}", name(a), short(b.parent().unwrap_or(b)))).collect::<Vec<_>>().join("\n");
    if plan.len() > 12 { preview += &format!("\n…and {} more", plan.len() - 12); }
    if !sys::confirm(&format!("Move {} file{}?", plan.len(), if plan.len() == 1 { "" } else { "s" }), &preview, "Move them") { return said_no(); }
    let (mut moved, mut failed) = (0, vec![]);
    for (a, b) in &plan {
        let ok = b.parent().map(|p| fs::create_dir_all(p).is_ok()).unwrap_or(true) && fs::rename(a, b).is_ok();
        if ok { moved += 1 } else { failed.push(name(a)) }
    }
    Ok(json!(format!("Moved {moved} of {}.{}", plan.len(), if failed.is_empty() { String::new() } else { format!(" Couldn’t move: {}", failed.iter().take(5).cloned().collect::<Vec<_>>().join(", ")) })))
}

/* ---------------- web ---------------- */
fn get(url: &str) -> Option<(String, String)> {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(20))).build().into();
    let r = agent.get(url).header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) TheStupidBuddy/0.5").call().ok()?;
    let ty = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let body = r.into_body().with_config().limit(8 * 1024 * 1024).read_to_vec().ok()?;
    Some((String::from_utf8(body.clone()).unwrap_or_else(|_| body.iter().map(|&b| b as char).collect()), ty))
}
fn host(u: &str) -> String { u.split("://").nth(1).unwrap_or(u).split('/').next().unwrap_or(u).trim_start_matches("www.").to_string() }
fn enc(s: &str) -> String { s.bytes().map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") }).collect() }
fn dec(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) { out.push(v); i += 3; continue; }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}
fn capture(pattern: &str, s: &str) -> Option<String> {
    Regex::new(&format!("(?is){pattern}")).ok()?.captures(s)?.get(1).map(|m| m.as_str().to_string())
}
/// DuckDuckGo's plain HTML results: titles, links and snippets.
fn web_search(m: &Map<String, Value>) -> Out {
    let q = str_of(m, "query").trim();
    if q.is_empty() { return Err("What should I search for?".into()); }
    let Some((html, _)) = get(&format!("https://html.duckduckgo.com/html/?q={}", enc(q))) else { return Err("The search didn’t answer. Is the internet on?".into()) };
    let mut results = vec![];
    for b in html.split("class=\"result__body\"").skip(1).take(8) {
        let Some(href) = capture(r#"class="result__a" href="([^"]+)""#, b) else { continue };
        let mut link = href.replace("&amp;", "&");
        if let Some(u) = capture(r"[?&]uddg=([^&]+)", &link) { link = dec(&u); }
        if link.starts_with("//") { link = format!("https:{link}"); }
        results.push(json!({ "title": plain(&capture(r#"class="result__a"[^>]*>(.*?)</a>"#, b).unwrap_or_default()), "url": link,
            "snippet": plain(&capture(r#"class="result__snippet"[^>]*>(.*?)</a>"#, b).unwrap_or_default()) }));
    }
    Ok(json!(results))
}
fn web_fetch(m: &Map<String, Value>) -> Out {
    let url = str_of(m, "url");
    if !(url.starts_with("https://") || url.starts_with("http://")) { return Err("I couldn’t open that page.".into()); }
    let Some((html, ty)) = get(url) else { return Err("I couldn’t open that page.".into()) };
    if !ty.contains("html") { return Ok(json!({ "url": url, "title": "", "text": html.chars().take(30_000).collect::<String>() })); }
    let title = plain(&capture(r"<title[^>]*>(.*?)</title>", &html).unwrap_or_default());
    Ok(json!({ "url": url, "title": title, "text": page_text(&html).chars().take(30_000).collect::<String>() }))
}
/// The readable text of a web page.
fn page_text(html: &str) -> String {
    let mut body = html.to_string();
    for tag in ["script", "style", "noscript", "svg", "nav", "footer", "header", "form"] {
        body = Regex::new(&format!(r"(?is)<{tag}[\s>].*?</{tag}>")).unwrap().replace_all(&body, " ").to_string();
    }
    body = Regex::new(r"(?i)<(br|/p|/div|/li|/h[1-6]|/tr)[^>]*>").unwrap().replace_all(&body, "\n").to_string();
    Regex::new(r"\n\s*\n\s*\n+").unwrap().replace_all(&plain(&body), "\n\n").to_string()
}
fn plain(html: &str) -> String {
    let mut t = Regex::new(r"<[^>]+>").unwrap().replace_all(html, "").to_string();
    for (a, b) in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#x27;", "'"), ("&#39;", "'"), ("&nbsp;", " ")] { t = t.replace(a, b); }
    Regex::new(r"[ \t]+").unwrap().replace_all(&t, " ").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dates() { assert_eq!(date(std::time::UNIX_EPOCH + Duration::from_secs(1_760_000_000)), "2025-10-09"); }
    #[test]
    fn percent() { assert_eq!(dec("https%3A%2F%2Fa.se%2Fx%3Fy%3D1"), "https://a.se/x?y=1"); }
    #[test]
    fn paths() {
        let h = home();
        assert_eq!(short(&h.join("Downloads").join("a.txt")), "~/Downloads/a.txt");
        assert!(allowed(Some(&json!("C:/Windows/System32"))).is_none());
        assert!(allowed(Some(&json!("~/Downloads/../../secret"))).is_none());
        if let Some(d) = dirs::download_dir() { assert!(allowed(Some(&json!(d.join("x.txt").to_string_lossy()))).is_some()); }
    }
    #[test]
    fn text() { assert_eq!(plain("<b>Hi</b> &amp; you"), "Hi & you"); }
}
