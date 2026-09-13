import streamdeck, { SingletonAction } from "@elgato/streamdeck";
import { execFile } from "node:child_process";

const FOCUS = 25, SHORT = 5, LONG = 15, ROUNDS = 4; // minutes; long break after ROUNDS focus sessions
const FONT = "Avenir Next, Helvetica Neue, sans-serif";
const SOUND = "/System/Library/Sounds/Glass.aiff";
const PALETTE = { focus: { bg: "#f3d9d3", fg: "#4a1d15", accent: "#e5533d" }, break: { bg: "#d3ece3", fg: "#123d2c", accent: "#2f9e6e" } };

/** Pure state machine: { phase: "focus"|"break", done: <focus sessions finished>, left: seconds, running, deadline } */
export const fresh = () => ({ phase: "focus", done: 0, left: FOCUS * 60, running: false, deadline: 0 });
export function next(s) { // phase that follows `s`, paused
  if (s.phase === "focus") { const done = s.done + 1; return { phase: "break", done, left: (done % ROUNDS ? SHORT : LONG) * 60, running: false, deadline: 0 }; }
  return { phase: "focus", done: s.done, left: FOCUS * 60, running: false, deadline: 0 };
}
const remaining = (s) => (s.running ? Math.max(0, Math.ceil((s.deadline - Date.now()) / 1000)) : s.left);
const total = (s) => (s.phase === "focus" ? FOCUS : s.done % ROUNDS ? SHORT : LONG) * 60;

class Pomodoro extends SingletonAction {
  manifestId = "com.artur.pomodoro.timer";
  s = fresh(); dials = new Set(); timer = null;

  onWillAppear(ev) { this.dials.add(ev.action); this.render(); }
  onWillDisappear(ev) { this.dials.delete(ev.action); }
  onDialDown() { this.s.running ? this.pause() : this.start(); }
  onDialRotate(ev) { this.s.left = Math.max(60, remaining(this.s) + ev.payload.ticks * 60); if (this.s.running) this.s.deadline = Date.now() + this.s.left * 1000; this.render(); }
  onTouchTap(ev) { this.pause(); this.s = ev.payload.hold ? fresh() : next(this.s); this.render(); }

  start() { this.s.running = true; this.s.deadline = Date.now() + this.s.left * 1000; this.timer = setInterval(() => this.tick(), 1000); this.render(); }
  pause() { this.s.left = remaining(this.s); this.s.running = false; clearInterval(this.timer); this.render(); }
  tick() {
    if (remaining(this.s) > 0) return this.render();
    const finished = this.s.phase; this.pause(); this.s = next(this.s); this.render();
    execFile("afplay", [SOUND]);
    execFile("osascript", ["-e", `display notification "${finished === "focus" ? "Take a break" : "Back to focus"}" with title "Pomodoro"`]);
  }
  render() {
    const s = this.s, p = PALETTE[s.phase], left = remaining(s), frac = 1 - left / total(s);
    const mm = String(Math.floor(left / 60)), ss = String(left % 60).padStart(2, "0");
    const r = 34, c = 2 * Math.PI * r, dots = Array.from({ length: ROUNDS }, (_, i) => `<circle cx="${16 + i * 14}" cy="86" r="4" fill="${p.accent}" opacity="${i < s.done % ROUNDS || (s.done && s.done % ROUNDS === 0 && s.phase === "break") ? 1 : 0.25}"/>`).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
<rect width="200" height="100" fill="${p.bg}"/>
<text x="12" y="52" font-family="${FONT}" font-size="40" font-weight="600" fill="${p.fg}" opacity="${s.running ? 1 : 0.55}">${mm}:${ss}</text>
<text x="12" y="70" font-family="${FONT}" font-size="12" font-weight="600" letter-spacing="1.5" fill="${p.fg}" opacity="0.7">${s.phase === "focus" ? "FOCUS" : s.done % ROUNDS ? "BREAK" : "LONG BREAK"}${s.running ? "" : " · PAUSED"}</text>
${dots}
<circle cx="154" cy="50" r="${r}" fill="none" stroke="${p.fg}" stroke-opacity="0.12" stroke-width="7"/>
<circle cx="154" cy="50" r="${r}" fill="none" stroke="${p.accent}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(c * frac).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 154 50)"/>
<text x="154" y="55" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="600" fill="${p.fg}" opacity="0.8">${s.done}</text>
</svg>`;
    const panel = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
    for (const d of this.dials) d.setFeedback({ panel });
  }
}

if (process.argv.includes("--check")) { // node bin/plugin.js --check
  const assert = (await import("node:assert")).strict;
  let s = fresh(); assert.equal(s.left, FOCUS * 60);
  for (let i = 1; i <= ROUNDS; i++) { s = next(s); assert.equal(s.phase, "break"); assert.equal(s.left, (i < ROUNDS ? SHORT : LONG) * 60); s = next(s); assert.equal(s.phase, "focus"); }
  assert.equal(s.done, ROUNDS); console.log("ok");
} else {
  streamdeck.actions.registerAction(new Pomodoro());
  streamdeck.connect();
}
