// Discord Bot Only

const { Client, Events, GatewayIntentBits } = require('discord.js');
const { token, volume } = require('./config.json'); // removed unused User_id
const express = require('express');
const SocketServer = require('ws').Server;
const { Innertube } = require('youtubei.js');

const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, StreamType } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const { spawn } = require('child_process'); // <-- add this

const PORT = 3000;

const server = express()
    .listen(PORT, () => console.log(`Listening on ${PORT}`))

const wss = new SocketServer({ server })

let hasJoinedVoice = false; // Track if bot has already joined
let lastSongInfo = null; // Store the last played song info
let allSongs = []; // Store every song ever added (acts as the playlist)

let connection = null;
let player = null;
let currentChannel = null;

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
  autoplayModeGetter: () => autoplayMode
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

        const audioStream = ytdl(url, {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 25
        });

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
      console.log('Received URL from extension:', url);
      await handleAddUrl(url, userIdFromClient, ws);
    }
  });

  ws.on('close', () => { console.log('Close connected'); });
});

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ] 
});

client.once(Events.ClientReady, async readyClient => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
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
    shuffleSongs = shuffleArray(allSongs || []);
    if (currentSongIndex >= 0 && allSongs[currentSongIndex]) {
      const curUrl = allSongs[currentSongIndex].url;
      const idx = shuffleSongs.findIndex(s => s.url === curUrl);
      shuffleIndex = idx >= 0 ? idx : 0;
    } else shuffleIndex = 0;
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
async function handleAddUrl(url, userIdFromClient, wsClient) {
  if (!url) return;
  // require user id if not connected
  if (!connection) {
    if (!userIdFromClient) {
      safeSend(wsClient, { error: 'missing_user_id', message: 'Please open Settings in the extension and set your user ID, then try again.' });
      return;
    }
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
    if (!hasJoinedVoice) {
      hasJoinedVoice = true;
      playSongAtIndex(0);
    }
  } catch (e) {
    console.error('[Main] addUrlOrPlaylist failed:', e && e.message);
    safeSend(wsClient, { error: 'add_failed', message: e && e.message });
  }
}

