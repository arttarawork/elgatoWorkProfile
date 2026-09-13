// Spotify Web API (read-only): next track from the queue, previous from listening history.
// Needs a Spotify developer app (developer.spotify.com/dashboard) with redirect URI http://127.0.0.1:8888/callback
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import streamdeck from "@elgato/streamdeck";

try { process.loadEnvFile(new URL("../.env", import.meta.url).pathname); } catch {} // <plugin>/.env, git-ignored
export const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID ?? "PASTE_YOUR_SPOTIFY_CLIENT_ID";
const REDIRECT = "http://127.0.0.1:8888/callback";
const SCOPES = "user-read-playback-state user-read-recently-played";
let token = null;        // { access, refresh, exp }
let authOpened = false;  // the browser login is offered once per plugin launch

async function tokenRequest(params) {
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  if (!r.ok) throw new Error(`token ${r.status} ${await r.text()}`);
  const j = await r.json();
  token = { access: j.access_token, refresh: j.refresh_token ?? token?.refresh, exp: Date.now() + (j.expires_in - 60) * 1000 };
  await streamdeck.settings.setGlobalSettings({ refresh: token.refresh });
}

/** Opens the Spotify consent page in the browser and waits for the redirect on 127.0.0.1:8888. */
export function authorize() {
  if (authOpened || CLIENT_ID.startsWith("PASTE")) return;
  authOpened = true;
  streamdeck.logger.info("authorize: opening Spotify consent page");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const srv = createServer(async (req, res) => {
    const code = new URL(req.url, REDIRECT).searchParams.get("code");
    if (!code) return res.writeHead(404).end();
    try { await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }); res.end("Spotify linked - you can close this tab."); }
    catch (e) { streamdeck.logger.error(e); res.end(String(e)); }
    srv.close();
  }).listen(8888, "127.0.0.1");
  const url = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
    client_id: CLIENT_ID, response_type: "code", redirect_uri: REDIRECT, scope: SCOPES, code_challenge_method: "S256", code_challenge: challenge });
  execFile("open", [url]);
}

async function api(path) {
  if (!token) {
    const { refresh } = await streamdeck.settings.getGlobalSettings();
    streamdeck.logger.info(`api: refresh token ${refresh ? "present" : "absent"}`);
    if (refresh) token = { refresh, exp: 0 }; else { authorize(); return null; }
  }
  if (Date.now() > token.exp) {
    try { await tokenRequest({ grant_type: "refresh_token", refresh_token: token.refresh }); }
    catch (e) { streamdeck.logger.error(e); token = null; await streamdeck.settings.setGlobalSettings({}); authorize(); return null; }
  }
  const r = await fetch("https://api.spotify.com/v1" + path, { headers: { Authorization: `Bearer ${token.access}` } });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

const img = (t) => t?.album?.images?.at(-1)?.url ?? null; // images are largest-first; the last is 64px

const ctxCache = new Map(); // context uri -> { at, list: [{ id, img }] }
/** Track order of an album or playlist context (paged, cached 10 min). */
async function contextTracks(ctx) {
  const hit = ctxCache.get(ctx.uri);
  if (hit && Date.now() - hit.at < 600_000) return hit.list;
  const id = ctx.uri.split(":").pop(), list = [];
  if (ctx.type === "album") {
    const a = await api(`/albums/${id}`);
    const cover = a.images?.at(-1)?.url ?? null;
    for (let page = a.tracks, n = 0; page && n < 10; n++) {
      for (const t of page.items) list.push({ id: t.id, img: cover });
      page = page.next && (await api(page.next.replace("https://api.spotify.com/v1", "")));
    }
  } else {
    let url = `/playlists/${id}/tracks?limit=100&fields=next,items(track(id,album(images)))`;
    for (let n = 0; url && n < 10; n++) { // ponytail: first 1000 tracks only
      const page = await api(url);
      for (const it of page.items) list.push({ id: it.track?.id, img: img(it.track) });
      url = page.next?.replace("https://api.spotify.com/v1", "");
    }
  }
  if (ctxCache.size > 10) ctxCache.delete(ctxCache.keys().next().value);
  ctxCache.set(ctx.uri, { at: Date.now(), list });
  return list;
}

/** @returns {Promise<{next: string|null, prev: string|null}>} 64px album-art URLs of the neighbouring tracks. */
export async function neighbours() {
  const pl = await api("/me/player");
  const ctx = pl?.context, cur = pl?.item?.id;
  let prev = null, next = null;
  // Exact order from the album/playlist when not shuffling (Spotify-generated 37i9dQZF1E… mixes are API-hidden).
  if (ctx && cur && !pl.shuffle_state && ["album", "playlist"].includes(ctx.type) && !ctx.uri.includes("37i9dQZF1E")) {
    const list = await contextTracks(ctx).catch((e) => { // hidden/curated playlists 403: remember that for 10 min
      streamdeck.logger.warn(String(e)); ctxCache.set(ctx.uri, { at: Date.now(), list: [] }); return null; });
    const i = list?.findIndex((t) => t.id === cur) ?? -1;
    if (i > 0) prev = list[i - 1].img;
    if (i >= 0 && i + 1 < list.length) next = list[i + 1].img;
  }
  const q = await api("/me/player/queue");
  next = img(q?.queue?.[0]) ?? next; // the explicit queue wins
  if (!prev) prev = img((await api("/me/player/recently-played?limit=1"))?.items?.[0]?.track); // history fallback
  return { next, prev };
}

const cache = new Map(); // url -> data URI
/** Downloads (once) a small album image as a JPEG data URI for key images. */
export async function dataUri(url) {
  if (!url) return null;
  if (!cache.has(url)) {
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    cache.set(url, `data:image/jpeg;base64,${Buffer.from(await (await fetch(url)).arrayBuffer()).toString("base64")}`);
  }
  return cache.get(url);
}
