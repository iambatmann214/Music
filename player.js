/**
 * player.js — Playback engine.
 *
 * Wraps a single real <audio> element. The UI never fakes progress or
 * state: every visible number comes from the audio element's own events
 * (timeupdate, loadedmetadata, play, pause, ended, waiting, canplay, error).
 *
 * Also owns:
 *  - the play queue (array of song ids + a cursor)
 *  - shuffle / repeat modes
 *  - an optional Web Audio graph for the equalizer (created lazily, and
 *    only if the browser supports it — playback still works without it)
 *  - Media Session integration for lock-screen / notification controls
 *  - debounced persistence of player state so it can be restored later
 */

(function () {
  const DB = window.MSDB;

  const EQ_PRESETS = {
    'Balanced':        { bass: 0,  mid: 0,  treble: 0  },
    'Bass Boost':      { bass: 6,  mid: 1,  treble: 0  },
    'Deep Bass':       { bass: 9,  mid: -1, treble: -1 },
    'Vocal':           { bass: -2, mid: 5,  treble: 2  },
    'Electronic':      { bass: 5,  mid: -1, treble: 4  },
    'Classical':       { bass: 2,  mid: 2,  treble: 3  },
    'Rock':            { bass: 4,  mid: 2,  treble: 3  },
    'Smooth / Premium':{ bass: 3,  mid: 0,  treble: 2  },
  };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  const listeners = {
    trackchange: [], playstate: [], time: [], queue: [],
    error: [], eq: [], settings: [], liveInfo: [],
  };
  function emit(evt, payload) {
    (listeners[evt] || []).forEach((cb) => {
      try { cb(payload); } catch (e) { console.error('[player] listener error', evt, e); }
    });
  }
  function on(evt, cb) {
    if (!listeners[evt]) listeners[evt] = [];
    listeners[evt].push(cb);
  }

  const state = {
    audioEl: null,
    queue: [],          // array of song ids, in the order they'll play
    currentIndex: -1,
    shuffleOrder: null,  // array of indices into `queue` when shuffle is on
    shufflePos: 0,
    shuffle: false,
    repeat: 'off',       // 'off' | 'all' | 'one'
    volume: 1,
    playbackRate: 1,
    currentSongMeta: null,
    currentObjectUrl: null,
    currentArtworkUrl: null,
    contextLabel: '',
    restoring: false,
    saveTimer: null,
    ready: false,
  };

  // ---- Web Audio graph (EQ) — created lazily on first play() call ----
  const audioGraph = {
    ctx: null,
    source: null,
    bass: null,
    mid: null,
    treble: null,
    connected: false,
    supported: 'AudioContext' in window || 'webkitAudioContext' in window,
  };

  function ensureAudioGraph() {
    if (!audioGraph.supported || audioGraph.connected) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioGraph.ctx = new Ctx();
      audioGraph.source = audioGraph.ctx.createMediaElementSource(state.audioEl);

      audioGraph.bass = audioGraph.ctx.createBiquadFilter();
      audioGraph.bass.type = 'lowshelf';
      audioGraph.bass.frequency.value = 150;

      audioGraph.mid = audioGraph.ctx.createBiquadFilter();
      audioGraph.mid.type = 'peaking';
      audioGraph.mid.frequency.value = 1000;
      audioGraph.mid.Q.value = 0.9;

      audioGraph.treble = audioGraph.ctx.createBiquadFilter();
      audioGraph.treble.type = 'highshelf';
      audioGraph.treble.frequency.value = 6000;

      audioGraph.source
        .connect(audioGraph.bass)
        .connect(audioGraph.mid)
        .connect(audioGraph.treble)
        .connect(audioGraph.ctx.destination);

      audioGraph.connected = true;
    } catch (e) {
      console.warn('Web Audio EQ unavailable, continuing without it.', e);
      audioGraph.supported = false;
    }
  }

  function applyEQGains(bassDb, midDb, trebleDb) {
    if (!audioGraph.connected) return;
    const t = audioGraph.ctx.currentTime;
    audioGraph.bass.gain.setTargetAtTime(bassDb, t, 0.05);
    audioGraph.mid.gain.setTargetAtTime(midDb, t, 0.05);
    audioGraph.treble.gain.setTargetAtTime(trebleDb, t, 0.05);
  }

  let eqSettings = { preset: 'Balanced', bass: 0, mid: 0, treble: 0 };

  async function loadAudioSettings() {
    const saved = await DB.getKV('audioSettings', null);
    if (saved) eqSettings = Object.assign(eqSettings, saved);
    state.volume = typeof eqSettings.volume === 'number' ? eqSettings.volume : 1;
    state.playbackRate = typeof eqSettings.playbackRate === 'number' ? eqSettings.playbackRate : 1;
  }

  function persistAudioSettings() {
    DB.setKV('audioSettings', Object.assign({}, eqSettings, {
      volume: state.volume,
      playbackRate: state.playbackRate,
    }));
  }

  function setEQPreset(name) {
    const preset = EQ_PRESETS[name] || EQ_PRESETS['Balanced'];
    eqSettings = { preset: name, bass: preset.bass, mid: preset.mid, treble: preset.treble };
    ensureAudioGraph();
    applyEQGains(eqSettings.bass, eqSettings.mid, eqSettings.treble);
    persistAudioSettings();
    emit('eq', getEQState());
  }

  function setBass(db) {
    eqSettings.bass = clamp(db, -12, 12);
    eqSettings.preset = 'Custom';
    ensureAudioGraph();
    applyEQGains(eqSettings.bass, eqSettings.mid, eqSettings.treble);
    persistAudioSettings();
    emit('eq', getEQState());
  }

  function setTreble(db) {
    eqSettings.treble = clamp(db, -12, 12);
    eqSettings.preset = 'Custom';
    ensureAudioGraph();
    applyEQGains(eqSettings.bass, eqSettings.mid, eqSettings.treble);
    persistAudioSettings();
    emit('eq', getEQState());
  }

  function resetAudioSettings() {
    setEQPreset('Balanced');
    setVolume(1);
    setPlaybackRate(1);
  }

  function getEQState() {
    return {
      preset: eqSettings.preset,
      bass: eqSettings.bass,
      mid: eqSettings.mid,
      treble: eqSettings.treble,
      supported: audioGraph.supported,
      presets: Object.keys(EQ_PRESETS),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Queue management                                                    */
  /* ------------------------------------------------------------------ */

  function buildShuffleOrder() {
    const idx = state.queue.map((_, i) => i).filter((i) => i !== state.currentIndex);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    state.shuffleOrder = state.currentIndex >= 0 ? [state.currentIndex, ...idx] : idx;
    state.shufflePos = 0;
  }

  function setShuffle(on) {
    state.shuffle = !!on;
    if (state.shuffle) buildShuffleOrder();
    else state.shuffleOrder = null;
    schedulePersist();
    emit('queue', getQueueState());
  }

  function setRepeat(mode) {
    if (!['off', 'all', 'one'].includes(mode)) mode = 'off';
    state.repeat = mode;
    schedulePersist();
    emit('queue', getQueueState());
  }

  function getQueueState() {
    return {
      queue: state.queue.slice(),
      currentIndex: state.currentIndex,
      shuffle: state.shuffle,
      repeat: state.repeat,
      contextLabel: state.contextLabel,
    };
  }

  /**
   * Load a fresh queue (e.g. "play this album" or "play this playlist")
   * and start playback at `startIndex`.
   */
  async function playQueue(songIds, startIndex, contextLabel, autoplay = true) {
    state.queue = songIds.slice();
    state.currentIndex = clamp(startIndex, 0, Math.max(0, songIds.length - 1));
    state.contextLabel = contextLabel || '';
    if (state.shuffle) buildShuffleOrder();
    await loadTrack(state.currentIndex, { autoplay, resume: false });
    emit('queue', getQueueState());
  }

  function addToQueueNext(songId) {
    if (state.currentIndex < 0) {
      state.queue.push(songId);
      state.currentIndex = state.queue.length - 1;
    } else {
      state.queue.splice(state.currentIndex + 1, 0, songId);
    }
    schedulePersist();
    emit('queue', getQueueState());
  }

  function addToQueueEnd(songId) {
    state.queue.push(songId);
    schedulePersist();
    emit('queue', getQueueState());
  }

  function removeFromQueue(index) {
    if (index === state.currentIndex) return; // don't yank the playing track
    state.queue.splice(index, 1);
    if (index < state.currentIndex) state.currentIndex -= 1;
    schedulePersist();
    emit('queue', getQueueState());
  }

  function clearQueue() {
    const keep = state.currentIndex >= 0 ? state.queue[state.currentIndex] : null;
    state.queue = keep ? [keep] : [];
    state.currentIndex = keep ? 0 : -1;
    schedulePersist();
    emit('queue', getQueueState());
  }

  function reorderQueue(fromIndex, toIndex) {
    const currentId = state.currentIndex >= 0 ? state.queue[state.currentIndex] : null;
    const [moved] = state.queue.splice(fromIndex, 1);
    state.queue.splice(toIndex, 0, moved);
    if (currentId) state.currentIndex = state.queue.indexOf(currentId);
    schedulePersist();
    emit('queue', getQueueState());
  }

  /* ------------------------------------------------------------------ */
  /* Track loading & playback                                            */
  /* ------------------------------------------------------------------ */

  function revokeCurrentUrls() {
    if (state.currentObjectUrl) {
      URL.revokeObjectURL(state.currentObjectUrl);
      state.currentObjectUrl = null;
    }
    if (state.currentArtworkUrl) {
      URL.revokeObjectURL(state.currentArtworkUrl);
      state.currentArtworkUrl = null;
    }
  }

  async function loadTrack(index, opts = {}) {
    const songId = state.queue[index];
    if (!songId) return false;

    let meta, blobRow;
    try {
      [meta, blobRow] = await Promise.all([DB.getSongMeta(songId), DB.getSongBlob(songId)]);
    } catch (e) {
      emit('error', { type: 'db', message: 'Could not load song from storage.', error: e });
      return false;
    }

    if (!meta || !blobRow || !blobRow.audioBlob) {
      // The referenced song is missing (deleted, or a corrupt record).
      // Skip it instead of breaking the whole queue.
      emit('error', { type: 'missing-track', message: 'A track in your queue is unavailable — skipping.' });
      state.queue.splice(index, 1);
      if (state.queue.length === 0) { state.currentIndex = -1; return false; }
      const nextIndex = clamp(index, 0, state.queue.length - 1);
      return loadTrack(nextIndex, opts);
    }

    state.currentIndex = index;
    state.currentSongMeta = meta;

    revokeCurrentUrls();
    state.currentObjectUrl = URL.createObjectURL(blobRow.audioBlob);
    if (blobRow.artworkBlob) {
      state.currentArtworkUrl = URL.createObjectURL(blobRow.artworkBlob);
    }

    const audio = state.audioEl;
    audio.src = state.currentObjectUrl;
    audio.playbackRate = state.playbackRate;
    audio.volume = state.volume;

    const resumeAt = opts.resume && meta.resumePosition ? meta.resumePosition : 0;

    const onLoadedMeta = () => {
      if (resumeAt > 0 && resumeAt < (audio.duration || Infinity) - 2) {
        try { audio.currentTime = resumeAt; } catch (e) { /* ignore seek errors */ }
      }
      // Self-heal missing/incorrect duration captured at import time now
      // that the real decoder has reported the true value.
      if (audio.duration && isFinite(audio.duration) && Math.abs((meta.duration || 0) - audio.duration) > 1) {
        meta.duration = audio.duration;
        DB.updateSongMeta(meta.id, { duration: audio.duration }).catch(() => {});
      }
      audio.removeEventListener('loadedmetadata', onLoadedMeta);
    };
    audio.addEventListener('loadedmetadata', onLoadedMeta);

    updateMediaSessionMetadata(meta, state.currentArtworkUrl);
    emit('trackchange', { meta, index, artworkUrl: state.currentArtworkUrl, contextLabel: state.contextLabel });
    schedulePersist(true);

    if (opts.autoplay) {
      try {
        await play();
      } catch (e) {
        // Autoplay was blocked — that's expected browser policy, not a bug.
        // Leave the track cued and let the user press play.
        emit('playstate', { playing: false, blocked: true });
      }
    }
    return true;
  }

  async function play() {
    ensureAudioGraph();
    if (audioGraph.ctx && audioGraph.ctx.state === 'suspended') {
      try { await audioGraph.ctx.resume(); } catch (e) { /* ignore */ }
    }
    await state.audioEl.play();
  }

  function pause() {
    state.audioEl.pause();
  }

  function togglePlay() {
    if (state.audioEl.paused) return play();
    pause();
    return Promise.resolve();
  }

  function seek(time) {
    if (!isFinite(time)) return;
    state.audioEl.currentTime = clamp(time, 0, state.audioEl.duration || time);
  }

  function seekBy(deltaSeconds) {
    seek(state.audioEl.currentTime + deltaSeconds);
  }

  function setVolume(v) {
    state.volume = clamp(v, 0, 1);
    state.audioEl.volume = state.volume;
    persistAudioSettings();
    emit('settings', { volume: state.volume, playbackRate: state.playbackRate });
  }

  function setPlaybackRate(r) {
    state.playbackRate = clamp(r, 0.5, 2);
    state.audioEl.playbackRate = state.playbackRate;
    persistAudioSettings();
    emit('settings', { volume: state.volume, playbackRate: state.playbackRate });
  }

  function nextQueueIndex(manual) {
    if (state.queue.length === 0) return -1;

    if (state.repeat === 'one' && !manual) {
      return state.currentIndex;
    }

    if (state.shuffle && state.shuffleOrder) {
      state.shufflePos += 1;
      if (state.shufflePos >= state.shuffleOrder.length) {
        if (state.repeat === 'all') { buildShuffleOrder(); state.shufflePos = 0; }
        else return -1;
      }
      return state.shuffleOrder[state.shufflePos];
    }

    const next = state.currentIndex + 1;
    if (next < state.queue.length) return next;
    if (state.repeat === 'all') return 0;
    return -1;
  }

  function prevQueueIndex() {
    if (state.queue.length === 0) return -1;

    if (state.shuffle && state.shuffleOrder) {
      state.shufflePos = Math.max(0, state.shufflePos - 1);
      return state.shuffleOrder[state.shufflePos];
    }

    const prev = state.currentIndex - 1;
    if (prev >= 0) return prev;
    if (state.repeat === 'all') return state.queue.length - 1;
    return 0;
  }

  async function next(manual = true) {
    const idx = nextQueueIndex(manual);
    if (idx === -1) {
      pause();
      emit('queue', Object.assign(getQueueState(), { finished: true }));
      return;
    }
    await loadTrack(idx, { autoplay: true, resume: false });
  }

  async function prev() {
    // If we're more than 3s into the track, "previous" restarts it —
    // standard music-player behavior — rather than jumping tracks.
    if (state.audioEl.currentTime > 3) {
      seek(0);
      return;
    }
    const idx = prevQueueIndex();
    if (idx === -1) return;
    await loadTrack(idx, { autoplay: true, resume: false });
  }

  /* ------------------------------------------------------------------ */
  /* State persistence                                                    */
  /* ------------------------------------------------------------------ */

  function schedulePersist(immediate = false) {
    if (state.restoring) return;
    if (state.saveTimer) clearTimeout(state.saveTimer);
    const doSave = () => {
      DB.setKV('playerState', {
        queue: state.queue,
        currentIndex: state.currentIndex,
        shuffle: state.shuffle,
        repeat: state.repeat,
        position: state.audioEl ? state.audioEl.currentTime : 0,
        contextLabel: state.contextLabel,
      });
      if (state.currentSongMeta) {
        DB.saveResumePosition(state.currentSongMeta.id, state.audioEl.currentTime || 0);
      }
    };
    if (immediate) doSave();
    else state.saveTimer = setTimeout(doSave, 1500);
  }

  async function restoreState() {
    state.restoring = true;
    await loadAudioSettings();
    state.audioEl.volume = state.volume;
    state.audioEl.playbackRate = state.playbackRate;

    const saved = await DB.getKV('playerState', null);
    if (saved && Array.isArray(saved.queue) && saved.queue.length) {
      state.queue = saved.queue;
      state.currentIndex = clamp(saved.currentIndex || 0, 0, saved.queue.length - 1);
      state.shuffle = !!saved.shuffle;
      state.repeat = saved.repeat || 'off';
      state.contextLabel = saved.contextLabel || '';
      if (state.shuffle) buildShuffleOrder();
      // Cue the track without autoplaying (mobile browsers block unsolicited
      // autoplay, and it would surprise the user anyway).
      await loadTrack(state.currentIndex, { autoplay: false, resume: true });
      if (typeof saved.position === 'number') {
        const applyPos = () => {
          try { state.audioEl.currentTime = saved.position; } catch (e) {}
        };
        if (state.audioEl.readyState >= 1) applyPos();
        else state.audioEl.addEventListener('loadedmetadata', applyPos, { once: true });
      }
    }
    state.restoring = false;
    state.ready = true;
    emit('eq', getEQState());
    emit('settings', { volume: state.volume, playbackRate: state.playbackRate });
  }

  /* ------------------------------------------------------------------ */
  /* Media Session                                                       */
  /* ------------------------------------------------------------------ */

  function updateMediaSessionMetadata(meta, artworkUrl) {
    if (!('mediaSession' in navigator)) return;
    const artwork = artworkUrl
      ? [{ src: artworkUrl, sizes: '512x512', type: 'image/png' }]
      : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: meta.title || meta.fileName || 'Unknown Title',
      artist: meta.artist || 'Unknown Artist',
      album: meta.album || '',
      artwork,
    });
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', () => play());
      ms.setActionHandler('pause', () => pause());
      ms.setActionHandler('previoustrack', () => prev());
      ms.setActionHandler('nexttrack', () => next(true));
      ms.setActionHandler('seekbackward', (details) => seekBy(-(details.seekOffset || 10)));
      ms.setActionHandler('seekforward', (details) => seekBy(details.seekOffset || 10));
      ms.setActionHandler('seekto', (details) => {
        if (details.fastSeek && 'fastSeek' in state.audioEl) {
          state.audioEl.fastSeek(details.seekTime);
        } else {
          seek(details.seekTime);
        }
      });
      ms.setActionHandler('stop', () => { pause(); seek(0); });
    } catch (e) {
      console.warn('Some Media Session actions are unsupported.', e);
    }
  }

  function updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const audio = state.audioEl;
    if (!audio.duration || !isFinite(audio.duration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate,
        position: clamp(audio.currentTime, 0, audio.duration),
      });
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ */
  /* Wiring real <audio> events                                          */
  /* ------------------------------------------------------------------ */

  let lastTickSave = 0;

  function bindAudioEvents() {
    const audio = state.audioEl;

    audio.addEventListener('play', () => {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      emit('playstate', { playing: true });
    });

    audio.addEventListener('pause', () => {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      emit('playstate', { playing: false });
      schedulePersist(true);
    });

    audio.addEventListener('timeupdate', () => {
      emit('time', { currentTime: audio.currentTime, duration: audio.duration });
      updatePositionState();
      const now = Date.now();
      if (now - lastTickSave > 5000) {
        lastTickSave = now;
        schedulePersist();
      }
    });

    audio.addEventListener('loadedmetadata', () => {
      emit('time', { currentTime: audio.currentTime, duration: audio.duration });
    });

    audio.addEventListener('durationchange', () => {
      emit('time', { currentTime: audio.currentTime, duration: audio.duration });
    });

    audio.addEventListener('waiting', () => emit('liveInfo', { buffering: true }));
    audio.addEventListener('canplay', () => emit('liveInfo', { buffering: false }));

    audio.addEventListener('ended', () => {
      if (state.currentSongMeta) {
        DB.recordPlay(state.currentSongMeta.id, 0);
        DB.saveResumePosition(state.currentSongMeta.id, 0);
      }
      next(false);
    });

    audio.addEventListener('error', () => {
      const err = audio.error;
      let message = 'Playback error.';
      if (err) {
        switch (err.code) {
          case err.MEDIA_ERR_ABORTED: message = 'Playback was aborted.'; break;
          case err.MEDIA_ERR_NETWORK: message = 'A network error interrupted playback.'; break;
          case err.MEDIA_ERR_DECODE: message = 'This file appears to be corrupted and can\u2019t be played.'; break;
          case err.MEDIA_ERR_SRC_NOT_SUPPORTED: message = 'This audio format isn\u2019t supported by your browser.'; break;
        }
      }
      emit('error', { type: 'playback', message, songId: state.currentSongMeta && state.currentSongMeta.id });
      // Don't let one bad file wedge the whole queue — try the next track.
      if (state.queue.length > 1) next(false);
    });

    // Mark a play/scrobble once the user has heard a meaningful chunk,
    // not the instant playback starts.
    let scrobbled = false;
    audio.addEventListener('play', () => { scrobbled = false; });
    audio.addEventListener('timeupdate', () => {
      if (!scrobbled && state.currentSongMeta && audio.currentTime > 8) {
        scrobbled = true;
        DB.recordPlay(state.currentSongMeta.id);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Public init                                                          */
  /* ------------------------------------------------------------------ */

  async function init(audioElement) {
    state.audioEl = audioElement;
    bindAudioEvents();
    setupMediaSession();
    await restoreState();
    window.addEventListener('beforeunload', () => {
      schedulePersist(true);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') schedulePersist(true);
    });
  }

  /**
   * Hard reset used after the user deletes their entire library from
   * Settings — stop playback, drop the queue, and persist the empty
   * state so a reload doesn't try to resurrect songs that no longer exist.
   */
  function resetAll() {
    pause();
    revokeCurrentUrls();
    state.queue = [];
    state.currentIndex = -1;
    state.currentSongMeta = null;
    state.shuffleOrder = null;
    if (state.audioEl) state.audioEl.removeAttribute('src');
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    DB.setKV('playerState', { queue: [], currentIndex: -1, shuffle: state.shuffle, repeat: state.repeat, position: 0, contextLabel: '' });
    emit('trackchange', { meta: null, index: -1, artworkUrl: null, contextLabel: '' });
    emit('queue', getQueueState());
    emit('playstate', { playing: false });
  }

  window.MSPlayer = {
    init,
    on,
    resetAll,
    play, pause, togglePlay, seek, seekBy, next, prev,
    setVolume, setPlaybackRate,
    setShuffle, setRepeat,
    playQueue, addToQueueNext, addToQueueEnd, removeFromQueue, clearQueue, reorderQueue,
    getQueueState, getEQState,
    setEQPreset, setBass, setTreble, resetAudioSettings,
    get currentSong() { return state.currentSongMeta; },
    get isPlaying() { return state.audioEl ? !state.audioEl.paused : false; },
    get currentTime() { return state.audioEl ? state.audioEl.currentTime : 0; },
    get duration() { return state.audioEl ? state.audioEl.duration : 0; },
    get volume() { return state.volume; },
    get playbackRate() { return state.playbackRate; },
    get shuffle() { return state.shuffle; },
    get repeat() { return state.repeat; },
    get queueSongIds() { return state.queue.slice(); },
    get currentIndex() { return state.currentIndex; },
    EQ_PRESETS,
  };
})();
