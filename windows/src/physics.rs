// Buddy can be thrown (mac/Sources/Physics.swift): let go of the ball and it flies, bounces off the edges of the
// screen and lands on the bottom (above the taskbar). Works in screen pixels with y going down; a timer thread
// sends a tick 60 times a second while the ball flies, and main.rs moves the window.
pub struct Physics {
    pub flying: bool,
    vel: (f64, f64),
    last: std::time::Instant,
    resting: u32,
}
/// What one step did: where the window goes, and what the page needs to spin and squash the ball.
pub struct Step { pub x: i32, pub y: i32, pub vx: f64, pub hit: f64, pub floor: bool, pub landed: bool }

const GRAVITY: f64 = 2600.0;
const BOUNCE: f64 = 0.52;
const FLOOR_FRICTION: f64 = 0.82;
const AIR: f64 = 0.995;

impl Physics {
    pub fn new() -> Physics { Physics { flying: false, vel: (0.0, 0.0), last: std::time::Instant::now(), resting: 0 } }
    /// Let go with this speed (screen pixels per second).
    pub fn release(&mut self, vx: f64, vy: f64) {
        self.vel = (vx.clamp(-5000.0, 5000.0), vy.clamp(-5000.0, 5000.0));
        self.resting = 0;
        self.last = std::time::Instant::now();
        self.flying = true;
    }
    pub fn stop(&mut self) { self.flying = false; self.vel = (0.0, 0.0); }

    /// One step. pos/size: the window; area: the screen's usable part (left, top, right, bottom); scale: pixels per point.
    pub fn tick(&mut self, pos: (i32, i32), size: (i32, i32), area: (i32, i32, i32, i32), scale: f64) -> Step {
        let now = std::time::Instant::now();
        let dt = now.duration_since(self.last).as_secs_f64().min(1.0 / 30.0);
        self.last = now;
        let (mut x, mut y) = (pos.0 as f64, pos.1 as f64);
        let (w, h) = (size.0 as f64, size.1 as f64);
        let (l, t, r, b) = (area.0 as f64, area.1 as f64, area.2 as f64, area.3 as f64);
        self.vel.1 += GRAVITY * scale * dt;
        self.vel.0 *= AIR;
        x += self.vel.0 * dt;
        y += self.vel.1 * dt;
        let mut hit: f64 = 0.0;
        if x < l { x = l; hit = hit.max(self.vel.0.abs()); self.vel.0 = -self.vel.0 * BOUNCE; }
        if x + w > r { x = r - w; hit = hit.max(self.vel.0.abs()); self.vel.0 = -self.vel.0 * BOUNCE; }
        if y < t { y = t; hit = hit.max(self.vel.1.abs()); self.vel.1 = -self.vel.1 * BOUNCE; }
        let mut floor = false;
        if y + h >= b {
            y = b - h;
            if self.vel.1 > 0.0 { hit = hit.max(self.vel.1.abs()); self.vel.1 = -self.vel.1 * BOUNCE; }
            if self.vel.1.abs() < 120.0 * scale { self.vel.1 = 0.0; floor = true; }
            if floor { self.vel.0 *= FLOOR_FRICTION; }
        }
        if floor && self.vel.0.abs() < 15.0 * scale { self.resting += 1 } else { self.resting = 0 }
        let landed = self.resting > 6;
        if landed { self.stop(); }
        Step { x: x.round() as i32, y: y.round() as i32, vx: self.vel.0 / scale, hit: hit / scale, floor, landed }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_throw_lands_on_the_floor() {
        let mut p = Physics::new();
        p.release(1800.0, -1200.0);
        let (mut pos, mut frames) = ((200, 300), 0);
        loop {
            p.last -= std::time::Duration::from_millis(16);
            let s = p.tick(pos, (92, 92), (0, 0, 1920, 1040), 1.0);
            pos = (s.x, s.y);
            frames += 1;
            if s.landed || frames > 5000 { break; }
        }
        assert!(frames < 5000, "never landed");
        assert_eq!(pos.1, 1040 - 92);
        assert!(pos.0 >= 0 && pos.0 <= 1920 - 92);
    }
}
