// ...new file...
module.exports = function createUtils(deps = {}) {
  const { allSongs = [], lastAddedTimestamps = {} } = deps;

  function getVideoId(url) {
    if (!url) return null;
    const m1 = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (m1) return m1[1];
    const m2 = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (m2) return m2[1];
    const m3 = url.match(/([a-zA-Z0-9_-]{11})/);
    return m3 ? m3[1] : null;
  }

  function normalizeText(s = '') {
    return s.toString().toLowerCase()
      .replace(/\(.*?\)|\[.*?\]|\".*?\"/g, '')
      .replace(/feat\.|ft\.|official|audio|lyrics/gi, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseArtistTrack(title) {
    if (!title) return { artist: null, track: title };
    let t = title.replace(/\(.*?\)|\[.*?\]/g, '');
    const parts = t.split(/[-–—|\\/]/).map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return { artist: normalizeText(parts[0]), track: normalizeText(parts.slice(1).join(' ')) };
    }
    return { artist: null, track: normalizeText(t) };
  }

  function isLyrics(title) {
    if (!title) return false;
    return /lyrics|lyric video|歌詞|歌詞付き|歌詞mv|歌詞版/i.test(title);
  }

  function isLiveOrBad(title) {
    return /live|concert|stream|session|full album|interview|radio edit/i.test(title || '');
  }

  function isPerformanceOrDance(title) {
    if (!title) return false;
    return /performance|performance video|dance practice|dance-practice|choreography|dance practice video/i.test(title);
  }

  function titleTooSimilar(a, b) {
    if (!a || !b) return false;
    const na = normalizeText(a);
    const nb = normalizeText(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const wa = na.split(/\s+/).filter(Boolean);
    const wb = nb.split(/\s+/).filter(Boolean);
    const setA = new Set(wa);
    let match = 0;
    for (const w of wb) if (setA.has(w)) match++;
    const overlapRatio = match / Math.max(wa.length, wb.length);
    return overlapRatio >= 0.85 || na.includes(nb) || nb.includes(na);
  }

  function wordsOverlapRatio(seedWords, titleWords) {
    if (!seedWords || !seedWords.length) return 0;
    const s = new Set(seedWords);
    let match = 0;
    for (const w of titleWords) if (s.has(w)) match++;
    return match / seedWords.length;
  }

  function canAddUrl(url) {
    if (!url) return false;
    const vid = getVideoId(url);
    if (!vid) return false;
    if (allSongs.some(s => s.url === url)) return false;
    if (allSongs.some(s => getVideoId(s.url) === vid)) return false;
    const lastTs = lastAddedTimestamps[vid] || lastAddedTimestamps[url] || 0;
    if (Date.now() - lastTs < 5000) return false;
    return true;
  }

  // Export functions
  return {
    getVideoId,
    normalizeText,
    parseArtistTrack,
    isLyrics,
    isLiveOrBad,
    isPerformanceOrDance,
    titleTooSimilar,
    wordsOverlapRatio,
    canAddUrl
  };
};
// ...end file...