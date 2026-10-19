// Buddy can be thrown, like in The Stupid Browser: let go of the ball and it flies, bounces off the edges of the
// screen and lands on the bottom (above the Dock). The window moves here; the ball spins and squashes in the page.
import Cocoa

final class Physics {
  unowned let app: App
  private var timer: Timer?
  private var vel = CGVector.zero      // points per second (AppKit: y goes up)
  private var last = CACurrentMediaTime()
  private var resting = 0, frames = 0, bumps = 0
  private let gravity: CGFloat = 2600, bounce: CGFloat = 0.52, floorFriction: CGFloat = 0.82, air: CGFloat = 0.995

  init(app: App) { self.app = app }

  /// The ball was let go with this speed (screen pixels per second, y down, from the page).
  func release(vx: Double, vy: Double) {
    vel = CGVector(dx: max(-5000, min(5000, vx)), dy: max(-5000, min(5000, -vy)))
    resting = 0
    last = CACurrentMediaTime()
    if timer == nil {
      timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.tick() }
      RunLoop.main.add(timer!, forMode: .common)
    }
  }
  /// Picked up again (or the panel opened): stop flying.
  func stop() { timer?.invalidate(); timer = nil; vel = .zero }
  var flying: Bool { timer != nil }

  private func tick() {
    guard let panel = app.panel else { return stop() }
    let now = CACurrentMediaTime(), dt = CGFloat(min(1.0 / 30, now - last)); last = now
    let area = (panel.screen ?? NSScreen.main)?.visibleFrame ?? .zero
    var f = panel.frame
    vel.dy -= gravity * dt
    vel.dx *= air
    f.origin.x += vel.dx * dt
    f.origin.y += vel.dy * dt
    var hit: CGFloat = 0
    if f.minX < area.minX { f.origin.x = area.minX; hit = max(hit, abs(vel.dx)); vel.dx = -vel.dx * bounce }
    if f.maxX > area.maxX { f.origin.x = area.maxX - f.width; hit = max(hit, abs(vel.dx)); vel.dx = -vel.dx * bounce }
    if f.maxY > area.maxY { f.origin.y = area.maxY - f.height; hit = max(hit, abs(vel.dy)); vel.dy = -vel.dy * bounce }
    var onFloor = false
    if f.minY <= area.minY {
      f.origin.y = area.minY
      if vel.dy < 0 { hit = max(hit, abs(vel.dy)); vel.dy = -vel.dy * bounce }
      if vel.dy < 120 { vel.dy = 0; onFloor = true }
      vel.dx *= onFloor ? floorFriction : 1
    }
    panel.setFrameOrigin(f.origin)
    frames += 1; if hit > 300 { bumps += 1 }
    // The page spins the ball by how fast it rolls, and squashes it on hard bumps.
    app.emit("roll", ["vx": Double(vel.dx), "hit": Double(hit), "floor": onFloor])
    if onFloor && abs(vel.dx) < 15 { resting += 1 } else { resting = 0 }
    if resting > 6 {
      stop()
      UserDefaults.standard.set(NSStringFromPoint(panel.frame.origin), forKey: "ballOrigin")
      app.emit("landed", true)
      if ProcessInfo.processInfo.environment["STUPID_BUDDY_THROW"] != nil { print("[buddy] landed at \(Int(panel.frame.minX)),\(Int(panel.frame.minY)) after \(frames) frames, \(bumps) bumps"); exit(0) }
    }
  }
}
