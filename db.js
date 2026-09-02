/**
 * db.js — Persistent storage layer for Midnight Sonic.
 *
 * Everything the app needs to survive a refresh, a browser restart, or a
 * phone reboot lives in IndexedDB. Nothing important is kept only in memory
 * or in localStorage (localStorage is unsuitable for audio binary data and
 * has a tiny quota).
 *
 * Schema (versioned — upgrades never drop existing stores/data):
 *   songs      : song metadata only (fast to list, no binary data)
 *   songBlobs  : { id, audioBlob, artworkBlob } — binary data, fetched only
 *                when a track is actually loaded for playback
 *   playlists  : user-created playlists (ordered song id lists)
 *   kv         : small key/value store for settings + player state
 */

const DB_NAME = 'midnight-sonic-db';
const DB_VERSION = 1;

const STORE_SONGS = 'songs';
const STORE_BLOBS = 'songBlobs';
const STORE_PLAYLISTS = 'playlists';
const STORE_KV = 'kv';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not supported in this browser.'));
      return;
    }

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;

      // Migration-safe: only create stores/indexes that don't exist yet.
      if (!db.objectStoreNames.contains(STORE_SONGS)) {
        const songs = db.createObjectStore(STORE_SONGS, { keyPath: 'id' });
        songs.createIndex('title', 'title', { unique: false });
        songs.createIndex('artist', 'artist', { unique: false });
        songs.createIndex('album', 'album', { unique: false });
        songs.createIndex('genre', 'genre', { unique: false });
        songs.createIndex('dateAdded', 'dateAdded', { unique: false });
        songs.createIndex('lastPlayed', 'lastPlayed', { unique: false });
        songs.createIndex('playCount', 'playCount', { unique: false });
        songs.createIndex('liked', 'liked', { unique: false });
        songs.createIndex('fingerprint', 'fingerprint', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(STORE_PLAYLISTS)) {
        const playlists = db.createObjectStore(STORE_PLAYLISTS, { keyPath: 'id' });
        playlists.createIndex('createdAt', 'createdAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV, { keyPath: 'key' });
      }

      // Placeholder for future version bumps, e.g.:
      // if (oldVersion < 2) { ... add new index / store without touching existing data ... }
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        // Another tab is upgrading the DB — close gracefully so it can proceed.
        db.close();
      };
      resolve(db);
    };

    req.onerror = () => reject(req.error || new Error('Failed to open database.'));
    req.onblocked = () => console.warn('IndexedDB upgrade blocked by another open tab.');
  });

  return dbPromise;
}

function tx(db, stores, mode = 'readonly') {
  return db.transaction(stores, mode);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed.'));
  });
}

function txDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted.'));
  });
}

/* ------------------------------------------------------------------ */
/* Songs                                                               */
/* ------------------------------------------------------------------ */

/**
 * Persist a new song. Metadata and binary blobs are written in a single
 * atomic transaction so the library never ends up with metadata that
 * points at a missing blob (or vice versa).
 */
async function addSong(meta, audioBlob, artworkBlob) {
  const db = await openDB();
  const t = tx(db, [STORE_SONGS, STORE_BLOBS], 'readwrite');
  t.objectStore(STORE_SONGS).add(meta);
  t.objectStore(STORE_BLOBS).add({ id: meta.id, audioBlob, artworkBlob: artworkBlob || null });
  await txDone(t);
  return meta;
}

async function getAllSongsMeta() {
  const db = await openDB();
  const t = tx(db, [STORE_SONGS]);
  const result = await reqToPromise(t.objectStore(STORE_SONGS).getAll());
  return result || [];
}

async function getSongMeta(id) {
  const db = await openDB();
  const t = tx(db, [STORE_SONGS]);
  return reqToPromise(t.objectStore(STORE_SONGS).get(id));
}

async function getSongBlob(id) {
  const db = await openDB();
  const t = tx(db, [STORE_BLOBS]);
  return reqToPromise(t.objectStore(STORE_BLOBS).get(id));
}

async function updateSongMeta(id, changes) {
  const db = await openDB();
  const t = tx(db, [STORE_SONGS], 'readwrite');
  const store = t.objectStore(STORE_SONGS);
  const existing = await reqToPromise(store.get(id));
  if (!existing) {
    t.abort();
    throw new Error('Song not found: ' + id);
  }
  const updated = Object.assign({}, existing, changes);
  store.put(updated);
  await txDone(t);
  return updated;
}

async function deleteSong(id) {
  const db = await openDB();
  const t = tx(db, [STORE_SONGS, STORE_BLOBS, STORE_PLAYLISTS], 'readwrite');
  t.objectStore(STORE_SONGS).delete(id);
  t.objectStore(STORE_BLOBS).delete(id);

  // Remove references from every playlist so the library and playlists
  // never drift out of sync.
  const plStore = t.objectStore(STORE_PLAYLISTS);
  const playlists = await reqToPromise(plStore.getAll());
  for (const pl of playlists) {
    if (pl.songIds && pl.songIds.includes(id)) {
      pl.songIds = pl.songIds.filter((sid) => sid !== id);
      pl.updatedAt = Date.now();
      plStore.put(pl);
    }
  }
  await txDone(t);
}

async function findByFingerprint(fingerprint) {
  if (!fingerprint) return null;
  const db = await openDB();
  const t = tx(db, [STORE_SONGS]);
  const idx = t.objectStore(STORE_SONGS).index('fingerprint');
  const matches = await reqToPromise(idx.getAll(IDBKeyRange.only(fingerprint)));
  return (matches && matches[0]) || null;
}

async function recordPlay(id, resumePosition) {
  const db = await openDB();
  const t = tx(db, [STORE_SONGS], 'readwrite');
  const store = t.objectStore(STORE_SONGS);
  const song = await reqToPromise(store.get(id));
  if (!song) { t.abort(); return null; }
  song.lastPlayed = Date.now();
  song.playCount = (song.playCount || 0) + 1;
  if (typeof resumePosition === 'number') song.resumePosition = resumePosition;
  store.put(song);
  await txDone(t);
  return song;
}

async function saveResumePosition(id, position) {
  const db = await openDB();
  const t = tx(db, [STORE_SONGS], 'readwrite');
  const store = t.objectStore(STORE_SONGS);
  const song = await reqToPromise(store.get(id));
  if (!song) { t.abort(); return; }
  song.resumePosition = position;
  store.put(song);
  await txDone(t);
}

async function setLiked(id, liked) {
  return updateSongMeta(id, { liked: !!liked });
}

/* ------------------------------------------------------------------ */
/* Playlists                                                           */
/* ------------------------------------------------------------------ */

function newId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

async function createPlaylist(name) {
  const db = await openDB();
  const playlist = {
    id: newId(),
    name: name && name.trim() ? name.trim() : 'New Playlist',
    songIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isDefault: false,
  };
  const t = tx(db, [STORE_PLAYLISTS], 'readwrite');
  t.objectStore(STORE_PLAYLISTS).add(playlist);
  await txDone(t);
  return playlist;
}

async function getAllPlaylists() {
  const db = await openDB();
  const t = tx(db, [STORE_PLAYLISTS]);
  const result = await reqToPromise(t.objectStore(STORE_PLAYLISTS).getAll());
  return (result || []).sort((a, b) => b.createdAt - a.createdAt);
}

async function getPlaylist(id) {
  const db = await openDB();
  const t = tx(db, [STORE_PLAYLISTS]);
  return reqToPromise(t.objectStore(STORE_PLAYLISTS).get(id));
}

async function renamePlaylist(id, name) {
  const db = await openDB();
  const t = tx(db, [STORE_PLAYLISTS], 'readwrite');
  const store = t.objectStore(STORE_PLAYLISTS);
  const pl = await reqToPromise(store.get(id));
  if (!pl) { t.abort(); throw new Error('Playlist not found'); }
  pl.name = name && name.trim() ? name.trim() : pl.name;
  pl.updatedAt = Date.now();
  store.put(pl);
  await txDone(t);
  return pl;
}

async function deletePlaylist(id) {
  const db = await openDB();
  const t = tx(db, [STORE_PLAYLISTS], 'readwrite');
  t.objectStore(STORE_PLAYLISTS).delete(id);
  await txDone(t);
}

async function addSongToPlaylist(playlistId, songId) {
  const db = await openDB();
  const t = tx(db, [STORE_PLAYLISTS], 'readwrite');
  const store = t.objectStore(STORE_PLAYLISTS);
  const pl = await reqToPromise(store.get(playlistId));
  if (!pl) { t.abort(); throw new Error('Playlist not found'); }
  if (!pl.songIds.includes(songId)) {
    pl.songIds.push(songId);
    pl.updatedAt = Date.now();
    store.put(pl);
  }
  await txDone(t);
  return pl;
}

async function removeSongFromPlaylist(playlistId, songId) {
  const db = await openDB();
  const t = tx(db, [STORE_PLAYLISTS], 'readwrite');
  const store = t.objectStore(STORE_PLAYLISTS);
  const pl = await reqToPromise(store.get(playlistId));
  if (!pl) { t.abort(); throw new Error('Playlist not found'); }
  pl.songIds = pl.songIds.filter((id) => id !== songId);
  pl.updatedAt = Date.now();
  store.put(pl);
  await txDone(t);
  return pl;
}

async function reorderPlaylist(playlistId, newSongIdOrder) {
  const db = await openDB();
  const t = tx(db, [STORE_PLAYLISTS], 'readwrite');
  const store = t.objectStore(STORE_PLAYLISTS);
  const pl = await reqToPromise(store.get(playlistId));
  if (!pl) { t.abort(); throw new Error('Playlist not found'); }
  pl.songIds = newSongIdOrder;
  pl.updatedAt = Date.now();
  store.put(pl);
  await txDone(t);
  return pl;
}

/* ------------------------------------------------------------------ */
/* Key/value: settings + player state                                  */
/* ------------------------------------------------------------------ */

async function getKV(key, fallback) {
  const db = await openDB();
  const t = tx(db, [STORE_KV]);
  const row = await reqToPromise(t.objectStore(STORE_KV).get(key));
  return row ? row.value : fallback;
}

async function setKV(key, value) {
  const db = await openDB();
  const t = tx(db, [STORE_KV], 'readwrite');
  t.objectStore(STORE_KV).put({ key, value });
  await txDone(t);
}

/* ------------------------------------------------------------------ */
/* Library-wide utilities                                              */
/* ------------------------------------------------------------------ */

async function getLibraryStats() {
  const [songs, playlists] = await Promise.all([getAllSongsMeta(), getAllPlaylists()]);
  const totalBytes = songs.reduce((sum, s) => sum + (s.size || 0), 0);
  return { songCount: songs.length, totalBytes, playlistCount: playlists.length };
}

async function clearAllMusic() {
  const db = await openDB();
  const t = tx(db, [STORE_SONGS, STORE_BLOBS, STORE_PLAYLISTS], 'readwrite');
  t.objectStore(STORE_SONGS).clear();
  t.objectStore(STORE_BLOBS).clear();
  t.objectStore(STORE_PLAYLISTS).clear();
  await txDone(t);
}

async function clearRecentlyPlayed() {
  const db = await openDB();
  const t = tx(db, [STORE_SONGS], 'readwrite');
  const store = t.objectStore(STORE_SONGS);
  const all = await reqToPromise(store.getAll());
  for (const song of all) {
    if (song.lastPlayed) {
      song.lastPlayed = null;
      store.put(song);
    }
  }
  await txDone(t);
}

async function estimateStorageQuota() {
  if (navigator.storage && navigator.storage.estimate) {
    try {
      return await navigator.storage.estimate();
    } catch (e) {
      return null;
    }
  }
  return null;
}

async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    try {
      return await navigator.storage.persist();
    } catch (e) {
      return false;
    }
  }
  return false;
}

window.MSDB = {
  addSong,
  getAllSongsMeta,
  getSongMeta,
  getSongBlob,
  updateSongMeta,
  deleteSong,
  findByFingerprint,
  recordPlay,
  saveResumePosition,
  setLiked,
  createPlaylist,
  getAllPlaylists,
  getPlaylist,
  renamePlaylist,
  deletePlaylist,
  addSongToPlaylist,
  removeSongFromPlaylist,
  reorderPlaylist,
  getKV,
  setKV,
  getLibraryStats,
  clearAllMusic,
  clearRecentlyPlayed,
  estimateStorageQuota,
  requestPersistentStorage,
  newId,
  openDB,
};
