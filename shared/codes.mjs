// 掃描程式和 Worker 共用的代碼表：資料庫裡只存數字，顯示時再換回名稱
// 這兩個陣列只能往後加，不能改順序，否則資料庫裡的舊資料會對錯

// 繁中服伺服器，代碼 = 陣列索引 + 1
export const SERVERS = ['伊弗利特', '迦樓羅', '利維坦', '鳳凰', '奧汀', '巴哈姆特', '拉姆', '泰坦'];

// FFLogs 的職業 subType，代碼 = 陣列索引 + 1，0 代表不認得
export const JOBS = [
  'Paladin', 'Warrior', 'DarkKnight', 'Gunbreaker',
  'WhiteMage', 'Scholar', 'Astrologian', 'Sage',
  'Monk', 'Dragoon', 'Ninja', 'Samurai', 'Reaper', 'Viper',
  'Bard', 'Machinist', 'Dancer',
  'BlackMage', 'Summoner', 'RedMage', 'Pictomancer',
  'BlueMage',
];

export const serverCode = (name) => SERVERS.indexOf(name) + 1;
export const serverName = (code) => SERVERS[code - 1] ?? null;
export const jobCode = (name) => JOBS.indexOf(name) + 1;
export const jobName = (code) => JOBS[code - 1] ?? null;

// 進度排序值：通關是 -1，其餘是 fightPercentage × 100，越小代表打得越遠
export const progressRank = (kill, pct) => (kill ? -1 : pct ?? 10000);
