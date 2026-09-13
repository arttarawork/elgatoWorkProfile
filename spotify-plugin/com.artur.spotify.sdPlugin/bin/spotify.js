// macOS-only glue for the Spotify desktop app: AppleScript for control/state, sips for album art.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

/** Runs `script` inside `tell application "Spotify"` without launching Spotify if it is closed. */
export async function osa(script) {
  const src = `if application "Spotify" is running then\ntell application "Spotify"\n${script}\nend tell\nend if`;
  const { stdout } = await run("osascript", ["-e", src]);
  return stdout.trim();
}

/** @returns {Promise<null | {song, artist, artUrl, position, duration, volume, playing}>} */
export async function nowPlaying() {
  const out = await osa(`try
set t to current track
return (name of t) & tab & (artist of t) & tab & (artwork url of t) & tab & (player position as integer) & tab & (duration of t) & tab & (sound volume) & tab & (player state as string) & tab & shuffling & tab & repeating
on error
return ""
end try`);
  if (!out) return null;
  const [song, artist, artUrl, position, duration, volume, state, shuffling, repeating] = out.split("\t");
  return { song, artist, artUrl, position: +position, duration: Math.round(+duration / 1000), volume: +volume, playing: state === "playing", shuffling: shuffling === "true", repeating: repeating === "true" };
}

export const playPause = () => osa("playpause");
export const next = () => osa("next track");
export const prev = () => osa("previous track");
export const setShuffle = (on) => osa(`set shuffling to ${on}`);
export const setRepeat = (on) => osa(`set repeating to ${on}`);
export const setVolume = (v) => osa(`set sound volume to ${Math.max(0, Math.min(100, Math.round(v)))}`);

/**
 * Downloads album art; returns an 88px PNG data URI plus a tonal palette { bg, fg, accent }
 * derived from the artwork's dominant vivid hue (16x16 downscale).
 */
export async function albumArt(url, theme) {
  const base = join(tmpdir(), "sd-spotify-art");
  const jpg = `${base}.jpg`, png = `${base}.png`, bmp = `${base}.bmp`;
  await writeFile(jpg, Buffer.from(await (await fetch(url)).arrayBuffer()));
  await run("sips", ["-s", "format", "png", "-z", "88", "88", jpg, "--out", png]);
  await run("sips", ["-s", "format", "bmp", "-z", "16", "16", jpg, "--out", bmp]);
  return { image: `data:image/png;base64,${(await readFile(png)).toString("base64")}`, ...colorsFromBmp(await readFile(bmp), theme) };
}

/** 24-bit BMP → { bg, fg, accent } tonal palette built from the artwork's dominant vivid hue.
 *  Exported for the self-check. */
export function colorsFromBmp(buf, theme = "light") {
  const off = buf.readUInt32LE(10), w = buf.readInt32LE(18), h = Math.abs(buf.readInt32LE(22));
  const stride = (w * 3 + 3) & ~3, bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = off + y * stride + x * 3, c = [buf[i + 2], buf[i + 1], buf[i]], [hue, sat, lum] = rgb2hsl(c);
    const wgt = sat > 0.15 ? sat * Math.max(0.1, 1 - Math.abs(lum - 0.5) * 1.6) : 0; // vivid, mid-tone pixels count most
    const bin = bins[Math.floor(hue / 30) % 12];
    bin.w += wgt; bin.r += c[0] * wgt; bin.g += c[1] * wgt; bin.b += c[2] * wgt;
  }
  const top = bins.reduce((a, b) => (b.w > a.w ? b : a));
  const [hue, sat] = top.w > 0 ? rgb2hsl([top.r / top.w, top.g / top.w, top.b / top.w]) : [0, 0, 0];
  const s = top.w > 0 ? Math.min(Math.max(sat, 0.25), 0.6) : 0;  // tame neon, lift dull, keep greys grey
  // ponytail: two fixed tonal ladders; tweak the lightness numbers here to taste
  return theme === "dark"
    ? { bg: hsl(hue, s, 0.2), fg: hsl(hue, s * 0.5, 0.92), accent: hsl(hue, Math.max(s, 0.5), 0.62) }
    : { bg: hsl(hue, s, 0.74), fg: hsl(hue, s, 0.16), accent: hsl(hue, Math.max(s, 0.5), 0.4) };
}
function rgb2hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hsl(h, s, l) {
  const f = (n) => { const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return "#" + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}

export const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// Self-check: `node bin/spotify.js` (needs Spotify running with a track loaded).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const assert = (await import("node:assert")).strict;
  // solid red 2x2 BMP, top-down, no padding needed (2*3=6 → stride 8)
  const px = Buffer.alloc(8 * 2); for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) px.set([0, 0, 255], y * 8 + x * 3);
  const hdr = Buffer.alloc(54); hdr.writeUInt32LE(54, 10); hdr.writeInt32LE(2, 18); hdr.writeInt32LE(-2, 22);
  const pal = colorsFromBmp(Buffer.concat([hdr, px]));
  assert.deepEqual(pal, { bg: hsl(0, 0.6, 0.74), fg: hsl(0, 0.6, 0.16), accent: hsl(0, 0.6, 0.4) }); // red art → red-hued ladder
  assert.equal(hsl(0, 1, 0.5), "#ff0000"); assert.deepEqual(rgb2hsl([0, 0, 255]).map(Math.round), [240, 1, 1]);
  assert.equal(mmss(181), "3:01");
  const np = await nowPlaying();
  assert.ok(np && np.song && np.duration > 0, "Spotify state");
  const art = await albumArt(np.artUrl);
  assert.ok(art.image.startsWith("data:image/png;base64,") && /^#[0-9a-f]{6}$/.test(art.bg) && art.bg !== art.fg);
  console.log("ok", np.song, "—", np.artist, mmss(np.position) + "/" + mmss(np.duration), art.bg, art.fg, art.accent);
}
