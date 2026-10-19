// Online AIs with free keys (Google Gemini, Groq, OpenRouter): the key lives in the Mac's Keychain and is
// added here, on the Mac side, so the panel's page never sees it. All three speak the OpenAI chat format.
import Foundation
import Security

enum Keys {
  private static let service = "com.emil.stupidbuddy.ai"
  static func save(_ provider: String, _ key: String) -> Bool {
    delete(provider)
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: provider,
                            kSecValueData as String: Data(key.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
  }
  static func load(_ provider: String) -> String? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: provider,
                            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
    return String(data: d, encoding: .utf8)
  }
  @discardableResult static func delete(_ provider: String) -> Bool {
    SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: provider] as CFDictionary) == errSecSuccess
  }
}

enum Cloud {
  /// Where each service's OpenAI-style API lives. "local" is Ollama's own OpenAI-style door (used for testing).
  static let bases: [String: String] = [
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "groq": "https://api.groq.com/openai/v1/",
    "openrouter": "https://openrouter.ai/api/v1/",
    "local": "http://localhost:11434/v1/",
  ]
  static func handle(_ op: String, _ m: [String: Any], done: @escaping (Bool, Any?) -> Void) {
    let provider = m["provider"] as? String ?? ""
    switch op {
    case "keys.set":
      let key = (m["key"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      guard bases[provider] != nil, provider != "local", key.count >= 10, key.count <= 300, !key.contains(where: { $0.isWhitespace }) else { return done(false, "That doesn’t look like a key.") }
      done(true, Keys.save(provider, key))
    case "keys.has": done(true, Keys.load(provider) != nil)
    case "keys.remove": done(true, Keys.delete(provider))
    case "ai.request": request(provider, m, done)
    default: done(false, "unknown")
    }
  }
  /// One call to a service: path "chat/completions" (POST body) or "models" (GET). Returns { status, body }.
  private static func request(_ provider: String, _ m: [String: Any], _ done: @escaping (Bool, Any?) -> Void) {
    guard let base = bases[provider], let path = m["path"] as? String, ["chat/completions", "models"].contains(path), let url = URL(string: base + path) else { return done(false, "bad request") }
    var r = URLRequest(url: url, timeoutInterval: 180)
    if provider != "local" {
      guard let key = Keys.load(provider) else { return done(false, "nokey") }
      r.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
    }
    if provider == "openrouter" { r.setValue("https://thestupidcompany.net", forHTTPHeaderField: "HTTP-Referer"); r.setValue("The Stupid Buddy", forHTTPHeaderField: "X-Title") }
    if let body = m["body"] as? String {
      r.httpMethod = "POST"; r.httpBody = Data(body.utf8); r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    URLSession.shared.dataTask(with: r) { d, resp, err in
      if let err { return done(false, (err as NSError).code == NSURLErrorNotConnectedToInternet ? "offline" : err.localizedDescription) }
      done(true, ["status": (resp as? HTTPURLResponse)?.statusCode ?? 0, "body": String(data: d ?? Data(), encoding: .utf8) ?? ""])
    }.resume()
  }
}
