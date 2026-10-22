-- 時間一律是 Unix 秒數；百分比一律 × 100 存成整數（42.6% → 4260）
-- 伺服器、職業的代碼見 shared/codes.mjs

CREATE TABLE players (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  server INTEGER NOT NULL,
  UNIQUE (name, server)
);

CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  start_time INTEGER NOT NULL,
  -- report 的 endTime 變了（直播上傳還在增加）就要重掃
  end_time INTEGER NOT NULL,
  scanned_at INTEGER NOT NULL
);

-- 每一場 pull（含滅團）
CREATE TABLE pulls (
  id INTEGER PRIMARY KEY,
  report_id INTEGER NOT NULL,
  fight INTEGER NOT NULL,
  encounter INTEGER NOT NULL,
  start_time INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  kill INTEGER NOT NULL,
  -- 結束時的階段，轉場存成負數
  phase INTEGER,
  boss INTEGER,
  pct INTEGER,
  -- 隊伍成員的雜湊，用來判斷是不是同一場被多人重複上傳
  party INTEGER NOT NULL
);
CREATE INDEX pulls_start_time ON pulls (start_time);

-- 誰打了哪一場。以 (player_id, pull_id) 排序存放，查某角色的所有 pull 不需要額外索引
CREATE TABLE pull_players (
  player_id INTEGER NOT NULL,
  pull_id INTEGER NOT NULL,
  job INTEGER NOT NULL,
  PRIMARY KEY (player_id, pull_id)
) WITHOUT ROWID;

-- 每個角色、每個副本的摘要，掃描時增量更新
CREATE TABLE player_stats (
  player_id INTEGER NOT NULL,
  encounter INTEGER NOT NULL,
  pulls INTEGER NOT NULL,
  kills INTEGER NOT NULL,
  first_pull INTEGER NOT NULL,
  last_pull INTEGER NOT NULL,
  -- 見 shared/codes.mjs 的 progressRank
  best_rank INTEGER NOT NULL,
  best_pull INTEGER NOT NULL,
  first_kill INTEGER,
  first_kill_at INTEGER,
  PRIMARY KEY (player_id, encounter)
) WITHOUT ROWID;

-- 補歷史的進度之類的小設定
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
