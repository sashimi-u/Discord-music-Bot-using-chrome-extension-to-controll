// Discord Bot Only

const { Client, Events, GatewayIntentBits } = require('discord.js');
const { token, volume, listenChannel} = require('./config.json'); // removed unused User_id
const express = require('express');
const SocketServer = require('ws').Server;
const http = require('http');
const { Innertube } = require('youtubei.js');

const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, StreamType } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const server = http.createServer(app); // 建立 HTTP server
const wss = new SocketServer({ server }); // 傳給 WebSocketServer

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

let hasJoinedVoice = false; // Track if bot has already joined
let shouldAnnounceNowPlaying = false; // 控制 listenChannel 自動推送 Now Playing
let lastActiveChannelId = null; // 最後一次用來加歌的頻道 id
let lastSongInfo = null; // Store the last played song info
let allSongs = []; // Store every song ever added (acts as the playlist)

let connection = null;
let player = null;

let currentSongIndex = -1; // Index of the song currently playing in allSongs
let lastPreviousTime = 0;   // Timestamp of last 'previous' command
let isCurrentlyPlaying = true; // Track play/pause status
// repeat mode now handled by repeat.js module
// let repeatMode = 'no_repeat'; // removed
let shuffleMode = false;
let shuffleSongs = []; // 存放洗牌後的順序
let shuffleIndex = 0;
let toggleRepeatMode = false;
let autoplayMode = false;
const { addUrlOrPlaylist } = require('./playlistService');
// Ensure these exist (service uses them)
let youtubeApi = null;
const lastAddedTimestamps = {};

// --- require repeat module ---
const repeat = require('./repeat.js');

// --- Autoplay module init (moved to Autoplay.js) ---
const utils = require('./lib/utils.js')({ allSongs, lastAddedTimestamps });
const { createAutoplay } = require('./Autoplay.js');
const autoplay = createAutoplay({
  ytdl,
  Innertube,
  utils,
  allSongs,
  lastAddedTimestamps,
  getLastSongInfo: () => lastSongInfo,
  setLastSongInfo: (v) => { lastSongInfo = v; },
  getYoutubeApi: () => youtubeApi,
  setYoutubeApi: (v) => { youtubeApi = v; },
  autoplayModeGetter: () => autoplayMode,
  // 新增：讓 Autoplay 使用 main 的 upcoming 計算（已考慮 shuffle）
  getUpcomingSongsCount
});
const { createPlayer } = require('./player.js');
const connectionRef = { connection: null }; // 固定參考物件，後面會同步更新
const playerModule = createPlayer({
  ytdl,
  createAudioResource,
  StreamType,
  createAudioPlayer: createAudioPlayer,
  repeatModule: repeat,
  utils,
  volume,
  playerInstance: player,
  connectionRef,
  setHasJoinedVoice: (v) => { hasJoinedVoice = v; },
  setIsCurrentlyPlaying: (v) => { isCurrentlyPlaying = v; },
  autoplayModule: autoplay,
  allSongs,
  lastAddedTimestamps
});
// wire player instance setter so both main and module share it
// (removed unused fallback assignment)

const searchCache = new Map(); // simple cache: query -> { ts, results }

// Add these helpers below the cache
async function cachedSearch(query, opts = {}) {
  const key = `${query}::${opts.type || 'all'}`;
  const cached = searchCache.get(key);
  if (cached && (Date.now() - cached.ts) < 1000 * 60 * 5) return cached.results;
  try {
    const res = await youtubeApi.search(query, opts);
    searchCache.set(key, { ts: Date.now(), results: res });
    return res;
  } catch (err) {
    console.warn('cachedSearch error:', err);
    return {};
  }
}

// extract canonical YouTube video id (v=... or youtu.be/...)
function getVideoId(url) {
  if (!url) return null;
  const m1 = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (m1) return m1[1];
  const m2 = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (m2) return m2[1];
  // fallback: find any 11-char id
  const m3 = url.match(/([a-zA-Z0-9_-]{11})/);
  return m3 ? m3[1] : null;
}

// Play the song at currentSongIndex in allSongs
async function playSongAtIndex(index) {
    // use raw index (expect 0-based). Do not normalize or convert.
    const rawIndex = index;
    if (typeof index !== 'number' || Number.isNaN(index)) {
        index = 0;
    }

    let playList = allSongs;
    let playIdx = index;

    console.log(`[Main] playSongAtIndex called index=${playIdx}`);

    if (shuffleMode) {
        playList = shuffleSongs;
        playIdx = index;
        if (playIdx < 0 || playIdx >= playList.length) {
            shuffleSongs = shuffleArray(allSongs);
            playIdx = 0;
        }
    }

    if (playIdx < 0 || playIdx >= playList.length) {
        if (repeat.get() === 'repeat_all' && allSongs.length > 0) {
            if (shuffleMode) {
                shuffleSongs = shuffleArray(allSongs);
                playSongAtIndex(0);
            } else {
                playSongAtIndex(0);
            }
            return;
        }
        // All songs played, clear playlist and notify clients
        hasJoinedVoice = false;
        allSongs = [];
        lastSongInfo = null;
        currentSongIndex = -1;
        shuffleSongs = [];
        shuffleIndex = 0;
        if (connection) {
            try {
                connection.destroy();
            } catch(e) {}
            connection = null;
            connectionRef.connection = null; // <-- 同步清除
        }
        // Notify all clients to clear their playlist
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({ command: 'clear_playlist' }));
            }
        });
  // --- 新增：重置 listenChannel 推送 flag與頻道 ---
  shouldAnnounceNowPlaying = false;
  lastActiveChannelId = null;
        return;
    }

    const { url, title } = playList[playIdx];
    if (shuffleMode) {
        shuffleIndex = playIdx;
        currentSongIndex = allSongs.findIndex(s => s.url === url);
    } else {
        currentSongIndex = playIdx;
    }

    try {
        lastSongInfo = { title, url };

        // --- NEW: fetch approximate duration and mark start time for popup progress bar ---
        try {
            const info = await ytdl.getInfo(url);
            const dur = parseInt(info?.videoDetails?.lengthSeconds || '0', 10) || null;
            lastSongInfo.durationSeconds = dur;
        } catch (e) {
            // ignore enrichment failure; popup will show indeterminate bar
            lastSongInfo.durationSeconds = null;
        }
        lastSongInfo.started_at = Date.now();
        
        // upcoming calculation
        const upcoming = [];
        if (shuffleMode) {
            for (let i = playIdx + 1; i < Math.min(playList.length, playIdx + 6); i++) {
                upcoming.push({ title: playList[i].title, url: playList[i].url });
            }
        } else {
            for (let i = playIdx + 1; i < Math.min(allSongs.length, playIdx + 6); i++) {
                upcoming.push({ title: allSongs[i].title, url: allSongs[i].url });
            }
        }

        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({
                    ...lastSongInfo,
                    upcoming
                }));
                client.send(JSON.stringify({ status: 'playing' }));
                client.send(JSON.stringify({ repeat_mode: repeat.get() }));
                client.send(JSON.stringify({ shuffle_mode: shuffleMode }));
            }
        });

        console.log(`Now playing: ${title}`);
        console.log(`URL: ${url}`);

        // 取得音訊串流（改為加 headers，並在 403 時 fallback 使用 getInfo + downloadFromInfo）
        let audioStream;
        try {
          audioStream = ytdl(url, {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 25,
            // 加上 request headers 幫助避開簡單的封鎖
            requestOptions: {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
              }
            }
          });
        } catch (err) {
          // 若直接抓取失敗且為 403，嘗試用 getInfo + downloadFromInfo 作 fallback
          if (err && String(err.message).includes('Status code: 403')) {
            try {
              const info = await ytdl.getInfo(url);
              audioStream = ytdl.downloadFromInfo(info, {
                filter: 'audioonly',
                quality: 'highestaudio',
                highWaterMark: 1 << 25
              });
            } catch (err2) {
              console.error('Fallback downloadFromInfo also failed:', err2 && err2.message);
              throw err; // rethrow original
            }
          } else {
            throw err;
          }
        }

        const resource = createAudioResource(audioStream, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true
        });

        if (resource && resource.volume && typeof resource.volume.setVolume === 'function') {
            resource.volume.setVolume(typeof volume === 'number' ? volume : 0.5);
        }

        if (!player) {
            player = createAudioPlayer({
                behaviors: {
                    noSubscriber: NoSubscriberBehavior.Pause,
                },
            });

            player.on(AudioPlayerStatus.Idle, () => {
                if (repeat.get() === 'repeat_one') {
                    if (shuffleMode) {
                        playSongAtIndex(shuffleIndex);
                    } else {
                        playSongAtIndex(currentSongIndex);
                    }
                } else {
                    if (shuffleMode) {
                        playSongAtIndex(shuffleIndex + 1);
                    } else {
                        playSongAtIndex(currentSongIndex + 1);
                    }
                }
            });

            player.on('error', error => {
                console.error('Audio player error:', error);
                if (repeat.get() === 'repeat_one') {
                    if (shuffleMode) {
                        playSongAtIndex(shuffleIndex);
                    } else {
                        playSongAtIndex(currentSongIndex);
                    }
                } else {
                    if (shuffleMode) {
                        playSongAtIndex(shuffleIndex + 1);
                    } else {
                        playSongAtIndex(currentSongIndex + 1);
                    }
                }
            });

            player.on(AudioPlayerStatus.Playing, () => {
                isCurrentlyPlaying = true;
                wss.clients.forEach(client => {
                    if (client.readyState === 1) {
                        client.send(JSON.stringify({ status: 'playing' }));
                    }
                });
                // --- 新增：Now Playing 只推送到最後一次用來加歌的頻道 ---
                if (shouldAnnounceNowPlaying && lastActiveChannelId) {
                  try {
                    const list = shuffleMode ? shuffleSongs : allSongs;
                    const idx = shuffleMode ? shuffleIndex : currentSongIndex;
                    if (idx >= 0 && list[idx]) {
                      const nowPlayingTitle = list[idx].title;
                      const channel = client.channels.cache.get(lastActiveChannelId);
                      if (channel && channel.send) {
                        channel.send(`Now playing: ${nowPlayingTitle}`);
                      }
                    }
                  } catch (e) { console.warn('Now playing announce failed:', e && e.message); }
                }
            });
            player.on(AudioPlayerStatus.Paused, () => {
                isCurrentlyPlaying = false;
                wss.clients.forEach(client => {
                    if (client.readyState === 1) {
                        client.send(JSON.stringify({ status: 'paused' }));
                    }
                });
            });
        }
        player.play(resource);
        connection.subscribe(player);

        isCurrentlyPlaying = true;
        console.log('Started playing audio.');

        if (autoplayMode) {
            try {
                const before = allSongs.length;
                await autoplay.checkAndAutofillSongs();
                const added = allSongs.length - before;
                if (added > 0) {
                    console.log(`[Main] autoplay added ${added} song(s) during playback`);
                    wss.clients.forEach(client => {
                        if (client.readyState === 1) {
                            try {
                                client.send(JSON.stringify({ autoplay_mode: !!autoplayMode, added_autoplay_count: added }));
                                const list = shuffleMode ? shuffleSongs : allSongs;
                                const idx = shuffleMode ? shuffleIndex : currentSongIndex;
                                const upcoming = [];
                                for (let i = idx + 1; i < Math.min(list.length, idx + 6); i++) {
                                    upcoming.push({ title: list[i].title, url: list[i].url });
                                }
                                client.send(JSON.stringify({ upcoming }));
                            } catch (e) {}
                        }
                    });
                }
            } catch (e) {
                console.warn('[Main] autoplay autofill failed:', e && e.message);
            }
        }
    } catch (err) {
        console.error('Error playing audio:', err);
        if (repeat.get() === 'repeat_one') {
            playSongAtIndex(playIdx);
        } else {
            playSongAtIndex(playIdx + 1);
        }
    }
}

//當 WebSocket 從外部連結時執行
wss.on('connection', (ws) => {
  // send lastSong + upcoming if available
  if (lastSongInfo) {
    const list = shuffleMode ? shuffleSongs : allSongs;
    const idx = shuffleMode ? shuffleIndex : currentSongIndex;
    safeSend(ws, { ...lastSongInfo, upcoming: getUpcoming(list, idx) });
  }

  // send playback status and authoritative modes
  safeSend(ws, { status: isCurrentlyPlaying ? 'playing' : 'paused' });
  try {
    safeSend(ws, { autoplay_mode: !!autoplayMode });
    safeSend(ws, { repeat_mode: repeat.get() });
    safeSend(ws, { shuffle_mode: !!shuffleMode });
  } catch (e) { console.warn('[WS] failed to send initial modes to client:', e && e.message); }

  ws.on('message', async (message) => {
    let url = null;
    let userIdFromClient = null;
    let parsed = null;

    // try parse JSON
    try {
      parsed = JSON.parse(message.toString());
    } catch (_) {
      url = message.toString();
    }

    // if parsed object, handle special commands first
    if (parsed) {
      // get_full_playlist handled immediately
      if (parsed.command === 'get_full_playlist') {
        const reqId = parsed.req_id || null;
        const full = [];
        if (shuffleMode && Array.isArray(shuffleSongs) && shuffleSongs.length > 0) {
          const start = (typeof shuffleIndex === 'number' ? shuffleIndex + 1 : 0);
          for (let i = start; i < shuffleSongs.length; i++) full.push({ title: shuffleSongs[i].title, url: shuffleSongs[i].url });
        } else {
          const start = (typeof currentSongIndex === 'number' && currentSongIndex >= 0) ? currentSongIndex + 1 : 0;
          for (let i = start; i < allSongs.length; i++) full.push({ title: allSongs[i].title, url: allSongs[i].url });
        }
        safeSend(ws, { full_playlist: full, req_id: reqId });
        return;
      }

      // mode logging (optional)
      if (parsed.command && ['toggle_autoplay_mode','set_autoplay_mode','get_autoplay_mode',
                               'set_shuffle_mode','get_shuffle_mode',
                               'toggle_repeat_mode','set_repeat_mode','get_repeat_mode'].includes(parsed.command)) {
        console.log('[WS] mode command received from client:', parsed.command, parsed);
      }

      // clear playlist shortcut
      if (parsed.command === 'clear_playlist') {
        console.log('[WS] clear_playlist requested by client');
        handleClearPlaylist();
        return;
      }

      // map parsed flags / commands
      if (parsed.command === 'skip') handleSkip();
      else if (parsed.command === 'previous') handlePrevious();
      else if (parsed.command === 'pause') handlePause();
      else if (parsed.command === 'resume') handleResume();
      else if (parsed.command === 'status') handleStatusRequest(ws);
      else if (parsed.command === 'get_autoplay_mode') safeSend(ws, { autoplay_mode: !!autoplayMode });
      else if (parsed.command === 'set_autoplay_mode') await handleSetAutoplayMode(ws, parsed.autoplay_mode ?? parsed.autoplay ?? true);
      else if (parsed.command === 'toggle_autoplay_mode') await handleSetAutoplayMode(ws, !autoplayMode);
      else if (parsed.command === 'get_shuffle_mode') safeSend(ws, { shuffle_mode: !!shuffleMode });
      else if (parsed.command === 'set_shuffle_mode') handleSetShuffleMode(ws, !!parsed.shuffle);
      else if (parsed.command === 'get_repeat_mode') safeSend(ws, { repeat_mode: repeat.get() });
      else if (parsed.command === 'set_repeat_mode') handleSetRepeatMode(ws, parsed.mode);
      else if (parsed.command === 'toggle_repeat_mode') handleToggleRepeat(ws);
      else if (parsed.url) { url = parsed.url; userIdFromClient = parsed.user_id || null; }
    }

    // if url determined (either raw message or parsed.url) => add flow
    if (url) {
      console.log('Received URL from extension:', url, ' user_id:', userIdFromClient);
      await handleRemoteAddUrl(url, userIdFromClient, ws);
    }
  });

  ws.on('close', () => { console.log('Close connected'); });
});

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages
    ] 
});

client.once(Events.ClientReady, async readyClient => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);

  // 支援 listenChannel 為陣列（多頻道 id）
  const listenChannelIds = Array.isArray(listenChannel) ? listenChannel : [listenChannel];
  // 監聽所有指定頻道的訊息
  readyClient.on('messageCreate', async (msg) => {
    if (!listenChannelIds.includes(msg.channel.id)) return;
    if (msg.author.bot) return;
    const videoId = getVideoId(msg.content);
    if (videoId) {
      const fullUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const userId = msg.member?.id || msg.author.id;
      await handleRemoteAddUrl(fullUrl, userId, null);
      shouldAnnounceNowPlaying = true; // 啟動自動推送
      lastActiveChannelId = msg.channel.id; // 記錄最後一次用來加歌的頻道
      // 取得剛加入的歌曲資訊
      const addedSong = allSongs.length > 0 ? allSongs[allSongs.length - 1] : null;
      if (addedSong) {
        // 回覆已加入歌曲（只顯示歌名）
        await msg.channel.send(`已加入歌曲：${addedSong.title}`);
        // Upcoming songs（只顯示歌名）
        const upcoming = [];
        const idx = shuffleMode ? shuffleIndex : currentSongIndex;
        const list = shuffleMode ? shuffleSongs : allSongs;
        for (let i = idx + 1; i < Math.min(list.length, idx + 6); i++) {
          upcoming.push(list[i].title);
        }
        if (upcoming.length > 0) {
          await msg.channel.send('Upcoming songs:\n' + upcoming.join('\n'));
        }
        // 立即推送 Now Playing
        if (shouldAnnounceNowPlaying) {
          const nowPlayingTitle = list[idx]?.title;
          if (nowPlayingTitle) await msg.channel.send(`Now playing: ${nowPlayingTitle}`);
        }
      }
    }
  });
});

client.login(token);

// Utility: return a new shuffled array (Fisher–Yates)
function shuffleArray(arr) {
  if (!Array.isArray(arr)) return [];
  const a = arr.slice(); // 不改變原陣列
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// (removed unused auto-start async IIFE; playback is driven by incoming WS add-url commands)

// --- 新增：安全發送 / 廣播 / upcoming 工具函式 ---
function safeSend(wsClient, obj) {
  try {
    if (wsClient && wsClient.readyState === 1) wsClient.send(JSON.stringify(obj));
  } catch (e) { /* ignore per-client send errors */ }
}
function broadcast(obj) {
  const payload = JSON.stringify(obj);
  wss.clients.forEach((c) => {
    try { if (c.readyState === 1) c.send(payload); } catch (_) {}
  });
}
function getUpcoming(list, idx, count = 5) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (let i = idx + 1; i < Math.min(list.length, idx + 1 + count); i++) {
    out.push({ title: list[i].title, url: list[i].url });
  }
  return out;
}

// --- 新增：封裝模式處理函式 ---
async function handleSetAutoplayMode(wsClient, value) {
  const prev = !!autoplayMode;
  autoplayMode = !!value;
  broadcast({ autoplay_mode: !!autoplayMode });
  // immediate autofill if enabling
  if (autoplayMode && !prev) {
    try {
      const before = allSongs.length;
      await autoplay.checkAndAutofillSongs();
      const added = allSongs.length - before;
      if (added > 0) {
        broadcast({ autoplay_mode: !!autoplayMode, added_autoplay_count: added });
        // broadcast updated upcoming for each client individually to be safe
        wss.clients.forEach(c => {
          try {
            const list = shuffleMode ? shuffleSongs : allSongs;
            const idx = shuffleMode ? shuffleIndex : currentSongIndex;
            safeSend(c, { upcoming: getUpcoming(list, idx) });
          } catch(_) {}
        });
      }
    } catch (e) {
      console.warn('[WS] autoplay immediate autofill failed:', e && e.message);
    }
  }
}
function handleSetShuffleMode(wsClient, value) {
  shuffleMode = !!value;
  if (shuffleMode) {
    // 若沒有歌曲，直接初始化空陣列
    if (!Array.isArray(allSongs) || allSongs.length === 0) {
      shuffleSongs = [];
      shuffleIndex = 0;
    } else {
      // 如果有正在播放的曲目，保留該曲目為 shuffleSongs[0]，只洗牌之後的 upcoming
      const curIdx = (typeof currentSongIndex === 'number' && currentSongIndex >= 0) ? currentSongIndex : null;
      if (curIdx !== null && allSongs[curIdx]) {
        const cur = allSongs[curIdx];
        const upcoming = allSongs.slice(curIdx + 1);
        const shuffledUpcoming = shuffleArray(upcoming);
        shuffleSongs = [cur].concat(shuffledUpcoming);
        shuffleIndex = 0; // 目前播放曲目置於 0
      } else {
        // 若沒有正在播放的曲目，則整個 allSongs 做洗牌
        shuffleSongs = shuffleArray(allSongs || []);
        shuffleIndex = 0;
      }
    }
  } else {
    shuffleSongs = [];
    shuffleIndex = 0;
  }
  broadcast({ shuffle_mode: !!shuffleMode });
}
function handleSetRepeatMode(wsClient, mode) {
  repeat.set(String(mode));
  broadcast({ repeat_mode: repeat.get() });
}
function handleToggleRepeat(wsClient) {
  const newMode = repeat.toggle();
  broadcast({ repeat_mode: newMode });
}

// --- 新增：封裝控制命令處理 ---
function handleSkip() {
  try {
    if (shuffleMode) playSongAtIndex(shuffleIndex + 1);
    else playSongAtIndex(currentSongIndex + 1);
  } catch (e) { console.error('[WS] skip handling error:', e && e.message); }
}
function handlePrevious() {
  try {
    const now = Date.now();
    if (now - (lastPreviousTime || 0) < 3000) {
      if (shuffleMode) playSongAtIndex(Math.max(0, shuffleIndex - 1));
      else playSongAtIndex(Math.max(0, currentSongIndex - 1));
    } else {
      if (shuffleMode) playSongAtIndex(shuffleIndex);
      else if (currentSongIndex >= 0) playSongAtIndex(currentSongIndex);
      else playSongAtIndex(0);
    }
    lastPreviousTime = Date.now();
  } catch (e) { console.error('[WS] previous handling error:', e && e.message); }
}
function handlePause() {
  try {
    if (player && typeof player.pause === 'function') player.pause();
    isCurrentlyPlaying = false;
    broadcast({ status: 'paused' });
  } catch (e) { console.error('[WS] pause error:', e && e.message); }
}
function handleResume() {
  try {
    if (player && typeof player.unpause === 'function') {
      player.unpause();
    } else if (player && typeof player.play === 'function' && currentSongIndex >= 0) {
      if (shuffleMode) playSongAtIndex(shuffleIndex);
      else playSongAtIndex(currentSongIndex);
    }
    isCurrentlyPlaying = true;
    broadcast({ status: 'playing' });
  } catch (e) { console.error('[WS] resume error:', e && e.message); }
}
function handleStatusRequest(wsClient) {
  try {
    const list = shuffleMode ? shuffleSongs : allSongs;
    const idx = shuffleMode ? shuffleIndex : currentSongIndex;
    safeSend(wsClient, {
      status: isCurrentlyPlaying ? 'playing' : 'paused',
      repeat_mode: repeat.get(),
      shuffle_mode: !!shuffleMode,
      autoplay_mode: !!autoplayMode,
      title: lastSongInfo?.title,
      url: lastSongInfo?.url,
      upcoming: getUpcoming(list, idx)
    });
  } catch (e) { console.error('[WS] status handling error:', e && e.message); }
}

// --- 新增：封裝清除播放清單流程 ---
function handleClearPlaylist() {
  try { if (player && typeof player.stop === 'function') player.stop(true); } catch (e) {}
  try { if (connection) connection.destroy(); } catch (e) {}
  connection = null;
  if (connectionRef && connectionRef.connection) {
    try { connectionRef.connection.destroy(); } catch (_) {}
    connectionRef.connection = null;
  }
  hasJoinedVoice = false;
  isCurrentlyPlaying = false;
  lastSongInfo = null;
  allSongs = [];
  currentSongIndex = -1;
  shuffleSongs = [];
  shuffleIndex = 0;
  broadcast({ command: 'clear_playlist' });
  broadcast({ status: 'paused' });
}

// --- 新增：封裝加入 URL / join voice 流程 ---
async function handleRemoteAddUrl(url, userIdFromClient, wsClient) {
  if (!url) return;
  // require user id if not connected
  if (!connection) {
    // find user's voice channel
    let targetChannel = null;
    try {
      for (const [guildId, guild] of client.guilds.cache) {
        const vs = guild.voiceStates?.cache.get(userIdFromClient);
        if (vs && vs.channelId) { targetChannel = vs.channel; break; }
      }
    } catch (e) {
      console.warn('Error while searching user voice state:', e && e.message);
    }
    if (!targetChannel) {
      safeSend(wsClient, { error: 'user_not_in_voice', message: 'Please join a voice channel first, then press Add URL again.' });
      return;
    }
    // join
    try {
      connection = joinVoiceChannel({
        channelId: targetChannel.id,
        guildId: targetChannel.guild.id,
        adapterCreator: targetChannel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false
      });
      connectionRef.connection = connection;
      currentChannel = targetChannel;
      safeSend(wsClient, { info: 'joined_voice', channel_name: targetChannel.name });
    } catch (e) {
      console.error('Failed to join voice channel:', e && e.message);
      safeSend(wsClient, { error: 'join_failed', message: 'Bot failed to join your voice channel. Try again.' });
      return;
    }
  }

  // delegate adding to service
  try {
    const addRes = await addUrlOrPlaylist({
      url,
      ytdl,
      youtubeApi,
      allSongs,
      lastAddedTimestamps
    });
    youtubeApi = addRes.youtubeApi || youtubeApi;
    console.log(`[Main] addUrlOrPlaylist added ${addRes.addedCount || 0} item(s).`);

    // 新增：若為 shuffle 模式，只把剛加入的項目附加到 shuffleSongs 末端（不重洗）
    if (shuffleMode) {
      const addedCount = Number(addRes.addedCount || 0);
      if (addedCount > 0) {
        const newItems = allSongs.slice(-addedCount); // 取出剛加入的項目（已被 addUrlOrPlaylist push）
        // 若 shuffleSongs 還不存在，先初始化為目前的 shuffle 列表（不重洗）
        if (!Array.isArray(shuffleSongs) || shuffleSongs.length === 0) {
          shuffleSongs = allSongs.slice(); // 保留現有順序（不重洗）
          if (currentSongIndex >= 0 && allSongs[currentSongIndex]) {
            const curUrl = allSongs[currentSongIndex].url;
            const idx = shuffleSongs.findIndex(s => s.url === curUrl);
            shuffleIndex = idx >= 0 ? idx : 0;
          } else {
            shuffleIndex = 0;
          }
        }
        // 將新項目逐一推到 shuffleSongs 末端，避免重複（若確定不會重複可直接 concat）
        for (const it of newItems) {
          // 簡單檢查避免重複 URL（可選）
          if (!shuffleSongs.find(s => s.url === it.url)) {
            shuffleSongs.push(it);
          }
        }
        // 選擇性廣播更新的 upcoming 給 clients
        try {
          const upcoming = getUpcoming(shuffleSongs, shuffleIndex);
          broadcast({ upcoming });
        } catch (_) {}
      }
    }

    if (!hasJoinedVoice) {
      hasJoinedVoice = true;
      playSongAtIndex(0);
    }
  } catch (e) {
    console.error('[Main] addUrlOrPlaylist failed:', e && e.message);
    safeSend(wsClient, { error: 'add_failed', message: e && e.message });
  }
}

// 新增：提供給 Autoplay 的 upcoming 計算（放在變數宣告後、呼叫 createAutoplay 前）
function getUpcomingSongsCount() {
  try {
    // 若使用 shuffle 隊列，優先以 shuffleIndex / shuffleSongs 計算
    if (typeof shuffleMode !== 'undefined' && shuffleMode && Array.isArray(shuffleSongs)) {
      const cur = Number.isFinite(shuffleIndex) ? Math.floor(shuffleIndex) : -1;
      let lastIndex = shuffleSongs.length - 1;
      if (typeof lastSongInfo !== 'undefined' && lastSongInfo && lastSongInfo.url) {
        for (let i = shuffleSongs.length - 1; i >= 0; i--) {
          if (shuffleSongs[i] && shuffleSongs[i].url === lastSongInfo.url) { lastIndex = i; break; }
        }
      }
      if (cur >= 0) return Math.max(0, Math.floor(lastIndex) - cur);
      return Math.max(0, shuffleSongs.length);
    }

    // 否則使用 allSongs / currentSongIndex 計算
    const list = Array.isArray(allSongs) ? allSongs : [];
    const curMain = Number.isFinite(currentSongIndex) ? Math.floor(currentSongIndex) : -1;
    let lastIndexMain = list.length > 0 ? list.length - 1 : -1;
    if (typeof lastSongInfo !== 'undefined' && lastSongInfo && lastSongInfo.url && list.length > 0) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] && list[i].url === lastSongInfo.url) { lastIndexMain = i; break; }
      }
    }
    if (curMain >= 0) return Math.max(0, Math.floor(lastIndexMain) - curMain);
    return Math.max(0, list.length);
  } catch (e) {
    return Math.max(0, (Array.isArray(allSongs) ? allSongs.length : 0));
  }
}

