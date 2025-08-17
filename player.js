// ...new file...
const { spawn } = require('child_process');

module.exports.createPlayer = function createPlayer(deps) {
  // ensure optional callback provided by main is available
  const setPlayerInstance = (typeof deps.setPlayerInstance === 'function') ? deps.setPlayerInstance : () => {};

  // 如果你其它地方直接使用 setPlayerInstance(...)，現在可以安全呼叫它。
  let player = deps.playerInstance || null;
  let connectionRef = deps.connectionRef; // object with .connection property
  const volume = deps.volume;

  // module-local current index + idle guard
  let currentIndex = -1;
  let _lastIdleAt = 0;
  let _lastIdleHandledIndex = null;

  // attach stateChange handler to the actual `player` instance used for playback.
  // ensureAudioPlayer will create a player via deps.createAudioPlayer if none provided by main.
  let _playerHandlerAttached = false;
  function ensureAudioPlayer() {
    if (!player && typeof deps.createAudioPlayer === 'function') {
      try {
        player = deps.createAudioPlayer();
        // if main wants the instance, notify
        try { setPlayerInstance(player); } catch (e) {}
      } catch (e) {
        console.warn('[Player] createAudioPlayer failed:', e && e.message);
      }
    }

    if (player && !_playerHandlerAttached) {
      _playerHandlerAttached = true;
      const AudioPlayerStatus = (deps && deps.AudioPlayerStatus) ? deps.AudioPlayerStatus : { Idle: 'idle' };
      player.on('stateChange', (oldState, newState) => {
        try {
          console.log(`[Player] stateChange ${oldState && oldState.status} -> ${newState && newState.status} currentIndex=${currentIndex}`);
        } catch (e) {}
        if (!newState) return;
        if (newState.status === AudioPlayerStatus.Idle) {
          const now = Date.now();
          if (_lastIdleHandledIndex === currentIndex && (now - _lastIdleAt) < 1000) {
            console.log('[Player] Ignored duplicate Idle for same index (guard).');
            return;
          }
          _lastIdleHandledIndex = currentIndex;
          _lastIdleAt = now;

          if (!lastPlayOpts) {
            console.log('[Player] No lastPlayOpts - cannot compute next');
            return;
          }
          const opts = lastPlayOpts;
          const repeatMode = (deps.repeatModule && typeof deps.repeatModule.get === 'function') ? deps.repeatModule.get() : 'no_repeat';
          let nextIndex = currentIndex + 1;

          if (repeatMode === 'repeat_one') {
            nextIndex = currentIndex;
          } else if (opts.shuffleMode) {
            let nextShuffleIndex = (typeof opts.shuffleIndex === 'number') ? (opts.shuffleIndex + 1) : 0;
            if (nextShuffleIndex < (opts.shuffleSongs || []).length) {
              const nextShuffleSong = opts.shuffleSongs[nextShuffleIndex];
              const found = (opts.allSongs || []).findIndex(s => s.url === (nextShuffleSong && nextShuffleSong.url));
              if (found > -1) {
                nextIndex = found;
                if (typeof opts.setShuffleIndex === 'function') opts.setShuffleIndex(nextShuffleIndex);
              } else {
                nextIndex = currentIndex + 1;
              }
            } else {
              if (repeatMode === 'repeat_all') {
                if ((opts.shuffleSongs || []).length > 0) {
                  const first = opts.shuffleSongs[0];
                  const found0 = (opts.allSongs || []).findIndex(s => s.url === (first && first.url));
                  nextIndex = found0 > -1 ? found0 : 0;
                  if (typeof opts.setShuffleIndex === 'function') opts.setShuffleIndex(0);
                } else nextIndex = 0;
              } else {
                console.log('[Player] End of shuffle list and no repeat_all -> stopping.');
                return;
              }
            }
          } else {
            if (nextIndex >= (opts.allSongs || []).length) {
              if (repeatMode === 'repeat_all') nextIndex = 0;
              else {
                console.log('[Player] End of queue reached; stopping player.');
                return;
              }
            }
          }

          // 在 Idle handler 計算 nextIndex 後，立刻 log 並呼回 main
          console.log(`[Player] Idle detected. computed nextIndex=${nextIndex} (will set and play)`);
          try { if (typeof opts.setCurrentSongIndex === 'function') opts.setCurrentSongIndex(nextIndex); } catch (e) { console.error('[Player] setCurrentSongIndex error on idle', e); }
          currentIndex = nextIndex;

          try {
            modulePlaySongAtIndex({
              index: nextIndex,
              allSongs: opts.allSongs,
              shuffleMode: opts.shuffleMode,
              shuffleSongs: opts.shuffleSongs,
              setShuffleSongs: opts.setShuffleSongs,
              setShuffleIndex: opts.setShuffleIndex,
              setCurrentSongIndex: opts.setCurrentSongIndex,
              setLastSongInfo: opts.setLastSongInfo,
              wss: opts.wss
            });
          } catch (e) {
            console.error('[Player] failed to play next:', e && e.message);
          }
        }
      });
    }
    return player;
  }

  // keep last play options so Idle handler can use them
  let lastPlayOpts = null;

  // original playSongAtIndex implementation should be referenced as modulePlaySongAtIndex
  async function playSongAtIndex(opts) {
    const index = Number(opts.index);
    console.log(`[Player] playSongAtIndex requested -> index=${index} (before start) currentIndex=${currentIndex}`);

    // update main + module-local index immediately
    console.log(`[Player] playSongAtIndex start -> requestedIndex=${index} currentIndex(before)=${currentIndex}`);
    try { if (typeof opts.setCurrentSongIndex === 'function') opts.setCurrentSongIndex(index); } catch(e) { console.error('[Player] setCurrentSongIndex callback error', e); }
    currentIndex = index;
    console.log(`[Player] playSongAtIndex updated currentIndex -> ${currentIndex}`);

    // remember opts for Idle handler
    lastPlayOpts = Object.assign({}, opts, {
      shuffleIndex: typeof opts.shuffleIndex === 'number' ? opts.shuffleIndex : 0,
      shuffleSongs: opts.shuffleSongs || [],
      allSongs: opts.allSongs || []
    });

    // ensure audioPlayer exists and is used for playback below
    const playerInstance = ensureAudioPlayer();

    // opts should include: index, allSongs, shuffleMode, shuffleSongs, set state callbacks
    const { allSongs, shuffleMode, shuffleSongs, setShuffleSongs, setShuffleIndex, setCurrentSongIndex,
            setLastSongInfo, wss } = opts;
    let playList = allSongs;
    let playIdx = index;

    if (shuffleMode) {
      playList = shuffleSongs;
      playIdx = index;
      if (playIdx < 0 || playIdx >= playList.length) {
        setShuffleSongs(shuffleArray(allSongs));
        playIdx = 0;
      }
    }

    if (playIdx < 0 || playIdx >= playList.length) {
      if (deps.repeatModule.get() === 'repeat_all' && allSongs.length > 0) {
        if (shuffleMode) {
          setShuffleSongs(shuffleArray(allSongs));
          await playSongAtIndex({ ...opts, index: 0 });
        } else {
          await playSongAtIndex({ ...opts, index: 0 });
        }
        return;
      }
      // clear and disconnect
      deps.setHasJoinedVoice(false);
      allSongs.length = 0;
      setLastSongInfo(null);
      setCurrentSongIndex(-1);
      setShuffleSongs([]);
      setShuffleIndex(0);
      if (connectionRef.connection) {
        connectionRef.connection.destroy();
        connectionRef.connection = null;
      }
      wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(JSON.stringify({ command: 'clear_playlist' }));
      });
      return;
    }

    const { url, title } = playList[playIdx];
    if (shuffleMode) {
      setShuffleIndex(playIdx);
      setCurrentSongIndex(allSongs.findIndex(s => s.url === url));
    } else {
      setCurrentSongIndex(playIdx);
    }

    try {
      setLastSongInfo({ title, url });

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
          client.send(JSON.stringify({ title, url, upcoming }));
          client.send(JSON.stringify({ status: 'playing' }));
          client.send(JSON.stringify({ repeat_mode: deps.repeatModule.get() }));
        }
      });

      // create audio stream + normalize via ffmpeg with robust error handling and fallback
      const rawStream = deps.ytdl(url, { filter: 'audioonly', quality: 'highestaudio', highWaterMark: 1 << 25 });
      let resourceStream = rawStream; // default fallback
      let ffmpegProc = null;
      try {
        const ffmpegPath = require('ffmpeg-static');
        const ffmpegArgs = [
          '-i', 'pipe:0',
          '-vn',
          '-af', 'loudnorm=I=-16:LRA=11:TP=-1.5',
          '-f', 'mp3',
          'pipe:1'
        ];
        // keep stderr so we can log ffmpeg errors if needed
        ffmpegProc = spawn(ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

        // on error/exit: log and fallback to rawStream
        ffmpegProc.on('error', (err) => {
          console.warn('[Player] ffmpeg spawn error:', err && err.message);
        });
        ffmpegProc.on('exit', (code, sig) => {
          if (code !== 0) console.warn(`[Player] ffmpeg exited code=${code} signal=${sig}`);
          // if ffmpeg exited early and resourceStream still points to ffmpeg stdout, fallback
          if (resourceStream === ffmpegProc.stdout) resourceStream = rawStream;
        });

        // avoid uncaught EPIPE from piping when ffmpeg stdin closed
        ffmpegProc.stdin.on('error', (err) => {
          if (err && err.code === 'EPIPE') {
            // common: ffmpeg closed; ignore and fallback
            console.warn('[Player] ffmpeg stdin EPIPE - falling back to raw stream');
          } else {
            console.warn('[Player] ffmpeg.stdin error:', err && err.message);
          }
        });
        ffmpegProc.stdout.on('error', (err) => {
          console.warn('[Player] ffmpeg stdout error:', err && err.message);
        });
        rawStream.on('error', (err) => {
          console.warn('[Player] ytdl rawStream error:', err && err.message);
          try { if (ffmpegProc && ffmpegProc.stdin) ffmpegProc.stdin.end(); } catch(e) {}
        });

        // pipe and use ffmpeg stdout as resource stream
        rawStream.pipe(ffmpegProc.stdin);
        resourceStream = ffmpegProc.stdout;
      } catch (e) {
        console.warn('[Player] ffmpeg setup failed, using raw stream:', e && e.message);
        resourceStream = rawStream;
        // ensure ffmpegProc cleaned if partially created
        try { if (ffmpegProc && !ffmpegProc.killed) ffmpegProc.kill(); } catch(_) {}
      }

      const resource = deps.createAudioResource(resourceStream, { inputType: deps.StreamType.Arbitrary, inlineVolume: true });
      if (resource && resource.volume && typeof resource.volume.setVolume === 'function') {
        resource.volume.setVolume(typeof volume === 'number' ? volume : 0.5);
      }

      player.play(resource);
      if (connectionRef.connection) connectionRef.connection.subscribe(player);
      if (deps.setIsCurrentlyPlaying) deps.setIsCurrentlyPlaying(true);

      // autoplay check
      if (deps.autoplayModule && deps.autoplayModule.checkAndAutofillSongs) {
        await deps.autoplayModule.checkAndAutofillSongs();
      }
    } catch (err) {
      console.error('Error playing audio:', err);
      if (deps.repeatModule.get() === 'repeat_one') playSongAtIndex({ ...opts, index: index });
      else playSongAtIndex({ ...opts, index: index + 1 });
    }
  }

  // helper: shuffleArray used above (simple Fisher-Yates)
  function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      // swap a[i] and a[j]
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // NOTE: avoid calling .on(...) on player when it may be null.
  // We do not attach a global player.on('stateChange') here because `player` is created lazily inside playSongAtIndex.
  // Instead add a lightweight wrapper to log play requests.

  const playSongAtIndexOriginal = playSongAtIndex;
  playSongAtIndex = async function playSongAtIndexWrapper(opts) {
    try {
      const idx = opts && typeof opts.index === 'number' ? opts.index : '(no-index)';
      const hasConnection = !!(connectionRef && connectionRef.connection);
      console.log(`[Player] playSongAtIndex requested -> index=${idx} hasConnection=${hasConnection} repeat=${deps.repeatModule && typeof deps.repeatModule.get === 'function' ? deps.repeatModule.get() : 'n/a'}`);
    } catch (e) {
      // ignore logging errors
    }
    return playSongAtIndexOriginal.apply(this, arguments);
  };

  // NOTE: removed global audioPlayer.on('stateChange', ...) block which referenced undefined variables.
  // State change / idle handling is attached locally when the `player` is created inside playSongAtIndex
  // (see player.on('idle') / player.on('error') above). This avoids referencing undefined audioPlayer,
  // and prevents duplicate/global handlers that caused the ReferenceError.
  // If you want a centralized stateChange guard, attach it when you create `player` and use closure-scoped vars.

  return { playSongAtIndex, setPlayerInstance };
};
// ...end file...