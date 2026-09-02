/**
 * sw.js — App-shell service worker.
 *
 * Scope: caching the STATIC application shell only (HTML/CSS/JS/icons).
 * The user's actual music library lives in IndexedDB, not in a network
 * cache — that's a different, much larger and more durable storage
 * mechanism handled entirely by db.js. This service worker's only job is
 * to let the app shell itself open instantly and work with no network.
 *
 * Bump CACHE_VERSION whenever a shell file changes so clients pick up the
 * new version instead of serving stale files forever.
 */

const CACHE_VERSION = 'midnight-sonic-v1';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './db.js',
  './meta.js',
  './player.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch((err) => {
        // Never let a single missing/renamed asset block installation of
        // the rest of the shell.
        console.warn('Service worker precache had an issue:', err);
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('midnight-sonic-') && key !== SHELL_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

function isShellRequest(url) {
  return url.origin === self.location.origin;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle simple same-origin GETs. Everything else (blob: URLs used
  // for audio playback, POSTs, cross-origin calls — of which this app
  // makes none for its core functionality) passes straight through.
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (!isShellRequest(url)) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Navigations: try the network first (to pick up a newer deployed shell)
  // but fall straight back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Static shell assets: cache-first for instant, offline-safe loads, with
  // a background revalidation so updates still propagate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => null);

      return cached || network || fetch(req);
    })
  );
});
