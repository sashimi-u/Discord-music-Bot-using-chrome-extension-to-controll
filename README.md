# Discord Bot + Chrome Extension（本地播放與 Autoplay）

簡介
----
這是一個以 Node.js 實作的 Discord 播放器專案，包含：
- Discord bot（main.js）負責管理播放清單、語音連線、播放控制、repeat/shuffle/autoplay。
- Autoplay 模組（Autoplay.js）負責自動尋找並補歌到播放清單。
- Player 模組（player.js）負責串接 ytdl + ffmpeg 處理音訊並播放。
- Chrome extension（hello.html + popup.js）提供瀏覽器 UI，透過 WebSocket 與 bot 溝通（加入 YouTube 影片、控制播放、顯示目前曲目與 upcoming 列表）。

主要功能
- 由 extension 傳入 YouTube 影片或播放清單 URL，Bot 加入至播放清單並在 voice channel 播放。
- 支援 Play/Pause、Next、Previous、Shuffle、Repeat（no/repeat_all/repeat_one）、Autoplay（自動補歌）。
- Autoplay 會基於當前/近期歌曲做相關搜尋並加入合適歌曲（去重與過濾）。
- WS API 提供狀態與控制指令（供 extension 使用）。

系統需求
- Windows / macOS / Linux
- Node.js v18+（建議）
- ffmpeg（或安裝專案使用的 ffmpeg-static 套件）
- Discord Bot Token（在 Discord Developer Portal 取得）
- 需要安裝 npm 套件（詳下）

安裝與快速開始
1. 取得專案
   - 將專案放在本機資料夾（例如：`c:\Users\<you>\Desktop\Discord Bot`）。

2. 安裝相依套件
   打開終端（Windows: PowerShell / cmd），執行：
   ```
   npm install
   ```
   若使用全域 ffmpeg，請確保 ffmpeg 在 PATH；或安裝 `ffmpeg-static`（專案 player 模組已嘗試使用）。

3. 設定
   - 編輯 `config.json`（不要把 token 推到公開倉庫）：
     ```json
     {
       "token": "<YOUR_DISCORD_BOT_TOKEN>",
       "volume": 0.5
     }
     ```
   - (可選) 編輯 Chrome extension 的 `Chrome_extension/wsconfig.json` 以預設 ws host：
     ```json
     {
       "ws_host": "ws://<YOUR_HOST>:3000",
       "user_id": "<OPTIONAL_USER_ID_FROM_DISCORD>"
     }
     ```

4. 啟動 bot（Windows 範例）
   - 雙擊 `start-discord-bot.bat` 或在專案資料夾執行：
     ```
     node main.js
     ```

Chrome extension 使用
- 打開 extension popup（hello.html）：
  - Add URL（🔗）會將當前分頁的 YouTube 影片或 playlist 發送給 bot（需 extension 設定 websocket host 與 user_id）。
  - 其他按鈕：播放/暫停、上一首、下一首、清單清除、Shuffle、Repeat、Autoplay。
- 若未連線或 user_id 未設定，extension 會提示相關錯誤。

WebSocket 協議（摘要）
- 客戶端向 ws 發送 JSON 指令或直接傳送 URL（字串）。
- 常用 command：
  - { command: "status" }
  - { command: "skip" }
  - { command: "previous" }
  - { command: "pause" } / { command: "resume" }
  - { command: "set_shuffle_mode", shuffle: true|false }
  - { command: "set_repeat_mode", mode: "no_repeat"|"repeat_all"|"repeat_one" }
  - { command: "set_autoplay_mode", autoplay_mode: true|false }
  - { command: "clear_playlist" }
  - { url: "<youtube url>", user_id: "<discord user id>" }  // Add URL
  - { command: "get_full_playlist", req_id: "<id>" } -> 回傳 { full_playlist: [...], req_id }

架構說明（重點檔案）
- main.js
  - WebSocket server、Discord client、播放清單管理、playSongAtIndex（播放控制）與模式廣播。
- Autoplay.js
  - 搜尋候選、過濾、打分、將適合曲目自動加入 allSongs。
- player.js
  - 透過 ytdl 取得音訊、可選地用 ffmpeg 處理流、建立 audio resource 並播放；也包含播放完成（Idle）處理邏輯。
- playlistService.js
  - 處理單影片與 YouTube 播放清單加入流程（使用 Innertube）。
- lib/utils.js
  - 工具函式：normalizeText、getVideoId、canAddUrl、titleTooSimilar、isLiveOrBad 等。
- Chrome_extension/popup.js + hello.html
  - Extension 端 UI 與 WS 通訊邏輯。

安全與隱私
- 請勿把 `config.json` 中的 Bot token、或任何機密推上公開儲存庫。若 token 洩露，立即在 Discord Developer Portal 重新產生。
- WebSocket 目前為明文 ws://。若暴露在公網，務必使用反向代理或在內網/VPN 執行，或改用 wss（TLS）。

常見問題（快速排查）
- 無法 join voice / join_failed：
  - 確認 Bot 在該伺服器有「連入語音頻道」與「說話」權限。
  - 確認 extension 傳送的 user_id 對應使用者正確在 voice channel。
- ytdl 失敗或播放中斷：
  - 可能是 YouTube 拒絕串流，或 ffmpeg 問題；檢查 console log，有必要時更新套件或在系統安裝 ffmpeg。
- popup 顯示「WebSocket is not connected」：
  - 確認 wsconfig.json 的 ws_host 與 main.js 正在監聽的 host/port（預設 port 3000）一致，並且 bot 已啟動。

開發與測試
- 可用 `test_similarity.js` 測試標題相似度與 Autoplay 篩選邏輯。
- 需要跑單元測試請自行加入測試框架（jest / mocha）。

部署建議
- 若公開部署，建議：
  - 使用 HTTPS / WSS（TLS）。
  - 在 Docker 中執行，並把機密以環境變數或 secret 管理（不要在 repo 保留 token）。
  - 加入日誌輪替、重啟策略（pm2 / systemd），與監控。

授權與致謝
- 本專案整合多個開源套件（discord.js、@discordjs/voice、youtubei.js、ytdl-core 等）；請遵守各套件授權條款。
- 若需我將 README 轉為英文版或加上部署範例（Dockerfile、systemd unit），