# Midnight Sonic — Offline Music Player (PWA)

A rebuilt, fully functional offline local-music PWA. No demo data, no mock
buttons — every feature below is wired to real IndexedDB storage and real
`<audio>` playback.

## ⚠️ One important setup step

**Service workers (and therefore installability + offline caching) only
work when the app is served over `https://` or `http://localhost` — never
when opened directly as a `file://` path.** This is a browser security rule,
not a limitation of this app. Everything else (library, playback, IndexedDB
persistence, playlists) *does* work from `file://`, but for the full
"install to home screen / works with no internet" experience, host the
`midnight-sonic/` folder somewhere with real HTTP, for example:

- **GitHub Pages** (free, easiest): push this folder to a repo, enable
  Pages, done.
- **Any static host**: Netlify, Vercel, Cloudflare Pages, an S3 bucket, etc.
- **Local testing on your phone**: run `python3 -m http.server 8080` from
  inside this folder on a computer on the same Wi-Fi, then visit
  `http://<your-computer's-LAN-IP>:8080` from your Android phone's Chrome.
  (LAN HTTP is treated as insecure by some browser checks — for a real
  install test, use HTTPS hosting instead.)

Once hosted over HTTPS, open it in Chrome on Android → menu → **"Add to
Home screen"** (or use the in-app "Add to Home Screen" button under
Audio & Storage → Install, which appears automatically when the browser
fires its install prompt).

## What's actually implemented

- **Persistent storage** — IndexedDB (`db.js`), not `localStorage` and not
  `URL.createObjectURL` as a permanent reference. Audio blobs are stored
  once; playback URLs are created fresh from the stored blob each time a
  track loads, and revoked immediately after, so nothing leaks.
- **Import** — multi-file picker, duplicate detection (content fingerprint,
  not just filename), per-file progress, and a lightweight hand-written
  ID3v2 tag reader for MP3s (title/artist/album/artwork) with filename-based
  fallback for every other format. Duration comes from the browser's own
  decoder.
- **Library** — Songs / Albums / Artists / Genres / Liked tabs, sortable,
  debounced search, incremental rendering so it stays smooth with large
  libraries.
- **Player** — real `<audio>` element, all state driven by its actual events
  (no fake progress bars). Queue, shuffle, repeat (off/all/one), seek,
  volume, playback speed, mini + full player.
- **Playlists** — create/rename/delete/reorder/play/shuffle, plus computed
  "Liked Songs" and "Recently Played" smart playlists.
- **Equalizer** — real Web Audio API biquad filters (bass/mid/treble),
  8 presets, gracefully disabled with a visible notice on browsers without
  Web Audio support.
- **Media Session API** — lock-screen/notification playback controls and
  metadata, with feature detection so it no-ops safely where unsupported.
- **Service worker** — caches the static app shell only (HTML/CSS/JS/icons).
  Your music library is *not* stored in the SW cache — it's in IndexedDB,
  which is what makes it durable across browser/OS restarts.
- **Everything else in the spec**: storage stats + clear-all with
  confirmation, per-song context menu, resume position, safe-area insets,
  duplicate prevention, error toasts instead of silent failures.

## Honest limitations (browser reality, not overpromised)

- ID3 tag reading covers **ID3v2.3/2.4 MP3s**. Other formats (FLAC, OGG,
  M4A/AAC, WAV) fall back to filename-based title/artist — full tag parsing
  for every container format would require a much larger dependency, which
  conflicts with the "no unnecessary external code" goal. Duration is always
  correct regardless of format, since it comes from decoding, not tags.
- Background playback and lock-screen controls depend on the browser/OS
  actually supporting Media Session — this is solid on Android Chrome, patchy
  elsewhere.
- "Add to Home Screen" install prompting is controlled by the browser, not
  by this app; the in-app button just relays the browser's own prompt when
  offered.

## File structure

```
index.html      Screens, player, sheets, modals
styles.css      All styling + every icon (inline SVG masks, no icon font/CDN)
db.js           IndexedDB layer (songs, blobs, playlists, settings, state)
meta.js         Duration probing, ID3v2 parsing, fingerprinting
player.js       Playback engine, queue, EQ, Media Session, state persistence
app.js          UI controller — rendering, routing, import pipeline
sw.js           App-shell service worker
manifest.webmanifest
icons/          App icons (192/512, including maskable variants)
```
