// 團滅分析：從 FFLogs 的 report（場次 + 死亡紀錄）整理出每場怎麼滅的、整份 report 最常死在哪
//
// 「第一個倒下」和「團滅原因」都是推測：第一個倒下的人不一定是犯錯的人，
// 所以只整理事實（誰、何時、被什麼打死），不判定戰犯。

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

const CJK = /[㐀-鿿]/;

// 致死技能：優先用 FFLogs 判定的最後一擊，沒有的話（例如死於持續傷害）用死前受到傷害最多的技能
function killingAbility(entry) {
  if (entry.killingBlow?.name) return entry.killingBlow;
  const abilities = entry.damage?.abilities ?? [];
  return abilities.reduce((best, a) => (!best || a.total > best.total ? a : best), null);
}

// 台服資料裡只有英文名稱的技能，用技能編號查中文名稱；本來就是中文的保留台服譯名
function displayName(ability, names) {
  if (!ability?.name) return '不明';
  if (CJK.test(ability.name)) return ability.name;
  return names?.[ability.guid] ?? ability.name;
}

function toDeath(entry, fight, names) {
  return {
    name: entry.name,
    job: entry.type,
    at: entry.timestamp - fight.startTime,
    phase: phaseAt(fight, entry.timestamp),
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
      return { at: deaths[i].at, phase: deaths[i].phase, ability, deaths: wave.length };
    }
  }
  return null;
}

function summarizePull(fight, deaths) {
  const first = deaths[0] ?? null;
  const cascade = fight.kill ? null : findCascade(deaths);
  // 團滅原因：有明顯的一波團滅就用那波的機制，否則用第一個倒下的人的致死技能
  const cause = fight.kill
    ? null
    : cascade
      ? { phase: cascade.phase, ability: cascade.ability }
      : first
        ? { phase: first.phase, ability: first.ability }
        : null;
  return {
    id: fight.id,
    kill: Boolean(fight.kill),
    progress: {
      kill: Boolean(fight.kill),
      phase: fight.lastPhase,
      intermission: fight.lastPhaseIsIntermission,
      boss: fight.bossPercentage,
      pct: fight.fightPercentage,
    },
    duration: Math.round((fight.endTime - fight.startTime) / 1000),
    deaths,
    first,
    cascade,
    cause,
  };
}

function rankMechanics(wipes) {
  const byKey = new Map();
  const get = (phase, ability) => {
    const key = `${phase}|${ability}`;
    if (!byKey.has(key)) byKey.set(key, { phase, ability, wipes: 0, firstDeaths: 0, deaths: 0 });
    return byKey.get(key);
  };
  for (const pull of wipes) {
    if (pull.cause) get(pull.cause.phase, pull.cause.ability).wipes++;
    if (pull.first) get(pull.first.phase, pull.first.ability).firstDeaths++;
    for (const d of pull.deaths) get(d.phase, d.ability).deaths++;
  }
  return [...byKey.values()].sort((a, b) => b.wipes - a.wipes || b.firstDeaths - a.firstDeaths || b.deaths - a.deaths);
}

function rankPlayers(wipes) {
  const byName = new Map();
  for (const pull of wipes) {
    pull.deaths.forEach((d, i) => {
      if (!byName.has(d.name)) byName.set(d.name, { name: d.name, job: d.job, deaths: 0, firstDeaths: 0, abilities: new Map() });
      const p = byName.get(d.name);
      p.deaths++;
      if (i === 0) p.firstDeaths++;
      p.abilities.set(d.ability, (p.abilities.get(d.ability) ?? 0) + 1);
    });
  }
  return [...byName.values()]
    .map(({ abilities, ...p }) => {
      const [topAbility, topCount] = [...abilities].sort((a, b) => b[1] - a[1])[0];
      return { ...p, topAbility, topCount };
    })
    .sort((a, b) => b.firstDeaths - a.firstDeaths || b.deaths - a.deaths);
}

// report 是 FFLogs reportData.report（含 fights 與 table）；names 是技能編號 → 中文名稱的對照表（可省略）
export function analyzeReport(report, names) {
  const fights = (report.fights ?? []).filter((f) => f.encounterID);
  const deathsByFight = new Map(fights.map((f) => [f.id, []]));
  const fightById = new Map(fights.map((f) => [f.id, f]));
  for (const entry of report.table?.data?.entries ?? []) {
    const fight = fightById.get(entry.fight);
    if (fight) deathsByFight.get(fight.id).push(toDeath(entry, fight, names));
  }
  const pulls = fights.map((f) => ({
    ...summarizePull(f, deathsByFight.get(f.id).sort((a, b) => a.at - b.at)),
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
  const best = pulls.reduce(
    (b, p) => (!b || (p.kill && !b.kill) || (!b.kill && !p.kill && (p.progress.pct ?? 100) < (b.progress.pct ?? 100)) ? p : b),
    null
  );
  return {
    encounterID,
    name,
    pulls,
    wipes: wipes.length,
    kills: pulls.length - wipes.length,
    deaths: wipes.reduce((sum, p) => sum + p.deaths.length, 0),
    best: best.progress,
    mechanics: rankMechanics(wipes),
    players: rankPlayers(wipes),
  };
}

// 從貼上的網址或代碼取出 report code
export function parseReportCode(input) {
  const text = input.trim();
  return text.match(/reports\/([A-Za-z0-9]{16})/)?.[1] ?? (/^[A-Za-z0-9]{16}$/.test(text) ? text : null);
}
