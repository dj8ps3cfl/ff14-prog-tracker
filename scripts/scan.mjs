// 正式掃描：抓含繁中玩家的公開 reports，把每一場 pull（含滅團）存進 D1
//
// 用法：
//   node scripts/scan.mjs            掃描最近 windowHours 小時
//   node scripts/scan.mjs backfill   往回補歷史資料，補到各 zone 的 backfillSince，額度用完就停，下次接著補
//   node scripts/scan.mjs auto       先掃最近的，剩下的額度拿去補歷史（排程每 30 分鐘跑這個）
// 選項：
//   --since <日期>     backfill 補到哪一天，覆蓋 config 的 backfillSince
//   --max-points <n>   這次最多用多少 FFLogs 點數（預設看 config/tracked.json 的 maxPointsPerRun）
//
// 兩種額度都會控制：FFLogs 每小時的點數，以及 D1 免費方案每天 10 萬列的寫入。
// D1 寫入以「過去 24 小時已寫入列數 + 這次估計寫入」計算，
// 一般掃描最多用到 dailyWriteLimit，補歷史最多用到 backfillWriteLimit，留空間給之後的一般掃描
//
// 同一時間只能有一個掃描在跑：新資料的 id 是程式自己依目前最大值往上配的
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { SERVERS, jobCode, progressRank, serverCode } from '../shared/codes.mjs';
import { executeStatements, info, insertStatements, query, queryIn, sqlValue } from './lib/d1.mjs';
import { getRateLimit, gql } from './lib/fflogs.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 實測的點數花費，用來在送出查詢前估算額度
const COST_PER_PAGE = 1.5;
const COST_PER_REPORT = 2.2;
// 每份 report 大約寫入 D1 多少列（實測約 100，含索引），抓取前用來預留寫入額度
const WRITES_PER_REPORT = 110;
// 一次 GraphQL 查詢合併幾份 report
const BATCH_SIZE = 5;
// 同隊伍、同副本，開打時間差在這個秒數內就當成同一場被重複上傳
const DUPLICATE_WINDOW = 60;

const TW_SERVERS = new Set(SERVERS);
const toSeconds = (ms) => Math.floor(ms / 1000);
const times100 = (v) => (v == null ? null : Math.round(v * 100));

const config = JSON.parse(await readFile(new URL('../config/tracked.json', import.meta.url), 'utf8'));

class Budget {
  constructor(limit, used = 0) {
    this.limit = limit;
    this.used = used;
  }
  canSpend(points) {
    return this.used + points <= this.limit;
  }
  spend(points) {
    this.used += points;
  }
}

// ---------- FFLogs ----------

// FFLogs 的 reports 列表最多只能翻到第 25 頁（每頁 100 份）
const MAX_LIST_PAGES = 25;
// 先切成 12 小時一段來列；舊絕本這種全球熱門的副本，72 小時就有超過 2500 份 report
const LIST_CHUNK = 12 * HOUR;
// 某一段還是翻不完就再切半，切到這個長度還翻不完就放棄那一段
const MIN_LIST_WINDOW = HOUR;

// 停止的原因，scanWindow 和 listReports 都用這些值；null 代表範圍內全部處理完
const STOP_REASONS = {
  points: 'FFLogs 點數用完',
  writes: 'D1 寫入額度用完',
  pages: '列表超過 FFLogs 的頁數上限',
};

// 列出時間範圍內 CN 區的 reports（繁中服的 report 也被標成 CN），新的時段先列
async function listReports(zoneId, start, end, budget) {
  const byCode = new Map();
  for (let chunkEnd = end; chunkEnd > start; chunkEnd -= LIST_CHUNK) {
    const { reports, stop } = await listWindow(zoneId, Math.max(start, chunkEnd - LIST_CHUNK), chunkEnd, budget);
    // 跨時段的 report 可能在相鄰兩段都出現
    for (const r of reports) byCode.set(r.code, r);
    if (stop) return { reports: [...byCode.values()], stop };
  }
  return { reports: [...byCode.values()], stop: null };
}

async function listWindow(zoneId, start, end, budget) {
  const reports = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    if (!budget.canSpend(COST_PER_PAGE)) return { reports, stop: 'points' };
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
    if (!result.has_more_pages) return { reports, stop: null };
  }
  // 翻到頁數上限還有下一頁：這段時間切成兩半重新列
  if (end - start <= MIN_LIST_WINDOW) return { reports, stop: 'pages' };
  const mid = start + Math.floor((end - start) / 2);
  const later = await listWindow(zoneId, mid, end, budget);
  if (later.stop) return later;
  const earlier = await listWindow(zoneId, start, mid, budget);
  return { reports: [...later.reports, ...earlier.reports], stop: earlier.stop };
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
  // 少數 report（例如還在處理中）的 masterData 或 fights 會是 null，當成沒有資料
  const actors = new Map((report.masterData?.actors ?? []).map((a) => [a.id, a]));
  const pulls = [];
  for (const f of report.fights ?? []) {
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

// 把這一批掃描的結果寫進資料庫：新的 pull、角色、摘要，最後才把 report 標成已掃描。
// 回傳估計寫入的列數（有唯一索引或一般索引的表，每列另外多算一列）
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

  // 把 report 標成已掃描放在最後：萬一中途失敗，下次還會重掃
  await executeStatements([
    ...insertStatements('INSERT INTO players (id, name, server)', created),
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
    ...insertStatements('INSERT INTO reports (id, code, start_time, end_time, scanned_at)', newReports),
    ...updatedReports,
  ]);
  ctx.stats.newPlayers += created.length;
  return created.length * 2 + newReports.length * 2 + pullRows.length * 2 + pullPlayerRows.length +
    statRows.length + updatedReports.length;
}

// 掃描某個 zone 在 [start, end] 之間的 reports。全部處理完回傳 null，否則回傳停止原因（STOP_REASONS 的 key）
async function scanWindow(zone, start, end, ctx) {
  const { reports, stop: listStop } = await listReports(zone.id, start, end, ctx.budget);
  ctx.stats.listed += reports.length;
  if (!reports.length) return listStop;

  const known = new Map(
    (await queryIn((list) => `SELECT id, code, end_time FROM reports WHERE code IN (${list})`, reports.map((r) => r.code)))
      .map((r) => [r.code, r])
  );
  const pending = reports.filter((r) => known.get(r.code)?.end_time !== toSeconds(r.endTime));
  const scanned = [];
  const candidates = [];
  let reservedWrites = 0;
  let stop = null;

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const chunk = pending.slice(i, i + BATCH_SIZE);
    const writes = chunk.length * WRITES_PER_REPORT;
    if (!ctx.budget.canSpend(chunk.length * COST_PER_REPORT)) {
      stop = 'points';
      break;
    }
    if (!ctx.writes.canSpend(writes)) {
      stop = 'writes';
      break;
    }
    ctx.budget.spend(chunk.length * COST_PER_REPORT);
    // 先預留寫入額度，寫完再換成實際數字
    ctx.writes.spend(writes);
    reservedWrites += writes;
    const fetched = await fetchReports(chunk.map((r) => r.code));
    for (const [k, report] of fetched.entries()) {
      // 拿不到（private / 已刪除）也記成已掃描，免得每次都重抓
      scanned.push(chunk[k]);
      if (!report) continue;
      ctx.stats.reports++;
      candidates.push(...extractPulls(report, zone));
    }
  }
  if (scanned.length) ctx.writes.spend((await save(candidates, scanned, known, ctx)) - reservedWrites);
  return stop ?? listStop;
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
  if (!['scan', 'backfill', 'auto'].includes(mode)) throw new Error(`不認得的模式：${mode}`);

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
  // D1 的 24 小時統計偶爾會回 0，所以也自己記一份當天（UTC，跟 D1 額度重置時間一樣）的寫入量，取兩者較大的
  const writesKey = `writes:${new Date(now).toISOString().slice(0, 10)}`;
  const { rows_written_24h: reported } = await info();
  const writtenBefore = Math.max(reported ?? 0, Number(meta[writesKey] ?? 0));
  const ctx = {
    budget,
    writes: new Budget(config.dailyWriteLimit, writtenBefore),
    ids: { ...maxIds },
    stats: { listed: 0, reports: 0, pulls: 0, kills: 0, duplicates: 0, newPlayers: 0 },
  };
  console.log(
    `D1 寫入：D1 統計 ${reported ?? '?'} 列、自己記錄 ${meta[writesKey] ?? 0} 列，以 ${writtenBefore} 計；` +
      `上限 ${config.dailyWriteLimit}（補歷史 ${config.backfillWriteLimit}）`
  );

  if (mode !== 'backfill') {
    for (const zone of config.zones) {
      const stop = await scanWindow(zone, now - config.windowHours * HOUR, now, ctx);
      console.log(`[最近] zone ${zone.id} ${zone.name}：${stop ? `${STOP_REASONS[stop]}，下次繼續` : '完成'}`);
    }
  }

  if (mode !== 'scan') {
    // 補歷史只能用到較低的上限，保留寫入額度給之後每 30 分鐘的一般掃描
    ctx.writes.limit = config.backfillWriteLimit;
    // 照 config 的順序一個 zone 補完才補下一個，目前版本的副本優先
    for (const zone of config.zones) {
      const sinceDate = values.since ?? zone.backfillSince;
      if (!sinceDate) continue;
      const since = new Date(`${sinceDate}T00:00:00+08:00`).getTime();
      const key = `backfill:${zone.id}`;
      let cursor = Number(meta[key] ?? now - config.windowHours * HOUR);
      // 一天一天往回補，整天處理完才把游標往前推
      let stop = null;
      while (cursor > since) {
        if (!budget.canSpend(COST_PER_PAGE + BATCH_SIZE * COST_PER_REPORT)) stop = 'points';
        else if (!ctx.writes.canSpend(BATCH_SIZE * WRITES_PER_REPORT)) stop = 'writes';
        else stop = await scanWindow(zone, Math.max(since, cursor - DAY), cursor, ctx);
        if (stop) break;
        cursor = Math.max(since, cursor - DAY);
        await executeStatements([
          `INSERT INTO meta (key, value) VALUES (${sqlValue(key)}, ${sqlValue(String(cursor))})
           ON CONFLICT (key) DO UPDATE SET value = excluded.value;`,
        ]);
        ctx.writes.spend(1);
      }
      const at = new Date(cursor).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
      console.log(
        `[補歷史] zone ${zone.id} ${zone.name}：` +
          (cursor <= since ? `已補完（到 ${sinceDate}）` : `補到 ${at}（${STOP_REASONS[stop]}）`)
      );
      if (cursor > since) break;
    }
  }

  const writtenThisRun = ctx.writes.used - writtenBefore;
  await executeStatements([
    `INSERT INTO meta (key, value) VALUES (${sqlValue(writesKey)}, ${sqlValue(String(writtenThisRun))})
     ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + ${writtenThisRun};`,
    // 舊日期的計數用不到了
    `DELETE FROM meta WHERE key LIKE 'writes:%' AND key < ${sqlValue(`writes:${new Date(now - 2 * DAY).toISOString().slice(0, 10)}`)};`,
  ]);

  const after = await getRateLimit();
  const s = ctx.stats;
  console.log(
    `完成：列出 ${s.listed} 份 report，新處理 ${s.reports} 份；` +
      `新增 ${s.pulls} 場 pull（通關 ${s.kills}），重複上傳略過 ${s.duplicates} 場；新角色 ${s.newPlayers} 位`
  );
  const actual = after.pointsSpentThisHour - rate.pointsSpentThisHour;
  console.log(
    `FFLogs 點數：估計 ${budget.used.toFixed(1)}，` +
      (actual >= 0 ? `實際 ${actual.toFixed(1)}` : '實際用量不明（執行途中 FFLogs 額度重置了）')
  );
  console.log(`D1 寫入：這次約 ${writtenThisRun} 列，合計約 ${ctx.writes.used} 列`);
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
});
