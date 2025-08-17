let lastSong = null;
let isPlaying = true;
let ws = null;
let userId = null;
let repeatMode = 'no_repeat';
let shuffleMode = false;
let autoplayMode = false;
let pendingRepeatDesired = null;
let defaultWsConfig = null;
let currentConnConfig = null;

// send a command and await a single response with req_id (promise)
// rejects on timeout or when ws not available
function requestResponse(cmdObj, timeout = 3000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('no-ws'));
    const reqId = `req_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const payload = Object.assign({}, cmdObj, { req_id: reqId });
    let to = null;
    function handler(ev) {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && msg.req_id === reqId) {
        try { ws.removeEventListener('message', handler); } catch (_) {}
        if (to) clearTimeout(to);
        resolve(msg);
      }
    }
    ws.addEventListener('message', handler);
    to = setTimeout(() => {
      try { ws.removeEventListener('message', handler); } catch (_) {}
      reject(new Error('timeout'));
    }, timeout);
    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      try { ws.removeEventListener('message', handler); } catch (_) {}
      if (to) clearTimeout(to);
      return reject(e);
    }
  });
}

// helper: read stored settings (localStorage overrides defaults)
function loadStoredSettings() {
  try {
    const host = localStorage.getItem('ws_host');
    const uid = localStorage.getItem('user_id');
    return {
      ws_host: host || (defaultWsConfig ? defaultWsConfig.ws_host : null),
      user_id: uid || (defaultWsConfig ? defaultWsConfig.user_id : null)
    };
  } catch (e) { return { ws_host: null, user_id: null }; }
}

function displaySongInfo(data) {
  let infoDiv = document.getElementById('nowPlayingInfo');
  if (!infoDiv) {
    infoDiv = document.createElement('div');
    infoDiv.id = 'nowPlayingInfo';
    const btn = document.getElementById('helloBtn');
    if (btn && btn.parentNode) btn.parentNode.insertBefore(infoDiv, btn);
    else document.body.insertBefore(infoDiv, document.body.firstChild);
  }

  const labelHtml = `<span style="font-weight:600;margin-left:6px;font-size:13px;color:#222;">Now playing</span>`;
  const titleHtml = data && data.url ? ` <a href="${data.url}" target="_blank" rel="noopener noreferrer" style="margin-left:8px;font-weight:500;">${data.title || ''}</a>` : ` ${data.title || ''}`;

  infoDiv.innerHTML = `🔊 ${labelHtml}${titleHtml}`;

  let upcomingDiv = document.getElementById('upcomingSongs');
  if (!upcomingDiv) {
    upcomingDiv = document.createElement('div');
    upcomingDiv.id = 'upcomingSongs';
    if (infoDiv.parentNode) infoDiv.parentNode.insertBefore(upcomingDiv, infoDiv.nextSibling);
    else document.body.appendChild(upcomingDiv);
  }

  if (Array.isArray(data.upcoming) && data.upcoming.length > 0) {
    let html = '<b>➡️</b> <span style="font-size:12px;color:#666;margin-left:6px;">Next up — shows up to 5 upcoming songs.</span>';
    html += `<div style="margin-top:6px;font-size:12px;color:#666;"><a href="#" id="viewAllUpcoming">View full upcoming list</a></div>`;
    html += '<ol style="padding-left:20px;margin-top:6px;">';
    data.upcoming.slice(0, 5).forEach(song => {
      html += `<li><a href="${song.url}" target="_blank" rel="noopener noreferrer">${song.title}</a></li>`;
    });
    html += '</ol>';
    upcomingDiv.innerHTML = html;
  } else {
    upcomingDiv.innerHTML = '';
  }

  lastSong = data;
}

function updatePlayPauseButton(status) {
  const playBtn = document.getElementById('playBtn');
  if (!playBtn) return;
  if (status === 'playing') {
    playBtn.innerHTML = '\u23F8\uFE0F'; // ⏸️
    isPlaying = true;
  } else {
    playBtn.innerHTML = '\u25B6\uFE0F'; // ▶️
    isPlaying = false;
  }
}

function clearPlaylistDisplay() {
  const upcomingDiv = document.getElementById('upcomingSongs');
  if (upcomingDiv) upcomingDiv.innerHTML = '';
  const infoDiv = document.getElementById('nowPlayingInfo');
  if (infoDiv) infoDiv.innerHTML = '';
  lastSong = null;
}

function updateShuffleButtonUI(isShuffle) {
  const btn = document.getElementById('shuffleBtn');
  if (!btn) return;
  btn.innerHTML = '&#128256;'; // 🔀
  btn.style.background = isShuffle ? '#43b581' : '';
  btn.title = isShuffle ? '🔀 Shuffle ON — Disable shuffle' : '🔀 Shuffle OFF — Enable shuffle';
  btn.setAttribute('aria-label', 'Shuffle');
  shuffleMode = !!isShuffle;
}

function updateReplayButtonUI(mode) {
  const btn = document.getElementById('replayBtn');
  if (!btn) return;
  if (mode === 'repeat_one') {
    btn.innerHTML = '&#128258;'; // 🔂
    btn.style.background = '#43b581';
  } else if (mode === 'repeat_all') {
    btn.innerHTML = '&#128257;'; // 🔁
    btn.style.background = '#888';
  } else {
    btn.innerHTML = '&#128257;'; // 🔁
    btn.style.background = '';
  }
  if (mode === 'repeat_one') btn.title = '🔂 Repeat One — Current song repeats';
  else if (mode === 'repeat_all') btn.title = '🔁 Repeat All — Playlist loops';
  else btn.title = '🔁 No Repeat — Play once, then stop';
  btn.setAttribute('aria-label', 'Repeat');
  repeatMode = mode;
}

function updateAutoplayButtonUI(isOn) {
  const btn = document.getElementById('autoplayBtn');
  if (!btn) return;
  btn.innerHTML = '⚡';
  btn.style.background = isOn ? '#43b581' : '';
  btn.title = isOn ? '⚡ Autoplay ON — Bot will add similar songs automatically' : '⚡ Autoplay OFF — Disable automatic additions';
  btn.setAttribute('aria-label', 'Autoplay');
  autoplayMode = !!isOn;
}

function nextRepeatMode(mode) {
  if (mode === 'no_repeat') return 'repeat_all';
  if (mode === 'repeat_all') return 'repeat_one';
  return 'no_repeat';
}

(function initPendingRepeatFromStorage() {
  try {
    const saved = localStorage.getItem('pending_repeat_mode');
    if (saved) pendingRepeatDesired = saved;
  } catch (_) {}
})();

// all button handlers and light UI helpers
document.addEventListener('DOMContentLoaded', () => {
  const playBtn = document.getElementById('playBtn');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const helloBtn = document.getElementById('helloBtn');
  const clearBtn = document.getElementById('clearBtn');
  const shuffleBtn = document.getElementById('shuffleBtn');
  const replayBtn = document.getElementById('replayBtn');
  const autoplayBtn = document.getElementById('autoplayBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsCancel = document.getElementById('settingsCancel');
  const settingsSave = document.getElementById('settingsSave');

  // small generic click effect used for non-mode buttons
  function clickEffect(button) {
    if (!button) return;
    const prevTransition = button.style.transition;
    button.style.transition = 'transform 120ms ease, box-shadow 160ms ease, background 160ms ease';
    const prevTransform = button.style.transform;
    const prevBox = button.style.boxShadow;
    const prevBg = button.style.background;
    button.style.transform = 'scale(0.96)';
    button.style.boxShadow = '0 4px 10px rgba(0,0,0,0.12)';
    if (!button.dataset._origBg) button.dataset._origBg = prevBg || '';
    button.style.background = '#2f3136';
    setTimeout(() => {
      button.style.transform = prevTransform || '';
      button.style.boxShadow = prevBox || '';
      button.style.background = button.dataset._origBg || prevBg || '';
      setTimeout(() => { button.style.transition = prevTransition || ''; }, 180);
    }, 160);
  }

  if (helloBtn) {
    helloBtn.title = helloBtn.title || 'Add current YouTube video or playlist to the bot';
    helloBtn.setAttribute('aria-label', 'Add URL to bot');
    helloBtn.addEventListener('click', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) { alert('WebSocket is not connected.'); return; }
      clickEffect(helloBtn);
      helloBtn.style.background = '#b3c7ff';
      setTimeout(() => { helloBtn.style.background = ''; }, 300);
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length === 0) return;
        const url = (tabs[0].url || '').trim();
        const isYouTubeVideo = /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)/i.test(url);
        const isYouTubePlaylist = /^(https?:\/\/)?(www\.)?youtube\.com\/playlist\?list=/.test(url)
          || (/^(https?:\/\/)?(www\.)?youtube\.com\/watch\?/.test(url) && /[?&]list=/.test(url))
          || (/^(https?:\/\/)?(www\.)?youtu\.be\/.*[?&]list=/.test(url));
        if (!(isYouTubeVideo || isYouTubePlaylist)) { alert('Only YouTube video or playlist URLs are accepted!'); return; }
        try {
          ws.send(JSON.stringify({ url, user_id: userId }));
          try { ws.send(JSON.stringify({ command: 'status' })); } catch (_) {}
        } catch (e) { console.error('Add URL send failed', e); }
      });
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) { alert('WebSocket not connected.'); return; }
      clickEffect(clearBtn);
      clearBtn.style.background = '#f7a9a5';
      setTimeout(() => { clearBtn.style.background = ''; }, 300);
      const ok = confirm('Clear the current playlist and stop playback?');
      if (!ok) return;
      try { ws.send(JSON.stringify({ command: 'clear_playlist' })); } catch (e) { console.warn(e); }
      clearPlaylistDisplay();
      updatePlayPauseButton('paused');
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) { alert('WebSocket not connected.'); return; }
      clickEffect(nextBtn);
      try { ws.send(JSON.stringify({ command: 'skip' })); } catch (e) { console.warn(e); }
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) { alert('WebSocket not connected.'); return; }
      clickEffect(prevBtn);
      try { ws.send(JSON.stringify({ command: 'previous' })); } catch (e) { console.warn(e); }
    });
  }

  if (playBtn) {
    playBtn.addEventListener('click', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) { alert('WebSocket not connected.'); return; }
      // no clickEffect for mode-changing actions
      if (isPlaying) {
        try { ws.send(JSON.stringify({ command: 'pause' })); } catch (e) { console.warn(e); }
        updatePlayPauseButton('paused');
      } else {
        try { ws.send(JSON.stringify({ command: 'resume' })); } catch (e) { console.warn(e); }
        updatePlayPauseButton('playing');
      }
    });
  }

  if (shuffleBtn) {
    shuffleBtn.addEventListener('click', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) { alert('WebSocket not connected.'); return; }
      const desired = !shuffleMode;
      // no clickEffect for mode-changing actions
      updateShuffleButtonUI(desired);
      try { ws.send(JSON.stringify({ command: 'set_shuffle_mode', shuffle: desired })); } catch (e) { console.warn(e); }
    });
  }

  if (replayBtn) {
    replayBtn.addEventListener('click', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) { alert('WebSocket not connected.'); return; }
      const prevMode = repeatMode || 'no_repeat';
      const desiredMode = nextRepeatMode(prevMode);
      // no clickEffect for mode-changing actions
      updateReplayButtonUI(desiredMode);
      try { ws.send(JSON.stringify({ command: 'set_repeat_mode', mode: desiredMode })); } catch (e) { console.warn(e); updateReplayButtonUI(prevMode); }
    });
  }

  if (autoplayBtn) {
    autoplayBtn.addEventListener('click', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) { alert('WebSocket not connected.'); return; }
      const prev = !!autoplayMode;
      const desired = !prev;
      // no clickEffect for mode-changing actions
      updateAutoplayButtonUI(desired);
      try { ws.send(JSON.stringify({ command: 'set_autoplay_mode', autoplay_mode: desired })); } catch (e) { console.warn(e); updateAutoplayButtonUI(prev); }
    });
  }

  if (settingsBtn) settingsBtn.addEventListener('click', () => { clickEffect(settingsBtn); openSettingsModal(); });
  if (settingsCancel) settingsCancel.addEventListener('click', () => { closeSettingsModal(); });
  if (settingsSave) settingsSave.addEventListener('click', () => { saveSettingsAndReconnect(); });

  // View full upcoming list handler (uses lastSong as source + requestResponse fallback)
  document.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!target || target.id !== 'viewAllUpcoming') return;
    ev.preventDefault();
    const fallbackItems = Array.isArray(lastSong && lastSong.upcoming) ? (lastSong.upcoming.slice(0, 5)) : [];
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // open fallback page
      const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      let page = `<!doctype html><html><head><meta charset="utf-8"><title>Upcoming songs (${fallbackItems.length})</title><style>body{font-family:Arial,Helvetica,sans-serif;padding:16px}a{color:#06c}</style></head><body>`;
      page += `<h2>Upcoming songs (${fallbackItems.length})</h2><ol>`;
      fallbackItems.forEach(song => { page += `<li><a href="${esc(song.url)}" target="_blank" rel="noopener noreferrer">${esc(song.title)}</a></li>`; });
      page += `</ol><p><small>Opened from extension popup.</small></p></body></html>`;
      const blob = new Blob([page], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => { URL.revokeObjectURL(url); }, 10000);
      return;
    }

    // try to request full playlist
    const reqId = `req_full_playlist_${Date.now()}_${Math.floor(Math.random()*1000)}`;
    let settled = false;
    function responseHandler(ev2) {
      let msg;
      try { msg = JSON.parse(ev2.data); } catch { return; }
      if (msg.req_id && msg.req_id !== reqId) return;
      if (Array.isArray(msg.full_playlist)) {
        settled = true;
        try { ws.removeEventListener('message', responseHandler); } catch (_) {}
        const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        let page = `<!doctype html><html><head><meta charset="utf-8"><title>Upcoming songs (${msg.full_playlist.length})</title><style>body{font-family:Arial,Helvetica,sans-serif;padding:16px}a{color:#06c}</style></head><body>`;
        page += `<h2>Upcoming songs (${msg.full_playlist.length})</h2><ol>`;
        msg.full_playlist.forEach(song => { page += `<li><a href="${esc(song.url)}" target="_blank" rel="noopener noreferrer">${esc(song.title)}</a></li>`; });
        page += `</ol><p><small>Opened from extension popup.</small></p></body></html>`;
        const blob = new Blob([page], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => { URL.revokeObjectURL(url); }, 10000);
      }
    }
    ws.addEventListener('message', responseHandler);
    try { ws.send(JSON.stringify({ command: 'get_full_playlist', req_id: reqId })); } catch (_) {}
    setTimeout(() => {
      if (settled) return;
      try { ws.removeEventListener('message', responseHandler); } catch (_) {}
      const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      let page = `<!doctype html><html><head><meta charset="utf-8"><title>Upcoming songs (${fallbackItems.length})</title><style>body{font-family:Arial,Helvetica,sans-serif;padding:16px}a{color:#06c}</style></head><body>`;
      page += `<h2>Upcoming songs (${fallbackItems.length})</h2><ol>`;
      fallbackItems.forEach(song => { page += `<li><a href="${esc(song.url)}" target="_blank" rel="noopener noreferrer">${esc(song.title)}</a></li>`; });
      page += `</ol><p><small>Opened from extension popup.</small></p></body></html>`;
      const blob = new Blob([page], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => { URL.revokeObjectURL(url); }, 10000);
    }, 1200);
  });
});

// load wsconfig.json defaults then connect using stored override
(function initConnectionFromSettings() {
   // wsconfig.json 已移除；extension 以 localStorage 為唯一預設來源
   defaultWsConfig = null;
   const cfg = loadStoredSettings();
   if (cfg && cfg.ws_host) {
     createAndAttachWS(cfg);
   } else {
     console.warn('No ws_host configured. Please open Settings (⚙️) and enter your WSS host (e.g. wss://your.domain:3000).');
     // 自動彈出設定視窗，強制使用者輸入 ws_host / user_id
     openSettingsModal();
   }
 })();

function createAndAttachWS(cfg) {
  if (!cfg || !cfg.ws_host) { console.error('No ws_host provided for WebSocket connection.'); return; }
  // prefer plain ws:// (do not force wss)
  let host = String(cfg.ws_host).trim();
  // if user provided wss://, downgrade to ws:// to match server
  if (/^wss:\/\//i.test(host)) {
    console.warn('[popup] wss:// provided — using ws:// to match server (WSS disabled)');
    host = host.replace(/^wss:\/\//i, 'ws://');
  }
  // if user provided ws:// keep as-is; if no scheme, prepend ws://
  if (!/^(wss?:\/\/)/i.test(host)) host = 'ws://' + host;

  try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch (e) {}
  ws = new WebSocket(host);
  userId = cfg.user_id || null;
  currentConnConfig = { ws_host: host, user_id: userId };

  ws.onopen = () => {
    console.log('WebSocket connected (popup)', cfg.ws_host);
    if (lastSong) displaySongInfo(lastSong);
    try {
      ws.send(JSON.stringify({ command: 'status' }));
      ws.send(JSON.stringify({ command: 'get_repeat_mode' }));
      ws.send(JSON.stringify({ command: 'get_shuffle_mode' }));
      ws.send(JSON.stringify({ command: 'get_autoplay_mode' }));
    } catch (_) {}
    if (pendingRepeatDesired) {
      try { ws.send(JSON.stringify({ command: 'set_repeat_mode', mode: pendingRepeatDesired })); console.log('[popup] applied pending repeat on connect:', pendingRepeatDesired); } catch (e) { console.warn('[popup] failed to apply pending repeat on connect:', e); }
    }
  };

  ws.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    if (typeof data.shuffle_mode !== 'undefined') updateShuffleButtonUI(data.shuffle_mode);
    if (typeof data.repeat_mode !== 'undefined') {
      updateReplayButtonUI(data.repeat_mode);
      if (pendingRepeatDesired && data.repeat_mode === pendingRepeatDesired) {
        try { localStorage.removeItem('pending_repeat_mode'); } catch (_) {}
        pendingRepeatDesired = null;
      }
    }
    if (typeof data.autoplay_mode !== 'undefined') updateAutoplayButtonUI(data.autoplay_mode);
    if (data.status) updatePlayPauseButton(data.status);

    if (data && data.error) {
      if (data.error === 'missing_user_id') alert('Please open Settings (⚙️) and set your user ID, then try again.');
      else if (data.error === 'user_not_in_voice') alert('Please join a voice channel first, then press Add URL again.');
      else if (data.error === 'join_failed') alert('Bot failed to join your voice channel. Try again.');
    }

    if (data.title || data.upcoming) displaySongInfo(data);
    if (data.command === 'clear_playlist') clearPlaylistDisplay();
  };

  ws.onclose = () => { console.log('WebSocket disconnected (popup)'); };
  ws.onerror = (error) => { console.error('WebSocket error (popup):', error); };
}

function reconnectWebSocket(cfg) {
  try { if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close(); } catch (e) {}
  createAndAttachWS(cfg);
}

function openSettingsModal() {
  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  const cfg = loadStoredSettings();
  document.getElementById('settingsWsHost').value = cfg.ws_host || '';
  document.getElementById('settingsUserId').value = cfg.user_id || '';
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
}

function closeSettingsModal() {
  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  modal.style.display = 'none';
  modal.setAttribute('aria-hidden', 'true');
}

function saveSettingsAndReconnect() {
  const host = (document.getElementById('settingsWsHost').value || '').trim();
  const uid = (document.getElementById('settingsUserId').value || '').trim();
  try {
    if (host) localStorage.setItem('ws_host', host); else localStorage.removeItem('ws_host');
    if (uid) localStorage.setItem('user_id', uid); else localStorage.removeItem('user_id');
  } catch (e) { console.warn('Saving settings failed', e); }

  closeSettingsModal();
  const cfg = loadStoredSettings();
  reconnectWebSocket(cfg);
}
