// The Stupid Buddy: Buddy on your desktop with a team of helpers that do work for you, powered by a free AI
// running on this Mac (Ollama). This file: the floating window (Buddy's ball, which opens into the team panel),
// the app:// pages, and the bridge the UI uses for native things (Tools.swift, Hands.swift).
import Cocoa
import WebKit

let resources: URL = {
  let bundled = Bundle.main.resourceURL!.appendingPathComponent("ui")
  if FileManager.default.fileExists(atPath: bundled.path) { return bundled }
  return URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("../../ui").standardizedFileURL   // dev runs
}()

/// app://buddy/… → the ui folder.
final class AppScheme: NSObject, WKURLSchemeHandler {
  func webView(_ w: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url else { return }
    let rel = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
    let target = resources.appendingPathComponent(rel).standardizedFileURL
    let types = ["html": "text/html", "js": "text/javascript", "css": "text/css", "svg": "image/svg+xml", "png": "image/png", "ttf": "font/ttf", "json": "application/json"]
    guard target.path.hasPrefix(resources.path), let data = try? Data(contentsOf: target) else {
      task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: nil, headerFields: nil)!); task.didFinish(); return
    }
    task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": types[target.pathExtension] ?? "application/octet-stream", "Cache-Control": "no-cache"])!)
    task.didReceive(data); task.didFinish()
  }
  func webView(_ w: WKWebView, stop task: WKURLSchemeTask) {}
}

/// A borderless panel that floats over other apps and can take typing.
final class BuddyPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

final class App: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
  var panel: BuddyPanel!
  var web: WKWebView!
  let tools = Tools()
  lazy var physics = Physics(app: self)
  lazy var hands = Hands(app: self)
  static let ballSize = NSSize(width: 92, height: 92)
  static let openSize = NSSize(width: 440, height: 660)

  /// Clicking Buddy's Dock icon opens the panel.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    web.evaluateJavaScript("open()", completionHandler: nil)
    return false
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let saved = UserDefaults.standard.string(forKey: "ballOrigin").map(NSPointFromString)
    let origin = saved ?? NSPoint(x: screen.maxX - App.ballSize.width - 24, y: screen.minY + 24)
    panel = BuddyPanel(contentRect: NSRect(origin: origin, size: App.ballSize), styleMask: [.borderless, .nonactivatingPanel, .resizable], backing: .buffered, defer: false)
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.isMovableByWindowBackground = false
    panel.hidesOnDeactivate = false

    let cfg = WKWebViewConfiguration()
    cfg.setURLSchemeHandler(AppScheme(), forURLScheme: "app")
    cfg.userContentController.add(self, name: "buddy")
    web = WKWebView(frame: NSRect(origin: .zero, size: App.ballSize), configuration: cfg)
    web.setValue(false, forKey: "drawsBackground")
    web.autoresizingMask = [.width, .height]
    web.navigationDelegate = self
    if #available(macOS 13.3, *) { web.isInspectable = true }
    panel.contentView = web
    web.load(URLRequest(url: URL(string: "app://buddy/index.html")!))
    panel.orderFrontRegardless()
    tools.app = self
    buildMenu()
    startCursorFeed()
  }

  /// The 3D Buddy looks at the cursor anywhere on the screen (and spins when you circle it): while Buddy is the closed
  /// ball, the cursor's position from Buddy's middle goes to the page whenever it moves (ui/ball3d.js).
  private var lastCursor = NSPoint(x: -1, y: -1)
  private func startCursorFeed() {
    Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
      guard let self, let panel = self.panel, panel.frame.size == App.ballSize else { return }
      let p = NSEvent.mouseLocation
      if p == self.lastCursor { return }
      self.lastCursor = p
      self.emit("cursor", ["dx": Double(p.x - panel.frame.midX), "dy": Double(panel.frame.midY - p.y)])
    }
  }

  private func buildMenu() {
    let main = NSMenu(), appItem = NSMenuItem(); main.addItem(appItem)
    let m = NSMenu()
    m.addItem(withTitle: "About The Stupid Buddy", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    m.addItem(.separator())
    m.addItem(withTitle: "Quit The Stupid Buddy", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = m
    let editItem = NSMenuItem(); main.addItem(editItem)
    let e = NSMenu(title: "Edit")
    for (t, s, k) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
      e.addItem(withTitle: t, action: Selector((s)), keyEquivalent: k)
    }
    editItem.submenu = e
    NSApp.mainMenu = main
  }

  /// Dev self-test: STUPID_BUDDY_ASK="…" opens the panel, asks the team, prints each step and the answer, then quits.
  func webView(_ w: WKWebView, didFinish _: WKNavigation!) {
    // Dev self-test: STUPID_BUDDY_THROW="vx,vy" throws the ball, prints where it goes, and quits when it lands.
    if let t = ProcessInfo.processInfo.environment["STUPID_BUDDY_THROW"] {
      let v = t.split(separator: ",").compactMap { Double($0) }
      print("[buddy] start \(Int(panel.frame.minX)),\(Int(panel.frame.minY)) screen \(Int(panel.screen?.visibleFrame.minY ?? 0))…\(Int(panel.screen?.visibleFrame.maxX ?? 0))")
      physics.release(vx: v.first ?? 0, vy: v.count > 1 ? v[1] : 0)
      return
    }
    // Dev check: STUPID_BUDDY_EVAL="expression" prints what the page says after 3 s, then quits.
    if let js = ProcessInfo.processInfo.environment["STUPID_BUDDY_EVAL"] {
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
        self.web.evaluateJavaScript("String(\(js))") { r, e in print("[buddy] EVAL \(r ?? e?.localizedDescription ?? "nil")"); fflush(stdout); exit(0) }
      }
      return
    }
    guard let q = ProcessInfo.processInfo.environment["STUPID_BUDDY_ASK"] else { return }
    window(["mode": "open"])
    web.evaluateJavaScript("window.__test(\(json(q)), \(json(ProcessInfo.processInfo.environment["STUPID_BUDDY_PROVIDER"] ?? "")))", completionHandler: nil)
  }

  // MARK: bridge
  func reply(_ id: Int, _ ok: Bool, _ value: Any?) {
    web.evaluateJavaScript("window.__native && __native.reply(\(id), \(ok), \(json(value)))", completionHandler: nil)
  }
  func emit(_ name: String, _ value: Any?) {
    web.evaluateJavaScript("window.__native && __native.emit(\(json(name)), \(json(value)))", completionHandler: nil)
  }

  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard m.frameInfo.isMainFrame, m.frameInfo.request.url?.scheme == "app",
          let msg = m.body as? [String: Any], let op = msg["op"] as? String else { return }
    let id = msg["id"] as? Int ?? 0
    let done: (Bool, Any?) -> Void = { [weak self] ok, v in DispatchQueue.main.async { self?.reply(id, ok, v) } }
    switch op {
    case "window": done(true, window(msg))
    case "drag": physics.stop(); drag(msg); done(true, true)
    case "release": physics.release(vx: msg["vx"] as? Double ?? 0, vy: msg["vy"] as? Double ?? 0); done(true, true)
    case "dragEnd": UserDefaults.standard.set(NSStringFromPoint(panel.frame.origin), forKey: "ballOrigin"); done(true, true)
    case "confirm": ask(title: msg["title"] as? String ?? "Allow this?", text: msg["text"] as? String ?? "", yes: msg["yes"] as? String ?? "Allow") { done(true, $0) }
    case "quit": done(true, true); NSApp.terminate(nil)
    case "log": print("[buddy] \(msg["text"] as? String ?? "")"); fflush(stdout); done(true, true)
    default:
      if op.hasPrefix("hands.") { hands.handle(op, msg, done: done) }
      else if op.hasPrefix("keys.") || op == "ai.request" { Cloud.handle(op, msg, done: done) }
      else { tools.handle(op, msg, done: done) }
    }
  }

  /// "ball" (just Buddy) or "open" (the team panel), growing from the ball's corner of the screen.
  /// The size changes at once (the page animates the panel itself, which is smoother than resizing the window
  /// frame by frame). Returns where Buddy's ball is inside the new window, in page coordinates.
  @discardableResult private func window(_ m: [String: Any]) -> [String: Double] {
    let open = (m["mode"] as? String) == "open"
    if open { physics.stop() }
    let size = open ? App.openSize : App.ballSize
    let screen = panel.screen?.visibleFrame ?? NSScreen.main!.visibleFrame
    var f = panel.frame
    let right = f.midX > screen.midX, top = f.midY > screen.midY
    let anchorX = right ? f.maxX : f.minX, anchorY = top ? f.maxY : f.minY
    f.size = size
    f.origin.x = right ? anchorX - size.width : anchorX
    f.origin.y = top ? anchorY - size.height : anchorY
    f.origin.x = min(max(f.origin.x, screen.minX + 8), screen.maxX - size.width - 8)
    f.origin.y = min(max(f.origin.y, screen.minY + 8), screen.maxY - size.height - 8)
    let ball = NSPoint(x: panel.frame.midX, y: panel.frame.midY)
    panel.setFrame(f, display: true, animate: false)
    if open { NSApp.activate(ignoringOtherApps: true); panel.makeKey() }
    return ["x": Double(ball.x - f.minX), "y": Double(f.maxY - ball.y)]
  }
  private func drag(_ m: [String: Any]) {
    let dx = m["dx"] as? Double ?? 0, dy = m["dy"] as? Double ?? 0
    var o = panel.frame.origin; o.x += dx; o.y -= dy
    panel.setFrameOrigin(o)
  }

  /// "Can I…?" before anything risky: a Mac alert that only you can answer (the AI can't fake or skip it).
  func ask(title: String, text: String, yes: String, _ done: @escaping (Bool) -> Void) {
    if panel.frame.size != App.openSize { window(["mode": "open"]) }
    let a = NSAlert()
    a.messageText = title
    a.informativeText = text
    a.addButton(withTitle: yes)
    a.addButton(withTitle: "Don’t")
    NSApp.activate(ignoringOtherApps: true)
    a.beginSheetModal(for: panel) { r in done(r == .alertFirstButtonReturn) }
  }
}

func json(_ v: Any?) -> String {
  guard let v = v, !(v is NSNull) else { return "null" }
  if let s = v as? String { return (try? String(data: JSONSerialization.data(withJSONObject: [s]), encoding: .utf8)).map { String($0.dropFirst().dropLast()) } ?? "null" }
  if JSONSerialization.isValidJSONObject(v), let d = try? JSONSerialization.data(withJSONObject: v), let s = String(data: d, encoding: .utf8) { return s }
  if let b = v as? Bool { return b ? "true" : "false" }
  if let n = v as? NSNumber { return n.stringValue }
  return "null"
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)   // in the Dock like any app; clicking the icon opens Buddy
app.run()
