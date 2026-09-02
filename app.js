/**
 * app.js — UI layer. Owns the DOM, talks to MSDB for persistence and
 * MSPlayer for playback. Nothing in here fakes state: every list is built
 * from what's actually in IndexedDB, and every player control reflects
 * real <audio> events relayed through MSPlayer's event bus.
 */

(function () {
  const DB = window.MSDB;
  const Player = window.MSPlayer;
  const Meta = window.MSMeta;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ------------------------------------------------------------------ */
  /* In-memory cache (source of truth is always IndexedDB; this is just  */
  /* a fast mirror for rendering)                                        */
  /* ------------------------------------------------------------------ */

  const cache = {
    songs: [],       // array of song metadata
    songsById: new Map(),
    playlists: [],   // array of playlist records (custom only)
  };

  const ui = {
    screen: 'home',
    libraryTab: 'songs',
    librarySort: 'dateAdded-desc',
    searchQuery: '',
    searchActive: false,
    collection: null,     // { type: 'album'|'artist'|'genre', key }
    playlistDetailId: null,
    contextSong: null,
    contextFromPlaylistId: null,
    addToPlaylistSong: null,
    confirmCallback: null,
    textInputCallback: null,
    seeking: false,
    deferredInstallPrompt: null,
  };

  /* ------------------------------------------------------------------ */
  /* Small utilities                                                      */
  /* ------------------------------------------------------------------ */

  function debounce(fn, wait) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDuration(seconds) {
    if (!seconds || !isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 MB';
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
  }

  let artworkUrlCache = new Map(); // songId -> object URL, for list thumbnails
  async function getArtworkThumbUrl(songId) {
    if (artworkUrlCache.has(songId)) return artworkUrlCache.get(songId);
    try {
      const row = await DB.getSongBlob(songId);
      if (row && row.artworkBlob) {
        const url = URL.createObjectURL(row.artworkBlob);
        artworkUrlCache.set(songId, url);
        return url;
      }
    } catch (e) { /* ignore */ }
    artworkUrlCache.set(songId, null);
    return null;
  }

  function artHtml(song, sizeClass) {
    // Lightweight placeholder synchronously; real artwork (if any) is
    // swapped in asynchronously by hydrateArtwork() to avoid blocking
    // the initial render on blob reads for every row.
    return `<div class="${sizeClass || 'song-art'} art-fallback ph-note" data-art-for="${song.id}"></div>`;
  }

  function hydrateArtwork(container) {
    const nodes = $$('[data-art-for]', container);
    nodes.forEach(async (node) => {
      const id = node.getAttribute('data-art-for');
      const url = await getArtworkThumbUrl(id);
      if (url) {
        node.style.backgroundImage = `url("${url}")`;
        node.style.backgroundSize = 'cover';
        node.style.backgroundPosition = 'center';
        node.classList.remove('art-fallback', 'ph-note');
      }
    });
  }

  function toast(message, type) {
    const container = $('#toast-container');
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' error' : '');
    el.innerHTML = `<span class="toast-icon ${type === 'error' ? 'ic-warning' : 'ic-check'}"></span><span>${escapeHtml(message)}</span>`;
    container.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 0.25s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 260);
    }, 3200);
  }

  function showBackdrop(onClick) {
    const bd = $('#backdrop');
    bd.classList.remove('hidden');
    bd._onClick = onClick;
  }
  function hideBackdrop() {
    $('#backdrop').classList.add('hidden');
  }
  $('#backdrop').addEventListener('click', () => {
    const bd = $('#backdrop');
    if (bd._onClick) bd._onClick();
  });

  function openSheet(id) {
    $(id).classList.remove('hidden');
    showBackdrop(() => closeSheet(id));
  }
  function closeSheet(id) {
    $(id).classList.add('hidden');
    hideBackdrop();
  }

  function showConfirm(title, message, onConfirm) {
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    ui.confirmCallback = onConfirm;
    $('#confirm-modal').classList.remove('hidden');
  }
  $('#confirm-cancel').addEventListener('click', () => $('#confirm-modal').classList.add('hidden'));
  $('#confirm-ok').addEventListener('click', () => {
    $('#confirm-modal').classList.add('hidden');
    if (ui.confirmCallback) ui.confirmCallback();
    ui.confirmCallback = null;
  });

  function showTextInput(title, placeholder, initial, onConfirm) {
    $('#text-input-title').textContent = title;
    const field = $('#text-input-field');
    field.placeholder = placeholder || '';
    field.value = initial || '';
    ui.textInputCallback = onConfirm;
    $('#text-input-modal').classList.remove('hidden');
    setTimeout(() => field.focus(), 50);
  }
  $('#text-input-cancel').addEventListener('click', () => $('#text-input-modal').classList.add('hidden'));
  $('#text-input-confirm').addEventListener('click', () => {
    const val = $('#text-input-field').value.trim();
    $('#text-input-modal').classList.add('hidden');
    if (ui.textInputCallback) ui.textInputCallback(val);
    ui.textInputCallback = null;
  });

  /* ------------------------------------------------------------------ */
  /* Incremental list rendering (keeps large libraries smooth)           */
  /* ------------------------------------------------------------------ */

  function renderIncremental(container, items, rowBuilder, batchSize) {
    batchSize = batchSize || 120;
    container.innerHTML = '';
    if (container._observer) { container._observer.disconnect(); container._observer = null; }
    let rendered = 0;

    function renderNext() {
      const slice = items.slice(rendered, rendered + batchSize);
      if (slice.length === 0) return;
      const html = slice.map(rowBuilder).join('');
      const frag = document.createElement('div');
      frag.innerHTML = html;
      while (frag.firstChild) container.appendChild(frag.firstChild);
      rendered += slice.length;
      hydrateArtwork(container);

      if (rendered < items.length) {
        const sentinel = document.createElement('div');
        sentinel.style.height = '1px';
        container.appendChild(sentinel);
        const obs = new IntersectionObserver((entries) => {
          if (entries[0].isIntersecting) {
            obs.disconnect();
            sentinel.remove();
            renderNext();
          }
        });
        obs.observe(sentinel);
        container._observer = obs;
      }
    }
    renderNext();
  }

  /* ------------------------------------------------------------------ */
  /* Song row / card builders                                            */
  /* ------------------------------------------------------------------ */

  function songRowHtml(song, opts) {
    opts = opts || {};
    const playing = Player.currentSong && Player.currentSong.id === song.id;
    const reorder = opts.reorder ? `
      <div class="song-reorder">
        <button class="icon-btn small ic-chevron-up" data-action="move-up" data-id="${song.id}"></button>
        <button class="icon-btn small ic-chevron-down" data-action="move-down" data-id="${song.id}"></button>
      </div>` : '';
    return `
      <div class="song-row${playing ? ' is-playing' : ''}" data-id="${song.id}" data-list-action="open">
        ${artHtml(song)}
        <div class="song-info">
          <p class="song-title">${escapeHtml(song.title)}</p>
          <p class="song-sub">${escapeHtml(song.artist)}${song.album && song.album !== 'Unknown Album' ? ' • ' + escapeHtml(song.album) : ''}</p>
        </div>
        <span class="song-duration">${formatDuration(song.duration)}</span>
        ${reorder}
        <button class="icon-btn small song-more ic-more" data-action="context" data-id="${song.id}" aria-label="More"></button>
      </div>`;
  }

  function hcardHtml(song, sub) {
    return `
      <div class="hcard" data-id="${song.id}" data-list-action="open-single">
        ${artHtml(song, 'hcard-art')}
        <p class="hcard-title">${escapeHtml(song.title)}</p>
        <p class="hcard-sub">${escapeHtml(sub || song.artist)}</p>
      </div>`;
  }

  function collectionCardHtml(type, key, songs) {
    const first = songs[0];
    return `
      <div class="hcard" data-collection="${type}" data-key="${escapeHtml(key)}">
        ${artHtml(first, 'hcard-art')}
        <p class="hcard-title">${escapeHtml(key)}</p>
        <p class="hcard-sub">${songs.length} song${songs.length === 1 ? '' : 's'}</p>
      </div>`;
  }

  /* ------------------------------------------------------------------ */
  /* Data loading                                                         */
  /* ------------------------------------------------------------------ */

  async function reloadCache() {
    const [songs, playlists] = await Promise.all([DB.getAllSongsMeta(), DB.getAllPlaylists()]);
    cache.songs = songs;
    cache.songsById = new Map(songs.map((s) => [s.id, s]));
    cache.playlists = playlists;
  }

  function getSong(id) { return cache.songsById.get(id); }

  /* ------------------------------------------------------------------ */
  /* Router                                                               */
  /* ------------------------------------------------------------------ */

  function navigateTo(screen, opts) {
    opts = opts || {};
    ui.screen = screen;
    $$('.screen').forEach((s) => s.classList.remove('active'));
    const target = $(`#screen-${screen}`);
    if (target) target.classList.add('active');

    $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.nav === screen));

    if (screen === 'home') renderHome();
    if (screen === 'library') renderLibrary();
    if (screen === 'playlists') renderPlaylists();
    if (screen === 'collection' && opts.type) renderCollection(opts.type, opts.key);
    if (screen === 'playlist-detail' && opts.id) renderPlaylistDetail(opts.id);

    target && (target.scrollTop = 0);
    DB.setKV('lastScreen', screen);
  }

  $$('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => {
      const screen = el.getAttribute('data-nav');
      navigateTo(screen);
    });
  });

  /* ------------------------------------------------------------------ */
  /* HOME                                                                  */
  /* ------------------------------------------------------------------ */

  function getGreeting() {
    const h = new Date().getHours();
    if (h < 5) return 'Late night listening';
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  function renderHome() {
    $('#home-greeting').textContent = getGreeting();

    if (cache.songs.length === 0) {
      $('#home-empty').classList.remove('hidden');
      $('#home-content').classList.add('hidden');
      return;
    }
    $('#home-empty').classList.add('hidden');
    $('#home-content').classList.remove('hidden');

    // Continue listening: has a resume position mid-track
    const continueList = cache.songs
      .filter((s) => s.resumePosition && s.duration && s.resumePosition > 5 && s.resumePosition < s.duration - 8)
      .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))
      .slice(0, 10);
    toggleRow('#home-continue-row', continueList.length);
    $('#home-continue').innerHTML = continueList.map((s) => hcardHtml(s)).join('');
    hydrateArtwork($('#home-continue'));

    const recent = cache.songs.filter((s) => s.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 12);
    toggleRow('#home-recent-row', recent.length);
    $('#home-recent').innerHTML = recent.map((s) => hcardHtml(s)).join('');
    hydrateArtwork($('#home-recent'));

    const added = cache.songs.slice().sort((a, b) => b.dateAdded - a.dateAdded).slice(0, 12);
    toggleRow('#home-added-row', added.length);
    $('#home-added').innerHTML = added.map((s) => hcardHtml(s)).join('');
    hydrateArtwork($('#home-added'));

    const most = cache.songs.filter((s) => s.playCount > 0).sort((a, b) => b.playCount - a.playCount).slice(0, 12);
    toggleRow('#home-most-row', most.length);
    $('#home-most').innerHTML = most.map((s) => hcardHtml(s, `${s.playCount} plays`)).join('');
    hydrateArtwork($('#home-most'));

    const liked = cache.songs.filter((s) => s.liked).length;
    $('#home-quick-playlists').innerHTML = `
      <div class="quick-card" data-quick="liked">
        <div class="quick-card-icon"><span class="mini-icon ic-heart"></span></div>
        <div><p class="quick-card-title">Liked Songs</p><p class="quick-card-sub">${liked} song${liked === 1 ? '' : 's'}</p></div>
      </div>
      <div class="quick-card" data-quick="recent">
        <div class="quick-card-icon secondary"><span class="mini-icon" data-icon="playlist"></span></div>
        <div><p class="quick-card-title">Recently Played</p><p class="quick-card-sub">${recent.length} song${recent.length === 1 ? '' : 's'}</p></div>
      </div>
      ${cache.playlists.slice(0, 4).map((p) => `
      <div class="quick-card" data-playlist-id="${p.id}">
        <div class="quick-card-icon"><span class="mini-icon" data-icon="playlist"></span></div>
        <div><p class="quick-card-title">${escapeHtml(p.name)}</p><p class="quick-card-sub">${p.songIds.length} song${p.songIds.length === 1 ? '' : 's'}</p></div>
      </div>`).join('')}
    `;
  }

  function toggleRow(sel, hasContent) {
    $(sel).classList.toggle('hidden', !hasContent);
  }

  $('#home-quick-playlists').addEventListener('click', (e) => {
    const quick = e.target.closest('[data-quick]');
    const pl = e.target.closest('[data-playlist-id]');
    if (quick) {
      const key = quick.getAttribute('data-quick');
      navigateTo('playlist-detail', { id: key === 'liked' ? 'virtual-liked' : 'virtual-recent' });
    } else if (pl) {
      navigateTo('playlist-detail', { id: pl.getAttribute('data-playlist-id') });
    }
  });

  ['#home-continue', '#home-recent', '#home-added', '#home-most'].forEach((sel) => {
    $(sel).addEventListener('click', (e) => {
      const card = e.target.closest('[data-id]');
      if (!card) return;
      const id = card.getAttribute('data-id');
      const list = getListForRow(sel);
      const idx = list.findIndex((s) => s.id === id);
      if (idx >= 0) Player.playQueue(list.map((s) => s.id), idx, labelForRow(sel));
      openFullPlayer();
    });
  });

  function getListForRow(sel) {
    if (sel === '#home-continue') return cache.songs.filter((s) => s.resumePosition && s.duration && s.resumePosition > 5 && s.resumePosition < s.duration - 8).sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0)).slice(0, 10);
    if (sel === '#home-recent') return cache.songs.filter((s) => s.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 12);
    if (sel === '#home-added') return cache.songs.slice().sort((a, b) => b.dateAdded - a.dateAdded).slice(0, 12);
    if (sel === '#home-most') return cache.songs.filter((s) => s.playCount > 0).sort((a, b) => b.playCount - a.playCount).slice(0, 12);
    return [];
  }
  function labelForRow(sel) {
    if (sel === '#home-continue') return 'Continue Listening';
    if (sel === '#home-recent') return 'Recently Played';
    if (sel === '#home-added') return 'Recently Added';
    if (sel === '#home-most') return 'Most Played';
    return '';
  }

  /* ------------------------------------------------------------------ */
  /* LIBRARY                                                              */
  /* ------------------------------------------------------------------ */

  function sortSongs(songs, sortKey) {
    const [field, dir] = sortKey.split('-');
    const mul = dir === 'asc' ? 1 : -1;
    return songs.slice().sort((a, b) => {
      let av = a[field], bv = b[field];
      if (field === 'title' || field === 'artist' || field === 'album') {
        av = (av || '').toLowerCase(); bv = (bv || '').toLowerCase();
        return av < bv ? -1 * mul : av > bv ? 1 * mul : 0;
      }
      av = av || 0; bv = bv || 0;
      return (av - bv) * mul;
    });
  }

  function currentLibraryList() {
    let list = cache.songs;
    if (ui.searchActive && ui.searchQuery) {
      const q = ui.searchQuery.toLowerCase();
      list = list.filter((s) =>
        (s.title || '').toLowerCase().includes(q) ||
        (s.artist || '').toLowerCase().includes(q) ||
        (s.album || '').toLowerCase().includes(q) ||
        (s.genre || '').toLowerCase().includes(q)
      );
      return sortSongs(list, ui.librarySort);
    }
    if (ui.libraryTab === 'favorites') list = list.filter((s) => s.liked);
    return sortSongs(list, ui.librarySort);
  }

  function groupBy(songs, field) {
    const map = new Map();
    songs.forEach((s) => {
      const key = s[field] || `Unknown ${field.charAt(0).toUpperCase() + field.slice(1)}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(s);
    });
    return map;
  }

  function renderLibrary() {
    $('#library-count').textContent = cache.songs.length ? `${cache.songs.length} song${cache.songs.length === 1 ? '' : 's'}` : '';

    if (cache.songs.length === 0) {
      $('#library-empty').classList.remove('hidden');
      $('#library-list-wrap').classList.add('hidden');
      $('#library-tabs').classList.add('hidden');
      $('#library-sort-row').classList.add('hidden');
      return;
    }
    $('#library-empty').classList.add('hidden');
    $('#library-list-wrap').classList.remove('hidden');
    $('#library-tabs').classList.remove('hidden');
    $('#library-sort-row').classList.remove('hidden');

    const listEl = $('#library-list');
    const gridEl = $('#library-grid');

    const groupedTabs = ['albums', 'artists', 'genres'];
    const isGrouped = !ui.searchActive && groupedTabs.includes(ui.libraryTab);

    listEl.classList.toggle('hidden', isGrouped);
    gridEl.classList.toggle('hidden', !isGrouped);
    $('#library-sort-row').classList.toggle('hidden', isGrouped);

    if (isGrouped) {
      const fieldMap = { albums: 'album', artists: 'artist', genres: 'genre' };
      const groups = groupBy(cache.songs, fieldMap[ui.libraryTab]);
      const entries = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      const type = ui.libraryTab.slice(0, -1); // albums->album etc.
      gridEl.innerHTML = entries.map(([key, songs]) => collectionCardHtml(type, key, songs)).join('');
      hydrateArtwork(gridEl);
    } else {
      const list = currentLibraryList();
      if (list.length === 0) {
        listEl.innerHTML = `<div class="empty-state small"><p class="hint">No matches.</p></div>`;
      } else {
        renderIncremental(listEl, list, (s) => songRowHtml(s));
      }
    }
  }

  $$('.tab', $('#library-tabs')).forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab', $('#library-tabs')).forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      ui.libraryTab = tab.getAttribute('data-tab');
      ui.searchActive = false;
      $('#library-search-bar').classList.add('hidden');
      renderLibrary();
    });
  });

  $('#library-sort-select').addEventListener('change', (e) => {
    ui.librarySort = e.target.value;
    renderLibrary();
  });

  $('#library-grid').addEventListener('click', (e) => {
    const card = e.target.closest('[data-collection]');
    if (!card) return;
    navigateTo('collection', { type: card.getAttribute('data-collection'), key: card.getAttribute('data-key') });
  });

  function wireLibrarySearchToggle(btnSel) {
    $(btnSel).addEventListener('click', () => {
      const bar = $('#library-search-bar');
      bar.classList.toggle('hidden');
      if (!bar.classList.contains('hidden')) {
        $('#library-search-input').focus();
      } else {
        ui.searchActive = false;
        ui.searchQuery = '';
        $('#library-search-input').value = '';
        renderLibrary();
      }
    });
  }
  wireLibrarySearchToggle('#library-search-btn');

  $('#library-search-input').addEventListener('input', debounce((e) => {
    ui.searchQuery = e.target.value.trim();
    ui.searchActive = ui.searchQuery.length > 0;
    renderLibrary();
  }, 250));

  $('#library-search-clear').addEventListener('click', () => {
    $('#library-search-input').value = '';
    ui.searchQuery = '';
    ui.searchActive = false;
    renderLibrary();
  });

  // Home header search shortcut: jump to Library with search open
  $$('.ic-search[data-nav="library"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setTimeout(() => {
        $('#library-search-bar').classList.remove('hidden');
        $('#library-search-input').focus();
      }, 80);
    });
  });

  // Delegate list actions (open song / context menu / reorder) for the library list
  $('#library-list').addEventListener('click', (e) => makeSongListHandler(() => currentLibraryList())(e));

  function makeSongListHandler(getListFn) {
    return function (e) {
      const moreBtn = e.target.closest('[data-action="context"]');
      if (moreBtn) {
        const song = getSong(moreBtn.getAttribute('data-id'));
        if (song) openContextMenu(song, null);
        return;
      }
      const row = e.target.closest('[data-list-action="open"]');
      if (row) {
        const id = row.getAttribute('data-id');
        const list = getListFn();
        const idx = list.findIndex((s) => s.id === id);
        if (idx >= 0) {
          Player.playQueue(list.map((s) => s.id), idx, currentContextLabel());
          openFullPlayer();
        }
      }
    };
  }

  function currentContextLabel() {
    if (ui.screen === 'library') return ui.searchActive ? 'Search Results' : 'My Library';
    if (ui.screen === 'collection' && ui.collection) return ui.collection.key;
    if (ui.screen === 'playlist-detail') return $('#playlist-detail-title').textContent;
    return 'Now Playing';
  }

  /* ------------------------------------------------------------------ */
  /* COLLECTION (album / artist / genre detail)                          */
  /* ------------------------------------------------------------------ */

  function renderCollection(type, key) {
    ui.collection = { type, key };
    const field = type; // 'album' | 'artist' | 'genre'
    const songs = sortSongs(cache.songs.filter((s) => (s[field] || `Unknown ${field}`) === key), 'title-asc');
    $('#collection-title').textContent = key;
    $('#collection-meta').textContent = `${songs.length} song${songs.length === 1 ? '' : 's'}${type === 'album' && songs[0] ? ' • ' + escapeHtml(songs[0].artist) : ''}`;
    const artEl = $('#collection-art');
    artEl.className = 'collection-art art-fallback ph-note';
    artEl.removeAttribute('style');
    if (songs[0]) { artEl.setAttribute('data-art-for', songs[0].id); }
    $('#collection-list').innerHTML = songs.map((s) => songRowHtml(s)).join('');
    hydrateArtwork($('#screen-collection'));

    $('#collection-play-btn').onclick = () => { Player.playQueue(songs.map((s) => s.id), 0, key); openFullPlayer(); };
    $('#collection-shuffle-btn').onclick = () => {
      Player.playQueue(songs.map((s) => s.id), 0, key);
      if (!Player.shuffle) Player.setShuffle(true);
      openFullPlayer();
    };
  }

  $('#collection-list').addEventListener('click', (e) => {
    const handler = makeSongListHandler(() => sortSongs(cache.songs.filter((s) => (s[ui.collection.type] || `Unknown ${ui.collection.type}`) === ui.collection.key), 'title-asc'));
    handler(e);
  });

  /* ------------------------------------------------------------------ */
  /* PLAYLISTS                                                            */
  /* ------------------------------------------------------------------ */

  function virtualPlaylists() {
    const liked = cache.songs.filter((s) => s.liked);
    const recent = cache.songs.filter((s) => s.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 50);
    return [
      { id: 'virtual-liked', name: 'Liked Songs', songIds: liked.map((s) => s.id), isDefault: true, kind: 'liked' },
      { id: 'virtual-recent', name: 'Recently Played', songIds: recent.map((s) => s.id), isDefault: true, kind: 'recent' },
    ];
  }

  function renderPlaylists() {
    const all = virtualPlaylists().concat(cache.playlists);
    $('#playlist-grid').innerHTML = all.map((p) => {
      const first = p.songIds[0] ? getSong(p.songIds[0]) : null;
      const iconClass = p.kind === 'liked' ? 'ic-heart' : p.kind === 'recent' ? '' : '';
      return `
      <div class="playlist-card" data-playlist-id="${p.id}">
        ${first ? artHtml(first, 'playlist-card-art') : `<div class="playlist-card-art art-fallback ${iconClass || 'ph-note'}"></div>`}
        <p class="playlist-card-title">${escapeHtml(p.name)}</p>
        <p class="playlist-card-count">${p.songIds.length} song${p.songIds.length === 1 ? '' : 's'}</p>
      </div>`;
    }).join('');
    hydrateArtwork($('#playlist-grid'));
  }

  $('#playlist-grid').addEventListener('click', (e) => {
    const card = e.target.closest('[data-playlist-id]');
    if (card) navigateTo('playlist-detail', { id: card.getAttribute('data-playlist-id') });
  });

  $('#new-playlist-btn').addEventListener('click', () => {
    showTextInput('New Playlist', 'Playlist name', '', async (name) => {
      if (!name) return;
      await DB.createPlaylist(name);
      await reloadCache();
      renderPlaylists();
      toast('Playlist created');
    });
  });

  async function resolvePlaylist(id) {
    if (id === 'virtual-liked' || id === 'virtual-recent') {
      return virtualPlaylists().find((p) => p.id === id);
    }
    return cache.playlists.find((p) => p.id === id) || (await DB.getPlaylist(id));
  }

  async function renderPlaylistDetail(id) {
    ui.playlistDetailId = id;
    const pl = await resolvePlaylist(id);
    if (!pl) { navigateTo('playlists'); return; }
    $('#playlist-detail-title').textContent = pl.name;
    $('#playlist-detail-meta').textContent = `${pl.songIds.length} song${pl.songIds.length === 1 ? '' : 's'}`;
    $('#playlist-detail-menu-btn').classList.toggle('hidden', !!pl.isDefault);

    const songs = pl.songIds.map((sid) => getSong(sid)).filter(Boolean);
    $('#playlist-detail-empty').classList.toggle('hidden', songs.length > 0);
    $('#playlist-detail-list').innerHTML = songs.map((s) => songRowHtml(s, { reorder: !pl.isDefault })).join('');
    hydrateArtwork($('#playlist-detail-list'));

    $('#playlist-play-btn').onclick = () => { Player.playQueue(songs.map((s) => s.id), 0, pl.name); openFullPlayer(); };
    $('#playlist-shuffle-btn').onclick = () => {
      Player.playQueue(songs.map((s) => s.id), 0, pl.name);
      if (!Player.shuffle) Player.setShuffle(true);
      openFullPlayer();
    };
  }

  $('#playlist-detail-list').addEventListener('click', async (e) => {
    const moveUp = e.target.closest('[data-action="move-up"]');
    const moveDown = e.target.closest('[data-action="move-down"]');
    if (moveUp || moveDown) {
      const pl = await resolvePlaylist(ui.playlistDetailId);
      if (!pl || pl.isDefault) return;
      const id = (moveUp || moveDown).getAttribute('data-id');
      const idx = pl.songIds.indexOf(id);
      const swapWith = moveUp ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= pl.songIds.length) return;
      const newOrder = pl.songIds.slice();
      [newOrder[idx], newOrder[swapWith]] = [newOrder[swapWith], newOrder[idx]];
      await DB.reorderPlaylist(pl.id, newOrder);
      await reloadCache();
      renderPlaylistDetail(ui.playlistDetailId);
      return;
    }
    const moreBtn = e.target.closest('[data-action="context"]');
    if (moreBtn) {
      const song = getSong(moreBtn.getAttribute('data-id'));
      if (song) {
        const pl = await resolvePlaylist(ui.playlistDetailId);
        openContextMenu(song, pl && !pl.isDefault ? ui.playlistDetailId : null);
      }
      return;
    }
    const row = e.target.closest('[data-list-action="open"]');
    if (row) {
      const pl = await resolvePlaylist(ui.playlistDetailId);
      const songs = pl.songIds.map((sid) => getSong(sid)).filter(Boolean);
      const idx = songs.findIndex((s) => s.id === row.getAttribute('data-id'));
      if (idx >= 0) { Player.playQueue(songs.map((s) => s.id), idx, pl.name); openFullPlayer(); }
    }
  });

  $('#playlist-detail-menu-btn').addEventListener('click', async () => {
    const pl = await resolvePlaylist(ui.playlistDetailId);
    if (!pl || pl.isDefault) return;
    openPlaylistMenu(pl);
  });

  function openPlaylistMenu(pl) {
    // Temporarily repurpose the song context sheet's menu area for two
    // playlist-level actions. wireContextMenuClicks() is bound once at
    // startup (delegated on the persistent .sheet-menu container), so we
    // must NOT re-bind it here — only restore the default menu markup.
    const sheet = $('#context-sheet');
    $('#context-title').textContent = pl.name;
    $('#context-artist').textContent = `${pl.songIds.length} songs`;
    const art = $('#context-art');
    art.className = 'sheet-art art-fallback ph-note';
    art.removeAttribute('style');
    art.removeAttribute('data-art-for');
    const menu = $('.sheet-menu', sheet);
    menu.innerHTML = `
      <button class="sheet-menu-item" data-plmenu="rename">Rename playlist</button>
      <button class="sheet-menu-item danger" data-plmenu="delete">Delete playlist</button>
    `;
    openSheet('#context-sheet');
    menu.onclick = (e) => {
      const btn = e.target.closest('[data-plmenu]');
      if (!btn) return;
      closeSheet('#context-sheet');
      restoreContextMenu();
      if (btn.getAttribute('data-plmenu') === 'rename') {
        showTextInput('Rename Playlist', 'Playlist name', pl.name, async (name) => {
          if (!name) return;
          await DB.renamePlaylist(pl.id, name);
          await reloadCache();
          renderPlaylistDetail(pl.id);
          renderPlaylists();
        });
      } else if (btn.getAttribute('data-plmenu') === 'delete') {
        showConfirm('Delete playlist?', `"${pl.name}" will be removed. Your songs stay in your library.`, async () => {
          await DB.deletePlaylist(pl.id);
          await reloadCache();
          navigateTo('playlists');
          toast('Playlist deleted');
        });
      }
    };
  }

  function restoreContextMenu() {
    const menu = $('.sheet-menu', $('#context-sheet'));
    menu.onclick = null;
    menu.innerHTML = `
      <button class="sheet-menu-item" data-ctx="play">Play</button>
      <button class="sheet-menu-item" data-ctx="play-next">Play next</button>
      <button class="sheet-menu-item" data-ctx="add-queue">Add to queue</button>
      <button class="sheet-menu-item" data-ctx="add-playlist">Add to playlist</button>
      <button class="sheet-menu-item" data-ctx="like">Like</button>
      <button class="sheet-menu-item" data-ctx="view-album">View album</button>
      <button class="sheet-menu-item" data-ctx="view-artist">View artist</button>
      <button class="sheet-menu-item danger" data-ctx="remove-library">Remove from library</button>
      <button class="sheet-menu-item danger hidden" data-ctx="remove-playlist">Remove from this playlist</button>
    `;
  }

  /* ------------------------------------------------------------------ */
  /* CONTEXT MENU (song "more" sheet)                                    */
  /* ------------------------------------------------------------------ */

  function openContextMenu(song, fromPlaylistId) {
    ui.contextSong = song;
    ui.contextFromPlaylistId = fromPlaylistId || null;
    $('#context-title').textContent = song.title;
    $('#context-artist').textContent = song.artist;
    const art = $('#context-art');
    art.className = 'sheet-art art-fallback ph-note';
    art.removeAttribute('style');
    art.setAttribute('data-art-for', song.id);
    hydrateArtwork($('#context-sheet'));

    const likeBtn = $('[data-ctx="like"]', $('#context-sheet'));
    likeBtn.textContent = song.liked ? 'Unlike' : 'Like';
    likeBtn.classList.toggle('is-liked', !!song.liked);

    $('[data-ctx="remove-playlist"]', $('#context-sheet')).classList.toggle('hidden', !ui.contextFromPlaylistId);

    openSheet('#context-sheet');
  }

  function wireContextMenuClicks() {
    $('.sheet-menu', $('#context-sheet')).addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-ctx]');
      if (!btn || !ui.contextSong) return;
      const song = ui.contextSong;
      const action = btn.getAttribute('data-ctx');
      closeSheet('#context-sheet');

      if (action === 'play') {
        await Player.playQueue([song.id], 0, song.title);
        openFullPlayer();
      } else if (action === 'play-next') {
        Player.addToQueueNext(song.id);
        toast('Playing next');
      } else if (action === 'add-queue') {
        Player.addToQueueEnd(song.id);
        toast('Added to queue');
      } else if (action === 'add-playlist') {
        openAddToPlaylist(song);
      } else if (action === 'like') {
        await DB.setLiked(song.id, !song.liked);
        await reloadCache();
        refreshCurrentScreen();
        syncLikeButtonsForCurrentSong();
      } else if (action === 'view-album') {
        navigateTo('collection', { type: 'album', key: song.album || 'Unknown Album' });
      } else if (action === 'view-artist') {
        navigateTo('collection', { type: 'artist', key: song.artist || 'Unknown Artist' });
      } else if (action === 'remove-library') {
        showConfirm('Remove from library?', `"${song.title}" will be permanently deleted from your device.`, async () => {
          await DB.deleteSong(song.id);
          await reloadCache();
          refreshCurrentScreen();
          toast('Song removed');
        });
      } else if (action === 'remove-playlist') {
        if (ui.contextFromPlaylistId) {
          await DB.removeSongFromPlaylist(ui.contextFromPlaylistId, song.id);
          await reloadCache();
          renderPlaylistDetail(ui.contextFromPlaylistId);
          toast('Removed from playlist');
        }
      }
    });
  }
  wireContextMenuClicks();

  /* ------------------------------------------------------------------ */
  /* ADD TO PLAYLIST SHEET                                               */
  /* ------------------------------------------------------------------ */

  async function openAddToPlaylist(song) {
    ui.addToPlaylistSong = song;
    if (cache.playlists.length === 0) {
      $('#add-to-playlist-list').innerHTML = `<p class="hint" style="padding:14px 4px;">You don't have any playlists yet. Tap "New" to create one.</p>`;
    } else {
      $('#add-to-playlist-list').innerHTML = cache.playlists.map((p) => {
        const has = p.songIds.includes(song.id);
        return `
        <div class="playlist-pick-row" data-playlist-id="${p.id}">
          <div class="playlist-pick-check ${has ? 'checked' : ''}"><span class="mini-icon ic-check chk-icon"></span></div>
          <div class="playlist-pick-name">${escapeHtml(p.name)}</div>
          <div class="playlist-pick-count">${p.songIds.length}</div>
        </div>`;
      }).join('');
    }
    openSheet('#add-to-playlist-sheet');
  }

  $('#add-to-playlist-list').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-playlist-id]');
    if (!row || !ui.addToPlaylistSong) return;
    const plId = row.getAttribute('data-playlist-id');
    const pl = cache.playlists.find((p) => p.id === plId);
    const has = pl.songIds.includes(ui.addToPlaylistSong.id);
    if (has) await DB.removeSongFromPlaylist(plId, ui.addToPlaylistSong.id);
    else await DB.addSongToPlaylist(plId, ui.addToPlaylistSong.id);
    await reloadCache();
    row.querySelector('.playlist-pick-check').classList.toggle('checked', !has);
    toast(has ? 'Removed from playlist' : 'Added to playlist');
  });

  $('#add-playlist-new-btn').addEventListener('click', () => {
    showTextInput('New Playlist', 'Playlist name', '', async (name) => {
      if (!name) return;
      const pl = await DB.createPlaylist(name);
      if (ui.addToPlaylistSong) {
        await DB.addSongToPlaylist(pl.id, ui.addToPlaylistSong.id);
      }
      await reloadCache();
      closeSheet('#add-to-playlist-sheet');
      toast('Playlist created');
    });
  });

  function refreshCurrentScreen() {
    if (ui.screen === 'home') renderHome();
    else if (ui.screen === 'library') renderLibrary();
    else if (ui.screen === 'playlists') renderPlaylists();
    else if (ui.screen === 'collection' && ui.collection) renderCollection(ui.collection.type, ui.collection.key);
    else if (ui.screen === 'playlist-detail' && ui.playlistDetailId) renderPlaylistDetail(ui.playlistDetailId);
  }

  /* ------------------------------------------------------------------ */
  /* IMPORT PIPELINE                                                      */
  /* ------------------------------------------------------------------ */

  $$('[data-action="import"]').forEach((btn) => btn.addEventListener('click', () => $('#music-upload').click()));

  $('#music-upload').addEventListener('change', (e) => {
    handleFiles(Array.from(e.target.files || []));
    e.target.value = ''; // allow re-selecting the same file later
  });

  async function handleFiles(files) {
    if (!files.length) return;
    const panel = $('#import-progress');
    const fill = $('#import-progress-fill');
    const countEl = $('#import-progress-count');
    const titleEl = $('#import-progress-title');
    panel.classList.remove('hidden');
    titleEl.textContent = 'Importing…';

    let imported = 0, duplicates = 0, failed = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      countEl.textContent = `${i + 1} / ${files.length}`;
      fill.style.width = `${Math.round(((i) / files.length) * 100)}%`;

      try {
        if (!file || file.size === 0) { failed++; continue; }

        const fingerprint = await Meta.computeFingerprint(file);
        const existing = await DB.findByFingerprint(fingerprint);
        if (existing) { duplicates++; continue; }

        const extracted = await Meta.extractMetadata(file);
        const id = DB.newId();
        const meta = {
          id,
          fileName: file.name,
          title: extracted.title || file.name,
          artist: extracted.artist || 'Unknown Artist',
          album: extracted.album || 'Unknown Album',
          genre: extracted.genre || 'Unknown Genre',
          duration: extracted.duration || 0,
          size: file.size,
          mimeType: file.type || 'audio/mpeg',
          dateAdded: Date.now(),
          liked: false,
          playCount: 0,
          lastPlayed: null,
          resumePosition: 0,
          fingerprint,
        };
        await DB.addSong(meta, file, extracted.artworkBlob || null);
        imported++;
      } catch (err) {
        console.error('Import failed for', file && file.name, err);
        failed++;
      }
    }

    fill.style.width = '100%';
    setTimeout(() => panel.classList.add('hidden'), 500);

    await reloadCache();
    refreshCurrentScreen();

    const parts = [];
    if (imported) parts.push(`${imported} song${imported === 1 ? '' : 's'} imported`);
    if (duplicates) parts.push(`${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped`);
    if (failed) parts.push(`${failed} failed`);
    toast(parts.join(' · ') || 'Nothing imported', failed && !imported ? 'error' : undefined);
  }

  /* ------------------------------------------------------------------ */
  /* PLAYER UI WIRING                                                     */
  /* ------------------------------------------------------------------ */

  function openFullPlayer() {
    $('#full-player').classList.add('open');
  }
  function closeFullPlayer() {
    $('#full-player').classList.remove('open');
  }
  $('#player-collapse-btn').addEventListener('click', closeFullPlayer);
  $('#mini-player').addEventListener('click', (e) => {
    if (e.target.closest('#mini-play-btn') || e.target.closest('#mini-next-btn')) return;
    openFullPlayer();
  });
  $('#mini-play-btn').addEventListener('click', (e) => { e.stopPropagation(); Player.togglePlay(); });
  $('#mini-next-btn').addEventListener('click', (e) => { e.stopPropagation(); Player.next(true); });

  $('#player-play-btn').addEventListener('click', () => Player.togglePlay());
  $('#player-prev-btn').addEventListener('click', () => Player.prev());
  $('#player-next-btn').addEventListener('click', () => Player.next(true));
  $('#player-shuffle-btn').addEventListener('click', () => Player.setShuffle(!Player.shuffle));
  $('#player-repeat-btn').addEventListener('click', () => {
    const modes = ['off', 'all', 'one'];
    const next = modes[(modes.indexOf(Player.repeat) + 1) % modes.length];
    Player.setRepeat(next);
  });
  $('#player-like-btn').addEventListener('click', async () => {
    const song = Player.currentSong;
    if (!song) return;
    await DB.setLiked(song.id, !song.liked);
    await reloadCache();
    syncLikeButtonsForCurrentSong();
    refreshCurrentScreen();
  });
  $('#player-menu-btn').addEventListener('click', () => {
    if (Player.currentSong) openContextMenu(getSong(Player.currentSong.id) || Player.currentSong);
  });

  const seekInput = $('#player-seek');
  seekInput.addEventListener('input', () => { ui.seeking = true; });
  seekInput.addEventListener('change', () => {
    const duration = Player.duration || 0;
    Player.seek((seekInput.value / 100) * duration);
    ui.seeking = false;
  });

  $('#player-volume').addEventListener('input', (e) => Player.setVolume(parseFloat(e.target.value)));
  $('#settings-volume').addEventListener('input', (e) => Player.setVolume(parseFloat(e.target.value)));
  $('#speed-select').addEventListener('change', (e) => Player.setPlaybackRate(parseFloat(e.target.value)));

  function syncLikeButtonsForCurrentSong() {
    const song = Player.currentSong ? getSong(Player.currentSong.id) : null;
    $('#player-like-btn').classList.toggle('is-liked', !!(song && song.liked));
  }

  Player.on('trackchange', ({ meta, artworkUrl, contextLabel }) => {
    if (!meta) {
      $('#mini-player').classList.add('hidden');
      closeFullPlayer();
      return;
    }
    $('#mini-player').classList.remove('hidden');
    $('#mini-title').textContent = meta.title;
    $('#mini-artist').textContent = meta.artist;
    $('#player-title').textContent = meta.title;
    $('#player-artist').textContent = meta.artist;
    $('#player-context-label').textContent = contextLabel ? `Playing from ${contextLabel}` : 'Now Playing';

    const miniArt = $('#mini-art');
    const fullArt = $('#player-artwork');
    [miniArt, fullArt].forEach((el) => {
      el.className = el.id === 'mini-art' ? 'mini-art art-fallback ph-note' : 'artwork art-fallback ph-note';
      el.style.backgroundImage = '';
    });
    if (artworkUrl) {
      [miniArt, fullArt].forEach((el) => {
        el.style.backgroundImage = `url("${artworkUrl}")`;
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
        el.classList.remove('art-fallback', 'ph-note');
      });
    }

    syncLikeButtonsForCurrentSong();
    // Refresh library/collection rows to move the "now playing" highlight
    refreshCurrentScreen();
  });

  Player.on('playstate', ({ playing, blocked }) => {
    $('#mini-play-btn').classList.toggle('is-playing', playing);
    $('#player-play-btn').classList.toggle('is-playing', playing);
    if (blocked) {
      toast('Tap play to resume — your browser blocked automatic playback.');
    }
  });

  Player.on('time', ({ currentTime, duration }) => {
    const pct = duration ? (currentTime / duration) * 100 : 0;
    $('#mini-progress-fill').style.width = `${pct}%`;
    if (!ui.seeking) seekInput.value = pct || 0;
    $('#player-time-current').textContent = formatDuration(currentTime);
    $('#player-time-remaining').textContent = duration ? `-${formatDuration(duration - currentTime)}` : '-0:00';
  });

  Player.on('queue', ({ shuffle, repeat }) => {
    $('#player-shuffle-btn').classList.toggle('is-active', shuffle);
    $('#player-repeat-btn').classList.toggle('is-active', repeat !== 'off');
    $('#player-repeat-btn').setAttribute('data-mode', repeat);
    renderQueueSheetIfOpen();
  });

  Player.on('error', ({ message, type }) => {
    toast(message, 'error');
  });

  Player.on('settings', ({ volume, playbackRate }) => {
    $('#player-volume').value = volume;
    $('#settings-volume').value = volume;
    $('#speed-select').value = String(playbackRate);
  });

  Player.on('eq', (state) => {
    const select = $('#eq-preset-select');
    if (select.options.length === 0) {
      select.innerHTML = state.presets.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
    }
    select.value = state.preset === 'Custom' ? select.value : state.preset;
    $('#eq-bass').value = state.bass;
    $('#eq-treble').value = state.treble;
    $('#eq-bass-val').textContent = `${state.bass > 0 ? '+' : ''}${state.bass}dB`;
    $('#eq-treble-val').textContent = `${state.treble > 0 ? '+' : ''}${state.treble}dB`;
    const unsupported = !state.supported;
    $('#eq-bars').classList.toggle('hidden', unsupported);
    $('#eq-preset-select').disabled = unsupported;
    $('#eq-unsupported-hint').classList.toggle('hidden', !unsupported);
  });

  $('#eq-preset-select').addEventListener('change', (e) => Player.setEQPreset(e.target.value));
  $('#eq-bass').addEventListener('input', (e) => { Player.setBass(parseFloat(e.target.value)); $('#eq-bass-val').textContent = `${e.target.value > 0 ? '+' : ''}${e.target.value}dB`; });
  $('#eq-treble').addEventListener('input', (e) => { Player.setTreble(parseFloat(e.target.value)); $('#eq-treble-val').textContent = `${e.target.value > 0 ? '+' : ''}${e.target.value}dB`; });
  $('#reset-audio-btn').addEventListener('click', () => { Player.resetAudioSettings(); toast('Audio settings reset'); });

  /* ------------------------------------------------------------------ */
  /* QUEUE SHEET                                                          */
  /* ------------------------------------------------------------------ */

  $('#player-queue-btn').addEventListener('click', () => { renderQueueSheetIfOpen(true); openSheet('#queue-sheet'); });
  $('#queue-clear-btn').addEventListener('click', () => { Player.clearQueue(); toast('Queue cleared'); });

  function renderQueueSheetIfOpen(force) {
    const sheet = $('#queue-sheet');
    if (!force && sheet.classList.contains('hidden')) return;
    const q = Player.getQueueState();
    const songs = q.queue.map((id) => getSong(id)).filter(Boolean);
    if (songs.length === 0) {
      $('#queue-list').innerHTML = `<p class="hint" style="padding:14px 4px;">Queue is empty.</p>`;
      return;
    }
    $('#queue-list').innerHTML = songs.map((s, i) => `
      <div class="song-row${i === q.currentIndex ? ' is-playing' : ''}" data-id="${s.id}" data-index="${i}">
        ${artHtml(s)}
        <div class="song-info">
          <p class="song-title">${escapeHtml(s.title)}</p>
          <p class="song-sub">${escapeHtml(s.artist)}</p>
        </div>
        <div class="song-reorder">
          <button class="icon-btn small ic-chevron-up" data-qaction="up" data-index="${i}"></button>
          <button class="icon-btn small ic-chevron-down" data-qaction="down" data-index="${i}"></button>
        </div>
        <button class="icon-btn small ic-close" data-qaction="remove" data-index="${i}"></button>
      </div>`).join('');
    hydrateArtwork($('#queue-list'));
  }

  $('#queue-list').addEventListener('click', (e) => {
    const upBtn = e.target.closest('[data-qaction="up"]');
    const downBtn = e.target.closest('[data-qaction="down"]');
    const removeBtn = e.target.closest('[data-qaction="remove"]');
    if (upBtn) {
      const idx = parseInt(upBtn.getAttribute('data-index'), 10);
      if (idx > 0) Player.reorderQueue(idx, idx - 1);
      renderQueueSheetIfOpen(true);
      return;
    }
    if (downBtn) {
      const idx = parseInt(downBtn.getAttribute('data-index'), 10);
      Player.reorderQueue(idx, idx + 1);
      renderQueueSheetIfOpen(true);
      return;
    }
    if (removeBtn) {
      Player.removeFromQueue(parseInt(removeBtn.getAttribute('data-index'), 10));
      renderQueueSheetIfOpen(true);
      return;
    }
    const row = e.target.closest('[data-index]');
    if (row) {
      const idx = parseInt(row.getAttribute('data-index'), 10);
      const q = Player.getQueueState();
      Player.playQueue(q.queue, idx, q.contextLabel);
    }
  });

  /* ------------------------------------------------------------------ */
  /* SETTINGS / STORAGE                                                   */
  /* ------------------------------------------------------------------ */

  async function renderSettingsStorage() {
    const stats = await DB.getLibraryStats();
    $('#stat-songs').textContent = stats.songCount;
    $('#stat-playlists').textContent = stats.playlistCount;
    $('#stat-size').textContent = formatBytes(stats.totalBytes);

    const quota = await DB.estimateStorageQuota();
    if (quota && quota.usage != null && quota.quota) {
      $('#stat-quota').textContent = `${formatBytes(quota.usage)} of ${formatBytes(quota.quota)}`;
    } else {
      $('#stat-quota').textContent = '—';
    }
  }

  $('#clear-recent-btn').addEventListener('click', () => {
    showConfirm('Clear recently played?', 'This clears your play history. Your songs and playlists are not affected.', async () => {
      await DB.clearRecentlyPlayed();
      await reloadCache();
      refreshCurrentScreen();
      toast('Recently played cleared');
    });
  });

  $('#clear-all-btn').addEventListener('click', () => {
    showConfirm('Clear all music?', 'This permanently deletes every imported song and playlist from this device. This cannot be undone.', async () => {
      Player.resetAll();
      await DB.clearAllMusic();
      await reloadCache();
      artworkUrlCache.forEach((url) => url && URL.revokeObjectURL(url));
      artworkUrlCache = new Map();
      navigateTo('home');
      renderSettingsStorage();
      toast('Library cleared');
    });
  });

  /* ------------------------------------------------------------------ */
  /* PWA INSTALL                                                          */
  /* ------------------------------------------------------------------ */

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    ui.deferredInstallPrompt = e;
    const btn = $('#install-btn');
    btn.disabled = false;
    $('#install-hint').textContent = 'Installs Midnight Sonic as an app on your home screen.';
  });

  $('#install-btn').addEventListener('click', async () => {
    if (!ui.deferredInstallPrompt) return;
    ui.deferredInstallPrompt.prompt();
    await ui.deferredInstallPrompt.userChoice;
    ui.deferredInstallPrompt = null;
    $('#install-btn').disabled = true;
  });

  window.addEventListener('appinstalled', () => {
    $('#install-hint').textContent = 'Installed! Launch Midnight Sonic from your home screen.';
    $('#install-btn').disabled = true;
  });

  function initInstallHint() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (standalone) {
      $('#install-btn').disabled = true;
      $('#install-hint').textContent = 'You\u2019re already running the installed app.';
    } else if (!ui.deferredInstallPrompt) {
      $('#install-hint').textContent = 'If you don\u2019t see a button here yet, use your browser menu → "Add to Home screen".';
    }
  }

  /* ------------------------------------------------------------------ */
  /* SERVICE WORKER                                                       */
  /* ------------------------------------------------------------------ */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('Service worker registration failed (app still works, but offline caching won\u2019t).', err);
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* INIT                                                                 */
  /* ------------------------------------------------------------------ */

  async function init() {
    registerServiceWorker();
    // Load the library into memory first so that when MSPlayer restores a
    // previous session (and immediately emits trackchange/queue events),
    // the UI has real data to render against instead of an empty cache.
    await reloadCache();
    await Player.init($('#main-audio'));

    navigateTo('home');
    renderPlaylists();
    renderSettingsStorage();
    initInstallHint();

    if (!Player.currentSong) {
      $('#mini-player').classList.add('hidden');
    }

    try { await DB.requestPersistentStorage(); } catch (e) { /* best-effort */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
