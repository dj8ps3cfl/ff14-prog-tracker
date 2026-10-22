// 正式掃描：抓含繁中玩家的公開 reports，把每一場 pull（含滅團）存進 D1
//
// 用法：
//   node scripts/scan.mjs                         掃描最近 windowHours 小時（排程每 30 分鐘跑這個）
//   node scripts/scan.mjs backfill --since 2026-07-28
//                                                 往回補歷史資料，每次跑到額度用完為止，下次接著補
// 選項：
//   --max-points <n>   這次最多用多少 FFLogs 點數（預設看 config/tracked.json 的 maxPointsPerRun）
//
// 同一時間只能有一個掃描在跑：新資料的 id 是程式自己依目前最大值往上配的
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { SERVERS, jobCode, progressRank, serverCode } from '../shared/codes.mjs';
import { executeStatements, insertStatements, query, queryIn, sqlValue } from './lib/d1.mjs';
import { getRateLimit, gql } from './lib/fflogs.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 實測的點數花費，用來在送出查詢前估算額度
const COST_PER_PAGE = 1.5;
const COST_PER_REPORT = 2.2;
// 一次 GraphQL 查詢合併幾份 report
const BATCH_SIZE = 5;
// 同隊伍、同副本，開打時間差在這個秒數內就當成同一場被重複上傳
const DUPLICATE_WINDOW = 60;

const TW_SERVERS = new Set(SERVERS);
const toSeconds = (ms) => Math.floor(ms / 1000);
const times100 = (v) => (v == null ? null : Math.round(v * 100));

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

// ---------- FFLogs ----------

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
            data { code startTime endTime region { slug } }
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

// ---------- 資料整理 ----------

function partyHash(party) {
  const members = party.map((a) => `${a.name}@${a.server}`).sort().join(',');
  return parseInt(createHash('sha1').update(members).digest('hex').slice(0, 8), 16);
}

// 從 report 挑出要記錄的 pull，並換成資料庫用的精簡格式
function extractPulls(report, zone) {
  const actors = new Map(report.masterData.actors.map((a) => [a.id, a]));
  const pulls = [];
  for (const f of report.fights) {
    if (!(String(f.encounterID) in zone.encounters)) continue;
    if (zone.difficulty && f.difficulty !== zone.difficulty) continue;
    // 還在直播上傳中的 fight 先跳過，report 的 endTime 變了下次會重掃
    if (f.inProgress) continue;
    // 沒有伺服器的是 LimitBreak 之類的假玩家
    const party = (f.friendlyPlayers ?? []).map((id) => actors.get(id)).filter((a) => a?.server);
    // 同一個角色在 masterData 裡可能有兩筆（例如換過職業），只算一次
    const players = new Map();
    for (const a of party) {
      if (TW_SERVERS.has(a.server)) {
        players.set(`${a.name}|${a.server}`, { name: a.name, server: serverCode(a.server), job: jobCode(a.subType) });
      }
    }
    if (!players.size) continue;
    pulls.push({
      code: report.code,
      fight: f.id,
      encounter: f.encounterID,
      start: toSeconds(report.startTime + f.startTime),
      duration: Math.round((f.endTime - f.startTime) / 1000),
      kill: f.kill ? 1 : 0,
      phase: f.lastPhase == null ? null : f.lastPhaseIsIntermission ? -f.lastPhase : f.lastPhase,
      boss: times100(f.bossPercentage),
      pct: times100(f.fightPercentage),
      party: partyHash(party),
      players: [...players.values()],
    });
  }
  return pulls;
}

// 去掉資料庫裡已經有的、以及這批裡彼此重複的 pull
async function dropDuplicates(candidates) {
  if (!candidates.length) return [];
  const starts = candidates.map((c) => c.start);
  const lo = Math.min(...starts) - DUPLICATE_WINDOW;
  const hi = Math.max(...starts) + DUPLICATE_WINDOW;
  const [existing] = await query(
    `SELECT encounter, party, start_time FROM pulls WHERE start_time BETWEEN ${lo} AND ${hi}`
  );
  const seen = new Map();
  const remember = (encounter, party, start) => {
    const key = `${encounter}|${party}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(start);
  };
  for (const e of existing) remember(e.encounter, e.party, e.start_time);

  const fresh = [];
  for (const c of [...candidates].sort((a, b) => a.start - b.start)) {
    const previous = seen.get(`${c.encounter}|${c.party}`) ?? [];
    if (previous.some((s) => Math.abs(s - c.start) <= DUPLICATE_WINDOW)) continue;
    remember(c.encounter, c.party, c.start);
    fresh.push(c);
  }
  return fresh;
}

// 角色名換成 id；資料庫沒有的就配新 id
async function resolvePlayers(pulls, ctx) {
  const wanted = new Map();
  for (const pull of pulls) for (const p of pull.players) wanted.set(`${p.name}|${p.server}`, p);
  const ids = new Map();
  const rows = await queryIn(
    (list) => `SELECT id, name, server FROM players WHERE name IN (${list})`,
    [...new Set([...wanted.values()].map((p) => p.name))]
  );
  for (const r of rows) ids.set(`${r.name}|${r.server}`, r.id);
  const created = [];
  for (const [key, p] of wanted) {
    if (ids.has(key)) continue;
    const id = ++ctx.ids.player;
    ids.set(key, id);
    created.push([id, p.name, p.server]);
  }
  return { ids, created };
}

const STATS_UPSERT = `ON CONFLICT (player_id, encounter) DO UPDATE SET
  pulls = pulls + excluded.pulls,
  kills = kills + excluded.kills,
  first_pull = min(first_pull, excluded.first_pull),
  last_pull = max(last_pull, excluded.last_pull),
  best_pull = CASE WHEN excluded.best_rank < best_rank THEN excluded.best_pull ELSE best_pull END,
  best_rank = min(best_rank, excluded.best_rank),
  first_kill = CASE WHEN excluded.first_kill_at < coalesce(first_kill_at, 9e18) THEN excluded.first_kill ELSE first_kill END,
  first_kill_at = CASE WHEN excluded.first_kill_at < coalesce(first_kill_at, 9e18) THEN excluded.first_kill_at ELSE first_kill_at END`;

// 把這一批掃描的結果寫進資料庫：新的 pull、角色、摘要，最後才把 report 標成已掃描
async function save(candidates, scanned, known, ctx) {
  const pulls = await dropDuplicates(candidates);
  ctx.stats.duplicates += candidates.length - pulls.length;
  const { ids: playerIds, created } = await resolvePlayers(pulls, ctx);

  const reportIds = new Map();
  const newReports = [];
  const updatedReports = [];
  const now = toSeconds(Date.now());
  for (const r of scanned) {
    const existing = known.get(r.code);
    if (existing) {
      reportIds.set(r.code, existing.id);
      updatedReports.push(`UPDATE reports SET end_time = ${sqlValue(toSeconds(r.endTime))}, scanned_at = ${now} WHERE id = ${existing.id};`);
    } else {
      const id = ++ctx.ids.report;
      reportIds.set(r.code, id);
      newReports.push([id, r.code, toSeconds(r.startTime), toSeconds(r.endTime), now]);
    }
  }

  const pullRows = [];
  const pullPlayerRows = [];
  const stats = new Map();
  for (const pull of pulls) {
    const id = ++ctx.ids.pull;
    pullRows.push([id, reportIds.get(pull.code), pull.fight, pull.encounter, pull.start, pull.duration,
      pull.kill, pull.phase, pull.boss, pull.pct, pull.party]);
    const rank = progressRank(pull.kill, pull.pct);
    for (const p of pull.players) {
      const playerId = playerIds.get(`${p.name}|${p.server}`);
      pullPlayerRows.push([playerId, id, p.job]);
      const key = `${playerId}|${pull.encounter}`;
      const s = stats.get(key) ?? {
        playerId, encounter: pull.encounter, pulls: 0, kills: 0,
        first: pull.start, last: pull.start, bestRank: Infinity, bestPull: null, bestAt: null,
        firstKill: null, firstKillAt: null,
      };
      s.pulls++;
      s.kills += pull.kill;
      s.first = Math.min(s.first, pull.start);
      s.last = Math.max(s.last, pull.start);
      if (rank < s.bestRank || (rank === s.bestRank && pull.start < s.bestAt)) {
        s.bestRank = rank;
        s.bestPull = id;
        s.bestAt = pull.start;
      }
      if (pull.kill && (s.firstKillAt === null || pull.start < s.firstKillAt)) {
        s.firstKill = id;
        s.firstKillAt = pull.start;
      }
      stats.set(key, s);
    }
    ctx.stats.pulls++;
    ctx.stats.kills += pull.kill;
  }
  const statRows = [...stats.values()].map((s) => [s.playerId, s.encounter, s.pulls, s.kills, s.first, s.last,
    s.bestRank, s.bestPull, s.firstKill, s.firstKillAt]);

  await executeStatements([
    ...insertStatements('INSERT INTO players (id, name, server)', created),
    ...insertStatements('INSERT INTO reports (id, code, start_time, end_time, scanned_at)', newReports),
    ...insertStatements(
      'INSERT INTO pulls (id, report_id, fight, encounter, start_time, duration, kill, phase, boss, pct, party)',
      pullRows
    ),
    ...insertStatements('INSERT INTO pull_players (player_id, pull_id, job)', pullPlayerRows),
    ...insertStatements(
      'INSERT INTO player_stats (player_id, encounter, pulls, kills, first_pull, last_pull, best_rank, best_pull, first_kill, first_kill_at)',
      statRows,
      STATS_UPSERT
    ),
    ...updatedReports,
  ]);
  ctx.stats.newPlayers += created.length;
}

// 掃描某個 zone 在 [start, end] 之間的 reports，回傳範圍內是否全部處理完
async function scanWindow(zone, start, end, ctx) {
  const { reports, complete: listed } = await listReports(zone.id, start, end, ctx.budget);
  ctx.stats.listed += reports.length;
  if (!reports.length) return listed;

  const known = new Map(
    (await queryIn((list) => `SELECT id, code, end_time FROM reports WHERE code IN (${list})`, reports.map((r) => r.code)))
      .map((r) => [r.code, r])
  );
  const pending = reports.filter((r) => known.get(r.code)?.end_time !== toSeconds(r.endTime));
  const scanned = [];
  const candidates = [];

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const chunk = pending.slice(i, i + BATCH_SIZE);
    if (!ctx.budget.canSpend(chunk.length * COST_PER_REPORT)) break;
    ctx.budget.spend(chunk.length * COST_PER_REPORT);
    const fetched = await fetchReports(chunk.map((r) => r.code));
    for (const [k, report] of fetched.entries()) {
      // 拿不到（private / 已刪除）也記成已掃描，免得每次都重抓
      scanned.push(chunk[k]);
      if (!report) continue;
      ctx.stats.reports++;
      candidates.push(...extractPulls(report, zone));
    }
  }
  if (scanned.length) await save(candidates, scanned, known, ctx);
  return listed && scanned.length === pending.length;
}

// ---------- 進入點 ----------

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
    `FFLogs 額度：本小時已用 ${rate.pointsSpentThisHour.toFixed(1)} / ${rate.limitPerHour}，` +
      `這次最多用 ${Math.max(0, budget.limit).toFixed(0)} 點`
  );
  if (budget.limit <= 0) {
    console.log('額度不夠，這次先跳過');
    return;
  }

  const [[maxIds], metaRows] = await query(
    `SELECT (SELECT coalesce(max(id), 0) FROM players) AS player,
            (SELECT coalesce(max(id), 0) FROM reports) AS report,
            (SELECT coalesce(max(id), 0) FROM pulls) AS pull;
     SELECT key, value FROM meta`
  );
  const meta = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));
  const ctx = {
    budget,
    ids: { ...maxIds },
    stats: { listed: 0, reports: 0, pulls: 0, kills: 0, duplicates: 0, newPlayers: 0 },
  };

  for (const zone of config.zones) {
    if (mode === 'scan') {
      const done = await scanWindow(zone, now - config.windowHours * HOUR, now, ctx);
      console.log(`zone ${zone.id} ${zone.name}：${done ? '完成' : '額度用完，下次繼續'}`);
    } else {
      const since = new Date(`${values.since}T00:00:00+08:00`).getTime();
      const key = `backfill:${zone.id}`;
      let cursor = Number(meta[key] ?? now - config.windowHours * HOUR);
      // 一天一天往回補，整天處理完才把游標往前推
      while (cursor > since && budget.canSpend(COST_PER_PAGE)) {
        const start = Math.max(since, cursor - DAY);
        if (!(await scanWindow(zone, start, cursor, ctx))) break;
        cursor = start;
        await executeStatements([
          `INSERT INTO meta (key, value) VALUES (${sqlValue(key)}, ${sqlValue(String(cursor))})
           ON CONFLICT (key) DO UPDATE SET value = excluded.value;`,
        ]);
      }
      const at = new Date(cursor).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
      console.log(`zone ${zone.id} ${zone.name}：${cursor <= since ? '已補完' : `補到 ${at}`}`);
    }
  }

  const after = await getRateLimit();
  const s = ctx.stats;
  console.log(
    `完成：列出 ${s.listed} 份 report，新處理 ${s.reports} 份；` +
      `新增 ${s.pulls} 場 pull（通關 ${s.kills}），重複上傳略過 ${s.duplicates} 場；新角色 ${s.newPlayers} 位`
  );
  console.log(
    `FFLogs 點數：估計 ${budget.used.toFixed(1)}，實際 ${(after.pointsSpentThisHour - rate.pointsSpentThisHour).toFixed(1)}`
  );
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
});
