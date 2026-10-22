// 正式掃描：抓含繁中玩家的公開 reports，把每場 fight（含滅團）記到玩家的進度裡
//
// 用法：
//   node scripts/scan.mjs                         掃描最近 windowHours 小時（排程每 30 分鐘跑這個）
//   node scripts/scan.mjs backfill --since 2026-07-28
//                                                 往回補歷史資料，每次跑到額度用完為止，下次接著補
// 選項：
//   --max-points <n>   這次最多用多少點（預設看 config/tracked.json 的 maxPointsPerRun）
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { getRateLimit, gql } from './lib/fflogs.mjs';
import { TW_SERVERS, applyFight, summarize, toProgress } from './lib/progress.mjs';
import { PlayerStore, readJson, writeJson } from './lib/store.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 實測的點數花費，用來在送出查詢前估算額度
const COST_PER_PAGE = 1.5;
const COST_PER_REPORT = 2.2;
// 一次 GraphQL 查詢合併幾份 report
const BATCH_SIZE = 5;
// 去重紀錄和已掃描 report 保留多久
const DEDUPE_TTL = 30 * DAY;
const REPORT_TTL = 14 * DAY;

const config = JSON.parse(await readFile(new URL('../config/tracked.json', import.meta.url), 'utf8'));

class Budget {
  constructor(limit) {
    this.limit = limit;
    this.used = 0;
  }
  canSpend(points) {
    return this.used + points <= this.limit;
  }
  spend(points) {
    this.used += points;
  }
}

// 同一場戰鬥常常有好幾個隊員各自上傳，用「副本 + 隊伍成員 + 開打時間（分鐘）」去重
class FightDedupe {
  constructor(entries = {}) {
    this.entries = entries;
  }
  // 回傳 true 代表這場已經算過了
  check(encounterId, party, at) {
    const members = party.map((a) => `${a.name}@${a.server}`).sort().join(',');
    const hash = createHash('sha1').update(members).digest('hex').slice(0, 10);
    const minute = Math.floor(at / 60_000);
    // 不同人的 log 開打時間會差幾秒，前後一分鐘都算同一場
    for (const m of [minute - 1, minute, minute + 1]) {
      if (this.entries[`${encounterId}|${hash}|${m}`]) return true;
    }
    this.entries[`${encounterId}|${hash}|${minute}`] = Date.now();
    return false;
  }
  prune(now) {
    for (const [key, insertedAt] of Object.entries(this.entries)) {
      if (insertedAt < now - DEDUPE_TTL) delete this.entries[key];
    }
  }
}

// 列出時間範圍內 CN 區的 reports（繁中服的 report 也被標成 CN）
async function listReports(zoneId, start, end, budget) {
  const reports = [];
  let complete = false;
  for (let page = 1; page <= config.maxPagesPerZone; page++) {
    if (!budget.canSpend(COST_PER_PAGE)) break;
    budget.spend(COST_PER_PAGE);
    const { reportData } = await gql(
      `query ($zoneID: Int, $start: Float, $end: Float, $page: Int) {
        reportData {
          reports(zoneID: $zoneID, startTime: $start, endTime: $end, limit: 100, page: $page) {
            has_more_pages
            data { code endTime region { slug } }
          }
        }
      }`,
      { zoneID: zoneId, start, end, page }
    );
    const result = reportData.reports;
    reports.push(...result.data.filter((r) => r.region?.slug === 'CN'));
    if (!result.has_more_pages) {
      complete = true;
      break;
    }
  }
  return { reports, complete };
}

async function fetchReports(codes) {
  const fields = codes
    .map(
      (code, i) => `r${i}: report(code: "${code}") {
        code startTime endTime
        fights(killType: Encounters) {
          id encounterID difficulty kill inProgress
          bossPercentage fightPercentage lastPhase lastPhaseIsIntermission
          startTime endTime friendlyPlayers
        }
        masterData { actors(type: "Player") { id name server subType } }
      }`
    )
    .join('\n');
  const { data, errors } = await gql(`{ reportData { ${fields} } }`, {}, { partial: true });
  for (const err of errors) console.log(`  ! ${err.message}`);
  // 整批都失敗（例如查詢太複雜）就丟例外，不要把這些 report 誤記成已掃描
  if (!data?.reportData) throw new Error('reports 查詢失敗：' + errors.map((e) => e.message).join('；'));
  return codes.map((_, i) => data.reportData[`r${i}`]);
}

function processReport(report, zone, ctx) {
  const actors = new Map(report.masterData.actors.map((a) => [a.id, a]));
  const work = [];
  for (const f of report.fights) {
    if (!(String(f.encounterID) in zone.encounters)) continue;
    if (zone.difficulty && f.difficulty !== zone.difficulty) continue;
    // 還在直播上傳中的 fight 先跳過，report 的 endTime 變了下次會重掃
    if (f.inProgress) continue;
    // 沒有伺服器的是 LimitBreak 之類的假玩家
    const party = (f.friendlyPlayers ?? []).map((id) => actors.get(id)).filter((a) => a?.server);
    const tw = party.filter((a) => TW_SERVERS.has(a.server));
    if (!tw.length) continue;
    const progress = toProgress(report, f, null);
    if (ctx.dedupe.check(f.encounterID, party, progress.at)) {
      ctx.stats.duplicates++;
      continue;
    }
    ctx.stats.fights++;
    if (progress.kill) ctx.stats.kills++;
    for (const a of tw) work.push({ actor: a, encounterId: f.encounterID, progress: { ...progress, job: a.subType } });
  }
  return work;
}

// 掃描某個 zone 在 [start, end] 之間的 reports，回傳範圍內是否全部處理完
async function scanWindow(zone, start, end, ctx) {
  const { reports, complete: listed } = await listReports(zone.id, start, end, ctx.budget);
  const pending = reports.filter((r) => ctx.state.reports[r.code]?.endTime !== r.endTime);
  ctx.stats.listed += reports.length;
  let done = 0;

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const chunk = pending.slice(i, i + BATCH_SIZE);
    if (!ctx.budget.canSpend(chunk.length * COST_PER_REPORT)) break;
    ctx.budget.spend(chunk.length * COST_PER_REPORT);
    const fetched = await fetchReports(chunk.map((r) => r.code));

    for (const [k, report] of fetched.entries()) {
      const listedReport = chunk[k];
      // 拿不到（private / 已刪除）也記下來，免得每次都重抓
      ctx.state.reports[listedReport.code] = { endTime: listedReport.endTime, scannedAt: Date.now() };
      done++;
      if (!report) continue;
      ctx.stats.reports++;
      for (const { actor, encounterId, progress } of processReport(report, zone, ctx)) {
        const player = await ctx.players.get(actor.name, actor.server);
        applyFight(player, encounterId, progress);
        ctx.players.markDirty(player);
      }
    }
  }
  return listed && done === pending.length;
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      since: { type: 'string' },
      'max-points': { type: 'string' },
    },
  });
  const mode = positionals[0] ?? 'scan';
  if (!['scan', 'backfill'].includes(mode)) throw new Error(`不認得的模式：${mode}`);
  if (mode === 'backfill' && !values.since) throw new Error('backfill 需要 --since，例如 --since 2026-07-28');

  const now = Date.now();
  const rate = await getRateLimit();
  const maxPoints = Number(values['max-points'] ?? config.maxPointsPerRun);
  const available = rate.limitPerHour - rate.pointsSpentThisHour - config.reservePoints;
  const budget = new Budget(Math.min(maxPoints, available));
  console.log(
    `額度：本小時已用 ${rate.pointsSpentThisHour.toFixed(1)} / ${rate.limitPerHour}，` +
      `這次最多用 ${Math.max(0, budget.limit).toFixed(0)} 點`
  );
  if (budget.limit <= 0) {
    console.log('額度不夠，這次先跳過');
    return;
  }

  const state = await readJson('state.json', { reports: {}, backfill: {} });
  const ctx = {
    state,
    budget,
    players: new PlayerStore(),
    dedupe: new FightDedupe(await readJson('fights.json', {})),
    stats: { listed: 0, reports: 0, fights: 0, kills: 0, duplicates: 0 },
  };

  for (const zone of config.zones) {
    if (mode === 'scan') {
      const done = await scanWindow(zone, now - config.windowHours * HOUR, now, ctx);
      console.log(`zone ${zone.id} ${zone.name}：${done ? '完成' : '額度用完，下次繼續'}`);
    } else {
      const since = new Date(`${values.since}T00:00:00+08:00`).getTime();
      const progress = (state.backfill[zone.id] ??= { cursor: now - config.windowHours * HOUR });
      // 一天一天往回補，整天處理完才把游標往前推
      while (progress.cursor > since && budget.canSpend(COST_PER_PAGE)) {
        const start = Math.max(since, progress.cursor - DAY);
        if (!(await scanWindow(zone, start, progress.cursor, ctx))) break;
        progress.cursor = start;
      }
      const at = new Date(progress.cursor).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
      console.log(`zone ${zone.id} ${zone.name}：${progress.cursor <= since ? '已補完' : `補到 ${at}`}`);
    }
  }

  // 寫回玩家檔與索引
  const index = await readJson('index.json', { players: {} });
  for (const player of ctx.players.dirtyPlayers) {
    index.players[`${player.name}@${player.server}`] = summarize(player);
  }
  index.generatedAt = now;
  const written = await ctx.players.flush();
  await writeJson('index.json', index);
  await writeJson('encounters.json', buildEncounterList());

  for (const [code, r] of Object.entries(state.reports)) {
    if (r.scannedAt < now - REPORT_TTL) delete state.reports[code];
  }
  ctx.dedupe.prune(now);
  state.lastScanAt = now;
  await writeJson('state.json', state);
  await writeJson('fights.json', ctx.dedupe.entries);

  const after = await getRateLimit();
  const s = ctx.stats;
  console.log(
    `完成：列出 ${s.listed} 份 report，新處理 ${s.reports} 份；` +
      `新增 ${s.fights} 場 fight（通關 ${s.kills}），重複上傳略過 ${s.duplicates} 場；` +
      `更新 ${written} 位玩家，共 ${Object.keys(index.players).length} 位`
  );
  console.log(
    `點數：估計 ${budget.used.toFixed(1)}，實際 ${(after.pointsSpentThisHour - rate.pointsSpentThisHour).toFixed(1)}`
  );
}

function buildEncounterList() {
  return config.zones.flatMap((zone) =>
    Object.entries(zone.encounters).map(([id, name]) => ({
      id: Number(id),
      name,
      zoneId: zone.id,
      category: zone.category,
    }))
  );
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
});
