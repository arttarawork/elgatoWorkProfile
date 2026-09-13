import streamdeck, { SingletonAction } from "@elgato/streamdeck";
import * as sp from "./spotify.js";
import * as web from "./web.js";

const VOL_STEP = 5;      // volume % per dial tick
const TICK_MS = 250;     // scroll step; Spotify is polled every 4th tick (1 s)
const THEME = "light";   // "light" = pale tint + dark text (the mockup); "dark" = deep tint + light text
const FONT = "Avenir Next, Helvetica Neue, sans-serif";
const SCROLL_PX = 4;     // marquee pixels per tick
const CHAR_W = 0.56;     // ponytail: text width estimate = chars * size * CHAR_W (no font metrics in the plugin); raise if long titles get clipped

let np = null;           // last nowPlaying() result
let mutedFrom = 0;       // volume before mute (0 = not muted)
const keys = new Set();  // visible prev/play-pause/next keys (coloured from the album art)
const GLYPH = {
  prev: '<path d="M20 18h6v36h-6z"/><path d="M52 18 28 36l24 18z"/>',
  play: '<path d="M26 16v40l30-20z"/>',
  pause: '<path d="M22 18h10v36H22zM40 18h10v36H40z"/>',
  next: '<path d="M46 18h6v36h-6z"/><path d="M20 18l24 18-24 18z"/>',
  shuffle: '<path d="M14 22h8c6 0 9 4 12 9s6 9 12 9h6M14 50h8c6 0 9-4 12-9s6-9 12-9h6" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M50 16l10 6-10 6zM50 44l10 6-10 6z"/>',
  repeat: '<path d="M20 30v-4a8 8 0 0 1 8-8h22M52 42v4a8 8 0 0 1-8 8H22" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M46 10l10 8-10 8zM26 46l-10 8 10 8z"/>',
  modeoff: '<g opacity="0.35"><path d="M14 22h8c6 0 9 4 12 9s6 9 12 9h6M14 50h8c6 0 9-4 12-9s6-9 12-9h6" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M50 16l10 6-10 6zM50 44l10 6-10 6z"/></g>',
};
const modeGlyph = () => (np?.shuffling ? "shuffle" : np?.repeating ? "repeat" : "modeoff");
const keyImage = (glyph, cover) => "data:image/svg+xml;base64," + Buffer.from(cover
  ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><image width="72" height="72" href="${cover}"/><circle cx="36" cy="36" r="17" fill="#000" opacity="0.55"/><g fill="#fff" transform="translate(36 36) scale(0.55) translate(-36 -36)">${GLYPH[glyph]}</g></svg>`
  : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><rect width="72" height="72" rx="12" fill="${art.bg}"/><g fill="${art.fg}" color="${art.fg}">${GLYPH[glyph]}</g></svg>`).toString("base64");

async function pollNeighbours() {
  const n = await web.neighbours();
  nb = { next: await web.dataUri(n.next), prev: await web.dataUri(n.prev) };
}
const dials = new Set(); // visible now-playing dials
let nb = { next: null, prev: null }; // data URIs of neighbouring album art (Web API)
let prevArt = null;                  // cover of the track that played before the current one
let timer, tick = 0, art = { url: null, image: null, bg: "#222222", fg: "#ffffff", accent: "#1DB954" };

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** One line of text inside a clip box; scrolls left in a loop when wider than `box`. */
function line(text, x, y, size, weight, box, opacity = 1) {
  const w = text.length * size * CHAR_W, gap = 40;
  const t = (dx) => `<text x="${x + dx}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${art.fg}" opacity="${opacity}">${esc(text)}</text>`;
  if (w <= box) return t(0);
  const off = (tick * SCROLL_PX) % (w + gap);
  return `<g clip-path="url(#clip)">${t(-off)}${t(w + gap - off)}</g>`;
}
function panel() {
  const pct = np.duration ? np.position / np.duration : 0;
  return "data:image/svg+xml;base64," + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
<defs><clipPath id="clip"><rect x="0" y="0" width="104" height="100"/></clipPath><clipPath id="art"><rect x="110" y="8" width="84" height="84" rx="6"/></clipPath></defs>
<rect width="200" height="100" fill="${art.bg}"/>
<rect x="0" y="0" width="200" height="4" fill="${art.fg}" opacity="0.15"/><rect x="0" y="0" width="${(200 * pct).toFixed(1)}" height="4" fill="${art.accent}"/>
${line(np.song, 8, 36, 17, 600, 96)}
${line(np.artist, 8, 60, 16, 400, 96, 0.8)}
<text x="104" y="91" text-anchor="end" font-family="${FONT}" font-size="15" fill="${art.fg}" opacity="0.7">${sp.mmss(np.position)} / ${sp.mmss(np.duration)}</text>
${art.image ? `<image x="110" y="8" width="84" height="84" href="${art.image}" clip-path="url(#art)"/>` : ""}
</svg>`).toString("base64");
}

async function refresh() {
  if (tick++ % 4 === 0) np = await sp.nowPlaying().catch(() => null);
  if (tick % 20 === 1 && np) pollNeighbours().catch((e) => { nb = { next: null, prev: null }; streamdeck.logger.warn(String(e)); });
  const playing = !!np?.playing;
  if (np?.artUrl && np.artUrl !== art.url) {
    if (art.image) prevArt = art.image;
    art = { url: np.artUrl, ...(await sp.albumArt(np.artUrl, THEME).catch(() => ({ image: null, bg: "#222222", fg: "#ffffff", accent: "#1DB954" }))) };
    tick = 1; // restart the scroll on a new track
  }
  const fb = { panel: np ? panel() : "imgs/dial.svg" };
  for (const d of dials) d.setFeedback(fb);
  for (const k of keys) {
    const kind = k.manifestId.split(".").pop();
    const glyph = kind === "playpause" ? (playing ? "pause" : "play") : kind === "mode" ? modeGlyph() : kind;
    const img = keyImage(glyph, glyph === "prev" ? prevArt ?? nb.prev : nb[glyph]);
    if (k._img !== img) { k._img = img; k.setImage(img); }
  }
}

function track(set, ev, on) {
  on ? set.add(ev.action) : set.delete(ev.action);
  streamdeck.logger.info(`${on ? "appear" : "disappear"} ${ev.action.manifestId} keys=${keys.size} dials=${dials.size}`);
  if (keys.size + dials.size === 0) { clearInterval(timer); timer = null; }
  else if (!timer) timer = setInterval(() => refresh().catch((e) => streamdeck.logger.error(e)), TICK_MS);
}

class Prev extends SingletonAction {
  manifestId = "com.artur.spotify.prev";
  onWillAppear(ev) { track(keys, ev, true); }
  onWillDisappear(ev) { track(keys, ev, false); }
  onKeyDown() { return sp.prev(); } }

class Next extends SingletonAction {
  manifestId = "com.artur.spotify.next";
  onWillAppear(ev) { track(keys, ev, true); }
  onWillDisappear(ev) { track(keys, ev, false); }
  onKeyDown() { return sp.next(); } }

class PlayPause extends SingletonAction {
  manifestId = "com.artur.spotify.playpause";
  onWillAppear(ev) { track(keys, ev, true); }
  onWillDisappear(ev) { track(keys, ev, false); }
  async onKeyDown() { await sp.playPause(); if (np) np.playing = !np.playing; refresh(); }
}

class NowPlaying extends SingletonAction {
  manifestId = "com.artur.spotify.nowplaying";
  onWillAppear(ev) { track(dials, ev, true); }
  onWillDisappear(ev) { track(dials, ev, false); }
  onTouchTap() { return sp.playPause(); }
  async onDialRotate(ev) {
    if (!np) return;
    np.volume = Math.max(0, Math.min(100, np.volume + ev.payload.ticks * VOL_STEP));
    mutedFrom = 0;
    await sp.setVolume(np.volume);
  }
  async onDialDown() {
    if (!np) return;
    if (np.volume > 0) { mutedFrom = np.volume; np.volume = 0; }
    else { np.volume = mutedFrom || 50; mutedFrom = 0; }
    await sp.setVolume(np.volume);
  }
}

class Mode extends SingletonAction { // one key cycling: off -> shuffle -> repeat -> off
  manifestId = "com.artur.spotify.mode";
  onWillAppear(ev) { track(keys, ev, true); }
  onWillDisappear(ev) { track(keys, ev, false); }
  async onKeyDown() {
    if (!np) return;
    if (np.shuffling) { np.shuffling = false; np.repeating = true; await sp.setShuffle(false); await sp.setRepeat(true); }
    else if (np.repeating) { np.repeating = false; await sp.setRepeat(false); }
    else { np.shuffling = true; await sp.setShuffle(true); }
    refresh();
  }
}

streamdeck.actions.registerAction(new Mode());
streamdeck.actions.registerAction(new Prev());
streamdeck.actions.registerAction(new Next());
streamdeck.actions.registerAction(new PlayPause());
streamdeck.actions.registerAction(new NowPlaying());
streamdeck.connect();
