# Function Reference — 簡介 / Overview

此檔案以雙語（繁體中文 & English）簡潔說明專案中主要檔案與函式的用途、參數與回傳行為，方便快速閱讀與維護。  
This file documents the main functions in the project (ZhTW + English), with short descriptions, parameters and behavior.

---

## 檔案：main.js
主要負責 WebSocket server、Discord client、播放流程與模式控制。  
Main WebSocket/Discord playback manager.

- cachedSearch(query, opts = {})  
  - 說明：查詢 YouTube（透過 youtubeApi），並做簡易快取。  
  - 參數：query (string), opts (object; e.g. { type })  
  - 回傳：搜尋結果 object 或空物件。  
  - Note: 5 分鐘快取。

- getVideoId(url)  
  - 說明：從 URL 或字串擷取 canonical YouTube video id (11 chars)。  
  - 參數：url (string)  
  - 回傳：videoId (string) 或 null。

- playSongAtIndex(index)  
  - 說明：在 allSongs/shuffleSongs 中播放指定 index，負責取得 stream、建立 resource、建立 player、處理 events（Idle/Error/Playing/Paused）、以及呼叫 autoplay。  
  - 參數：index (number) - 0-based。  
  - 行為：更新 lastSongInfo、currentSongIndex、shuffleIndex、broadcast upcoming/status/modes，並處理 repeat/shuffle/end-of-queue。  
  - 注意：會使用 ytdl、createAudioResource、createAudioPlayer、connectionRef 等外部依賴。

- shuffleArray(arr)  
  - 說明：Fisher–Yates 洗牌。輸入不變，回傳新陣列。  
  - 參數：arr (Array)  
  - 回傳：shuffled Array。

- safeSend(wsClient, obj)  
  - 說明：嘗試安全地對單一 client 傳送 JSON。忽略錯誤。  
  - 參數：wsClient (WebSocket), obj (any serializable)  
  - 回傳：無。

- broadcast(obj)  
  - 說明：將物件 JSON.stringify 後傳送給所有已連線 client。個別錯誤被忽略。  
  - 參數：obj (object)  
  - 回傳：無。

- getUpcoming(list, idx, count = 5)  
  - 說明：從 list 與目前 idx 計算接下來最多 count 個 upcoming 項目（title/url）。  
  - 參數：list (Array), idx (number), count (number)  
  - 回傳：Array of { title, url }。

- handleSetAutoplayMode(wsClient, value)  
  - 說明：設定 autoplayMode，啟用時會嘗試立即執行一次 autofill。會向 clients 廣播模式與新增數量。  
  - 參數：wsClient (WebSocket optional), value (boolean)

- handleSetShuffleMode(wsClient, value)  
  - 說明：設定 shuffleMode。啟用時若正在播放會保留當前曲目為 shuffleSongs[0]，只洗牌 upcoming；停用時清除 shuffle 狀態。最後 broadcast 更新。  
  - 參數：wsClient, value (boolean)

- handleSetRepeatMode(wsClient, mode)  
  - 說明：設定 repeat 模式（使用 repeat module）。模式字串為 'no_repeat'|'repeat_all'|'repeat_one'。並廣播。  
  - 參數：wsClient, mode (string)

- handleToggleRepeat(wsClient)  
  - 說明：切換 repeat 模式（cycle），並廣播。  
  - 參數：wsClient

- handleSkip()  
  - 說明：跳到下一首（考慮 shuffle/repeat）。  
  - 回傳：無。

- handlePrevious()  
  - 說明：依與上次 previous 間隔決定是回到上一首或重開當前曲目（3 秒內按兩次視為上一首）。  
  - 回傳：無。

- handlePause() / handleResume()  
  - 說明：暫停或恢復播放。會更新 isCurrentlyPlaying 並 broadcast status。resume 會嘗試 player.unpause 或重新 play 當前 index。  
  - 參數：無。

- handleStatusRequest(wsClient)  
  - 說明：回傳目前狀態與 upcoming（依 shuffleMode 決定來源）。  
  - 參數：wsClient

- handleClearPlaylist()  
  - 說明：停止 playback、銷毀 connection、清空所有播放列表狀態，並廣播清除與 paused。  
  - 回傳：無。

- handleAddUrl(url, userIdFromClient, wsClient)  
  - 說明：加入 URL（或 playlist）。如果 bot 未連線至 voice，會用 user_id 找到使用者的 voice channel 並 join。使用 playlistService.addUrlOrPlaylist 進行實際加入，並處理 shuffle-mode 下的 append 行為。若尚未 hasJoinedVoice，呼叫 playSongAtIndex(0)。  
  - 參數：url (string), userIdFromClient (string), wsClient (WebSocket)  
  - 回傳：無（錯誤會 safeSend 回 client）。

- getUpcomingSongsCount()  
  - 說明：提供 Autoplay 模組用來計算剩餘 upcoming 數量（支援 shuffle 與 lastSongInfo 尋找最後 index）。  
  - 回傳：number

---

## 檔案：player.js
播放模組：將 ytdl 流透過 ffmpeg 正規化（loudnorm）並交給 @discordjs/voice 播放。回傳 playSongAtIndex 與 setPlayerInstance。

- createPlayer(deps) -> { playSongAtIndex, setPlayerInstance }  
  - 說明：建立 player 模組工廠，使用傳入依賴（ytdl、createAudioResource、createAudioPlayer、StreamType、repeatModule、utils、connectionRef、volume、autoplayModule 等）。  
  - 主要函式 playSongAtIndex(opts)  
    - 參數 opts: { index, allSongs, shuffleMode, shuffleSongs, setShuffleSongs, setShuffleIndex, setCurrentSongIndex, setLastSongInfo, wss, autoplayModule, repeatModule, ... }  
    - 行為：類似 main.playSongAtIndex，但更模組化：建立或確保 audio player、用 ffmpeg 做 loudnorm 並 pipe，建立 audio resource 並 play。會在 idle state 計算下一首（考 repeat/shuffle）。會呼叫 deps.autoplayModule.checkAndAutofillSongs()。  
    - 備註：包含多重防守（ffmpeg spawn 錯誤處理、ytdl 錯誤 fallback、resource volume 設定）。

  - setPlayerInstance(fn)  
    - 說明：提供外部 setter（可由 main 用來同步 player 實例）。

---

## 檔案：Autoplay.js
自動補歌模組：以 getUpNext(seed) 取得候選，經 enrich/score/過濾後把歌加入 allSongs。

- createAutoplay(deps) -> { checkAndAutofillSongs }  
  - 參數依賴：ytdl, Innertube, utils, allSongs, lastAddedTimestamps, getLastSongInfo, setLastSongInfo, getYoutubeApi, setYoutubeApi, autoplayModeGetter, getUpcomingSongsCount  
  - getUpNext(seed)  
    - 說明：對 seed（可以是 URL 或 title 字串）嘗試取 related、channel search、fallback search，回傳候選陣列（{ url, title, source, durationSeconds, viewCount }）。會使用 ytdl.getInfo 與 Innertube.search (cachedSearch)。  
  - enrichCandidate(candidate)  
    - 說明：利用 ytdl.getInfo 補齊 title/duration/viewCount/videoId/authorName。  
  - scoreCandidates(candidates, seed)  
    - 說明：對候選做簡易打分（來源加權、官方標題、字詞重疊、觀看數、時長匹配、排除 live/performance/lyrics、相似度懲罰），回傳排序後的 candidates。  
  - checkAndAutofillSongs()  
    - 說明：主流程。檢查 autoplay 模式與 upcoming 長度（使用 getUpcomingSongsCount），若不足則用 immutable seeds（lastSong + 後面最多幾首）取得候選並過濾（isTooSimilar、stripAuthorAndKeywords、containsForbiddenWord、時長檢查、重複檢查），最後把通過的候選 push 到 allSongs 並登記 lastAddedTimestamps。

---

## 檔案：lib/utils.js
工具集合（標題正規化、相似度判定、canAddUrl 等）

- getVideoId(url)  
  - 同 main.getVideoId，提取 11 字元 id。

- normalizeText(s)  
  - 說明：lowercase、移除括號內容、移除常見標記、移除非字元/數字空白、合併空白。用於相似度/比對。

- parseArtistTrack(title)  
  - 說明：嘗試以分隔符 ( - | — | | / \ ) 拆成 artist 與 track；回傳 { artist, track }（normalized）。

- isLyrics(title), isLiveOrBad(title), isPerformanceOrDance(title)  
  - 說明：用正規表達式判斷標題是否為歌詞版 / 直播 / 表演等不想加入的類型。

- titleTooSimilar(a, b)  
  - 說明：基於 normalizeText 的 token overlap 與包含判斷來判斷是否「過於相似」。回傳 boolean。

- wordsOverlapRatio(seedWords, titleWords)  
  - 說明：計算 seed words 在 titleWords 中的覆蓋比率 (0..1)。

- canAddUrl(url)  
  - 說明：是否可以加入（檢查能否擷取 videoId、是否已存在於 allSongs、以及 lastAddedTimestamps 間隔防重複）。

---

## 檔案：playlistService.js
處理單影片或 YouTube 播放清單加入的邏輯。

- addUrlOrPlaylist({ url, ytdl, youtubeApi, allSongs, lastAddedTimestamps })  
  - 說明：判斷是否 playlist-like，若是使用 Innertube.getPlaylist 取得影片並逐一加入；否則嘗試 ytdl.getInfo 抓 title 再加入 single video。會更新 lastAddedTimestamps，以避免短時間重複加入。回傳 { youtubeApi, addedCount }（若從 Innertube 建立 api 會回傳）。

---

## 檔案：popup.js（Chrome extension popup）
前端 UI 與 WebSocket client，與 server 溝通並更新 UI。

- requestResponse(cmdObj, timeout = 3000)  
  - 說明：送出帶 req_id 的 JSON 並等待單次回應（以 req_id 匹配），成功 resolve 回傳消息。  
  - 參數：cmdObj (object), timeout (ms)  
  - 回傳：Promise resolving to message object。

- loadStoredSettings()  
  - 說明：從 localStorage 讀取 ws_host 與 user_id，若無則回傳 defaultWsConfig 或 null。

- displaySongInfo(data)  
  - 說明：在 popup 顯示目前播放與 upcoming 簡短清單（最多 5），會建立 DOM 元素或更新既存元素。  
  - 參數：data { title, url, upcoming[] }

- updatePlayPauseButton(status) / clearPlaylistDisplay() / updateShuffleButtonUI(isShuffle) / updateReplayButtonUI(mode) / updateAutoplayButtonUI(isOn)  
  - 說明：更新 popup 上的按鈕狀態與外觀（CSS/emoji）。

- nextRepeatMode(mode)  
  - 說明：repeat 模式輪替函式（no_repeat → repeat_all → repeat_one → no_repeat）。

- clickEffect(button)  
  - 說明：UI 按鈕按下的暫時動畫效果。

- createAndAttachWS(cfg) / reconnectWebSocket(cfg)  
  - 說明：建立 WebSocket 連線並綁定 onopen/onmessage/onclose/onerror。onmessage 會解析伺服器消息與更新 UI（mode/status/title/upcoming），並處理錯誤回報（missing_user_id 等）。

- openSettingsModal() / closeSettingsModal() / saveSettingsAndReconnect()  
  - 說明：設定視窗的開閉與儲存（寫入 localStorage），儲存後重新連線。

---

## 檔案：test_similarity.js
CLI 工具，用來測試 Autoplay 標題相似度判定流程（支援互動輸入或命令列參數）。

- main()  
  - 說明：讀取 removeKeywords.json 設定，對 seed / candidate / author 進行 normalize、strip、token-overlap 計算，並印出是否會被 Autoplay 視為「過於相似」而跳過的決策結果。
  - 用途：調整 removeKeywords.json 與相似度閾值時快速驗證行為。

---

## 其他小檔案 / 模組

- repeat.js  
  - get(), set(mode), toggle() — 簡單管理 repeat-mode 狀態。

- start-discord-bot.bat  
  - Windows 用的啟動 script：在 repo 根目錄執行 node main.js。

---
most of the stuff write in ai