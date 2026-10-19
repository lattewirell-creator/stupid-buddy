// The Stupid Buddy for Windows: the same Buddy and team as the Mac app (ui/, built into this program) in Windows'
// own web engine (WebView2), with the Mac app's native side ported to Rust: files and the web (tools.rs), the AI
// connection (cloud.rs), throwing the ball (physics.rs), Hands Buddy (hands.rs), settings and keys (store.rs).
// The page talks to it exactly as on the Mac: window.webkit.messageHandlers.buddy.postMessage({id, op, …}).
#![cfg_attr(windows, windows_subsystem = "windows")]
mod cloud;
mod hands;
mod physics;
mod store;
mod sys;
mod tools;

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
const BALL: (f64, f64) = (92.0, 92.0);
const OPEN: (f64, f64) = (440.0, 660.0);

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
    exit: bool,
}

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
    fn hwnd(&self) -> isize { sys::hwnd(&self.window) }
    fn pos(&self) -> (i32, i32) { self.window.outer_position().map(|p| (p.x, p.y)).unwrap_or((0, 0)) }
    fn size(&self) -> (i32, i32) { let s = self.window.outer_size(); (s.width as i32, s.height as i32) }

    /// "ball" (just Buddy) or "open" (the team panel), growing from the ball's corner of the screen.
    fn mode(&mut self, open: bool) {
        if open { self.stop_flying(); }
        let scale = self.window.scale_factor();
        let (l, t, r, b) = sys::work_area(self.hwnd());
        let ((x, y), (w, h)) = (self.pos(), self.size());
        let (lw, lh) = if open { OPEN } else { BALL };
        let (nw, nh) = ((lw * scale).round() as i32, (lh * scale).round() as i32);
        let right = x + w / 2 > (l + r) / 2;
        let bottom = y + h / 2 > (t + b) / 2;
        let nx = if right { x + w - nw } else { x };
        let ny = if bottom { y + h - nh } else { y };
        let m = (8.0 * scale) as i32;
        let nx = nx.clamp(l + m, (r - nw - m).max(l + m));
        let ny = ny.clamp(t + m, (b - nh - m).max(t + m));
        self.window.set_inner_size(LogicalSize::new(lw, lh));
        self.window.set_outer_position(PhysicalPosition::new(nx, ny));
        if open { self.window.set_focus(); }
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
        let s = self.physics.tick(self.pos(), self.size(), sys::work_area(self.hwnd()), self.window.scale_factor());
        self.window.set_outer_position(PhysicalPosition::new(s.x, s.y));
        self.emit("roll", json!({ "vx": s.vx, "hit": s.hit, "floor": s.floor }));
        if s.landed {
            self.ticking.store(false, Ordering::SeqCst);
            self.save_origin();
            self.emit("landed", json!(true));
            if std::env::var("STUPID_BUDDY_THROW").is_ok() { log(&format!("landed at {:?}", self.pos())); self.exit = true; }
        }
    }

    /// Hands Buddy may work: the red bar, clicks pass through Buddy, Buddy hides from its screenshots, Esc stops.
    fn hands_on(&mut self) {
        self.hands.active.store(true, Ordering::SeqCst);
        self.want_banner = true;
        let _ = self.window.set_ignore_cursor_events(true);
        sys::hide_from_capture(self.hwnd(), true);
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
    fn hands_off(&mut self) {
        self.hands.active.store(false, Ordering::SeqCst);
        self.want_banner = false;
        self.banner = None;
        let _ = self.window.set_ignore_cursor_events(false);
        sys::hide_from_capture(self.hwnd(), false);
    }
}

fn main() {
    let event_loop = EventLoopBuilder::<Ev>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let mut wb = WindowBuilder::new().with_title("The Stupid Buddy").with_inner_size(LogicalSize::new(BALL.0, BALL.1))
        .with_decorations(false).with_transparent(true).with_always_on_top(true).with_resizable(false).with_visible(false);
    // On the taskbar like any app (the red Hands bar below stays off it).
    #[cfg(windows)] { use tao::platform::windows::WindowBuilderExtWindows; wb = wb.with_undecorated_shadow(false); }
    let window = wb.build(&event_loop).expect("window");

    // Where the ball was left last time (if that's still on a screen), else the bottom-right corner.
    let (l, t, r, b) = sys::work_area(sys::hwnd(&window));
    let size = window.outer_size();
    let saved = store::get("ballOrigin").and_then(|v| Some((v.get(0)?.as_i64()? as i32, v.get(1)?.as_i64()? as i32)));
    let (x, y) = saved.filter(|&(x, y)| x >= l - 40 && x <= r - 40 && y >= t - 40 && y <= b - 40)
        .unwrap_or((r - size.width as i32 - (24.0 * window.scale_factor()) as i32, b - size.height as i32 - (24.0 * window.scale_factor()) as i32));
    window.set_outer_position(PhysicalPosition::new(x, y));
    window.set_visible(true);

    let ipc = proxy.clone();
    let view = WebViewBuilder::new()
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
        .with_initialization_script("window.__platform='windows';window.webkit={messageHandlers:{buddy:{postMessage:(m)=>window.ipc.postMessage(JSON.stringify(m))}}};")
        .with_ipc_handler(move |req| {
            // Only Buddy's own page may call the app (the Mac app checks the frame the same way).
            if req.uri().to_string().starts_with(origin()) { let _ = ipc.send_event(Ev::Ipc(req.body().clone())); }
        })
        .with_navigation_handler(|url| url.starts_with(origin()))
        .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
        .with_url(format!("{}/index.html", origin()))
        .build(&window).expect("webview");

    let mut app = App { proxy: proxy.clone(), window, view, physics: physics::Physics::new(), ticking: Arc::new(AtomicBool::new(false)),
        hands: hands::State::default(), banner: None, want_banner: false, exit: false };
    self_tests(&app);

    event_loop.run(move |event, target, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Ev::Ipc(body)) => handle(&mut app, &body),
            Event::UserEvent(Ev::Run(f)) => f(&mut app),
            Event::UserEvent(Ev::Tick) => app.tick(),
            Event::WindowEvent { event: WindowEvent::CloseRequested, window_id, .. } if window_id == app.window.id() => app.exit = true,
            _ => {}
        }
        if app.want_banner && app.banner.is_none() { app.banner = Some(banner(target)); }
        if app.exit { app.hands_off(); *flow = ControlFlow::Exit; }
    });
}

/// The red bar at the top of the screen while Hands Buddy works. Clicks go through it and screenshots skip it.
fn banner(target: &EventLoopWindowTarget<Ev>) -> (Window, WebView) {
    let mut wb = WindowBuilder::new().with_title("Buddy is using your computer").with_inner_size(LogicalSize::new(430.0, 34.0))
        .with_decorations(false).with_transparent(true).with_always_on_top(true).with_resizable(false).with_focused(false);
    #[cfg(windows)] { use tao::platform::windows::WindowBuilderExtWindows; wb = wb.with_skip_taskbar(true).with_undecorated_shadow(false); }
    let w = wb.build(target).expect("banner");
    let (l, t, r, _) = sys::work_area(sys::hwnd(&w));
    let width = w.outer_size().width as i32;
    w.set_outer_position(PhysicalPosition::new((l + r) / 2 - width / 2, t + (6.0 * w.scale_factor()) as i32));
    let _ = w.set_ignore_cursor_events(true);
    // Screenshots skip the bar, except in the showcase test, where the screenshots are the point.
    if std::env::var("STUPID_BUDDY_SHOWCASE").is_err() { sys::hide_from_capture(sys::hwnd(&w), true); }
    let v = WebViewBuilder::new().with_transparent(true).with_background_color((0, 0, 0, 0))
        .with_html(r#"<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent;overflow:hidden"><div style="height:34px;border-radius:17px;background:rgba(214,77,61,.96);color:#fff;font:600 13px 'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center">Buddy is using your computer · press Esc to stop</div>"#)
        .with_navigation_handler(|url| url.starts_with("about:") || url.starts_with("data:"))
        .build(&w).expect("banner view");
    (w, v)
}

fn handle(app: &mut App, body: &str) {
    let Ok(Value::Object(m)) = serde_json::from_str::<Value>(body) else { return };
    let id = m.get("id").and_then(Value::as_i64).unwrap_or(0);
    let op = m.get("op").and_then(Value::as_str).unwrap_or("").to_string();
    let f = |k: &str| m.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    match op.as_str() {
        "window" => { app.mode(m.get("mode").and_then(Value::as_str) == Some("open")); app.reply(id, Ok(json!(true))) }
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
        "hands.permissions" | "hands.askPermissions" => app.reply(id, Ok(json!({ "screen": true, "control": true }))),
        "hands.start" => {
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
        op if op.starts_with("hands.") => { let (s, op) = (app.hands.clone(), op.to_string()); app.work(id, move || hands::act(&op, &m, &s)) }
        op if op.starts_with("keys.") || op == "ai.request" || op == "ollama.request" => { let op = op.to_string(); app.work(id, move || cloud::handle(&op, &m)) }
        op => { let op = op.to_string(); app.work(id, move || tools::handle(&op, &m)) }
    }
}

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
    } else if std::env::var("STUPID_BUDDY_SHOWCASE").is_ok() {
        // Each "SHOT name" in the log is the moment the test machine photographs the screen (see windows.yml).
        later(r#"(async()=>{const L=(t)=>Native.call('log',{text:t});const W=(ms)=>new Promise(r=>setTimeout(r,ms));const S=async(n)=>{await L('SHOT '+n);await W(2500)};
localStorage.removeItem('look');Look.apply();await W(800);await S('1-ball');
open();await W(1200);await S('2-panel');
await showSettings();await W(500);Look.render(document.getElementById('lookBox'));await S('3-settings');
localStorage.setItem('look',JSON.stringify({shape:'eye',color:'mint',hat:'crown',name:'Pip'}));Look.apply();Look.render(document.getElementById('lookBox'));await W(400);await S('4-eye-settings');
hideSettings();close();await W(1200);await S('5-eye-ball');
await Native.call('hands.start',{task:'showcase'});await W(800);await S('6-hands-bar');await Native.call('hands.stop');
localStorage.removeItem('look');Look.apply();await L('DONE');Native.call('quit')})()"#.into());
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
