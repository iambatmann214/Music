/**
 * meta.js — Best-effort metadata extraction for imported audio files.
 *
 * Browsers give us almost nothing for free beyond duration (via a temporary
 * <audio> element). Real title/artist/album/artwork requires reading the
 * file's tag data ourselves. This module implements a small, defensive
 * ID3v2 (v2.3 / v2.4) reader — which covers the large majority of MP3s in
 * the wild — plus filename-based fallbacks for every other format so import
 * never fails just because a tag couldn't be parsed.
 */

(function () {
  function probeDuration(file) {
    return new Promise((resolve) => {
      let settled = false;
      const url = URL.createObjectURL(file);
      const audio = new Audio();
      const cleanup = () => {
        URL.revokeObjectURL(url);
        audio.removeEventListener('loadedmetadata', onLoaded);
        audio.removeEventListener('error', onError);
      };
      const finish = (val) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(val);
      };
      const onLoaded = () => finish(isFinite(audio.duration) ? audio.duration : 0);
      const onError = () => finish(0);
      audio.addEventListener('loadedmetadata', onLoaded);
      audio.addEventListener('error', onError);
      audio.preload = 'metadata';
      audio.src = url;
      // Some browsers/files never fire an event for malformed streams —
      // don't let a single bad file stall the whole import batch.
      setTimeout(() => finish(0), 8000);
    });
  }

  async function computeFingerprint(file) {
    try {
      const chunkSize = 262144; // 256KB is enough to distinguish real duplicates
      const head = file.slice(0, Math.min(chunkSize, file.size));
      const buf = await head.arrayBuffer();
      const hashBuf = await crypto.subtle.digest('SHA-256', buf);
      const hashArr = Array.from(new Uint8Array(hashBuf));
      const hex = hashArr.map((b) => b.toString(16).padStart(2, '0')).join('');
      return `${file.size}-${hex}`;
    } catch (e) {
      // SubtleCrypto unavailable (e.g. non-secure context) — fall back to a
      // weaker but still useful fingerprint.
      return `${file.size}-${file.name}-${file.lastModified}`;
    }
  }

  function readSynchsafe(bytes, offset) {
    return (
      ((bytes[offset] & 0x7f) << 21) |
      ((bytes[offset + 1] & 0x7f) << 14) |
      ((bytes[offset + 2] & 0x7f) << 7) |
      (bytes[offset + 3] & 0x7f)
    );
  }

  function readUInt32BE(bytes, offset) {
    return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
  }

  function decodeText(bytes) {
    if (!bytes || bytes.length === 0) return '';
    const encoding = bytes[0];
    let body = bytes.slice(1);
    try {
      if (encoding === 1 || encoding === 2) {
        // UTF-16 (with or without BOM)
        let littleEndian = true;
        let start = 0;
        if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) { littleEndian = true; start = 2; }
        else if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) { littleEndian = false; start = 2; }
        const units = [];
        for (let i = start; i + 1 < body.length; i += 2) {
          const code = littleEndian ? (body[i] | (body[i + 1] << 8)) : ((body[i] << 8) | body[i + 1]);
          if (code === 0) break;
          units.push(code);
        }
        return String.fromCharCode.apply(null, units);
      }
      // encoding 0 (Latin-1) or 3 (UTF-8)
      let end = body.indexOf(0);
      if (end === -1) end = body.length;
      body = body.slice(0, end);
      if (encoding === 3) {
        return new TextDecoder('utf-8').decode(new Uint8Array(body));
      }
      return String.fromCharCode.apply(null, body);
    } catch (e) {
      return '';
    }
  }

  async function parseID3v2(file) {
    const result = { title: '', artist: '', album: '', genre: '', artworkBlob: null };
    try {
      const headerBuf = await file.slice(0, 10).arrayBuffer();
      const header = new Uint8Array(headerBuf);
      if (!(header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33)) {
        return result; // no "ID3" magic — not an ID3v2 tag
      }
      const majorVersion = header[3];
      const tagSize = readSynchsafe(header, 6);
      if (!tagSize || tagSize <= 0) return result;

      // Cap how much we read defensively (huge embedded artwork shouldn't
      // stall import or blow up memory).
      const readSize = Math.min(tagSize, 8 * 1024 * 1024);
      const tagBuf = await file.slice(10, 10 + readSize).arrayBuffer();
      const bytes = new Uint8Array(tagBuf);

      let offset = 0;
      const wanted = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TCON: 'genre' };

      while (offset + 10 <= bytes.length) {
        const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
        if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding / end of frames

        let frameSize;
        if (majorVersion >= 4) frameSize = readSynchsafe(bytes, offset + 4);
        else frameSize = readUInt32BE(bytes, offset + 4);

        const frameStart = offset + 10;
        if (frameSize <= 0 || frameStart + frameSize > bytes.length) break;
        const frameData = bytes.slice(frameStart, frameStart + frameSize);

        if (wanted[id]) {
          const text = decodeText(frameData);
          if (text) result[wanted[id]] = text.replace(/\u0000/g, '').trim();
        } else if (id === 'APIC' && !result.artworkBlob) {
          try {
            const encoding = frameData[0];
            let p = 1;
            let mimeEnd = frameData.indexOf(0, p);
            if (mimeEnd === -1) mimeEnd = p;
            const mime = String.fromCharCode.apply(null, frameData.slice(p, mimeEnd)) || 'image/jpeg';
            p = mimeEnd + 1;
            p += 1; // picture type byte
            // description string, terminated per encoding
            if (encoding === 1 || encoding === 2) {
              while (p + 1 < frameData.length && !(frameData[p] === 0 && frameData[p + 1] === 0)) p += 2;
              p += 2;
            } else {
              while (p < frameData.length && frameData[p] !== 0) p += 1;
              p += 1;
            }
            const imgBytes = frameData.slice(p);
            if (imgBytes.length > 100) {
              result.artworkBlob = new Blob([imgBytes], { type: mime.startsWith('image/') ? mime : 'image/jpeg' });
            }
          } catch (e) { /* ignore malformed artwork frame */ }
        }

        offset = frameStart + frameSize;
      }
    } catch (e) {
      console.warn('ID3 parse failed, falling back to filename metadata.', e);
    }
    return result;
  }

  function parseFilenameFallback(fileName) {
    const base = fileName.replace(/\.[^/.]+$/, '').replace(/_/g, ' ').trim();
    const sep = base.match(/^(.+?)\s*[-–—]\s*(.+)$/);
    if (sep) {
      return { artist: sep[1].trim(), title: sep[2].trim() };
    }
    return { artist: '', title: base };
  }

  /**
   * Full best-effort extraction. Never throws — worst case you get the
   * filename as the title and "Unknown Artist".
   */
  async function extractMetadata(file) {
    const [duration, id3, fingerprint] = await Promise.all([
      probeDuration(file),
      // parseID3v2 is internally defensive (try/catch) and simply returns
      // empty fields when a file has no ID3v2 tag, so it's safe to attempt
      // on every file rather than gatekeeping on MIME type/extension.
      parseID3v2(file),
      computeFingerprint(file),
    ]);

    const fallback = parseFilenameFallback(file.name);

    return {
      title: id3.title || fallback.title || file.name,
      artist: id3.artist || fallback.artist || 'Unknown Artist',
      album: id3.album || 'Unknown Album',
      genre: id3.genre || 'Unknown Genre',
      duration: duration || 0,
      fingerprint,
      artworkBlob: id3.artworkBlob || null,
    };
  }

  window.MSMeta = { extractMetadata, probeDuration, computeFingerprint };
})();
