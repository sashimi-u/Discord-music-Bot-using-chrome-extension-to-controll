# Discord Bot + Chrome Extension（A music bot for using the chrome extension to controll and using button but not discord command to play music）

繁體中文
----------------
簡介  
這是一個以 Node.js 製作的 Discord 播放機器人，播放來源由 Chrome 擴充功能傳送（將目前開啟的 YouTube 影片或播放清單送到 Bot）。擴充功能透過 WebSocket 與 Bot 溝通並控制播放（加入曲目、跳過、暫停、 隨機播放、 重複播放 、Autoplay 等）， 幫助各位有更好的discord 音樂播放體驗。

主要功能
- 從 Chrome popup 一鍵把目前 YouTube 影片或 playlist 傳給 Bot 並加入播放清單。  
- 在 Discord 語音頻道播放音訊。 
- Autoplay：自動搜尋並加入相似歌曲，確保音樂不會停下來。  
- Chrome Popup 顯示當前曲目與接下來的歌曲清單，用按鈕控制：播放 / 暫停 / 上一首 / 下一首 / 清除播放清單 / 隨機播放 / 重複播放 / Autoplay


架構概覽
- main.js — WebSocket server、Discord client、播放清單與播放流程管理。  
- Chrome_extension/popup.html + popup.js — 使用者 UI，設定 ws_host 與 user_id，發送 URL / 指令給 Bot。  
- player.js — ytdl + ffmpeg 流處理並產生 audio resource。  
- Autoplay.js — 候選搜尋、過濾與自動加入邏輯。  
- playlistService.js — 處理單影片或 YouTube 播放清單加入。  
- lib/utils.js — 標題正規化、重複判定等工具函式。

快速安裝與啟動
1. 安裝相依套件：  
   npm install
2. 設定 Bot token 與音量：建立或編輯 config.json（切勿公開 token）：  
   {
     "token": "<YOUR_DISCORD_BOT_TOKEN>",
     "volume": 0.5
   }  
3. 啟動（開發 / 本機 Windows）：  
   node main.js  
   或執行 start-discord-bot.bat（已包含 node main.js）
4. 在 Discord 將 Bot 邀請進伺服器，並確保 Bot 有「連線語音」與「說話」權限；另外需在 config 允許 intents（程式已使用 GUILD_VOICE_STATES）。

Chrome 擴充功能使用
- 打包或以擴充功能開發模式載入 Chrome_extension 資料夾。  
- Popup 設定：輸入 WebSocket host，例如 ws://YOUR_HOST:3000（若在同台機器可用 ws://localhost:3000），以及（可選）Discord user_id（擴充功能會把 user_id 一併送出，方便 Bot 找到要加入的語音頻道）。  
- 在 YouTube 分頁按「🔗」會把當前分頁 URL 傳給 Bot。若 Bot 尚未連線語音頻道，需先在 Discord 內加入語音並在 popup 設定 user_id。

npm 套件清單（Packages / npm）
此處列出專案程式碼中實際 require / import 的主要 npm 套件（以 package 名稱為準），供你核對 package.json 或用於安裝。

- discord.js — Discord API client。  
- @discordjs/voice — Discord 語音功能（音訊播放 / 連線）。  
- youtubei.js — 取得 YouTube 資訊與搜尋（Innertube API）。  
- @distube/ytdl-core — 下載 YouTube 音訊（ytdl-core 的 fork/包裝）。  
- ffmpeg-static — 提供 ffmpeg 可執行檔路徑（用於音訊轉碼）。  
- ws — WebSocket server / client（擴充功能與 bot 的通訊）。  
- express — 提供簡單 HTTP server（main.js 使用）。  

（程式碼還會使用 Node 內建模組：fs, path, http/https, child_process 等）

快速安裝（範例）
- 在專案根目錄執行：
  npm install discord.js @discordjs/voice youtubei.js @distube/ytdl-core ffmpeg-static ws express

WebSocket 指令摘要（由 popup 發送）
- 傳送純 URL（字串） → 加入播放清單並在必要時讓 Bot 加入你所在的語音頻道（需 user_id）。  
- JSON 指令範例：  
  - { "command": "status" }  
  - { "command": "skip" }  
  - { "command": "previous" }  
  - { "command": "pause" } / { "command": "resume" }  
  - { "command": "set_shuffle_mode", "shuffle": true }  
  - { "command": "set_repeat_mode", "mode": "no_repeat"|"repeat_all"|"repeat_one" }  
  - { "command": "set_autoplay_mode", "autoplay_mode": true|false }  
  - { "command": "clear_playlist" }  
  - { "command": "get_full_playlist", "req_id": "<id>" } → 回傳 { full_playlist: [...], req_id }

部署與安全建議
- 預設 WebSocket 為明文（ws://）。  
- 切勿把 config.json（含 token）上傳到公開倉庫；若 token 洩漏，立即在 Discord 開發者後台重置。

除錯要點
- popup 顯示 missing_user_id → 在 popup 設定 user_id 或在 popup 開啟對應 Discord 使用者。  
- Bot 無法加入語音 → 確認 Bot 已被邀請到伺服器並有語音權限且目標使用者正在語音頻道。  
- ffmpeg 相關錯誤 → 安裝 ffmpeg 或 npm install ffmpeg-static。  
- 若無法抓取 YouTube 音訊（403 等）程式具備 fallback，但若仍失敗可能是網路或 ytdl-core 問題。

開發與測試
- 使用 test_similarity.js 來測試 Autoplay 的相似度判定邏輯。  
- 移除 / 調整自動補歌（removeKeywords.json）可影響 Autoplay 的結果與過濾行為。

License / 套件
- 本專案使用多個開源套件（discord.js, @discordjs/voice, youtubei.js, ytdl-core 等），請遵守各套件授權條款。

安全注意事項
- 本專案包含可直接控制 Discord Bot 的程式碼與可接收遠端指令的通訊介面。公開或部署前，務必評估敏感資訊曝光與未授權存取的風險。  
- 切勿將實際的 bot token、私密憑證或任何機敏設定放入公開版本庫。  
- 若服務可被外部連線，可能會遭到未授權指令、濫用或資源耗盡攻擊；使用者資料（例如 extension 傳送的 user_id）應視為敏感資訊並謹慎處理。  
- 作者不在此提供變更系統設定或安全配置的步驟；公開或對外提供本專案時，請自行評估並承擔相關風險。

作者備註
- 我只是個新手，這是我的第一個專案。專案中很多內容與說明是由 AI 協助產生或整理的。感謝你花時間閱讀，若有任何建議或發現問題，歡迎回報與指教。

English
-------

Introduction
This is a Discord music bot built with Node.js. The playback source is sent by a Chrome extension (which sends the currently open YouTube video or playlist to the bot). The extension communicates with the bot via WebSocket and controls playback (adding tracks, skipping, pausing, shuffling, repeating, autoplay, etc.), helping everyone enjoy a better Discord music playback experience.

Key Features
- Send the current YouTube video or playlist to the bot from the Chrome popup and add it to the playlist with one click.
- Play audio in the Discord voice channel.
- Autoplay: Automatically search and add similar songs to ensure the music never stops.
- The Chrome popup displays the current track and the next song list, with buttons to control: Play / Pause / Previous / Next / Clear Playlist / Shuffle / Repeat / Autoplay

Architecture
- main.js — WebSocket server, Discord client, playlist & playback manager.  
- Chrome_extension/popup.html + popup.js — UI and WebSocket client (set ws_host and user_id).  
- player.js — streaming via ytdl + ffmpeg, builds audio resources.  
- Autoplay.js — candidate search, filtering, and auto-fill logic.  
- playlistService.js — playlist and single-video adding logic.  
- lib/utils.js — normalization, similarity checks, canAddUrl, etc.

Quick start
1. Install dependencies:  
   npm install
2. Configure token and volume in config.json (keep token secret):  
   {
     "token": "<YOUR_DISCORD_BOT_TOKEN>",
     "volume": 0.5
   }
3. Start the bot:  
   node main.js  
   or run start-discord-bot.bat on Windows.
4. Invite the bot to your server with voice permissions.

Chrome extension
- Load the Chrome_extension folder as an unpacked extension.  
- In popup settings, set WebSocket host (e.g. ws://localhost:3000) and optional user_id.  
- Click the Add URL button to send the current YouTube page to the bot.

WebSocket commands (summary)
- Send a raw URL string to add a song.  
- Send JSON commands: status, skip, previous, pause/resume, set_shuffle_mode, set_repeat_mode, set_autoplay_mode, clear_playlist, get_full_playlist (uses req_id).

Deployment & security
- Default WebSocket is plain ws://.  
- Never commit config.json with the bot token; rotate the token if leaked.

Troubleshooting
- missing_user_id → set user_id in popup or use the popup from the Discord user who is in a voice channel.  
- join failed → verify bot permissions and that the target user is in a voice channel.  
- ffmpeg errors → install ffmpeg or ffmpeg-static.  
- YouTube fetch errors → may be network/ytdl limitations; code includes fallback behavior.

Testing & tuning
- Use test_similarity.js to experiment with Autoplay similarity behavior.  
- Adjust removeKeywords.json to tune Autoplay (keyword removal, thresholds, forbidden words).

Acknowledgements
- Built with discord.js, @discordjs/voice, youtubei.js, ytdl-core and other OSS libraries — follow their licenses.

Security notices
- This project includes code that accepts remote commands and controls a Discord bot. Before making this repository public or deploying it, evaluate risks related to sensitive data exposure and unauthorized access.  
- Do not commit real bot tokens, private keys, or other secrets into a public repository.  
- A publicly reachable service can be subject to unauthorized commands, abuse, or resource-exhaustion attacks; user identifiers (e.g., user_id sent by the extension) should be treated as sensitive.  
- No step-by-step secure deployment instructions are provided here; if you publish or offer this project to others, assess and accept the security responsibilities yourself.

Author note
- I'm just a programming noob and this is my first project. Much of the content was produced or organized with help from AI. Thanks for reading — feedback and bug reports are welcome.

## NPM packages used (English)

This project directly requires the following npm packages (used in the repository source):

- discord.js — Discord API client (bot core).  
- @discordjs/voice — Discord voice connections and audio playback.  
- youtubei.js — Innertube-based YouTube API/search/playlist access.  
- @distube/ytdl-core — ytdl-core fork/wrapper used to download YouTube audio.  
- ffmpeg-static — Provides a portable ffmpeg binary path used by the player.  
- ws — WebSocket server used for communication between the Chrome extension and the bot.  
- express — Lightweight HTTP server used by main.js.

Install example:
npm install discord.js @discordjs/voice youtubei.js @distube/ytdl-core ffmpeg-static ws express

