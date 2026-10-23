// System Buddy on Linux ("Siri things"): opens apps and GNOME Settings, changes the volume, brightness, Wi-Fi,
// Bluetooth, dark mode and do-not-disturb, locks the screen, takes screenshots, shows notifications and tells you
// how the computer is doing. Each action is a small call to the desktop's own command-line tools; one that isn't
// installed gives a friendly message. Turning Wi-Fi or Bluetooth off asks you first (it can cut you off).
// STUPID_BUDDY_DRYRUN=1 logs the commands instead of running them (for testing without the real hardware).
// Runs on worker threads.
use crate::sys;
use serde_json::{json, Map, Value};
use std::process::Command;

type Out = Result<Value, String>;

fn have(cmd: &str) -> bool {
    std::env::var_os("PATH").map(|p| std::env::split_paths(&p).any(|d| d.join(cmd).is_file())).unwrap_or(false)
}
fn dry() -> bool { std::env::var_os("STUPID_BUDDY_DRYRUN").is_some() }
fn missing(cmd: &str) -> String { format!("That needs “{cmd}”, which isn’t installed on this computer.") }
/// Runs a command and returns what it printed (or its first error line).
fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    if dry() { crate::log(&format!("RUN {cmd} {}", args.join(" "))); return Ok(String::new()); }
    if !have(cmd) { return Err(missing(cmd)); }
    let out = Command::new(cmd).args(args).output().map_err(|_| missing(cmd))?;
    if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()) }
    else { Err(String::from_utf8_lossy(&out.stderr).lines().next().unwrap_or("It didn’t work.").to_string()) }
}
/// Starts a program that stays open (like Settings) without waiting for it.
fn launch(cmd: &str, args: &[&str]) -> Result<(), String> {
    if dry() { crate::log(&format!("RUN {cmd} {}", args.join(" "))); return Ok(()); }
    if !have(cmd) { return Err(missing(cmd)); }
    let mut child = Command::new(cmd).args(args).spawn().map_err(|_| missing(cmd))?;
    std::thread::spawn(move || child.wait());
    Ok(())
}
fn gsettings(schema: &str, key: &str, value: &str) -> Result<String, String> { run("gsettings", &["set", schema, key, value]) }
fn str_of<'a>(m: &'a Map<String, Value>, k: &str) -> &'a str { m.get(k).and_then(Value::as_str).unwrap_or("").trim() }
fn percent(m: &Map<String, Value>, k: &str, dflt: f64) -> i64 { m.get(k).and_then(Value::as_f64).unwrap_or(dflt).round().clamp(0.0, 100.0) as i64 }

pub fn handle(op: &str, m: &Map<String, Value>) -> Out {
    match op {
        "system.openApp" => open_app(str_of(m, "name")),
        "system.settings" => {
            // gnome-control-center's own panel names: wifi, bluetooth, display, sound, power, background, …
            let panel = str_of(m, "panel").to_lowercase();
            let ok = panel.is_empty() || (panel.len() <= 30 && panel.chars().all(|c| c.is_ascii_lowercase() || c == '-'));
            if !ok { return Err("I don’t know that part of Settings.".into()); }
            let args: Vec<&str> = if panel.is_empty() { vec![] } else { vec![panel.as_str()] };
            launch("gnome-control-center", &args)?;
            Ok(json!(format!("Opened Settings{}", if panel.is_empty() { String::new() } else { format!(" › {panel}") })))
        }
        "system.volume" => volume(str_of(m, "action"), percent(m, "percent", 10.0)),
        "system.brightness" => brightness(str_of(m, "action"), percent(m, "percent", 10.0)),
        "system.radio" => {
            let on = m.get("on").and_then(Value::as_bool).unwrap_or(true);
            let what = str_of(m, "what").to_lowercase();
            let label = if what == "bluetooth" { "Bluetooth" } else { "Wi-Fi" };
            if !on && !sys::confirm(&format!("Turn {label} off?"), &format!("Buddy wants to turn {label} off. That can cut you off (and Buddy too, if it uses an online AI)."), &format!("Turn {label} off")) {
                return Err("You said no, so I didn’t do it.".into());
            }
            match what.as_str() {
                "wifi" | "wi-fi" => run("nmcli", &["radio", "wifi", if on { "on" } else { "off" }])?,
                "bluetooth" => run("rfkill", &[if on { "unblock" } else { "block" }, "bluetooth"])?,
                _ => return Err("I can turn Wi-Fi or Bluetooth on and off.".into()),
            };
            Ok(json!(format!("{label} is {}", if on { "on" } else { "off" })))
        }
        "system.theme" => {
            let dark = m.get("dark").and_then(Value::as_bool).unwrap_or(true);
            gsettings("org.gnome.desktop.interface", "color-scheme", if dark { "prefer-dark" } else { "default" })?;
            // Ubuntu's Yaru themes come in light and dark versions of each colour: switch those too.
            let theme = run("gsettings", &["get", "org.gnome.desktop.interface", "gtk-theme"]).unwrap_or_default().trim_matches('\'').to_string();
            if theme.starts_with("Yaru") {
                let base = theme.trim_end_matches("-dark");
                let _ = gsettings("org.gnome.desktop.interface", "gtk-theme", &if dark { format!("{base}-dark") } else { base.to_string() });
            }
            Ok(json!(if dark { "Dark mode is on" } else { "Light mode is on" }))
        }
        "system.dnd" => {
            let on = m.get("on").and_then(Value::as_bool).unwrap_or(true);
            gsettings("org.gnome.desktop.notifications", "show-banners", if on { "false" } else { "true" })?;
            Ok(json!(if on { "Do not disturb is on: notifications stay quiet" } else { "Do not disturb is off" }))
        }
        "system.lock" => {
            let gnome = run("gdbus", &["call", "--session", "--dest", "org.gnome.ScreenSaver", "--object-path", "/org/gnome/ScreenSaver", "--method", "org.gnome.ScreenSaver.Lock"]);
            if gnome.is_err() { run("loginctl", &["lock-session"])?; }
            Ok(json!("Locked the screen"))
        }
        "system.screenshot" => screenshot(),
        "system.status" => Ok(status()),
        _ => Err("unknown".into()),
    }
}

/// An app by name: the installed apps (their .desktop files in the XDG data folders, the same list the app grid
/// shows), best match first, launched the way the desktop launches them (what gtk-launch does).
fn open_app(name: &str) -> Out {
    use gtk::gio::{self, prelude::*};
    let want = name.to_lowercase();
    if want.is_empty() { return Err("Which app?".into()); }
    let apps = gio::AppInfo::all();
    let browser = ["browser", "web browser", "webbläsare", "webbläsaren", "internet"].contains(&want.as_str());
    let found = if browser { gio::AppInfo::default_for_uri_scheme("https") } else {
        let rank = |a: &gio::AppInfo| -> Option<u8> {
            let display = a.display_name().to_lowercase();
            let id = a.id().map(|s| s.to_lowercase()).unwrap_or_default();
            let extra = a.downcast_ref::<gio::DesktopAppInfo>().map(|d| format!("{} {}", d.generic_name().unwrap_or_default(), d.keywords().join(" ")).to_lowercase()).unwrap_or_default();
            if display == want { Some(0) } else if display.starts_with(&want) { Some(1) } else if display.contains(&want) { Some(2) }
            else if extra.contains(&want) { Some(3) } else if id.contains(&want.replace(' ', "")) { Some(4) } else { None }
        };
        apps.into_iter().filter(|a| a.should_show()).filter_map(|a| rank(&a).map(|r| (r, a))).min_by_key(|(r, _)| *r).map(|(_, a)| a)
    };
    let Some(app) = found else { return Err(format!("I couldn’t find an app called {name}.")) };
    let label = app.display_name().to_string();
    if dry() { crate::log(&format!("RUN gtk-launch {}", app.id().unwrap_or_default())); }
    else { app.launch(&[], gio::AppLaunchContext::NONE).map_err(|_| format!("{label} didn’t start."))?; }
    Ok(json!(format!("Opened {label}")))
}

/// The speakers' volume through PipeWire (wpctl): up, down, set, mute, unmute. Says the new volume.
fn volume(action: &str, pct: i64) -> Out {
    const SINK: &str = "@DEFAULT_AUDIO_SINK@";
    let (step_up, step_down, set) = (format!("{pct}%+"), format!("{pct}%-"), format!("{:.2}", pct as f64 / 100.0));
    match action {
        "up" => run("wpctl", &["set-volume", "-l", "1.0", SINK, &step_up])?,
        "down" => run("wpctl", &["set-volume", SINK, &step_down])?,
        "set" => run("wpctl", &["set-volume", "-l", "1.0", SINK, &set])?,
        "mute" => run("wpctl", &["set-mute", SINK, "1"])?,
        "unmute" => run("wpctl", &["set-mute", SINK, "0"])?,
        _ => return Err("I can turn the volume up, down, to a number, or mute it.".into()),
    };
    Ok(json!(current_volume().unwrap_or_else(|| "Done".into())))
}
/// "Volume 40%" (or "muted"), from wpctl's "Volume: 0.40 [MUTED]".
fn current_volume() -> Option<String> {
    let out = run("wpctl", &["get-volume", "@DEFAULT_AUDIO_SINK@"]).ok()?;
    let v: f64 = out.split_whitespace().nth(1)?.parse().ok()?;
    Some(format!("Volume {}%{}", (v * 100.0).round(), if out.contains("MUTED") { " (muted)" } else { "" }))
}

/// The built-in screen's brightness: GNOME's power service, or brightnessctl where that's installed.
fn brightness(action: &str, pct: i64) -> Out {
    let prop = |args: &[&str]| -> Result<String, String> {
        let mut all = vec!["call", "--session", "--dest", "org.gnome.SettingsDaemon.Power", "--object-path", "/org/gnome/SettingsDaemon/Power", "--method"];
        all.extend_from_slice(args);
        run("gdbus", &all)
    };
    // "(<45>,)" → 45
    let now = prop(&["org.freedesktop.DBus.Properties.Get", "org.gnome.SettingsDaemon.Power.Screen", "Brightness"])
        .ok().and_then(|s| s.chars().filter(|c| c.is_ascii_digit() || *c == '-').collect::<String>().parse::<i64>().ok());
    let target = match action {
        "up" => now.map(|n| (n + pct).min(100)),
        "down" => now.map(|n| (n - pct).max(1)),
        "set" => Some(pct.max(1)),
        _ => return Err("I can make the screen brighter, darker, or set a number.".into()),
    };
    if let (Some(t), true) = (target, now.is_some() || dry()) {
        let value = format!("<int32 {t}>");
        if prop(&["org.freedesktop.DBus.Properties.Set", "org.gnome.SettingsDaemon.Power.Screen", "Brightness", &value]).is_ok() {
            return Ok(json!(format!("Brightness {t}%")));
        }
    }
    let arg = match action { "up" => format!("+{pct}%"), "down" => format!("{pct}%-"), _ => format!("{}%", pct.max(1)) };
    if have("brightnessctl") || dry() { run("brightnessctl", &["set", &arg])?; return Ok(json!("Changed the brightness")); }
    Err("This screen’s brightness can’t be changed from here (an external monitor sets its own).".into())
}

/// gnome-screenshot saves straight to Pictures; without it, GNOME's own screenshot tool opens (through the
/// screenshot portal) and saves to Pictures › Screenshots.
fn screenshot() -> Out {
    if have("gnome-screenshot") && !dry() {
        let dir = dirs::picture_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Pictures")).join("Screenshots");
        std::fs::create_dir_all(&dir).ok();
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let file = dir.join(format!("Screenshot {secs}.png"));
        run("gnome-screenshot", &["-f", &file.to_string_lossy()])?;
        return Ok(json!(format!("Saved a screenshot: {}", crate::tools::short(&file))));
    }
    run("gdbus", &["call", "--session", "--dest", "org.freedesktop.portal.Desktop", "--object-path", "/org/freedesktop/portal/desktop",
        "--method", "org.freedesktop.portal.Screenshot.Screenshot", "", "{'interactive': <true>}"])?;
    Ok(json!("Opened the screenshot tool: pick what to capture. It saves to Pictures › Screenshots."))
}

/// A desktop notification (for timers and reminders).
pub fn notify(title: &str, text: &str) {
    let _ = run("notify-send", &["--app-name=The Stupid Buddy", "--icon=stupid-buddy", title, text]);
}

/// Battery, power, memory, disk, uptime, volume and Wi-Fi, read from /sys and /proc (and wpctl, nmcli if there).
fn status() -> Value {
    let read = |p: &str| std::fs::read_to_string(p).ok().map(|s| s.trim().to_string());
    let mut battery = None;
    let mut plugged = None;
    for e in std::fs::read_dir("/sys/class/power_supply").into_iter().flatten().flatten() {
        let p = e.path().to_string_lossy().to_string();
        match read(&format!("{p}/type")).as_deref() {
            Some("Battery") => battery = Some(json!({ "percent": read(&format!("{p}/capacity")).and_then(|c| c.parse::<u32>().ok()), "state": read(&format!("{p}/status")) })),
            Some("Mains") => plugged = read(&format!("{p}/online")).map(|o| o == "1"),
            _ => {}
        }
    }
    let meminfo = read("/proc/meminfo").unwrap_or_default();
    let mem = |key: &str| meminfo.lines().find(|l| l.starts_with(key)).and_then(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok()).map(|kb| kb / 1024);
    let uptime_h = read("/proc/uptime").and_then(|u| u.split_whitespace().next()?.parse::<f64>().ok()).map(|s| (s / 360.0).round() / 10.0);
    let home = dirs::home_dir().unwrap_or_default();
    let disk = std::ffi::CString::new(home.to_string_lossy().as_bytes()).ok().and_then(|path| unsafe {
        let mut st: libc::statvfs = std::mem::zeroed();
        (libc::statvfs(path.as_ptr(), &mut st) == 0).then(|| json!({ "freeGB": (st.f_bavail as f64 * st.f_frsize as f64 / 1e9).round(), "sizeGB": (st.f_blocks as f64 * st.f_frsize as f64 / 1e9).round() }))
    });
    json!({
        "battery": battery.unwrap_or(json!("no battery (a desktop computer)")),
        "pluggedIn": plugged,
        "memoryMB": { "total": mem("MemTotal:"), "available": mem("MemAvailable:") },
        "disk": disk,
        "uptimeHours": uptime_h,
        "volume": current_volume(),
        "wifi": run("nmcli", &["radio", "wifi"]).ok(),
    })
}
