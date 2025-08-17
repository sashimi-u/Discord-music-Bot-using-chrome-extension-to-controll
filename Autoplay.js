// 重寫的 Autoplay：以 getUpNext(seed) 為主要來源，fallback 使用 Innertube.search
module.exports.createAutoplay = function createAutoplay(deps) {
  const { ytdl, Innertube, utils } = deps;
  const searchCache = new Map();

  const fs = require('fs');
  const path = require('path');

  // 讀取 removeKeywords.json（若失敗則使用內建預設）
  let REMOVE_KEYWORDS = ['mv','music video','performance','performance video','字幕','subtitles','cover','official','live','lyrics','lyric','karaoke','instrumental'];
  let SIMILARITY_THRESHOLD = 0.60;
  let TITLE_MAX_LENGTH = 120; // default (chars)
  let FORBIDDEN_WORDS = []; // normalized list
  try {
    const kwPath = path.join(__dirname, 'removeKeywords.json');
    if (fs.existsSync(kwPath)) {
      const raw = fs.readFileSync(kwPath, 'utf8');
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        const cleaned = raw.replace(/\/\/.*$/gm, '');
        parsed = JSON.parse(cleaned);
      }
      if (parsed && Array.isArray(parsed.removeKeywords)) {
        REMOVE_KEYWORDS = parsed.removeKeywords.map(k => utils.normalizeText(String(k)));
        console.log('[Autoplay] loaded removeKeywords.json, count=', REMOVE_KEYWORDS.length);
      } else {
        console.log('[Autoplay] removeKeywords.json parsed but no removeKeywords array; using defaults');
      }
      if (parsed && typeof parsed.similarityThreshold === 'number') {
        const v = parsed.similarityThreshold;
        if (v > 0 && v <= 1) {
          SIMILARITY_THRESHOLD = v;
          console.log('[Autoplay] loaded similarityThreshold =', SIMILARITY_THRESHOLD);
        }
      }
      if (parsed && typeof parsed.titleMaxLength === 'number' && parsed.titleMaxLength > 0) {
        TITLE_MAX_LENGTH = Math.floor(parsed.titleMaxLength);
        console.log('[Autoplay] loaded titleMaxLength =', TITLE_MAX_LENGTH);
      }
      if (parsed && Array.isArray(parsed.forbiddenWords)) {
        FORBIDDEN_WORDS = parsed.forbiddenWords.map(w => utils.normalizeText(String(w)).trim()).filter(Boolean);
        console.log('[Autoplay] loaded forbiddenWords count =', FORBIDDEN_WORDS.length);
      }
    } else {
      console.log('[Autoplay] removeKeywords.json not found, using default keywords');
    }
  } catch (e) {
    console.warn('[Autoplay] failed to load removeKeywords.json, using defaults:', e && e.message);
  }

  // helper: remove anything after '#' (first #) and trim
  function stripAfterHashRaw(s) {
    if (!s) return '';
    return String(s).split('#')[0].trim();
  }

  // 新增：用 token overlap 計算兩個標題的相似度（0..1）
  function titleSimilarityRatio(a, b) {
    const na = utils.normalizeText(String(a || ''));
    const nb = utils.normalizeText(String(b || ''));
    if (!na || !nb) return 0;
    const ta = na.split(/\s+/).filter(Boolean);
    const tb = nb.split(/\s+/).filter(Boolean);
    if (ta.length === 0 || tb.length === 0) return 0;
    const setA = new Set(ta);
    let inter = 0;
    for (const t of tb) if (setA.has(t)) inter++;
    return inter / Math.max(ta.length, tb.length);
  }
  function isTooSimilar(a, b, threshold = SIMILARITY_THRESHOLD) {
    try {
      if (typeof utils.titleTooSimilar === 'function' && threshold === SIMILARITY_THRESHOLD) {
        if (utils.titleTooSimilar(a, b)) return true;
      }
    } catch (e) {}
    return titleSimilarityRatio(a, b) >= threshold;
  }

  // 新增 helper：escape regexp
  function escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 新增 helper：移除作者名稱與可配置關鍵字後的標題（Unicode-aware），會先刪掉 '#' 之後的文字
  function stripAuthorAndKeywords(title, authorName) {
    // remove after hash first (user requested)
    const beforeHash = stripAfterHashRaw(title || '');
    let s = utils.normalizeText(beforeHash || '');
    if (!s) return s;

    const wordBoundaryPattern = '(?<![\\p{L}\\p{N}])';
    const wordBoundaryEnd = '(?![\\p{L}\\p{N}])';

    if (authorName) {
      const an = utils.normalizeText(authorName || '');
      if (an) {
        s = s.replace(new RegExp(`${wordBoundaryPattern}${escapeRegExp(an)}${wordBoundaryEnd}`, 'gu'), ' ');
        for (const tok of an.split(/\s+/).filter(Boolean)) {
          s = s.replace(new RegExp(`${wordBoundaryPattern}${escapeRegExp(tok)}${wordBoundaryEnd}`, 'gu'), ' ');
        }
      }
    }

    for (const kw of REMOVE_KEYWORDS) {
      if (!kw) continue;
      s = s.replace(new RegExp(`${wordBoundaryPattern}${escapeRegExp(kw)}${wordBoundaryEnd}`, 'gu'), ' ');
    }

    return s.replace(/\s+/g, ' ').trim();
  }

  // 新增 helper：檢查是否包含 forbiddenWords（normalized contains）
  function containsForbiddenWord(title) {
    if (!title) return false;
    const tn = utils.normalizeText(stripAfterHashRaw(title || ''));
    if (!tn) return false;
    for (const fw of FORBIDDEN_WORDS) {
      if (!fw) continue;
      if (tn.includes(fw)) return true;
    }
    return false;
  }

  async function cachedSearch(query, opts = {}) {
    console.log(`[Autoplay] cachedSearch start: query="${query}"`);
    const key = `${query}::${opts.type || 'all'}`;
    const cached = searchCache.get(key);
    if (cached && (Date.now() - cached.ts) < 1000 * 60 * 5) {
      console.log(`[Autoplay] cachedSearch hit: "${query}"`);
      return cached.results;
    }
    try {
      const api = deps.getYoutubeApi ? deps.getYoutubeApi() : await Innertube.create();
      if (deps.setYoutubeApi && !deps.getYoutubeApi()) deps.setYoutubeApi(api);
      const res = await api.search(query, opts);
      searchCache.set(key, { ts: Date.now(), results: res });
      console.log(`[Autoplay] cachedSearch fetched: "${query}" -> items=${(res?.results||res?.videos||[]).length}`);
      return res;
    } catch (err) {
      console.warn('[Autoplay] cachedSearch error:', err && err.message);
      return {};
    }
  }

  // 取得「Up Next / related」候選影片（seed 可為 video URL/ID 或文字）
  async function getUpNext(seed) {
    console.log(`[Autoplay] getUpNext called for seed="${typeof seed === 'string' ? seed : (seed && seed.title) || '<object>'}"`);
    const results = [];
    let vid = null;
    if (typeof seed === 'string') vid = utils.getVideoId(seed);
    else if (seed && seed.url) vid = utils.getVideoId(seed.url);

    // try related + also capture author/channel info for channel-based search
    let authorName = null;
    let channelId = null;

    // compute seed text normalized for later checks
    const seedText = (typeof seed === 'string') ? seed : (seed && seed.title) || '';
    const seedNorm = utils.normalizeText(seedText || '');

    try {
      if (vid) {
        const videoUrl = `https://www.youtube.com/watch?v=${vid}`;
        console.log(`[Autoplay] getUpNext using ytdl.getInfo for vid=${vid}`);
        const info = await ytdl.getInfo(videoUrl);
        const related = info.related_videos || info.related || [];
        // extract possible author/channel info (robust to field variations)
        authorName = info.videoDetails?.author?.name || info.videoDetails?.ownerChannelName || info.videoDetails?.author || null;
        channelId = info.videoDetails?.author?.id || info.videoDetails?.channelId || null;
        console.log(`[Autoplay] detected author="${authorName}" channelId="${channelId}"`);

        console.log(`[Autoplay] getUpNext related count=${related.length} for vid=${vid}`);
        for (const rv of related) {
          const rid = rv.id || rv.videoId || rv.video_id || null;
          if (!rid) continue;
          const url = `https://www.youtube.com/watch?v=${rid}`;
          if (!utils.canAddUrl(url)) continue;
          results.push({
            url,
            title: rv.title || rv.name || '(Unknown)',
            source: 'related',
            durationSeconds: rv.lengthSeconds || rv.duration || null,
            viewCount: rv.viewCount || null
          });
        }
      }
    } catch (e) {
      console.warn('[Autoplay] getUpNext ytdl.getInfo failed:', e && e.message);
    }

    // 如果有作者名稱，且作者名稱出現在 seed/title（normalized 包含關係或 token match）才嘗試以作者做 channel 搜尋
    if (authorName) {
      try {
        const authorNorm = utils.normalizeText(authorName || '');
        let useChannelSearch = false;
        if (authorNorm && seedNorm) {
          // 如果 normalized seed 包含整個 author 字串，直接使用
          if (seedNorm.includes(authorNorm)) useChannelSearch = true;
          else {
            // 否則比對 tokens：若作者名稱的任一 token 出現在 seed 中，視作可用
            const authorTokens = authorNorm.split(/\s+/).filter(Boolean);
            const seedTokens = new Set(seedNorm.split(/\s+/).filter(Boolean));
            for (const t of authorTokens) {
              if (t && seedTokens.has(t)) { useChannelSearch = true; break; }
            }
          }
        }

        if (useChannelSearch) {
          const channelQuery = `${authorName} uploads`;
          console.log(`[Autoplay] attempting channel search for author="${authorName}" (seed matched)`);
          const res = await cachedSearch(channelQuery, { type: 'all' });
          const items = Array.isArray(res?.results) ? res.results : (Array.isArray(res?.videos) ? res.videos : []);
          console.log(`[Autoplay] channel search items=${items.length} for "${channelQuery}"`);
          for (const it of items.slice(0, 40)) {
            let rid = null;
            if (typeof it.id === 'string') rid = it.id;
            else if (it.id && typeof it.id === 'object') rid = it.id.videoId || it.id.id || null;
            else if (it.videoId) rid = it.videoId;
            if (!rid) continue;
            const url = `https://www.youtube.com/watch?v=${rid}`;
            if (!utils.canAddUrl(url)) continue;
            const title = it.title?.text || it.title || it.name || '(Unknown)';
            // mark as channel_search so scoring can boost these
            results.push({ url, title, source: 'channel_search', durationSeconds: it.lengthSeconds || null, viewCount: it.viewCount || null });
          }
          console.log(`[Autoplay] channel search produced ${results.filter(r => r.source === 'channel_search').length} candidates`);
        } else {
          console.log(`[Autoplay] skip channel search for author="${authorName}" because author name not present in seed/title`);
        }
      } catch (e) {
        console.warn('[Autoplay] channel search failed:', e && e.message);
      }
    }

    // fallback to general search if still need more candidates or no query
    let query = null;
    if (!authorName) {
      if (typeof seed === 'string') query = seed;
      else if (seed && seed.title) query = seed.title;
      else if (seed && seed.url) query = seed.url;
    } else {
      // 如果有 authorName 但沒有使用 channel search，也允許使用 seed text fallback搜尋
      if (typeof seed === 'string') query = seed;
      else if (seed && seed.title) query = seed.title;
      else if (seed && seed.url) query = seed.url;
    }
    if (query) {
      try {
        const res = await cachedSearch(query, { type: 'all' });
        const items = Array.isArray(res?.results) ? res.results : (Array.isArray(res?.videos) ? res.videos : []);
        console.log(`[Autoplay] getUpNext fallback search items=${items.length} for query="${query}"`);
        for (const it of items.slice(0, 40)) {
          let rid = null;
          if (typeof it.id === 'string') rid = it.id;
          else if (it.id && typeof it.id === 'object') rid = it.id.videoId || it.id.id || null;
          else if (it.videoId) rid = it.videoId;
          if (!rid) continue;
          const url = `https://www.youtube.com/watch?v=${rid}`;
          if (!utils.canAddUrl(url)) continue;
          const title = it.title?.text || it.title || it.name || '(Unknown)';
          results.push({ url, title, source: 'search', durationSeconds: it.lengthSeconds || null, viewCount: it.viewCount || null });
        }
        console.log(`[Autoplay] getUpNext fallback produced ${results.length} candidates for query="${query}"`);
      } catch (e) {
        console.warn('[Autoplay] getUpNext fallback search error:', e && e.message);
      }
    } else {
      if (!authorName) console.log('[Autoplay] getUpNext no query available for seed -> returning current results');
    }

    return results;
  }

  async function enrichCandidate(candidate) {
    if (!candidate || !candidate.url) return candidate;
    try {
      const info = await ytdl.getInfo(candidate.url);
      const vd = info.videoDetails || {};
      candidate.title = candidate.title || vd.title || candidate.title;
      candidate.durationSeconds = candidate.durationSeconds || parseInt(vd.lengthSeconds || '0', 10) || candidate.durationSeconds;
      candidate.viewCount = candidate.viewCount || parseInt(vd.viewCount || vd.views || '0', 10) || candidate.viewCount;
      candidate.videoId = candidate.videoId || utils.getVideoId(candidate.url) || (vd.videoId || vd.video_id);
      // 新增：嘗試填入候選的作者名稱（若可得）
      candidate.authorName = candidate.authorName || (vd?.author?.name || vd?.ownerChannelName || null);
    } catch (e) {
      console.warn('[Autoplay] enrichCandidate failed for', candidate.url, e && e.message);
    }
    return candidate;
  }

  async function scoreCandidates(candidates, seed) {
    // keep a minimal log to observe scoring progress
    console.log(`[Autoplay] scoreCandidates called: candidates=${candidates.length}, seed="${(seed && seed.title) || seed || ''}"`);
    const seedText = (seed && seed.title) ? seed.title : (seed || '');
    const seedNorm = utils.normalizeText(seedText || '');
    const seedWords = seedNorm.split(/\s+/).filter(Boolean);
    const seedFirst15 = seedWords.slice(0, 15);
    const seedBeyond = seedWords.slice(15);

    const toEnrich = candidates.slice(0, 12);
    await Promise.all(toEnrich.map(c => enrichCandidate(c)));

    function isOfficialTitle(title) {
      if (!title) return false;
      return /\bofficial\b|\bofficial video\b|\bofficial mv\b|\bmv\b|\bm\/v\b/i.test(title);
    }

    candidates.forEach(c => {
      let score = 0;
      // source base weights (channel_search strongly prioritized)
      if (c.source === 'channel_search') score += 120; // 大幅提升同頻道來源權重
      else if (c.source === 'related') score += 50;
      else if (c.source === 'artist_search') score += 35;
      else if (c.source === 'search') score += 20;

      if (isOfficialTitle(c.title)) score += 30;

      const a = new Set((c.title || '').toLowerCase().split(/\s+/));
      const b = new Set(seedNorm.split(/\s+/));
      let overlap = 0;
      for (const w of b) if (a.has(w)) overlap++;
      score += overlap * 4;

      if (c.viewCount) score += Math.min(20, Math.log10(Math.max(1, c.viewCount)) * 2);

      if (c.durationSeconds) {
        if (c.durationSeconds >= 120 && c.durationSeconds <= 480) score += 12;
        if (seed.durationSeconds && Math.abs((c.durationSeconds - seed.durationSeconds)) < 60) score += 6;
      }

      if (utils.isLiveOrBad(c.title)) score -= 100;
      if (utils.isPerformanceOrDance(c.title)) score -= 200;
      if (utils.isLyrics(c.title)) score -= 150;

      if (seedBeyond.length > 0) {
        const candWords = utils.normalizeText(c.title || '').split(/\s+/).filter(Boolean);
        const maxCompare = Math.min(seedBeyond.length, Math.max(0, candWords.length - 15));
        if (maxCompare > 0) {
          let matches = 0;
          for (let i = 0; i < maxCompare; i++) {
            const seedWord = seedBeyond[i];
            const candIndex = 15 + i;
            if (candWords[candIndex] && candWords[candIndex] === seedWord) matches++;
          }
          const ratio = matches / seedBeyond.length;
          if (ratio >= 0.5) score -= 150;
          else score -= matches * 25;
        }
      }

      if (utils.titleTooSimilar(seedText, c.title)) score -= 200;
      c._score = score;
    });

    console.log('[Autoplay] scoring complete');
    return candidates.sort((a, b) => (b._score || 0) - (a._score || 0));
  }

  // 主要函式：用 immutable seeds，先由 getUpNext 取得候選，再評分與加入
  async function checkAndAutofillSongs() {
    console.log(`[Autoplay] checkAndAutofillSongs start - autoplayMode=${!!(deps.autoplayModeGetter && deps.autoplayModeGetter())}, allSongs=${(deps.allSongs||[]).length}`);
    if (!deps.autoplayModeGetter || !deps.autoplayModeGetter()) return;
    const allSongs = deps.allSongs;
    if (allSongs.length >= 10) {
      console.log('[Autoplay] playlist already >= 10, skipping autofill');
      return;
    }

    try {
      if (deps.getYoutubeApi && !deps.getYoutubeApi()) {
        const api = await Innertube.create();
        if (deps.setYoutubeApi) deps.setYoutubeApi(api);
      }

      const seedSet = new Set();
      const lastSongInfo = deps.getLastSongInfo ? deps.getLastSongInfo() : null;
      if (lastSongInfo && lastSongInfo.title) seedSet.add(lastSongInfo.title);
      for (let i = allSongs.length - 1; i >= 0 && seedSet.size < 4; i--) {
        const t = allSongs[i]?.title;
        if (t && !seedSet.has(t) && lastSongInfo && allSongs[i].url !== lastSongInfo.url) seedSet.add(t);
      }
      const initialSeeds = Array.from(seedSet);
      console.log('[Autoplay] immutable seeds:', initialSeeds);
      if (initialSeeds.length === 0) return;

      // 取得每個 seed 對應的 authorName（若能從 lastSongInfo url 取得）
      const seedAuthorMap = new Map();
      for (const seedText of initialSeeds) {
        let authorName = null;
        let authorAppears = false;
        if (lastSongInfo && lastSongInfo.title === seedText && lastSongInfo.url) {
          try {
            const info = await ytdl.getInfo(lastSongInfo.url);
            authorName = info.videoDetails?.author?.name || info.videoDetails?.ownerChannelName || null;
            console.log(`[Autoplay] seed author for "${seedText}" -> "${authorName}"`);
          } catch (e) {
            // ignore
          }
        }
        // 判斷作者名稱是否實際出現在 seed 標題（normalized token 比對）
        if (authorName) {
          const seedNorm = utils.normalizeText(seedText || '');
          const authorNorm = utils.normalizeText(authorName || '');
          if (seedNorm && authorNorm) {
            if (seedNorm.includes(authorNorm)) authorAppears = true;
            else {
              const authorTokens = authorNorm.split(/\s+/).filter(Boolean);
              const seedTokens = new Set(seedNorm.split(/\s+/).filter(Boolean));
              for (const t of authorTokens) {
                if (t && seedTokens.has(t)) { authorAppears = true; break; }
              }
            }
          }
        }
        seedAuthorMap.set(seedText, { authorName, authorAppears });
      }

      const candidatesMap = new Map();

      // we will iterate each seed's upNext candidates and decide per-candidate whether to add
      let added = 0;
      for (const seedText of initialSeeds) {
        const upNext = await getUpNext(seedText);
        console.log(`[Autoplay] seed="${seedText}" returned upNext=${upNext.length}`);
        for (const c of upNext) {
          if (allSongs.length >= 10) break;
          if (!utils.canAddUrl(c.url)) continue;

          // enrich once early so we have title/author/duration for checks
          await enrichCandidate(c);

          // decide whether to skip this candidate based on all seeds
          let skipCandidate = false;
          for (const checkSeed of initialSeeds) {
            // direct similarity (use configurable isTooSimilar)
            if (isTooSimilar(checkSeed, c.title)) {
              console.log(`[Autoplay] SKIP candidate (too similar - direct): seed="${checkSeed}" candidate="${c.title}" ${c.url}`);
              skipCandidate = true;
              break;
            }

            const seedAuthorInfo = seedAuthorMap.get(checkSeed) || {};
            const authorName = seedAuthorInfo.authorName || null;
            const authorAppears = !!seedAuthorInfo.authorAppears;

            if (authorAppears) {
              const strippedSeed = stripAuthorAndKeywords(checkSeed, authorName);
              const candidateAuthorForStrip = c.authorName || authorName || null;
              const strippedCand = stripAuthorAndKeywords(c.title, candidateAuthorForStrip);
              if (strippedSeed && strippedCand && isTooSimilar(strippedSeed, strippedCand)) {
                console.log(`[Autoplay] SKIP candidate (too similar after stripping author/keywords): seed="${checkSeed}" candidate="${c.title}" ${c.url}`);
                skipCandidate = true;
                break;
              }
            } else {
              const strippedSeedNoAuthor = stripAuthorAndKeywords(checkSeed, null);
              const strippedCandNoAuthor = stripAuthorAndKeywords(c.title, null);
              if (strippedSeedNoAuthor && strippedCandNoAuthor && isTooSimilar(strippedSeedNoAuthor, strippedCandNoAuthor)) {
                console.log(`[Autoplay] SKIP candidate (too similar after stripping keywords only): seed="${checkSeed}" candidate="${c.title}" ${c.url}`);
                skipCandidate = true;
                break;
              }
            }
          } // end seed checks

          if (skipCandidate) continue;

          // remove content after '#' and reject if too long
          const candTitleNoHash = stripAfterHashRaw(c.title || '');
          if (TITLE_MAX_LENGTH && candTitleNoHash.length > TITLE_MAX_LENGTH) {
            console.log(`[Autoplay] SKIP candidate (title too long): length=${candTitleNoHash.length} limit=${TITLE_MAX_LENGTH} title="${c.title}" ${c.url}`);
            continue;
          }

          // reject if contains any forbidden word
          if (containsForbiddenWord(c.title)) {
            console.log(`[Autoplay] SKIP candidate (forbidden word found): ${c.title} ${c.url}`);
            continue;
          }

          // final validations before adding
          if (c.durationSeconds && (c.durationSeconds < 60 || c.durationSeconds > 480)) continue;
          if (allSongs.some(s => utils.titleTooSimilar(s.title, c.title))) continue;

          const candTitle = (c.title || '').trim();
          if (!candTitle || candTitle === '(Unknown)') {
            console.log(`[Autoplay] SKIP candidate (unknown title): ${c.url}`);
            continue;
          }

          allSongs.push({ title: candTitle, url: c.url });
          const vidKey = utils.getVideoId(c.url) || c.url;
          deps.lastAddedTimestamps[vidKey] = Date.now();
          deps.lastAddedTimestamps[c.url] = Date.now();
          added++;
          console.log(`[Autoplay] added: ${candTitle} -> ${c.url}`);
        }
      }
    } catch (e) {
      console.warn('[Autoplay] checkAndAutofillSongs error:', e && e.message);
    }
  }

  return { checkAndAutofillSongs };
};