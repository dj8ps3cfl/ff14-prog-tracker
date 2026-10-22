// 進度紀錄的建立、比較與顯示

export const TW_SERVERS = new Set(['伊弗利特', '迦樓羅', '利維坦', '鳳凰', '奧汀', '巴哈姆特', '拉姆', '泰坦']);

// 由一場 fight 建立進度紀錄（欄位名稱刻意縮短，因為每個玩家檔會存很多筆）
export function toProgress(report, fight, job) {
  return {
    kill: Boolean(fight.kill),
    phase: fight.lastPhase ?? null,
    inter: Boolean(fight.lastPhaseIsIntermission),
    boss: fight.bossPercentage ?? null,
    pct: fight.fightPercentage ?? null,
    code: report.code,
    fight: fight.id,
    at: report.startTime + fight.startTime,
    dur: fight.endTime - fight.startTime,
    job,
  };
}

// a 是否比 b 打得更遠：通關最好，其次 fightPercentage 越低越遠，同進度取較早達成的
export function isFurther(a, b) {
  if (!b) return true;
  if (a.kill !== b.kill) return a.kill;
  const pa = a.pct ?? 100;
  const pb = b.pct ?? 100;
  if (pa !== pb) return pa < pb;
  return a.at < b.at;
}

export function progressLabel(p) {
  if (!p) return '-';
  if (p.kill) return '通關';
  const phase = p.phase ? `P${p.phase}${p.inter ? ' 轉場' : ''}` : null;
  const hp = p.boss != null ? `${p.boss.toFixed(1)}%` : null;
  return [phase, hp].filter(Boolean).join(' · ') || '滅團';
}

// 台北時間的日期字串，例如 2026-10-22
export const taipeiDate = (ms) =>
  new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

// 把一場 fight 記到玩家的某個副本底下
export function applyFight(player, encounterId, p) {
  const e = (player.encounters[encounterId] ??= {
    pulls: 0,
    kills: 0,
    firstPull: p.at,
    lastPull: p.at,
    best: null,
    firstKill: null,
    jobs: {},
    daily: {},
  });
  e.pulls++;
  if (p.kill) e.kills++;
  e.firstPull = Math.min(e.firstPull, p.at);
  e.lastPull = Math.max(e.lastPull, p.at);
  e.jobs[p.job] = (e.jobs[p.job] ?? 0) + 1;
  if (isFurther(p, e.best)) e.best = p;
  if (p.kill && (!e.firstKill || p.at < e.firstKill.at)) e.firstKill = p;

  const day = (e.daily[taipeiDate(p.at)] ??= { pulls: 0, kills: 0, best: null });
  day.pulls++;
  if (p.kill) day.kills++;
  if (isFurther(p, day.best)) day.best = p;
}

// 索引用的精簡摘要：[是否通關, 階段, Boss 血量, fightPercentage, 場數]
export function summarize(player) {
  const e = {};
  for (const [id, enc] of Object.entries(player.encounters)) {
    const b = enc.best;
    e[id] = [b.kill ? 1 : 0, b.phase, b.boss, b.pct, enc.pulls];
  }
  const lastPull = Math.max(...Object.values(player.encounters).map((enc) => enc.lastPull));
  return { n: player.name, s: player.server, l: lastPull, e };
}
