// Hands Buddy: looks at the screen and clicks and types in other apps. Needs two Mac permissions (Screen
// Recording to see, Accessibility to click and type) and your OK for each task. While it works a red bar says
// so and Esc stops it at once. It never types into password fields, and clicks on things like Send, Buy or
// Delete ask you first.
import Cocoa
import ScreenCaptureKit

final class Hands {
  typealias Done = (Bool, Any?) -> Void
  unowned let app: App
  private(set) var active = false
  private var escGlobal: Any?, escLocal: Any?
  private var banner: NSPanel?
  private var lastScale: CGFloat = 1        // screenshot pixels per screen point
  private var displayOrigin = CGPoint.zero  // the shot display's top-left, in global points

  init(app: App) { self.app = app }

  func handle(_ op: String, _ m: [String: Any], done: @escaping Done) {
    switch op {
    case "hands.permissions": done(true, permissions())
    case "hands.askPermissions": askPermissions(); done(true, permissions())
    case "hands.start": start(m, done)
    case "hands.stop": stop(); done(true, true)
    case "hands.shot":
      guard active else { return done(false, "Hands Buddy isn’t allowed to act right now.") }
      shot(done)
    default:
      guard active else { return done(false, "Hands Buddy isn’t allowed to act right now.") }
      DispatchQueue.main.async { self.act(op, m, done) }
    }
  }

  // MARK: permissions
  private func permissions() -> [String: Bool] { ["screen": CGPreflightScreenCaptureAccess(), "control": AXIsProcessTrusted()] }
  private func askPermissions() {
    if !CGPreflightScreenCaptureAccess() { CGRequestScreenCaptureAccess() }
    if !AXIsProcessTrusted() { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) }
  }

  // MARK: one task: your OK, a visible bar, Esc to stop
  private func start(_ m: [String: Any], _ done: @escaping Done) {
    let p = permissions()
    guard p["screen"] == true, p["control"] == true else { DispatchQueue.main.async { self.askPermissions() }; return done(false, "permissions") }
    DispatchQueue.main.async {
      self.app.ask(title: "Let Buddy use your mouse and keyboard?", text: "For: \(m["task"] as? String ?? "this task")\n\nA red bar shows while Buddy works. Press Esc any time to stop it. It won’t type passwords, and it asks before clicking things like Send, Buy or Delete.", yes: "Let Buddy work") { ok in
        guard ok else { return done(false, "You said no, so Buddy didn’t touch anything.") }
        self.active = true
        self.showBanner()
        // Buddy steps aside: clicks pass through its window and the keyboard goes back to your app.
        self.app.panel.ignoresMouseEvents = true; self.app.panel.alphaValue = 0.75
        NSApp.deactivate()
        let stopper: (NSEvent) -> Void = { [weak self] e in if e.keyCode == 53, self?.active == true { self?.stop(); self?.app.emit("hands:stopped", "esc") } }
        self.escGlobal = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: stopper)
        self.escLocal = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in stopper(e); return e }
        done(true, true)
      }
    }
  }
  func stop() {
    active = false
    if let m = escGlobal { NSEvent.removeMonitor(m) }; if let m = escLocal { NSEvent.removeMonitor(m) }
    escGlobal = nil; escLocal = nil
    DispatchQueue.main.async { self.banner?.orderOut(nil); self.banner = nil; self.app.panel.ignoresMouseEvents = false; self.app.panel.alphaValue = 1 }
  }
  private func showBanner() {
    guard banner == nil, let screen = NSScreen.main else { return }
    let w: CGFloat = 430, h: CGFloat = 34
    let p = NSPanel(contentRect: NSRect(x: screen.frame.midX - w / 2, y: screen.visibleFrame.maxY - h - 6, width: w, height: h), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.level = .statusBar; p.isOpaque = false; p.backgroundColor = .clear; p.ignoresMouseEvents = true; p.hasShadow = true
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    let pill = NSView(frame: NSRect(x: 0, y: 0, width: w, height: h))
    pill.wantsLayer = true; pill.layer?.cornerRadius = h / 2; pill.layer?.backgroundColor = NSColor(srgbRed: 0.84, green: 0.30, blue: 0.24, alpha: 0.96).cgColor
    let label = NSTextField(labelWithString: "Buddy is using your computer · press Esc to stop")
    label.alignment = .center; label.textColor = .white; label.font = .systemFont(ofSize: 13, weight: .semibold)
    label.frame = NSRect(x: 0, y: (h - 17) / 2, width: w, height: 17)
    pill.addSubview(label); p.contentView = pill; p.orderFrontRegardless(); banner = p
  }

  // MARK: seeing
  /// The main screen as a JPEG (Buddy's own windows left out), at most 1280 px wide.
  private func shot(_ done: @escaping Done) {
    Task {
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else { return done(false, "no screen") }
        let mine = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
        let filter = SCContentFilter(display: display, excludingApplications: mine, exceptingWindows: [])
        let cfg = SCStreamConfiguration()
        let scale = min(1, 1280.0 / Double(display.width))
        cfg.width = Int(Double(display.width) * scale); cfg.height = Int(Double(display.height) * scale); cfg.showsCursor = true
        let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        guard let jpg = NSBitmapImageRep(cgImage: img).representation(using: .jpeg, properties: [.compressionFactor: 0.6]) else { return done(false, "no picture") }
        self.lastScale = CGFloat(scale); self.displayOrigin = CGDisplayBounds(display.displayID).origin
        done(true, ["image": jpg.base64EncodedString(), "width": cfg.width, "height": cfg.height])
      } catch { done(false, error.localizedDescription) }
    }
  }

  // MARK: acting (x, y are in the last screenshot's pixels)
  private func point(_ m: [String: Any]) -> CGPoint {
    CGPoint(x: displayOrigin.x + CGFloat(m["x"] as? Double ?? 0) / lastScale, y: displayOrigin.y + CGFloat(m["y"] as? Double ?? 0) / lastScale)
  }
  private static let risky = try! NSRegularExpression(pattern: "\\b(send|buy|pay|purchase|order|checkout|delete|remove|erase|trash|submit|post|publish|transfer|confirm|sign out|log out|uninstall)\\b", options: .caseInsensitive)
  private func act(_ op: String, _ m: [String: Any], _ done: @escaping Done) {
    switch op {
    case "hands.click", "hands.doubleClick", "hands.rightClick":
      let what = m["what"] as? String ?? ""
      let go = { self.click(op, self.point(m)); done(true, "Clicked \(what.isEmpty ? "there" : what)") }
      if Hands.risky.firstMatch(in: what, range: NSRange(what.startIndex..., in: what)) != nil {
        app.ask(title: "Click “\(what)”?", text: "Buddy wants to click something that might send, buy or delete. Only you can say yes.", yes: "Click it") { ok in
          NSApp.deactivate()
          if ok && self.active { go() } else { done(false, "You said no, so Buddy didn’t click it.") }
        }
      } else { go() }
    case "hands.type":
      if focusedIsPassword() { return done(false, "That’s a password field. Buddy doesn’t type passwords; please type it yourself.") }
      type(String((m["text"] as? String ?? "").prefix(2000))); done(true, "Typed")
    case "hands.key":
      guard let (code, flags) = keyCode(m["keys"] as? String ?? "") else { return done(false, "I don’t know that key.") }
      let src = CGEventSource(stateID: .hidSystemState)
      let d = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true), u = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
      d?.flags = flags; u?.flags = flags; d?.post(tap: .cghidEventTap); usleep(30_000); u?.post(tap: .cghidEventTap)
      done(true, "Pressed \(m["keys"] as? String ?? "")")
    case "hands.scroll":
      let src = CGEventSource(stateID: .hidSystemState), p = point(m)
      CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
      let amount = Int32(max(-30, min(30, (m["amount"] as? Int) ?? -5)))
      CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 1, wheel1: amount, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
      done(true, "Scrolled")
    case "hands.openApp":
      let name = m["name"] as? String ?? ""
      guard !name.isEmpty, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) ?? findApp(name) else { return done(false, "I couldn’t find an app called \(name).") }
      NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, err in done(err == nil, err == nil ? "Opened \(name)" : "I couldn’t open \(name).") }
    default: done(false, "unknown")
    }
  }
  private func findApp(_ name: String) -> URL? {
    for dir in ["/Applications", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"] {
      let u = URL(fileURLWithPath: dir).appendingPathComponent(name.hasSuffix(".app") ? name : name + ".app")
      if FileManager.default.fileExists(atPath: u.path) { return u }
    }
    return nil
  }
  private func click(_ op: String, _ p: CGPoint) {
    let src = CGEventSource(stateID: .hidSystemState)
    let right = op == "hands.rightClick"
    let (down, up, button): (CGEventType, CGEventType, CGMouseButton) = right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
    CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: button)?.post(tap: .cghidEventTap)
    usleep(60_000)
    for n in 1...(op == "hands.doubleClick" ? 2 : 1) {
      let d = CGEvent(mouseEventSource: src, mouseType: down, mouseCursorPosition: p, mouseButton: button), u = CGEvent(mouseEventSource: src, mouseType: up, mouseCursorPosition: p, mouseButton: button)
      d?.setIntegerValueField(.mouseEventClickState, value: Int64(n)); u?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
      d?.post(tap: .cghidEventTap); usleep(40_000); u?.post(tap: .cghidEventTap); usleep(80_000)
    }
  }
  private func type(_ text: String) {
    let src = CGEventSource(stateID: .hidSystemState)
    let units = Array(text.utf16)
    var i = 0
    while i < units.count {
      let chunk = Array(units[i..<min(i + 20, units.count)]); i += 20
      let d = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true), u = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
      d?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk); u?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
      d?.post(tap: .cghidEventTap); u?.post(tap: .cghidEventTap); usleep(25_000)
    }
  }
  /// Is the text field with the keyboard focus a password field?
  private func focusedIsPassword() -> Bool {
    var el: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString, &el) == .success, let e = el else { return false }
    var role: CFTypeRef?
    AXUIElementCopyAttributeValue(e as! AXUIElement, kAXSubroleAttribute as CFString, &role)
    return (role as? String) == (kAXSecureTextFieldSubrole as String)
  }
  private func keyCode(_ combo: String) -> (CGKeyCode, CGEventFlags)? {
    let parts = combo.lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
    var flags: CGEventFlags = []
    for p in parts.dropLast() {
      switch p { case "cmd", "command": flags.insert(.maskCommand); case "shift": flags.insert(.maskShift); case "alt", "option": flags.insert(.maskAlternate); case "ctrl", "control": flags.insert(.maskControl); default: return nil }
    }
    let keys: [String: CGKeyCode] = ["return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
      "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
      "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29, "pageup": 116, "pagedown": 121, "home": 115, "end": 119]
    guard let last = parts.last, let code = keys[last] else { return nil }
    return (code, flags)
  }
}
