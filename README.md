# ff14-prog-tracker

追蹤繁中服 FF14 高難副本的開荒進度。現有的成績網站只收通關紀錄，這裡連**未通關（滅團）**的 fight 也一起記下來：看得到角色曾經打到哪個階段、Boss 剩多少血，還能直接連到 FFLogs 看死亡紀錄。

資料來自 [FFLogs API v2](https://www.fflogs.com/v2-api-docs/ff/)，只抓得到公開（public）的 report。

## 設定

需要 Node.js 20.12 以上，不用安裝任何套件。

1. 到 <https://www.fflogs.com/api/clients/> 建立 client（**不要**勾 Public Client，Redirect URL 填 `http://localhost` 即可）
2. 把 `.env.example` 複製成 `.env`，填入 Client ID 和 Secret

## 實測腳本

```bash
npm run probe                                   # 全部跑一次
node scripts/probe.mjs zones                    # 列出 zone / encounter ID
node scripts/probe.mjs reports 48 68            # 近 48 小時 zone 68 含繁中玩家的 reports
node scripts/probe.mjs report <code>            # 單一 report 的每場 fight
node scripts/probe.mjs player <角色名> <伺服器>   # 在近期 reports 裡找某角色的進度
```

## 實測發現（2026-10-22）

- FFLogs **沒有繁中區**，也沒有繁中伺服器 / 角色資料，`characterData.character` 查不到繁中角色。
- 繁中服的 report 被標成 `CN` 區，只能從參戰者（`masterData.actors`）的伺服器名稱辨認繁中玩家。
- `reportData.reports(zoneID, startTime, endTime)` 不用指定公會或使用者也能掃全站公開 reports。
- 每場 fight 都有 `kill`、`lastPhase`、`bossPercentage`、`fightPercentage`，滅團進度完整可用。
- 額度：每小時 1000 點。列表一頁約 1.5 點，檢查一份 report 的參戰者約 1 點，展開一份 report 的 fights 約 3 點。
