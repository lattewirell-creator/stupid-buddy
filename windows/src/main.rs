// The Stupid Buddy for Windows and Linux: the same Buddy and team as the Mac app (ui/, built into this program) in
// the system's own web engine (WebView2 on Windows, WebKitGTK on Linux), with the Mac app's native side ported to
// Rust: files and the web (tools.rs), the AI connection (cloud.rs), throwing the ball (physics.rs), Hands Buddy
// (hands.rs, Windows only for now), settings and keys (store.rs), updates (update.rs), system bits (sys.rs).
// Linux also has System Buddy (system.rs), voice (voice.rs) and summoning from anywhere (instance.rs).
// The page talks to it exactly as on the Mac: window.webkit.messageHandlers.buddy.postMessage({id, op, …}).
#![cfg_attr(windows, windows_subsystem = "windows")]
mod autostart;
mod cloud;
mod hands;
#[cfg(target_os = "linux")]
mod instance;
mod physics;
mod store;
mod sys;
#[cfg(target_os = "linux")]
mod system;
mod teach;
mod tools;
mod update;
#[cfg(target_os = "linux")]
mod voice;

use serde_json::{json, Value};
use std::borrow::Cow;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tao::dpi::{LogicalSize, PhysicalPosition};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget};
use tao::window::{Window, WindowBuilder};
use wry::{http::Response, WebView, WebViewBuilder};

static WEB: include_dir::Dir = include_dir::include_dir!("$CARGO_MANIFEST_DIR/../ui");
// The closed window has room around Buddy's ball: picked up he throws his arms up, and landing squashes him wider.
const BALL: (f64, f64) = (120.0, 120.0);
const OPEN: (f64, f64) = (440.0, 660.0);
/// Buddy saying something (ui/speech.js): the ball in its corner with a speech bubble beside it.
const BUBBLE: (f64, f64) = (340.0, 210.0);

/// Work handed back to the main thread.
pub enum Ev { Ipc(String), Run(Box<dyn FnOnce(&mut App) + Send>), Tick }

pub struct App {
    proxy: EventLoopProxy<Ev>,
    window: Window,
    view: WebView,
    physics: physics::Physics,
    ticking: Arc<AtomicBool>,
    hands: hands::State,
    banner: Option<(Window, WebView)>,
    want_banner: bool,
    last_cursor: Option<(i32, i32)>,
    /// What the bar at the top says: Hands Buddy at work, or Buddy watching you teach it a task.
    banner_text: &'static str,
    teach: teach::Recorder,
    exit: bool,
}

/// What the page calls this system (ui/ai.js).
const PLATFORM: &str = if cfg!(windows) { "windows" } else { "linux" };
/// wry serves the page as http://buddy.localhost on Windows (buddy://localhost elsewhere).
fn origin() -> &'static str { if cfg!(windows) { "http://buddy.localhost" } else { "buddy://localhost" } }
fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") { "html" => "text/html", "js" => "text/javascript", "css" => "text/css", "png" => "image/png", "svg" => "image/svg+xml", _ => "application/octet-stream" }
}
fn log(text: &str) {
    match std::env::var_os("STUPID_BUDDY_LOG") {
        Some(f) => { use std::io::Write; if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(f) { let _ = writeln!(file, "[buddy] {text}"); } }
        None => println!("[buddy] {text}"),
    }
}

impl App {
    fn reply(&self, id: i64, r: Result<Value, String>) {
        let (ok, v) = match r { Ok(v) => (true, v), Err(e) => (false, Value::String(e)) };
        let _ = self.view.evaluate_script(&format!("window.__native && __native.reply({id}, {ok}, {v})"));
    }
    fn emit(&self, name: &str, v: Value) { let _ = self.view.evaluate_script(&format!("window.__native && __native.emit({}, {v})", json!(name))); }
    /// Runs `f` on a worker thread and answers the page with its result.
    fn work(&self, id: i64, f: impl FnOnce() -> Result<Value, String> + Send + 'static) {
        let p = self.proxy.clone();
        std::thread::spawn(move || { let r = f(); let _ = p.send_event(Ev::Run(Box::new(move |app| app.reply(id, r)))); });
    }
    /// Runs the verified installer quietly (it starts Buddy again when it's done) and quits.
    fn install(&mut self, path: std::path::PathBuf) {
        if std::process::Command::new(&path).arg("/S").spawn().is_ok() { self.exit = true; }
        else { log("The update installer couldn’t start."); }
    }
    fn pos(&self) -> (i32, i32) { self.window.outer_position().map(|p| (p.x, p.y)).unwrap_or((0, 0)) }
    fn size(&self) -> (i32, i32) { let s = self.window.outer_size(); (s.width as i32, s.height as i32) }

    /// "ball" (just Buddy) or "open" (the team panel), growing from the ball's corner of the screen. The size changes at
    /// once (the page animates the panel); returns where Buddy's ball is inside the new window, in page coordinates.
    fn mode(&mut self, kind: &str) -> Value {
        let open = kind == "open";
        if kind == "bubble" { self.stop_flying(); }
        if open { self.stop_flying(); }
        let scale = self.window.scale_factor();
        let (l, t, r, b) = sys::work_area(&self.window);
        let ((x, y), (w, h)) = (self.pos(), self.size());
        let (lw, lh) = match kind { "open" => OPEN, "bubble" => BUBBLE, _ => BALL };
        let (nw, nh) = ((lw * scale).round() as i32, (lh * scale).round() as i32);
        let right = x + w / 2 > (l + r) / 2;
        let bottom = y + h / 2 > (t + b) / 2;
        let nx = if right { x + w - nw } else { x };
        let ny = if bottom { y + h - nh } else { y };
        let m = (8.0 * scale) as i32;
        let nx = nx.clamp(l + m, (r - nw - m).max(l + m));
        let ny = ny.clamp(t + m, (b - nh - m).max(t + m));
        if !sys::set_frame(&self.window, nx, ny, nw, nh) {
            self.window.set_inner_size(LogicalSize::new(lw, lh));
            self.window.set_outer_position(PhysicalPosition::new(nx, ny));
        }
        if open { sys::focus(&self.window, ""); }
        json!({ "x": (x + w / 2 - nx) as f64 / scale, "y": (y + h / 2 - ny) as f64 / scale })
    }
    fn save_origin(&self) { let (x, y) = self.pos(); store::set("ballOrigin", json!([x, y])); }
    fn stop_flying(&mut self) { self.physics.stop(); self.ticking.store(false, Ordering::SeqCst); }
    fn release(&mut self, vx: f64, vy: f64) {
        let scale = self.window.scale_factor();
        self.physics.release(vx * scale, vy * scale);
        if !self.ticking.swap(true, Ordering::SeqCst) {
            let (p, ticking) = (self.proxy.clone(), self.ticking.clone());
            std::thread::spawn(move || while ticking.load(Ordering::SeqCst) { std::thread::sleep(Duration::from_millis(16)); let _ = p.send_event(Ev::Tick); });
        }
    }
    fn tick(&mut self) {
        if !self.physics.flying { return; }
        let s = self.physics.tick(self.pos(), self.size(), sys::work_area(&self.window), self.window.scale_factor());
        self.window.set_outer_position(PhysicalPosition::new(s.x, s.y));
        self.emit("roll", json!({ "vx": s.vx, "hit": s.hit, "floor": s.floor }));
        if s.landed {
            self.ticking.store(false, Ordering::SeqCst);
            self.save_origin();
            self.emit("landed", json!(true));
            if std::env::var("STUPID_BUDDY_THROW").is_ok() { log(&format!("landed at {:?}", self.pos())); self.exit = true; }
        }
    }

    /// The 3D Buddy looks at the cursor anywhere on the screen (and spins when you circle it): while Buddy is the
    /// closed ball, the cursor's position from Buddy's middle goes to the page whenever it moves (ui/ball3d.js).
    fn follow_cursor(&mut self) {
        let now = sys::cursor(&self.window);
        if now.is_none() || now == self.last_cursor { return; }
        self.last_cursor = now;
        let (cx, cy) = now.unwrap();
        let scale = self.window.scale_factor();
        let ((x, y), (w, h)) = (self.pos(), self.size());
        if (w as f64 / scale - BALL.0).abs() > 1.0 { return; }   // only the closed ball
        self.emit("cursor", json!({ "dx": (cx - (x + w / 2)) as f64 / scale, "dy": (cy - (y + h / 2)) as f64 / scale }));
    }

    /// Another start of Buddy (instance.rs): "summon" opens the panel ready to type, "summon voice" ready to
    /// listen, "show" (Buddy started again from the app grid) opens it, "background" changes nothing.
    #[cfg(target_os = "linux")]
    fn summon(&mut self, wish: &str, startup_id: &str) {
        if wish == "background" { return; }
        sys::focus(&self.window, startup_id);
        self.emit("summon", json!({ "voice": wish == "summon voice" }));
    }

    /// Hands Buddy may work: the red bar, clicks pass through Buddy, Buddy hides from its screenshots, Esc stops.
    fn hands_on(&mut self) {
        self.hands.active.store(true, Ordering::SeqCst);
        self.banner = None; self.banner_text = HANDS_BAR;
        self.want_banner = true;
        let _ = self.window.set_ignore_cursor_events(true);
        sys::hide_from_capture(&self.window, true);
        let (p, s) = (self.proxy.clone(), self.hands.clone());
        std::thread::spawn(move || {
            while s.active.load(Ordering::SeqCst) {
                if hands::esc_down() && hands::now_ms() > s.own_esc_until.load(Ordering::SeqCst) {
                    let _ = p.send_event(Ev::Run(Box::new(|app| { if app.hands.active.load(Ordering::SeqCst) { app.hands_off(); app.emit("hands:stopped", json!("esc")); } })));
                    break;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
        });
    }
    /// Teaching: the blue bar, clicks pass through Buddy, Buddy keeps out of the screenshots; the page gets the steps.
    fn teach_on(&mut self, id: i64) {
        let p = self.proxy.clone();
        let started = self.teach.start(move |steps| {
            let _ = p.send_event(Ev::Run(Box::new(move |app| { app.teach_off(); app.emit("teach:done", Value::Array(steps)); })));
        });
        if let Err(e) = started { return self.reply(id, Err(e)); }
        self.banner = None; self.banner_text = TEACH_BAR; self.want_banner = true;
        let _ = self.window.set_ignore_cursor_events(true);
        sys::hide_from_capture(&self.window, true);
        self.reply(id, Ok(json!(true)));
    }
    fn teach_off(&mut self) {
        self.teach.stop();
        self.want_banner = false; self.banner = None;
        let _ = self.window.set_ignore_cursor_events(false);
        sys::hide_from_capture(&self.window, false);
    }
    fn hands_off(&mut self) {
        self.hands.active.store(false, Ordering::SeqCst);
        self.want_banner = false;
        self.banner = None;
        let _ = self.window.set_ignore_cursor_events(false);
        sys::hide_from_capture(&self.window, false);
    }
}

fn main() {
    // Linux: one Buddy at a time. A second start hands its wish to the running one and quits (instance.rs).
    #[cfg(target_os = "linux")]
    let wish = instance::wish(&std::env::args().skip(1).collect::<Vec<_>>());
    #[cfg(target_os = "linux")]
    if !testing() && instance::hand_over(&wish) { return; }
    #[cfg(not(target_os = "linux"))]
    let wish = String::new();
    #[cfg(target_os = "linux")] sys::prefer_x11();
    let event_loop = EventLoopBuilder::<Ev>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let wb = WindowBuilder::new().with_title("The Stupid Buddy").with_inner_size(LogicalSize::new(BALL.0, BALL.1))
        .with_decorations(false).with_transparent(true).with_always_on_top(true).with_resizable(!cfg!(windows)).with_visible(false);
    // (GTK pins a window that can't be resized to its content's natural size, so on Linux Buddy stays "resizable":
    // it has no frame to grab, and main.rs sets every size itself.)
    // On the taskbar like any app (the red Hands bar below stays off it).
    #[cfg(windows)] let wb = { use tao::platform::windows::WindowBuilderExtWindows; wb.with_undecorated_shadow(false) };
    let window = wb.build(&event_loop).expect("window");

    // Where the ball was left last time (if that's still on a screen), else the bottom-right corner.
    let (l, t, r, b) = sys::work_area(&window);
    let size = LogicalSize::new(BALL.0, BALL.1).to_physical::<u32>(window.scale_factor());   // (GTK only knows after it's shown)
    let saved = store::get("ballOrigin").and_then(|v| Some((v.get(0)?.as_i64()? as i32, v.get(1)?.as_i64()? as i32)));
    let (x, y) = saved.filter(|&(x, y)| x >= l - 40 && x <= r - 40 && y >= t - 40 && y <= b - 40)
        .unwrap_or((r - size.width as i32 - (24.0 * window.scale_factor()) as i32, b - size.height as i32 - (24.0 * window.scale_factor()) as i32));
    window.set_outer_position(PhysicalPosition::new(x, y));
    window.set_visible(true);

    let ipc = proxy.clone();
    let builder = WebViewBuilder::new()
        .with_transparent(true)
        .with_background_color((0, 0, 0, 0))
        .with_custom_protocol("buddy".into(), |_id, request| {
            let path = request.uri().path().trim_start_matches('/');
            let path = if path.is_empty() { "index.html" } else { path };
            match WEB.get_file(path) {
                Some(f) => Response::builder().header("Content-Type", mime(path)).header("Cache-Control", "no-store").body(Cow::Borrowed(f.contents())).unwrap(),
                None => Response::builder().status(404).body(Cow::Borrowed(&b"Not found"[..])).unwrap(),
            }
        })
        // The page posts to window.webkit.messageHandlers.buddy like on the Mac. WebKitGTK's own window.webkit
        // carries wry's channel (messageHandlers.ipc), so that one is kept before window.webkit is replaced.
        // Started with --summon: the page opens itself as soon as it's there.
        .with_initialization_script(["window.__platform='", PLATFORM, "';window.__summon='", match wish.as_str() { "summon" => "text", "summon voice" => "voice", _ => "" }, "';(()=>{const h=window.webkit&&window.webkit.messageHandlers.ipc;const post=h?(s)=>h.postMessage(s):(s)=>window.ipc.postMessage(s);",
            "window.webkit={messageHandlers:{buddy:{postMessage:(m)=>post(JSON.stringify(m))}}};})();"].concat())
        .with_ipc_handler(move |req| {
            // Only Buddy's own page may call the app (the Mac app checks the frame the same way).
            if req.uri().to_string().starts_with(origin()) { let _ = ipc.send_event(Ev::Ipc(req.body().clone())); }
        })
        .with_navigation_handler(|url| url.starts_with(origin()))
        .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
        .with_url(format!("{}/index.html", origin()));
    let view = build_view(builder, &window);

    let mut app = App { proxy: proxy.clone(), window, view, physics: physics::Physics::new(), ticking: Arc::new(AtomicBool::new(false)),
        hands: hands::State::default(), banner: None, want_banner: false, last_cursor: None, banner_text: HANDS_BAR, teach: teach::Recorder::default(), exit: false };
    self_tests(&app);
    #[cfg(target_os = "linux")]
    if !testing() {
        let p = proxy.clone();
        instance::listen(move |wish, id| { let _ = p.send_event(Ev::Run(Box::new(move |app| app.summon(&wish, &id)))); });
    }
    // Updates: a first check shortly after start, then every 12 hours (update.rs skips it if it checked recently).
    if cfg!(windows) && std::env::var("STUPID_BUDDY_SELFTEST").is_err() && std::env::var("STUPID_BUDDY_SHOWCASE").is_err() {
        let p = proxy.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(30));
            match update::check(false, update::VERSION, false) {
                update::Outcome::Install(path) => { let _ = p.send_event(Ev::Run(Box::new(move |app| app.install(path)))); }
                update::Outcome::Available(v) => { let _ = p.send_event(Ev::Run(Box::new(move |app| app.emit("update:available", json!(v))))); }
                _ => {}
            }
            std::thread::sleep(Duration::from_secs(12 * 3600));
        });
    }
    // The cursor is read on the main thread (GTK wants that on Linux), 30 times a second.
    {
        let p = proxy.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(33));
            if p.send_event(Ev::Run(Box::new(|app| app.follow_cursor()))).is_err() { break; }
        });
    }

    event_loop.run(move |event, target, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Ev::Ipc(body)) => handle(&mut app, &body),
            Event::UserEvent(Ev::Run(f)) => f(&mut app),
            Event::UserEvent(Ev::Tick) => app.tick(),
            Event::WindowEvent { event: WindowEvent::CloseRequested, window_id, .. } if window_id == app.window.id() => app.exit = true,
            _ => {}
        }
        if app.want_banner && app.banner.is_none() { app.banner = Some(banner(target, app.banner_text)); }
        if app.exit { app.hands_off(); *flow = ControlFlow::Exit; }
    });
}

/// The bar at the top of the screen while Hands Buddy works (red) or Buddy watches you teach it (blue). Clicks go
/// through it and screenshots skip it.
const HANDS_BAR: &str = "<div style=\"background:rgba(214,77,61,.96)\">Buddy is using your computer · press Esc to stop</div>";
const TEACH_BAR: &str = "<div style=\"background:rgba(79,120,181,.96)\">Buddy is watching · do the task, then press Esc</div>";
fn banner(target: &EventLoopWindowTarget<Ev>, text: &str) -> (Window, WebView) {
    let title = if text == TEACH_BAR { "Buddy is watching" } else { "Buddy is using your computer" };
    let wb = WindowBuilder::new().with_title(title).with_inner_size(LogicalSize::new(430.0, 34.0))
        .with_decorations(false).with_transparent(true).with_always_on_top(true).with_resizable(false).with_focused(false);
    #[cfg(windows)] let wb = { use tao::platform::windows::WindowBuilderExtWindows; wb.with_skip_taskbar(true).with_undecorated_shadow(false) };
    let w = wb.build(target).expect("banner");
    let (l, t, r, _) = sys::work_area(&w);
    let width = w.outer_size().width as i32;
    w.set_outer_position(PhysicalPosition::new((l + r) / 2 - width / 2, t + (6.0 * w.scale_factor()) as i32));
    let _ = w.set_ignore_cursor_events(true);
    // Screenshots skip the bar, except in the showcase test, where the screenshots are the point.
    if std::env::var("STUPID_BUDDY_SHOWCASE").is_err() { sys::hide_from_capture(&w, true); }
    let v = build_view(WebViewBuilder::new().with_transparent(true).with_background_color((0, 0, 0, 0))
        .with_html(format!(r#"<!doctype html><meta charset="utf-8"><style>div{{height:34px;border-radius:17px;color:#fff;font:600 13px 'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center}}</style><body style="margin:0;background:transparent;overflow:hidden">{text}"#))
        .with_navigation_handler(|url| url.starts_with("about:") || url.starts_with("data:")), &w);
    (w, v)
}

/// Puts a web view in a window: on Windows straight in, on Linux inside the window's GTK box (WebKitGTK is a widget).
fn build_view(builder: WebViewBuilder, window: &Window) -> WebView {
    #[cfg(target_os = "linux")]
    {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        builder.build_gtk(window.default_vbox().expect("GTK box")).expect("webview")
    }
    #[cfg(not(target_os = "linux"))]
    { builder.build(window).expect("webview") }
}

fn handle(app: &mut App, body: &str) {
    let Ok(Value::Object(m)) = serde_json::from_str::<Value>(body) else { return };
    let id = m.get("id").and_then(Value::as_i64).unwrap_or(0);
    let op = m.get("op").and_then(Value::as_str).unwrap_or("").to_string();
    let f = |k: &str| m.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    match op.as_str() {
        "window" => { let at = app.mode(m.get("mode").and_then(Value::as_str).unwrap_or("ball")); app.reply(id, Ok(at)) }
        "drag" => {
            app.stop_flying();
            let scale = app.window.scale_factor();
            let (x, y) = app.pos();
            app.window.set_outer_position(PhysicalPosition::new(x + (f("dx") * scale).round() as i32, y + (f("dy") * scale).round() as i32));
            app.reply(id, Ok(json!(true)))
        }
        "release" => { app.release(f("vx"), f("vy")); app.reply(id, Ok(json!(true))) }
        "dragEnd" => { app.save_origin(); app.reply(id, Ok(json!(true))) }
        "confirm" => {
            let s = |k: &str, d: &str| m.get(k).and_then(Value::as_str).unwrap_or(d).to_string();
            let (title, text, yes) = (s("title", "Allow this?"), s("text", ""), s("yes", "Allow"));
            app.work(id, move || Ok(json!(sys::confirm(&title, &text, &yes))))
        }
        "quit" => { app.reply(id, Ok(json!(true))); app.exit = true }
        "log" => { log(m.get("text").and_then(Value::as_str).unwrap_or("")); app.reply(id, Ok(json!(true))) }
        "update.check" => {
            let p = app.proxy.clone();
            std::thread::spawn(move || {
                let outcome = update::check(true, update::VERSION, false);
                let _ = p.send_event(Ev::Run(Box::new(move |app| match outcome {
                    update::Outcome::Install(path) => { app.reply(id, Ok(json!("Installing the update…"))); app.install(path); }
                    update::Outcome::Message(m) => app.reply(id, Ok(json!(m))),
                    update::Outcome::Quiet | update::Outcome::Available(_) => app.reply(id, Ok(json!(""))),
                })));
            });
        }
        // From Buddy's speech bubble: Update now (you said yes there) or In 3 days.
        "update.install" => {
            let p = app.proxy.clone();
            std::thread::spawn(move || {
                let outcome = update::check_with(true, update::VERSION, false, true);
                let _ = p.send_event(Ev::Run(Box::new(move |app| match outcome {
                    update::Outcome::Install(path) => { app.reply(id, Ok(json!("Installing the update…"))); app.install(path); }
                    update::Outcome::Message(m) => app.reply(id, Ok(json!(m))),
                    _ => app.reply(id, Ok(json!(""))),
                })));
            });
        }
        "update.later" => { update::snooze(3); app.reply(id, Ok(json!(true))) }
        // Start with the computer: {} asks (null where it can't), {on} changes it.
        "autostart" => match m.get("on").and_then(Value::as_bool) {
            Some(on) => app.reply(id, autostart::set(on).map(|v| json!(v))),
            None => app.reply(id, Ok(json!(autostart::get()))),
        },
        "update.version" => app.reply(id, Ok(json!(update::VERSION))),
        op if op.starts_with("hands.") && !hands::AVAILABLE => app.reply(id, Err(hands::UNAVAILABLE.into())),
        "hands.permissions" | "hands.askPermissions" => app.reply(id, Ok(json!({ "screen": true, "control": true }))),
        "hands.start" => {
            if app.teach.on.load(Ordering::SeqCst) { return app.reply(id, Err("Buddy is watching you teach it a task right now.".into())); }
            let task = m.get("task").and_then(Value::as_str).unwrap_or("this task").to_string();
            let p = app.proxy.clone();
            std::thread::spawn(move || {
                let ok = std::env::var("STUPID_BUDDY_SELFTEST").is_ok() || std::env::var("STUPID_BUDDY_SHOWCASE").is_ok() || sys::confirm("Let Buddy use your mouse and keyboard?",
                    &format!("For: {task}\n\nA red bar shows while Buddy works. Press Esc any time to stop it. It won’t type passwords, and it asks before clicking things like Send, Buy or Delete."), "Let Buddy work");
                let _ = p.send_event(Ev::Run(Box::new(move |app| {
                    if ok { app.hands_on(); app.reply(id, Ok(json!(true))) } else { app.reply(id, Err("You said no, so Buddy didn’t touch anything.".into())) }
                })));
            });
        }
        "hands.stop" => { app.hands_off(); app.reply(id, Ok(json!(true))) }
        "teach.start" => app.teach_on(id),
        "teach.stop" => { app.teach.stop(); app.reply(id, Ok(json!(true))) }
        op if op.starts_with("hands.") => { let (s, op) = (app.hands.clone(), op.to_string()); app.work(id, move || hands::act(&op, &m, &s)) }
        #[cfg(target_os = "linux")]
        "voice.can" => {
            let provider = m.get("provider").and_then(Value::as_str).unwrap_or("").to_string();
            let speak = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).any(|d| d.join("spd-say").is_file())).unwrap_or(false);
            app.reply(id, Ok(json!({ "listen": voice::can_listen(&provider), "speak": speak })))
        }
        #[cfg(target_os = "linux")]
        "voice.listen" => {
            let provider = m.get("provider").and_then(Value::as_str).unwrap_or("").to_string();
            let p = app.proxy.clone();
            app.work(id, move || voice::listen(&provider, |level| { let _ = p.send_event(Ev::Run(Box::new(move |app| app.emit("voice:level", json!(level))))); }).map(|t| json!(t)))
        }
        #[cfg(target_os = "linux")]
        "voice.stop" => { voice::stop(); app.reply(id, Ok(json!(true))) }
        #[cfg(target_os = "linux")]
        "voice.speak" => { let text = m.get("text").and_then(Value::as_str).unwrap_or("").to_string(); app.work(id, move || voice::speak(&text)) }
        // A timer or reminder: a desktop notification when it's time, and a note from Buddy (ui/app.js).
        #[cfg(target_os = "linux")]
        "system.timer" => {
            let secs = f("seconds").round();
            if !(1.0..=7.0 * 86_400.0).contains(&secs) { return app.reply(id, Err("A timer can be from a second to a week.".into())); }
            let text = m.get("text").and_then(Value::as_str).unwrap_or("").trim().chars().take(200).collect::<String>();
            let text = if text.is_empty() { "Time’s up!".to_string() } else { text };
            let p = app.proxy.clone();
            let said = text.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(secs as u64));
                system::notify("The Stupid Buddy", &said);
                let _ = p.send_event(Ev::Run(Box::new(move |app| app.emit("timer", json!(said)))));
            });
            app.reply(id, Ok(json!(format!("Timer set: “{text}” in {}", human(secs as u64)))))
        }
        #[cfg(target_os = "linux")]
        op if op.starts_with("system.") => { let op = op.to_string(); app.work(id, move || system::handle(&op, &m)) }
        op if op.starts_with("voice.") || op.starts_with("system.") => app.reply(id, Err("That’s only in the Linux version for now.".into())),
        op if op.starts_with("keys.") || op == "ai.request" || op == "ollama.request" => { let op = op.to_string(); app.work(id, move || cloud::handle(&op, &m)) }
        op => { let op = op.to_string(); app.work(id, move || tools::handle(&op, &m)) }
    }
}

/// "5 minutes", "1 hour 30 minutes", "45 seconds".
#[cfg(target_os = "linux")]
fn human(secs: u64) -> String {
    let unit = |n: u64, one: &str| format!("{n} {one}{}", if n == 1 { "" } else { "s" });
    let (h, m, s) = (secs / 3600, secs % 3600 / 60, secs % 60);
    let parts: Vec<String> = [(h, "hour"), (m, "minute"), (s, "second")].iter().filter(|(n, _)| *n > 0).map(|&(n, u)| unit(n, u)).collect();
    parts.join(" ")
}

/// Started by a development test (below): those don't take part in "one Buddy at a time".
#[cfg(target_os = "linux")]
fn testing() -> bool { ["STUPID_BUDDY_SELFTEST", "STUPID_BUDDY_SHOWCASE", "STUPID_BUDDY_THROW", "STUPID_BUDDY_ASK", "STUPID_BUDDY_UPDATE_DRYRUN"].iter().any(|v| std::env::var_os(v).is_some()) }

/// Development self-tests: STUPID_BUDDY_SELFTEST=1 tries the app's tools and logs each result, then quits;
/// STUPID_BUDDY_ASK="…" asks the team (like the Mac app); STUPID_BUDDY_THROW="vx,vy" throws the ball.
fn self_tests(app: &App) {
    let p = app.proxy.clone();
    let later = move |code: String| { std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(4)); let _ = p.send_event(Ev::Run(Box::new(move |app| { let _ = app.view.evaluate_script(&code); }))); }); };
    if std::env::var("STUPID_BUDDY_SELFTEST").is_ok() {
        later(r#"(async()=>{const L=(t)=>Native.call('log',{text:t});const T=async(op,p)=>{try{const v=await Native.call(op,p||{});await L('OK '+op+' '+JSON.stringify(v).slice(0,160))}catch(e){await L('FAIL '+op+' '+e.message)}};
await L('DEVICE '+window.DEVICE+' · providers '+Object.keys(AI.PROVIDERS).join(',')+' · helpers '+Object.keys(HELPERS).join(','));
await T('files.roots');await T('files.list',{path:'~/Desktop'});await T('files.mkdir',{path:'~/Documents/Buddy self-test'});await T('files.write',{path:'~/Documents/Buddy self-test/hello.md',text:'Hello from Buddy'});
await T('files.read',{path:'~/Documents/Buddy self-test/hello.md'});await T('files.search',{query:'hello'});await T('files.list',{path:'C:/Windows'});await T('files.read',{path:'~/Documents/nope.txt'});
await T('web.search',{query:'the stupid company'});await T('keys.has',{provider:'groq'});await T('ollama.request',{path:'api/tags'});
await T('hands.shot');await T('hands.start',{task:'self-test'});await T('hands.shot');await T('hands.key',{keys:'shift'});await T('hands.stop');
await T('window',{mode:'open'});await T('window',{mode:'ball'});await L('DONE');Native.call('quit')})()"#.into());
    } else if let Ok(how) = std::env::var("STUPID_BUDDY_SYSTEMTEST") {
        // Linux: every System Buddy action, with the commands logged instead of run (STUPID_BUDDY_DRYRUN). "confirm"
        // also turns Wi-Fi off, which waits for your answer in an alert.
        std::env::set_var("STUPID_BUDDY_DRYRUN", "1");
        let off = if how == "confirm" { "await T('system.radio',{what:'wifi',on:false});" } else { "" };
        later(format!(r#"(async()=>{{const L=(t)=>Native.call('log',{{text:t}});const T=async(op,p)=>{{try{{const v=await Native.call(op,p||{{}});await L('OK '+op+' '+JSON.stringify(v).slice(0,200))}}catch(e){{await L('FAIL '+op+' '+e.message)}}}};
Native.on('timer',(t)=>L('TIMER '+t));await L('HELPERS '+Object.keys(HELPERS).join(','));await T('system.openApp',{{name:'browser'}});await T('system.openApp',{{name:'nope-app'}});await T('system.settings',{{panel:'wifi'}});await T('system.settings',{{panel:'../x'}});
await T('system.volume',{{action:'up',percent:10}});await T('system.volume',{{action:'set',percent:40}});await T('system.volume',{{action:'mute'}});await T('system.brightness',{{action:'set',percent:60}});
await T('system.radio',{{what:'wifi',on:true}});await T('system.radio',{{what:'bluetooth',on:true}});{off}await T('system.theme',{{dark:true}});await T('system.theme',{{dark:false}});await T('system.dnd',{{on:true}});
await T('system.lock');await T('system.screenshot');await T('system.status');await T('system.timer',{{seconds:2,text:'Stretch!'}});await T('voice.can',{{provider:'groq'}});await T('voice.can',{{provider:'ollama'}});
await T('voice.speak',{{text:'**Klart!** Jag har satt en timer.'}});await new Promise(r=>setTimeout(r,3500));await L('DONE');Native.call('quit')}})()"#));
    } else if std::env::var("STUPID_BUDDY_SHOWCASE").is_ok() {
        // Each "SHOT name" in the log is the moment the test machine photographs the screen (see windows.yml).
        later(r#"(async()=>{const L=(t)=>Native.call('log',{text:t});const W=(ms)=>new Promise(r=>setTimeout(r,ms));const S=async(n)=>{await L('SHOT '+n);await W(2500)};
localStorage.removeItem('look');Look.apply();await W(800);const gl=document.createElement('canvas');await L('reduced motion '+matchMedia('(prefers-reduced-motion: reduce)').matches);window.__force3d=true;Look.apply();await W(600);await L('3D '+typeof window.Buddy3D+' webgl2 '+!!gl.getContext('webgl2')+' webgl '+!!document.createElement('canvas').getContext('webgl')+' ball '+document.getElementById('ball').className);await S('1-ball');
open();await W(1200);await S('2-panel');
await showSettings();await W(500);Look.render(document.getElementById('lookBox'));await S('3-settings');
localStorage.setItem('look',JSON.stringify({shape:'eye',color:'mint',hat:'crown',name:'Pip'}));Look.apply();Look.render(document.getElementById('lookBox'));await W(400);await S('4-eye-settings');
hideSettings();close();await W(1200);await S('5-eye-ball');
await Native.call('hands.start',{task:'showcase'});await W(800);await S('6-hands-bar');await Native.call('hands.stop');
localStorage.removeItem('look');Look.apply();await L('DONE');Native.call('quit')})()"#.into());
    } else if let Ok(from) = std::env::var("STUPID_BUDDY_UPDATE_DRYRUN") {
        // Pretends to be an old version, finds the newest release, downloads it and checks its signature (no install).
        let p = app.proxy.clone();
        std::thread::spawn(move || {
            let text = match update::check(true, &from, true) { update::Outcome::Message(m) => m, update::Outcome::Install(_) => "install".into(), update::Outcome::Available(v) => format!("available {v}"), update::Outcome::Quiet => "quiet".into() };
            log(&format!("UPDATE {text}"));
            let _ = p.send_event(Ev::Run(Box::new(|app| app.exit = true)));
        });
    } else if let Ok(q) = std::env::var("STUPID_BUDDY_ASK") {
        let provider = std::env::var("STUPID_BUDDY_PROVIDER").unwrap_or_default();
        later(format!("Native.call('window',{{mode:'open'}});document.body.classList.remove('closed');window.__test({}, {})", json!(q), json!(provider)));
    } else if let Ok(t) = std::env::var("STUPID_BUDDY_THROW") {
        let v: Vec<f64> = t.split(',').filter_map(|s| s.trim().parse().ok()).collect();
        let (vx, vy) = (v.first().copied().unwrap_or(0.0), v.get(1).copied().unwrap_or(0.0));
        let p = app.proxy.clone();
        std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(3)); let _ = p.send_event(Ev::Run(Box::new(move |app| app.release(vx, vy)))); });
    }
}
