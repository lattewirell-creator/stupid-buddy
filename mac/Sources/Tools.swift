// What the helpers can do with files and the web. Every file path must be inside a folder you allowed
// (Desktop, Documents and Downloads to start); moving, renaming, overwriting and deleting ask you first, in a
// Mac alert the AI can't answer for you. Deleting goes to the Trash, never straight away.
import Cocoa
import PDFKit

final class Tools {
  typealias Done = (Bool, Any?) -> Void
  weak var app: App?
  private let fm = FileManager.default
  private let work = DispatchQueue(label: "buddy.tools", qos: .userInitiated, attributes: .concurrent)

  /// Folders the helpers may touch.
  var roots: [URL] {
    get {
      let saved = UserDefaults.standard.stringArray(forKey: "roots")
      let paths = saved ?? ["Desktop", "Documents", "Downloads"].map { fm.homeDirectoryForCurrentUser.appendingPathComponent($0).path }
      return paths.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath() }
    }
    set { UserDefaults.standard.set(newValue.map(\.path), forKey: "roots") }
  }
  /// A path the helpers asked for, if it's inside an allowed folder ("~" works).
  private func allowed(_ raw: Any?) -> URL? {
    guard var s = raw as? String, !s.isEmpty, !s.contains("\0") else { return nil }
    if s.hasPrefix("~") { s = fm.homeDirectoryForCurrentUser.path + s.dropFirst() }
    if !s.hasPrefix("/") { s = fm.homeDirectoryForCurrentUser.appendingPathComponent(s).path }
    let u = URL(fileURLWithPath: s).standardizedFileURL
    let real = fm.fileExists(atPath: u.path) ? u.resolvingSymlinksInPath() : u.deletingLastPathComponent().resolvingSymlinksInPath().appendingPathComponent(u.lastPathComponent)
    return roots.contains { real.path == $0.path || real.path.hasPrefix($0.path + "/") } ? real : nil
  }
  private func outside(_ done: Done) { done(false, "That’s outside the folders I’m allowed to use (\(roots.map { ($0.path as NSString).abbreviatingWithTildeInPath }.joined(separator: ", "))). You can allow more folders in settings.") }
  private func ask(_ title: String, _ text: String, yes: String, _ go: @escaping () -> Void, _ done: @escaping Done) {
    DispatchQueue.main.async { [weak self] in
      guard let app = self?.app else { return done(false, "no window") }
      app.ask(title: title, text: text, yes: yes) { ok in if ok { go() } else { done(false, "You said no, so I didn’t do it.") } }
    }
  }
  private let short = { (u: URL) in (u.path as NSString).abbreviatingWithTildeInPath }

  func handle(_ op: String, _ m: [String: Any], done: @escaping Done) {
    switch op {
    case "files.roots": done(true, roots.map(short))
    case "files.addRoot": DispatchQueue.main.async { self.addRoot(done) }
    case "files.list": work.async { self.list(m, done) }
    case "files.read": work.async { self.read(m, done) }
    case "files.search": work.async { self.search(m, done) }
    case "files.mkdir":
      guard let u = allowed(m["path"]) else { return outside(done) }
      do { try fm.createDirectory(at: u, withIntermediateDirectories: true); done(true, "Made the folder \(short(u))") } catch { done(false, error.localizedDescription) }
    case "files.move":
      guard let from = allowed(m["from"]), let to0 = allowed(m["to"]) else { return outside(done) }
      guard fm.fileExists(atPath: from.path) else { return done(false, "There’s no \(short(from)).") }
      var isDir: ObjCBool = false
      let to = fm.fileExists(atPath: to0.path, isDirectory: &isDir) && isDir.boolValue ? to0.appendingPathComponent(from.lastPathComponent) : to0
      if fm.fileExists(atPath: to.path) { return done(false, "\(short(to)) already exists; I won’t overwrite it.") }
      let rename = from.deletingLastPathComponent() == to.deletingLastPathComponent()
      ask(rename ? "Rename “\(from.lastPathComponent)”?" : "Move “\(from.lastPathComponent)”?", rename ? "New name: \(to.lastPathComponent)" : "From \(short(from.deletingLastPathComponent()))\nTo \(short(to.deletingLastPathComponent()))", yes: rename ? "Rename" : "Move", {
        do { try self.fm.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true); try self.fm.moveItem(at: from, to: to); done(true, "Done: \(self.short(to))") } catch { done(false, error.localizedDescription) }
      }, done)
    case "files.moveMany": moveMany(m, done)
    case "files.trash":
      guard let u = allowed(m["path"]), fm.fileExists(atPath: u.path) else { return outside(done) }
      ask("Move “\(u.lastPathComponent)” to the Trash?", "You can get it back from the Trash.", yes: "Move to Trash", {
        do { try self.fm.trashItem(at: u, resultingItemURL: nil); done(true, "Moved to the Trash: \(u.lastPathComponent)") } catch { done(false, error.localizedDescription) }
      }, done)
    case "files.write":
      guard let u = allowed(m["path"]), let text = m["text"] as? String, text.utf8.count < 5_000_000 else { return outside(done) }
      let save = { do { try self.fm.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true); try text.write(to: u, atomically: true, encoding: .utf8); done(true, "Saved \(self.short(u))") } catch { done(false, error.localizedDescription) } }
      if fm.fileExists(atPath: u.path) { ask("Replace “\(u.lastPathComponent)”?", "It already exists. The old version will be gone.", yes: "Replace", save, done) } else { save() }
    case "files.reveal":
      guard let u = allowed(m["path"]) else { return outside(done) }
      DispatchQueue.main.async { NSWorkspace.shared.activateFileViewerSelecting([u]) }; done(true, true)
    case "files.open":
      guard let u = allowed(m["path"]) else { return outside(done) }
      DispatchQueue.main.async { NSWorkspace.shared.open(u) }; done(true, "Opened \(u.lastPathComponent)")
    case "web.search": work.async { self.webSearch(m, done) }
    case "web.fetch": work.async { self.webFetch(m, done) }
    case "web.open":
      guard let s = m["url"] as? String, let u = URL(string: s), ["http", "https"].contains(u.scheme ?? "") else { return done(false, "bad link") }
      DispatchQueue.main.async {
        let browser = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.emil.stupidbrowser")
        if let b = browser { NSWorkspace.shared.open([u], withApplicationAt: b, configuration: NSWorkspace.OpenConfiguration()) } else { NSWorkspace.shared.open(u) }
      }
      done(true, "Opened \(u.host ?? s)")
    case "clipboard.write":
      DispatchQueue.main.async { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(m["text"] as? String ?? "", forType: .string) }; done(true, "Copied")
    default: done(false, "unknown tool \(op)")
    }
  }

  private func addRoot(_ done: @escaping Done) {
    let p = NSOpenPanel(); p.canChooseDirectories = true; p.canChooseFiles = false; p.prompt = "Allow"; p.message = "Choose a folder your helpers may use."
    NSApp.activate(ignoringOtherApps: true)
    if p.runModal() == .OK, let u = p.url { roots = roots + [u.resolvingSymlinksInPath()] }
    done(true, roots.map(short))
  }
  private func list(_ m: [String: Any], _ done: Done) {
    guard let u = allowed(m["path"]) else { return outside(done) }
    let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
    guard let items = try? fm.contentsOfDirectory(at: u, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { return done(false, "I can’t open \(short(u)).") }
    let f = ISO8601DateFormatter(); f.formatOptions = [.withFullDate]
    let out: [[String: Any]] = items.prefix(400).map { i in
      let r = try? i.resourceValues(forKeys: Set(keys))
      return ["name": i.lastPathComponent, "folder": r?.isDirectory ?? false, "size": r?.fileSize ?? 0, "modified": r?.contentModificationDate.map { f.string(from: $0) } ?? ""]
    }
    done(true, ["path": short(u), "count": items.count, "items": out])
  }
  private func read(_ m: [String: Any], _ done: Done) {
    guard let u = allowed(m["path"]), fm.fileExists(atPath: u.path) else { return outside(done) }
    let ext = u.pathExtension.lowercased()
    var text: String?
    if ext == "pdf" { text = PDFDocument(url: u)?.string }
    else if ["rtf", "rtfd", "doc", "docx", "odt", "html", "htm", "webarchive"].contains(ext) { text = (try? NSAttributedString(url: u, options: [:], documentAttributes: nil))?.string }
    else if let d = try? Data(contentsOf: u), d.count < 20_000_000 { text = String(data: d, encoding: .utf8) ?? String(data: d, encoding: .isoLatin1) }
    guard let t = text else { return done(false, "I can’t read that kind of file (\(ext)).") }
    let limit = 60_000
    done(true, ["path": short(u), "text": String(t.prefix(limit)), "cut": t.count > limit])
  }
  /// Spotlight, only inside the allowed folders.
  private func search(_ m: [String: Any], _ done: Done) {
    let q = (m["query"] as? String ?? "").trimmingCharacters(in: .whitespaces)
    guard !q.isEmpty, q.count < 200 else { return done(false, "What should I look for?") }
    var out: [String] = []
    for r in roots {
      let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind"); p.arguments = ["-onlyin", r.path, "-name", q]
      let pipe = Pipe(); p.standardOutput = pipe; p.standardError = FileHandle.nullDevice
      try? p.run(); let data = pipe.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
      out += (String(data: data, encoding: .utf8) ?? "").split(separator: "\n").map { short(URL(fileURLWithPath: String($0))) }
      if out.count > 60 { break }
    }
    done(true, Array(out.prefix(60)))
  }
  /// Several moves at once, asked once ("tidy my Downloads").
  private func moveMany(_ m: [String: Any], _ done: @escaping Done) {
    guard let list = m["moves"] as? [[String: Any]], !list.isEmpty, list.count <= 300 else { return done(false, "No moves given.") }
    var plan: [(URL, URL)] = []
    for item in list {
      guard let from = allowed(item["from"]), let to0 = allowed(item["to"]), fm.fileExists(atPath: from.path) else { continue }
      var isDir: ObjCBool = false
      let to = (fm.fileExists(atPath: to0.path, isDirectory: &isDir) && isDir.boolValue) || to0.pathExtension.isEmpty && from.pathExtension.isEmpty == false ? to0.appendingPathComponent(from.lastPathComponent) : to0
      if !fm.fileExists(atPath: to.path) { plan.append((from, to)) }
    }
    guard !plan.isEmpty else { return done(false, "None of those files could be moved (missing, outside allowed folders, or already there).") }
    let preview = plan.prefix(12).map { "• \($0.0.lastPathComponent) → \(short($0.1.deletingLastPathComponent()))" }.joined(separator: "\n") + (plan.count > 12 ? "\n…and \(plan.count - 12) more" : "")
    ask("Move \(plan.count) file\(plan.count == 1 ? "" : "s")?", preview, yes: "Move them", {
      var moved = 0, failed: [String] = []
      for (a, b) in plan { do { try self.fm.createDirectory(at: b.deletingLastPathComponent(), withIntermediateDirectories: true); try self.fm.moveItem(at: a, to: b); moved += 1 } catch { failed.append(a.lastPathComponent) } }
      done(true, "Moved \(moved) of \(plan.count)." + (failed.isEmpty ? "" : " Couldn’t move: \(failed.prefix(5).joined(separator: ", "))"))
    }, done)
  }

  // MARK: web
  private func get(_ url: URL, _ timeout: TimeInterval = 20) -> (Data, String)? {
    var r = URLRequest(url: url, timeoutInterval: timeout)
    r.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) TheStupidBuddy/0.1", forHTTPHeaderField: "User-Agent")
    let sem = DispatchSemaphore(value: 0); var out: (Data, String)?
    URLSession.shared.dataTask(with: r) { d, resp, _ in if let d { out = (d, (resp as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? "") }; sem.signal() }.resume()
    _ = sem.wait(timeout: .now() + timeout + 2)
    return out
  }
  /// DuckDuckGo's plain HTML results: titles, links and snippets.
  private func webSearch(_ m: [String: Any], _ done: Done) {
    let q = (m["query"] as? String ?? "").trimmingCharacters(in: .whitespaces)
    guard !q.isEmpty, let u = URL(string: "https://html.duckduckgo.com/html/?q=" + (q.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")), let (d, _) = get(u),
          let html = String(data: d, encoding: .utf8) else { return done(false, "The search didn’t answer. Is the internet on?") }
    var results: [[String: String]] = []
    let blocks = html.components(separatedBy: "class=\"result__body\"").dropFirst()
    for b in blocks.prefix(8) {
      guard let href = capture(#"class="result__a" href="([^"]+)""#, b) else { continue }
      var link = href.replacingOccurrences(of: "&amp;", with: "&")
      if let r = URLComponents(string: link.hasPrefix("//") ? "https:" + link : link)?.queryItems?.first(where: { $0.name == "uddg" })?.value { link = r }
      results.append(["title": plain(capture(#"class="result__a"[^>]*>(.*?)</a>"#, b) ?? ""), "url": link, "snippet": plain(capture(#"class="result__snippet"[^>]*>(.*?)</a>"#, b) ?? "")])
    }
    done(true, results)
  }
  private func webFetch(_ m: [String: Any], _ done: Done) {
    guard let s = m["url"] as? String, let u = URL(string: s), ["http", "https"].contains(u.scheme ?? ""), let (d, type) = get(u) else { return done(false, "I couldn’t open that page.") }
    guard let html = String(data: d, encoding: .utf8) ?? String(data: d, encoding: .isoLatin1) else { return done(false, "That page isn’t text.") }
    if !type.contains("html") { return done(true, ["url": s, "title": "", "text": String(html.prefix(30_000))]) }
    let title = plain(capture(#"<title[^>]*>(.*?)</title>"#, html) ?? "")
    var body = html
    for tag in ["script", "style", "noscript", "svg", "nav", "footer", "header", "form"] { body = body.replacingOccurrences(of: "<\(tag)[\\s\\S]*?</\(tag)>", with: " ", options: [.regularExpression, .caseInsensitive]) }
    body = body.replacingOccurrences(of: "<(br|/p|/div|/li|/h[1-6]|/tr)[^>]*>", with: "\n", options: [.regularExpression, .caseInsensitive])
    let text = plain(body).replacingOccurrences(of: "\n\\s*\n\\s*\n+", with: "\n\n", options: .regularExpression)
    done(true, ["url": s, "title": title, "text": String(text.prefix(30_000))])
  }
  private func capture(_ pattern: String, _ s: String) -> String? {
    guard let re = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators, .caseInsensitive]),
          let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)), let r = Range(m.range(at: 1), in: s) else { return nil }
    return String(s[r])
  }
  private func plain(_ html: String) -> String {
    var t = html.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
    for (a, b) in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#x27;", "'"), ("&#39;", "'"), ("&nbsp;", " ")] { t = t.replacingOccurrences(of: a, with: b) }
    return t.replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
