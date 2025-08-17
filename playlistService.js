const { Innertube } = require('youtubei.js');

// simple video id extractor
function getVideoId(url) {
  if (!url) return null;
  const m1 = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (m1) return m1[1];
  const m2 = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (m2) return m2[1];
  const m3 = url.match(/([a-zA-Z0-9_-]{11})/);
  return m3 ? m3[1] : null;
}

// Add a YouTube video or playlist into allSongs. Returns { youtubeApi, addedCount }.
async function addUrlOrPlaylist({ url, ytdl, youtubeApi, allSongs, lastAddedTimestamps }) {
  let addedCount = 0;

  const isPlaylistLike =
    ((/youtube\.com\/playlist\?list=/.test(url)) ||
     (/youtu\.be\/.*[?&]list=/.test(url)) ||
     ((/youtube\.com\/watch\?v=/.test(url)) && (/[?&]list=/.test(url))))
    && !/start_radio/.test(url);

  if (isPlaylistLike) {
    const originalUrl = url;
    const listMatch = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    const playlistId = listMatch ? listMatch[1] : null;

    if (playlistId) {
      try {
        if (!youtubeApi) youtubeApi = await Innertube.create();
        const playlist = await youtubeApi.getPlaylist(playlistId);
        for (const item of playlist.videos) {
          const itemUrl = `https://www.youtube.com/watch?v=${item.id}`;
          const now = Date.now();
          const lastTs = lastAddedTimestamps[itemUrl] || 0;
          if (now - lastTs < 5000) continue;
          if (!allSongs.some(s => s.url === itemUrl)) {
            allSongs.push({ title: item.title.text, url: itemUrl });
            lastAddedTimestamps[itemUrl] = now;
            addedCount++;
          }
        }
        console.log(`[Playlist] Added ${addedCount} from ${playlist.title?.text || playlist.title || playlistId}`);
      } catch (err) {
        console.error('[Playlist] fetch failed:', err && err.message);
        // fallback: try add single video from original url
        try {
          const vid = getVideoId(originalUrl);
          if (vid) {
            const videoUrl = `https://www.youtube.com/watch?v=${vid}`;
            const now = Date.now();
            const lastTs = lastAddedTimestamps[videoUrl] || 0;
            if (now - lastTs >= 5000 && !allSongs.some(s => s.url === videoUrl)) {
              try {
                const info = await ytdl.getInfo(videoUrl);
                const title = info.videoDetails?.title || '(Unknown Title)';
                allSongs.push({ title, url: videoUrl });
              } catch {
                allSongs.push({ title: '(Unknown Title)', url: videoUrl });
              }
              lastAddedTimestamps[videoUrl] = now;
              addedCount++;
            }
          }
        } catch (fallbackErr) {
          console.error('[Playlist] fallback failed:', fallbackErr && fallbackErr.message);
        }
      }
    } else {
      // no valid list= param found — fall back to single-video handling
      const vid = getVideoId(originalUrl);
      if (vid) {
        const videoUrl = `https://www.youtube.com/watch?v=${vid}`;
        const now = Date.now();
        const lastTs = lastAddedTimestamps[videoUrl] || 0;
        if (now - lastTs >= 5000 && !allSongs.some(s => s.url === videoUrl)) {
          try {
            const info = await ytdl.getInfo(videoUrl);
            const title = info.videoDetails?.title || '(Unknown Title)';
            allSongs.push({ title, url: videoUrl });
          } catch {
            allSongs.push({ title: '(Unknown Title)', url: videoUrl });
          }
          lastAddedTimestamps[videoUrl] = now;
          addedCount++;
        }
      }
    }
    return { youtubeApi, addedCount };
  }

  // Single video path
  try {
    const info = await ytdl.getInfo(url);
    const title = info.videoDetails?.title || 'Unknown Title';
    const now = Date.now();
    const lastTs = lastAddedTimestamps[url] || 0;
    if (now - lastTs >= 5000 && !allSongs.some(s => s.url === url)) {
      allSongs.push({ title, url });
      lastAddedTimestamps[url] = now;
      addedCount++;
    }
  } catch {
    const now = Date.now();
    const lastTs = lastAddedTimestamps[url] || 0;
    if (now - lastTs >= 5000 && !allSongs.some(s => s.url === url)) {
      allSongs.push({ title: '(Unknown Title)', url });
      lastAddedTimestamps[url] = now;
      addedCount++;
    }
  }

  return { youtubeApi, addedCount };
}

module.exports = { addUrlOrPlaylist };