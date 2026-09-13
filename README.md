# Stream Deck work profile

## Spotify plugin (`spotify-plugin/`)

Controls the **Spotify desktop app on the same Mac** via AppleScript (no Spotify developer app, no OAuth, no Premium needed).

Actions (drag them onto the deck in the Stream Deck app):
- **Previous / Play-Pause / Next / Shuffle-Repeat** keys. Previous and Next show the neighbouring covers, Play/Pause follows the player state, Shuffle/Repeat cycles off → shuffle → repeat → off and shows the current mode. Place them wherever you like (Artur: prev 35, next 36, play/pause 26).
- **Now Playing** → dial 6. Rotate = Spotify volume (5 % per tick), push = mute/unmute, touch = play/pause.
  The strip shows song, artist, position/duration and album art; background colour comes from the artwork, text is black or white for contrast; titles longer than ~13 chars scroll.

### Neighbour artwork on the Previous / Next keys (Spotify Web API)
The desktop app's AppleScript only exposes the current track, so the queue (next) and listening history (previous) come from the Web API:
1. Create an app once at https://developer.spotify.com/dashboard with redirect URI exactly `http://127.0.0.1:8888/callback` and the Web API enabled.
2. Put its Client ID in `spotify-plugin/com.artur.spotify.sdPlugin/.env` as `SPOTIFY_CLIENT_ID=…` (see `.env.example`; the file is git-ignored and travels inside the packed installer).
3. On each machine the plugin opens a Spotify consent page in the browser on first launch; approve it once. The refresh token is kept in the Stream Deck app's global settings for this plugin.
Without a Client ID the keys keep the plain art-coloured icons. "Previous" shows the last *played* track, which is usually but not always where Spotify's Previous goes.

### Set up from a fresh clone (e.g. the work laptop)
```sh
git clone <this repo> elgatoWorkProfile && cd elgatoWorkProfile
cp spotify-plugin/com.artur.spotify.sdPlugin/.env.example spotify-plugin/com.artur.spotify.sdPlugin/.env   # then paste the Client ID
(cd spotify-plugin/com.artur.spotify.sdPlugin && npm install --omit=dev)
(cd pomodoro-plugin/com.artur.pomodoro.sdPlugin && npm install --omit=dev)
# for development: symlink the folders into the app (needs the Stream Deck app installed)
npx @elgato/cli link spotify-plugin/com.artur.spotify.sdPlugin
npx @elgato/cli link pomodoro-plugin/com.artur.pomodoro.sdPlugin
# or build installers: `npx @elgato/cli pack <folder> --output .` and double-click the .streamDeckPlugin
```
Installers and `node_modules` are build output and not committed.

### Install on the work laptop
1. Install the Stream Deck app (6.9+) and Spotify.
2. Double-click `spotify-plugin/com.artur.spotify.streamDeckPlugin` (built as above).
3. First use: macOS asks to allow "Stream Deck" to control "Spotify" — click OK (System Settings → Privacy & Security → Automation if you missed it).
4. Place the four actions, then Profiles → ⋯ → Export and keep the `.streamDeckProfile` in this folder.

### Edit / rebuild
- Source: `com.artur.spotify.sdPlugin/bin/plugin.js` (actions) and `bin/spotify.js` (AppleScript + album-art colours). Tunables at the top of `plugin.js`: `VOL_STEP`, `SCROLL_CHARS`.
- Self-check (Spotify must be playing): `node com.artur.spotify.sdPlugin/bin/spotify.js`
- Validate + repack: `cd spotify-plugin && npx @elgato/cli validate com.artur.spotify.sdPlugin && npx @elgato/cli pack com.artur.spotify.sdPlugin --output . --force`
- On a machine with the Stream Deck app, `npx @elgato/cli link com.artur.spotify.sdPlugin` symlinks the folder for live development; `npx @elgato/cli restart com.artur.spotify` reloads it. Logs: `com.artur.spotify.sdPlugin/logs/`.

## Pomodoro plugin (`pomodoro-plugin/`)

A dial action. Installer: `pomodoro-plugin/com.artur.pomodoro.streamDeckPlugin`. Push = start/pause, rotate = ±1 minute on the running phase, tap the strip = skip to the next phase, long tap = reset the day.
25 / 5 / 15-after-4 by default (`FOCUS`, `SHORT`, `LONG`, `ROUNDS` at the top of `com.artur.pomodoro.sdPlugin/bin/plugin.js`). A phase end plays Glass.aiff and posts a macOS notification, then waits for a push.
Self-check: `node com.artur.pomodoro.sdPlugin/bin/plugin.js --check`.
