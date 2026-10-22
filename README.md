# ff14-prog-tracker

追蹤繁中服 FF14 高難副本的開荒進度。現有的成績網站只收通關紀錄，這裡連**未通關（滅團）**的 fight 也一起記下來：看得到角色曾經打到哪個階段、Boss 剩多少血，還能直接連到 FFLogs 看死亡紀錄。

資料來自 [FFLogs API v2](https://www.fflogs.com/v2-api-docs/ff/)，只抓得到公開（public）的 report。

## 設定

需要 Node.js 20.12 以上。

1. `npm install`
2. 到 <https://www.fflogs.com/api/clients/> 建立 client（**不要**勾 Public Client，Redirect URL 填 `http://localhost` 即可）
3. 把 `.env.example` 複製成 `.env`，填入 Client ID 和 Secret
4. `npx wrangler login`，登入 Cloudflare（掃描程式和 Worker 都透過 wrangler 存取 D1）

## 實測腳本

```bash
npm run probe                                   # 全部跑一次
node scripts/probe.mjs zones                    # 列出 zone / encounter ID
node scripts/probe.mjs reports 48 68            # 近 48 小時 zone 68 含繁中玩家的 reports
node scripts/probe.mjs report <code>            # 單一 report 的每場 fight
node scripts/probe.mjs player <角色名> <伺服器>   # 在近期 reports 裡找某角色的進度
```

## 掃描

```bash
npm run scan                                    # 掃描最近 72 小時
npm run backfill                                # 往回補歷史到各 zone 的 backfillSince，額度用完就停，下次接著補
node scripts/scan.mjs auto                      # 先掃最近的，剩下的額度補歷史（排程每 30 分鐘跑這個）
node scripts/scan.mjs --max-points 200          # 限制這次最多用多少 FFLogs 點數
```

要追蹤的副本、掃描範圍、補歷史到哪一天（`backfillSince`）、額度上限都在 `config/tracked.json`。補歷史照 zone 的順序一個補完才補下一個。

掃描同時控制兩種額度：

- **FFLogs**：每小時 1000 點，每次最多用 `maxPointsPerRun`，並保留 `reservePoints`。
- **D1 寫入**：免費方案每天（UTC 00:00 重置）10 萬列。用 D1 回報的過去 24 小時寫入量和自己記在 `meta` 表的當日寫入量，取較大的那個計算。一般掃描最多用到 `dailyWriteLimit`，補歷史最多用到 `backfillWriteLimit`，保留空間給之後的一般掃描。同一時間只能有一個掃描在跑（新資料的 id 是掃描程式自己配的），GitHub 上的排程在跑時不要在本機跑 `scan`。

`.github/workflows/scan.yml` 每 30 分鐘跑一次掃描。repo 的 Secrets 需要：`FFLOGS_CLIENT_ID`、`FFLOGS_CLIENT_SECRET`、`CLOUDFLARE_API_TOKEN`（權限只要 Account → D1 → Edit）、`CLOUDFLARE_ACCOUNT_ID`。

## 資料庫（Cloudflare D1）

資料表定義在 `db/migrations/`，變更後用 `npx wrangler d1 migrations apply ff14-prog --remote` 套用。為了省空間，存進資料庫前會先處理：

- 角色名、report code 都換成整數 id，只在 `players`、`reports` 存一次
- 時間存 Unix 秒數；Boss 血量、fightPercentage 乘以 100 存成整數
- 伺服器、職業存成代碼（對照表在 `shared/codes.mjs`，只能往後加）
- 同一場戰鬥被多個隊員上傳時只存一次（用隊伍成員雜湊 + 開打時間判斷）
- 只存繁中玩家，LimitBreak 之類的假玩家和雜魚戰都不存

| 資料表 | 內容 |
| --- | --- |
| `pulls` | 每一場 pull（含滅團）：副本、時間、是否通關、階段、Boss 血量 |
| `pull_players` | 誰打了哪一場、用什麼職業 |
| `player_stats` | 每個角色、每個副本的摘要：場數、最佳 pull、首次通關 |
| `players` / `reports` | 角色、report 的 id 對照 |
| `meta` | 補歷史的進度 |

## 查詢 API（Cloudflare Worker）

`worker/index.mjs`，用 `npx wrangler deploy` 部署，回應會快取 30 分鐘。

| 路徑 | 內容 |
| --- | --- |
| `GET /encounters` | 追蹤中的副本清單 |
| `GET /search?q=<名字開頭>` | 搜尋角色 |
| `GET /player?name=<角色名>&server=<伺服器>` | 角色的各副本最佳進度、首次通關、每日進度、每個 P 的到達次數 |
| `GET /pulls?player=<id>&encounter=<id>[&before=<上一頁的 next>]` | 角色在某副本的每一場 pull，依時間新到舊 |

## 網頁

`docs/` 底下的靜態網頁（不需要 build），從 Worker API 讀資料。

本機開發：先把遠端資料匯出到本機 D1，再 `npm run dev`（API 在 8811、網頁在 8812，本機不快取）：

```bash
npx wrangler d1 export ff14-prog --remote --output .cache/export.sql
npx wrangler d1 execute ff14-prog --local --file .cache/export.sql
npm run dev
```

本機 D1 已經有資料時，要先刪掉 `.wrangler/state/v3/d1` 再匯入。

## 實測發現（2026-10-22）

- FFLogs **沒有繁中區**，也沒有繁中伺服器 / 角色資料，`characterData.character` 查不到繁中角色。
- 繁中服的 report 被標成 `CN` 區，只能從參戰者（`masterData.actors`）的伺服器名稱辨認繁中玩家。
- `reportData.reports(zoneID, startTime, endTime)` 不用指定公會或使用者也能掃全站公開 reports。
- 每場 fight 都有 `kill`、`lastPhase`、`bossPercentage`、`fightPercentage`，滅團進度完整可用。
- 額度：每小時 1000 點。列表一頁約 1.5 點，檢查一份 report 的參戰者約 1 點，展開一份 report 的 fights 約 3 點。
