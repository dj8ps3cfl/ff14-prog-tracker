// 團滅分析：從 FFLogs 的 report（場次 + 死亡紀錄）整理出每場怎麼滅的、整份 report 最常死在哪
//
// 重點放在「哪個機制」而不是「誰」：刻意不統計誰第一個倒下，免得變成找戰犯。

// 這段時間內倒下這麼多人，就當成「開始團滅」
const CASCADE_WINDOW_MS = 10_000;
const CASCADE_MIN_DEATHS = 3;

// 第幾個階段：最後一個開始時間不晚於 t 的階段
function phaseAt(fight, t) {
  let phase = 1;
  for (const transition of fight.phaseTransitions ?? []) {
    if (transition.startTime <= t) phase = transition.id;
  }
  return phase;
}

const ORDINALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const ordinal = (n) => ORDINALS[n - 1] ?? String(n);

// 迷宮類（例如異聞迷宮）整趟只算一個 encounter、沒有階段，改用 dungeonPulls 把每場拆成小怪和各隻王。
// 回傳依時間排序的段落；一般副本回傳空陣列
function dungeonSegments(fight) {
  let bosses = 0;
  return (fight.dungeonPulls ?? []).map((p) =>
    p.encounterID
      ? {
          start: p.startTime,
          end: p.endTime,
          label: `${ordinal(++bosses)}王 ${p.name}`,
          boss: { encounterID: p.encounterID, kill: Boolean(p.kill), enemies: (p.enemyNPCs ?? []).map((e) => e.id) },
        }
      : { start: p.startTime, label: `${ordinal(bosses + 1)}王前小怪` }
  );
}

// 時間點 t 所在的階段名稱：迷宮用段落（還沒開打前算第一段），一般副本用 P1、P2…
function stageAt(fight, segments, t) {
  if (!segments.length) return `P${phaseAt(fight, t)}`;
  let label = segments[0].label;
  for (const s of segments) if (s.start <= t) label = s.label;
  return label;
}

// 這場依序經過的階段（相鄰的同名段落合併）
function stagesReached(fight, segments) {
  if (!segments.length) return Array.from({ length: fight.lastPhase ?? 0 }, (_, i) => `P${i + 1}`);
  return segments.map((s) => s.label).filter((label, i, all) => label !== all[i - 1]);
}

const CJK = /[㐀-鿿]/;

// 致死技能：優先用 FFLogs 判定的最後一擊，沒有的話（例如死於持續傷害）用死前受到傷害最多的技能
function killingAbility(entry) {
  if (entry.killingBlow?.name) return entry.killingBlow;
  const abilities = entry.damage?.abilities ?? [];
  return abilities.reduce((best, a) => (!best || a.total > best.total ? a : best), null);
}

// 死前完全沒有傷害紀錄的死亡：被擊退或吹出場外、即死類的負面狀態、暗黑騎士行屍走肉結束等
export const NON_DAMAGE_DEATH = '非傷害致死';

// 台服資料裡只有英文名稱的技能，用技能編號查中文名稱；本來就是中文的保留台服譯名
function displayName(ability, names) {
  if (!ability?.name) return NON_DAMAGE_DEATH;
  // 自動攻擊在國際服叫 attack、台服的紀錄裡是簡體的「攻击」
  if (ability.name === 'attack' || ability.name === '攻击') return '自動攻擊';
  if (CJK.test(ability.name)) return ability.name;
  return names?.[ability.guid] ?? ability.name;
}

function toDeath(entry, fight, segments, names) {
  return {
    name: entry.name,
    job: entry.type,
    at: entry.timestamp - fight.startTime,
    stage: stageAt(fight, segments, entry.timestamp),
    ability: displayName(killingAbility(entry), names),
  };
}

// 這份 report 的死亡紀錄裡有沒有英文的致死技能（有的話才需要載入中文對照表）
export function hasUntranslatedAbilities(report) {
  return (report.table?.data?.entries ?? []).some((e) => {
    const name = killingAbility(e)?.name;
    return name && !CJK.test(name);
  });
}

// 找出第一個「10 秒內倒下 3 人以上」的時間點，以及那波死亡最常見的致死技能
function findCascade(deaths) {
  for (let i = 0; i < deaths.length; i++) {
    const wave = deaths.filter((d, j) => j >= i && d.at - deaths[i].at <= CASCADE_WINDOW_MS);
    if (wave.length >= CASCADE_MIN_DEATHS) {
      const counts = new Map();
      for (const d of wave) counts.set(d.ability, (counts.get(d.ability) ?? 0) + 1);
      const [ability] = [...counts].sort((a, b) => b[1] - a[1])[0];
      return { at: deaths[i].at, stage: deaths[i].stage, ability, deaths: wave.length };
    }
  }
  return null;
}

function summarizePull(fight, segments, deaths) {
  const stages = stagesReached(fight, segments);
  const first = deaths[0] ?? null;
  const cascade = fight.kill ? null : findCascade(deaths);
  // 團滅原因：有明顯的一波團滅就用那波的機制，否則用最早一筆死亡的致死機制
  const cause = fight.kill
    ? null
    : cascade
      ? { stage: cascade.stage, ability: cascade.ability }
      : first
        ? { stage: first.stage, ability: first.ability }
        : null;
  return {
    id: fight.id,
    kill: Boolean(fight.kill),
    // 迷宮沒有階段和 Boss 血量（永遠是 100%），進度改用打到哪一段，depth 用來比較誰打得比較遠
    progress: segments.length
      ? { kill: Boolean(fight.kill), stage: stages.at(-1), depth: stages.length, pct: fight.fightPercentage }
      : {
          kill: Boolean(fight.kill),
          phase: fight.lastPhase,
          intermission: fight.lastPhaseIsIntermission,
          boss: fight.bossPercentage,
          pct: fight.fightPercentage,
          depth: 0,
        },
    stages,
    duration: Math.round((fight.endTime - fight.startTime) / 1000),
    deaths,
    cascade,
    cause,
  };
}

function rankMechanics(wipes) {
  const byKey = new Map();
  const get = (stage, ability) => {
    const key = `${stage}|${ability}`;
    if (!byKey.has(key)) byKey.set(key, { stage, ability, wipes: 0, deaths: 0 });
    return byKey.get(key);
  };
  for (const pull of wipes) {
    if (pull.cause) get(pull.cause.stage, pull.cause.ability).wipes++;
    for (const d of pull.deaths) get(d.stage, d.ability).deaths++;
  }
  return [...byKey.values()].sort((a, b) => b.wipes - a.wipes || b.deaths - a.deaths);
}

function rankPlayers(wipes) {
  const byName = new Map();
  for (const pull of wipes) {
    for (const d of pull.deaths) {
      if (!byName.has(d.name)) byName.set(d.name, { name: d.name, job: d.job, deaths: 0, abilities: new Map() });
      const p = byName.get(d.name);
      p.deaths++;
      p.abilities.set(d.ability, (p.abilities.get(d.ability) ?? 0) + 1);
    }
  }
  return [...byName.values()]
    .map(({ abilities, ...p }) => {
      const [topAbility, topCount] = [...abilities].sort((a, b) => b[1] - a[1])[0];
      return { ...p, topAbility, topCount };
    })
    .sort((a, b) => b.deaths - a.deaths);
}

// report 是 FFLogs reportData.report（含 fights 與 table）；names 是技能編號 → 中文名稱的對照表（可省略）
export function analyzeReport(report, names) {
  // 0 秒的場次是進副本後沒開打就重來，不算一場
  const fights = (report.fights ?? []).filter((f) => f.encounterID && f.endTime > f.startTime);
  const deathsByFight = new Map(fights.map((f) => [f.id, []]));
  const fightById = new Map(fights.map((f) => [f.id, f]));
  const segmentsByFight = new Map(fights.map((f) => [f.id, dungeonSegments(f)]));
  for (const entry of report.table?.data?.entries ?? []) {
    const fight = fightById.get(entry.fight);
    if (fight) deathsByFight.get(fight.id).push(toDeath(entry, fight, segmentsByFight.get(fight.id), names));
  }
  const pulls = fights.map((f) => ({
    ...summarizePull(f, segmentsByFight.get(f.id), deathsByFight.get(f.id).sort((a, b) => a.at - b.at)),
    // 迷宮裡每一次打到王：第幾場、什麼時候、有沒有打倒（血量另外查，見 applyBossHp）
    attempts: segmentsByFight.get(f.id).filter((s) => s.boss).map((s) => ({
      fight: f.id,
      label: s.label,
      start: s.start,
      end: s.end,
      at: s.start - f.startTime,
      duration: Math.round((s.end - s.start) / 1000),
      ...s.boss,
      hp: s.boss.kill ? 0 : undefined,
    })),
    encounterID: f.encounterID,
    bossName: f.name,
  }));

  // 同一份 report 可能連打好幾隻王，機制和個人統計要依 Boss 分開算，照第一次打的順序排
  const bosses = [];
  for (const pull of pulls) {
    let boss = bosses.find((b) => b.encounterID === pull.encounterID);
    if (!boss) bosses.push((boss = { encounterID: pull.encounterID, name: pull.bossName, pulls: [] }));
    boss.pulls.push(pull);
  }
  return {
    pulls,
    wipes: pulls.filter((p) => !p.kill).length,
    kills: pulls.filter((p) => p.kill).length,
    bosses: bosses.map((b) => summarizeBoss(b)),
  };
}

function summarizeBoss({ encounterID, name, pulls }) {
  // 排行只看滅團的場次，通關那場有人倒下不算團滅原因
  const wipes = pulls.filter((p) => !p.kill);
  const reach = (p) => (p.kill ? Infinity : p.progress.depth * 1000 + (100 - (p.progress.pct ?? 100)));
  const best = pulls.reduce((b, p) => (!b || reach(p) > reach(b) ? p : b), null);
  return {
    encounterID,
    name,
    pulls,
    wipes: wipes.length,
    kills: pulls.length - wipes.length,
    deaths: wipes.reduce((sum, p) => sum + p.deaths.length, 0),
    best: best.progress,
    stages: stageStats(pulls),
    dungeonBosses: dungeonBosses(pulls),
    mechanics: rankMechanics(wipes),
    players: rankPlayers(wipes),
  };
}

// 每個階段到達幾次、在那裡滅團幾次，照第一次出現的順序排
function stageStats(pulls) {
  const byLabel = new Map();
  for (const pull of pulls) {
    for (const label of pull.stages) {
      if (!byLabel.has(label)) byLabel.set(label, { label, reached: 0, wiped: 0 });
      byLabel.get(label).reached++;
    }
    if (!pull.kill && pull.stages.length) byLabel.get(pull.stages.at(-1)).wiped++;
  }
  return [...byLabel.values()];
}

// 迷宮裡每隻王的挑戰紀錄，依王出場的順序
function dungeonBosses(pulls) {
  const byLabel = new Map();
  for (const attempt of pulls.flatMap((p) => p.attempts)) {
    if (!byLabel.has(attempt.label)) byLabel.set(attempt.label, { label: attempt.label, attempts: [] });
    byLabel.get(attempt.label).attempts.push(attempt);
  }
  return [...byLabel.values()];
}

// 還不知道血量的挑戰，拿去向 Worker 的 /boss-hp 查：「fight.開始.結束.敵人id-敵人id」
export const bossHpSegment = (a) => `${a.fight}.${a.start}.${a.end}.${a.enemies.join('-')}`;
export const pendingBossHp = (attempts) => attempts.filter((a) => a.hp === undefined && a.enemies.length);

// body 是 /boss-hp 的回應，第 i 段對應 attempts[i]：取最後一筆打在王身上的事件的剩餘血量。
// 敵人不只一隻時，血量上限最多的那隻當成王。查不到事件的維持 undefined
export function applyBossHp(attempts, body) {
  const report = body?.data?.reportData?.report ?? {};
  attempts.forEach((attempt, i) => {
    const events = (report[`s${i}`]?.data ?? []).filter(
      (e) => attempt.enemies.includes(e.targetID) && e.targetResources?.maxHitPoints
    );
    if (!events.length) return;
    const bossId = events.reduce((a, b) => (b.targetResources.maxHitPoints > a.targetResources.maxHitPoints ? b : a)).targetID;
    const last = events.filter((e) => e.targetID === bossId).at(-1).targetResources;
    attempt.hp = (last.hitPoints / last.maxHitPoints) * 100;
  });
}

// 沒打倒但剩不到 threshold% 的挑戰，也當成擊倒（門檻由使用者自己填，0 代表只算真的打倒）
export const countsAsKill = (a, threshold) => a.kill || (threshold > 0 && a.hp !== undefined && a.hp <= threshold);

// 每隻王的摘要：挑戰幾次、打倒幾次（其中幾次是靠門檻算的）、滅團時最低血量
export function summarizeDungeonBoss(boss, threshold = 0) {
  const wipes = boss.attempts.filter((a) => !a.kill);
  const known = wipes.filter((a) => a.hp !== undefined);
  const nearKills = wipes.filter((a) => countsAsKill(a, threshold)).length;
  return {
    attempts: boss.attempts.length,
    kills: boss.attempts.length - wipes.length + nearKills,
    nearKills,
    bestHp: known.length ? Math.min(...known.map((a) => a.hp)) : null,
  };
}

// 從貼上的網址或代碼取出 report code
export function parseReportCode(input) {
  const text = input.trim();
  return text.match(/reports\/([A-Za-z0-9]{16})/)?.[1] ?? (/^[A-Za-z0-9]{16}$/.test(text) ? text : null);
}
