// FFLogs API 實測腳本：確認繁中服的資料抓不抓得到，尤其是未通關（滅團）的 fight
//
// 實測得知：FFLogs 沒有繁中區，也沒有繁中伺服器 / 角色資料，所以無法用角色名查詢。
// 繁中服的 report 被標成 CN 區，只能從參戰者的伺服器名稱（鳳凰、奧汀…）辨認出繁中玩家。
//
// 用法：
//   node scripts/probe.mjs                            全部跑一次：token、額度、掃描、展開 report
//   node scripts/probe.mjs zones                      列出所有 zone / encounter 的 ID
//   node scripts/probe.mjs reports [小時] [zoneID]     掃描近期含繁中玩家的 reports（預設 72 小時、zone 68）
//   node scripts/probe.mjs report <code> [zoneID]     看單一 report 的每一場 fight
//   node scripts/probe.mjs player <角色名> <伺服器> [小時] [zoneID]  在近期 reports 裡找某角色的進度
import { fightUrl, getToken, gql } from './lib/fflogs.mjs';

// 零式 M5S～M8S（AAC Cruiserweight）所在的 zone
const DEFAULT_ZONE_ID = 68;
const DEFAULT_HOURS = 72;
const TW_SERVERS = new Set(['伊弗利特', '迦樓羅', '利維坦', '鳳凰', '奧汀', '巴哈姆特', '拉姆', '泰坦']);
// 最多翻幾頁 reports（每頁 100 份）。檢查參戰者每份約 1 點，翻太多頁會吃掉不少額度
const MAX_PAGES = 2;
// 一次 GraphQL 查詢裡合併幾份 report
const BATCH_SIZE = 10;
// 預設展開幾份 report 的 fights
const MAX_REPORT_DETAILS = 3;

const fmtTime = (ms) =>
  new Date(ms).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function progressLabel(fight) {
  if (fight.kill) return '通關';
  const phase = fight.lastPhase
    ? `P${fight.lastPhase}${fight.lastPhaseIsIntermission ? ' 轉場' : ''}`
    : null;
  const hp = fight.bossPercentage != null ? `${fight.bossPercentage.toFixed(1)}%` : null;
  return [phase, hp].filter(Boolean).join(' · ') || '滅團';
}

// 進度比較：通關最好，其次 fightPercentage 越低代表打得越遠
function isFurther(a, b) {
  if (!b) return true;
  if (a.kill !== b.kill) return a.kill;
  return (a.fightPercentage ?? 100) < (b.fightPercentage ?? 100);
}

const isTwPlayer = (actor) => TW_SERVERS.has(actor.server);

async function step(title, fn) {
  console.log(`\n=== ${title} ===`);
  try {
    return (await fn()) ?? true;
  } catch (err) {
    console.log(`✗ ${err.message}`);
    return undefined;
  }
}

// ---------- 查詢 ----------

async function pointsSpent() {
  const { rateLimitData } = await gql('{ rateLimitData { pointsSpentThisHour } }');
  return rateLimitData.pointsSpentThisHour;
}

async function checkToken() {
  const token = await getToken();
  const days = Math.round((token.expires_at - Date.now()) / 86_400_000);
  console.log(`✓ 取得 token${token.fromCache ? '（使用快取）' : ''}，約 ${days} 天後到期`);
}

async function checkRateLimit() {
  const { rateLimitData: r } = await gql(
    '{ rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn } }'
  );
  console.log(
    `✓ 每小時額度 ${r.limitPerHour} 點，本小時已用 ${r.pointsSpentThisHour.toFixed(1)} 點，` +
      `${Math.round(r.pointsResetIn / 60)} 分鐘後重置`
  );
}

async function listZones() {
  const { worldData } = await gql(`{
    worldData { expansions { id name zones { id name encounters { id name } } } }
  }`);
  for (const exp of worldData.expansions) {
    console.log(`\n[${exp.id}] ${exp.name}`);
    for (const z of exp.zones) {
      const encounters = z.encounters.map((e) => `${e.name}(${e.id})`).join('、');
      console.log(`  zone ${z.id}  ${z.name}：${encounters}`);
    }
  }
}

async function fetchZone(zoneID) {
  const { worldData } = await gql(
    'query ($id: Int) { worldData { zone(id: $id) { id name encounters { id name } } } }',
    { id: zoneID }
  );
  if (!worldData.zone) throw new Error(`找不到 zone ${zoneID}`);
  return worldData.zone;
}

// 列出時間範圍內 CN 區的 report code（繁中服的 report 也在這裡面）
async function listCnReports(hours, zoneID) {
  const end = Date.now();
  const start = end - hours * 3_600_000;
  const reports = [];
  let page = 1;
  let more = true;
  while (more && page <= MAX_PAGES) {
    const { reportData } = await gql(
      `query ($zoneID: Int, $start: Float, $end: Float, $page: Int) {
        reportData {
          reports(zoneID: $zoneID, startTime: $start, endTime: $end, limit: 100, page: $page) {
            has_more_pages
            data { code title startTime region { slug } }
          }
        }
      }`,
      { zoneID, start, end, page }
    );
    const result = reportData.reports;
    reports.push(...result.data.filter((r) => r.region?.slug === 'CN'));
    more = result.has_more_pages;
    page++;
  }
  return { reports, truncated: more };
}

// 把多份 report 合併成一次查詢，只拿參戰者，用來判斷有沒有繁中玩家
async function filterTwReports(reports) {
  const tw = [];
  for (let i = 0; i < reports.length; i += BATCH_SIZE) {
    const chunk = reports.slice(i, i + BATCH_SIZE);
    const fields = chunk
      .map((r, k) => `r${k}: report(code: "${r.code}") { masterData { actors(type: "Player") { name server } } }`)
      .join('\n');
    const { reportData } = await gql(`{ reportData { ${fields} } }`);
    chunk.forEach((r, k) => {
      const actors = reportData[`r${k}`]?.masterData?.actors ?? [];
      const twPlayers = actors.filter(isTwPlayer);
      if (twPlayers.length) tw.push({ ...r, twPlayers });
    });
  }
  return tw;
}

async function scanReports(hours, zoneID) {
  const p0 = await pointsSpent();
  const { reports, truncated } = await listCnReports(hours, zoneID);
  const p1 = await pointsSpent();
  const tw = await filterTwReports(reports);
  const p2 = await pointsSpent();
  console.log(
    `✓ 近 ${hours} 小時 zone ${zoneID}：CN 區 ${reports.length} 份` +
      `${truncated ? `（只翻了 ${MAX_PAGES} 頁，還有更多）` : ''}，其中含繁中玩家 ${tw.length} 份`
  );
  console.log(
    `  花費：列表 ${(p1 - p0).toFixed(1)} 點，檢查參戰者 ${(p2 - p1).toFixed(1)} 點` +
      `（每份約 ${reports.length ? ((p2 - p1) / reports.length).toFixed(2) : 0} 點）`
  );
  for (const r of tw.slice(0, 10)) {
    console.log(`  ${r.code}  ${fmtTime(r.startTime)}  繁中玩家 ${r.twPlayers.length} 人  ${r.title}`);
  }
  if (tw.length > 10) console.log(`  …還有 ${tw.length - 10} 份`);
  return tw;
}

async function fetchReport(code) {
  const { reportData } = await gql(
    `query ($code: String) {
      reportData {
        report(code: $code) {
          code title startTime
          fights(killType: Encounters) {
            id encounterID name difficulty kill
            bossPercentage fightPercentage lastPhase lastPhaseIsIntermission
            startTime endTime friendlyPlayers
          }
          masterData { actors(type: "Player") { id name server subType } }
        }
      }
    }`,
    { code }
  );
  if (!reportData.report) throw new Error(`找不到 report ${code}（可能是 private 或已刪除）`);
  return reportData.report;
}

// 印出 report 裡屬於該 zone 的 fight，以及每個繁中玩家的最佳進度
function printReport(report, zone, onlyPlayer) {
  const encounterIds = new Set(zone.encounters.map((e) => e.id));
  // LimitBreak 之類的假玩家沒有伺服器，isTwPlayer 會把它們排除
  const actors = new Map(report.masterData.actors.filter(isTwPlayer).map((a) => [a.id, a]));
  const isTarget = (p) => !onlyPlayer || (p.name === onlyPlayer.name && p.server === onlyPlayer.server);

  const fights = report.fights.filter((f) => {
    if (!encounterIds.has(f.encounterID)) return false;
    const players = (f.friendlyPlayers ?? []).map((id) => actors.get(id)).filter(Boolean);
    return players.some(isTarget);
  });
  const kills = fights.filter((f) => f.kill).length;
  console.log(
    `\n[${report.code}] ${report.title}（${fmtTime(report.startTime)}）` +
      `：${zone.name} ${fights.length} 場，通關 ${kills}、滅團 ${fights.length - kills}` +
      `（report 共 ${report.fights.length} 場）`
  );

  const best = new Map();
  for (const f of fights) {
    console.log(
      `  #${String(f.id).padEnd(3)} ${f.name.padEnd(18)} ${progressLabel(f).padEnd(14)} ` +
        `${fmtDuration(f.endTime - f.startTime).padStart(6)}  ${fightUrl(report.code, f.id)}`
    );
    for (const id of f.friendlyPlayers ?? []) {
      const p = actors.get(id);
      if (!p || !isTarget(p)) continue;
      const key = `${p.name}@${p.server}|${f.encounterID}`;
      if (isFurther(f, best.get(key)?.fight)) best.set(key, { player: p, fight: f });
    }
  }

  if (best.size) {
    console.log('  ── 繁中玩家最佳進度 ──');
    for (const { player, fight } of best.values()) {
      console.log(
        `  ${`${player.name}@${player.server}`.padEnd(16)} ${player.subType.padEnd(12)} ` +
          `${fight.name}：${progressLabel(fight)}（#${fight.id}）`
      );
    }
  }
}

async function showReports(codes, zone, onlyPlayer) {
  for (const code of codes) {
    const p0 = await pointsSpent();
    printReport(await fetchReport(code), zone, onlyPlayer);
    console.log(`  （展開這份 report 花了 ${((await pointsSpent()) - p0).toFixed(1)} 點）`);
  }
}

// ---------- 進入點 ----------

async function main() {
  const [command = 'all', ...args] = process.argv.slice(2);

  switch (command) {
    case 'all': {
      // 拿不到 token 後面都不用跑了
      if (!(await step('1. 取得 token', checkToken))) {
        process.exitCode = 1;
        return;
      }
      await step('2. API 額度', checkRateLimit);
      const zone = await step(`3. 讀取 zone ${DEFAULT_ZONE_ID}`, async () => {
        const z = await fetchZone(DEFAULT_ZONE_ID);
        console.log(`✓ ${z.name}：${z.encounters.map((e) => `${e.name}(${e.id})`).join('、')}`);
        return z;
      });
      const reports = await step(`4. 掃描近 ${DEFAULT_HOURS} 小時含繁中玩家的 reports`, () =>
        scanReports(DEFAULT_HOURS, DEFAULT_ZONE_ID)
      );
      if (zone && reports?.length) {
        await step(`5. 展開前 ${MAX_REPORT_DETAILS} 份 report 的 fights`, () =>
          showReports(reports.slice(0, MAX_REPORT_DETAILS).map((r) => r.code), zone)
        );
      }
      await step('6. 跑完後的額度', checkRateLimit);
      break;
    }
    case 'zones':
      await step('zone / encounter 列表', listZones);
      break;
    case 'reports': {
      const hours = Number(args[0] ?? DEFAULT_HOURS);
      const zoneID = Number(args[1] ?? DEFAULT_ZONE_ID);
      await step(`掃描近 ${hours} 小時 zone ${zoneID} 含繁中玩家的 reports`, () =>
        scanReports(hours, zoneID)
      );
      break;
    }
    case 'report': {
      if (!args[0]) throw new Error('用法：node scripts/probe.mjs report <code> [zoneID]');
      const zone = await fetchZone(Number(args[1] ?? DEFAULT_ZONE_ID));
      await step(`report ${args[0]}`, () => showReports([args[0]], zone));
      break;
    }
    case 'player': {
      if (args.length < 2) throw new Error('用法：node scripts/probe.mjs player <角色名> <伺服器> [小時] [zoneID]');
      const [name, server] = args;
      const hours = Number(args[2] ?? DEFAULT_HOURS);
      const zone = await fetchZone(Number(args[3] ?? DEFAULT_ZONE_ID));
      await step(`在近 ${hours} 小時的 reports 裡找 ${name}@${server}`, async () => {
        const reports = await scanReports(hours, zone.id);
        const mine = reports.filter((r) => r.twPlayers.some((p) => p.name === name && p.server === server));
        console.log(`✓ ${name}@${server} 出現在 ${mine.length} 份 report`);
        await showReports(mine.slice(0, MAX_REPORT_DETAILS).map((r) => r.code), zone, { name, server });
      });
      break;
    }
    default:
      throw new Error(`不認得的指令：${command}`);
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
});
