// 查詢用的 API：網頁從這裡讀 D1 的資料。全部唯讀，回應會快取 30 分鐘。
// 另外也負責每 30 分鐘觸發 GitHub Actions 的掃描（見 triggerScan）
//
//   GET /encounters                       追蹤中的副本清單
//   GET /search?q=<名字開頭>                搜尋角色（最多 20 筆）
//   GET /player?name=<角色名>&server=<伺服器>  角色的各副本進度與每日進度
//   GET /pulls?player=<id>&encounter=<id>[&before=<上一頁的 next>]
//                                         角色在某副本的每一場 pull，依開打時間新到舊，每頁 100 筆
//   GET /analyze?code=<report code>       團滅分析用：把 FFLogs 上這份 report 的場次與死亡紀錄原樣轉給網頁，
//                                         分析在瀏覽器做（免費方案的 Worker 每次只有 10 毫秒 CPU，解析不了大 report）
import config from '../config/tracked.json';
import { jobName, serverCode, serverName } from '../shared/codes.mjs';

const CACHE_SECONDS = 1800;
const PAGE_SIZE = 100;
const SEARCH_LIMIT = 20;

const ENCOUNTERS = config.zones.flatMap((zone) =>
  Object.entries(zone.encounters).map(([id, name]) => ({ id: Number(id), name, zoneId: zone.id, category: zone.category }))
);
const ENCOUNTER_BY_ID = new Map(ENCOUNTERS.map((e) => [e.id, e]));

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': status === 200 ? `public, max-age=${CACHE_SECONDS}` : 'no-store',
    },
  });

const fightUrl = (code, fight) => `https://www.fflogs.com/reports/${code}#fight=${fight}&type=deaths`;

// 資料庫裡的精簡格式換回好讀的格式
function pullView(row, prefix = '') {
  const get = (k) => row[prefix + k];
  if (get('start_time') == null) return null;
  const phase = get('phase');
  return {
    kill: get('kill') === 1,
    phase: phase == null ? null : Math.abs(phase),
    intermission: phase != null && phase < 0,
    boss: get('boss') == null ? null : get('boss') / 100,
    pct: get('pct') == null ? null : get('pct') / 100,
    at: get('start_time') * 1000,
    duration: get('duration'),
    job: jobName(get('job')),
    url: fightUrl(get('code'), get('fight')),
  };
}

async function search(db, params) {
  const q = (params.get('q') ?? '').trim();
  if (!q || q.length > 30) return json({ error: '請輸入 1～30 個字的角色名' }, 400);
  // 用範圍查詢代替 LIKE，才能用到 (name, server) 的索引
  const { results: players } = await db
    .prepare('SELECT id, name, server FROM players WHERE name >= ?1 AND name < ?2 ORDER BY name LIMIT ?3')
    .bind(q, q + '\u{10FFFF}', SEARCH_LIMIT)
    .all();
  if (!players.length) return json({ players: [] });

  const ids = players.map((p) => p.id);
  const { results: stats } = await db
    .prepare(`SELECT player_id, encounter, pulls, kills, best_rank FROM player_stats
              WHERE player_id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids)
    .all();
  return json({
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      server: serverName(p.server),
      encounters: stats
        .filter((s) => s.player_id === p.id)
        .map((s) => ({
          id: s.encounter,
          pulls: s.pulls,
          kills: s.kills,
          // best_rank：-1 是通關，其餘是 fightPercentage × 100
          bestPct: s.best_rank < 0 ? 0 : s.best_rank / 100,
        })),
    })),
  });
}

async function player(db, params) {
  const name = params.get('name');
  const server = serverCode(params.get('server') ?? '');
  if (!name || !server) return json({ error: '需要 name 和 server（例如 server=鳳凰）' }, 400);
  const p = await db.prepare('SELECT id, name, server FROM players WHERE name = ?1 AND server = ?2').bind(name, server).first();
  if (!p) return json({ error: '找不到這個角色' }, 404);

  const [{ results: stats }, { results: daily }, { results: endings }] = await db.batch([
    db.prepare(`
      SELECT s.encounter, s.pulls, s.kills, s.first_pull, s.last_pull,
             b.kill AS b_kill, b.phase AS b_phase, b.boss AS b_boss, b.pct AS b_pct,
             b.start_time AS b_start_time, b.duration AS b_duration, b.fight AS b_fight,
             br.code AS b_code, bp.job AS b_job,
             k.kill AS k_kill, k.phase AS k_phase, k.boss AS k_boss, k.pct AS k_pct,
             k.start_time AS k_start_time, k.duration AS k_duration, k.fight AS k_fight,
             kr.code AS k_code, kp.job AS k_job
      FROM player_stats s
      JOIN pulls b ON b.id = s.best_pull
      JOIN reports br ON br.id = b.report_id
      LEFT JOIN pull_players bp ON bp.player_id = s.player_id AND bp.pull_id = s.best_pull
      LEFT JOIN pulls k ON k.id = s.first_kill
      LEFT JOIN reports kr ON kr.id = k.report_id
      LEFT JOIN pull_players kp ON kp.player_id = s.player_id AND kp.pull_id = s.first_kill
      WHERE s.player_id = ?1`).bind(p.id),
    // 每天（台北時間）的場數與最佳進度
    db.prepare(`
      SELECT u.encounter, date(u.start_time + 28800, 'unixepoch') AS day,
             count(*) AS pulls, sum(u.kill) AS kills,
             min(CASE WHEN u.kill = 1 THEN -1 ELSE u.pct END) AS best_rank
      FROM pull_players pp JOIN pulls u ON u.id = pp.pull_id
      WHERE pp.player_id = ?1
      GROUP BY u.encounter, day
      ORDER BY u.encounter, day`).bind(p.id),
    // 每個階段結束（滅團或通關）的場數，用來算每個 P 到達幾次
    db.prepare(`
      SELECT u.encounter, abs(u.phase) AS phase, u.kill, count(*) AS n
      FROM pull_players pp JOIN pulls u ON u.id = pp.pull_id
      WHERE pp.player_id = ?1
      GROUP BY u.encounter, abs(u.phase), u.kill`).bind(p.id),
  ]);

  return json({
    player: { id: p.id, name: p.name, server: serverName(p.server) },
    encounters: stats.map((s) => ({
      ...ENCOUNTER_BY_ID.get(s.encounter),
      id: s.encounter,
      pulls: s.pulls,
      kills: s.kills,
      firstPull: s.first_pull * 1000,
      lastPull: s.last_pull * 1000,
      best: pullView(s, 'b_'),
      firstKill: pullView(s, 'k_'),
      daily: daily
        .filter((d) => d.encounter === s.encounter)
        .map((d) => ({ date: d.day, pulls: d.pulls, kills: d.kills, bestPct: d.best_rank < 0 ? 0 : d.best_rank / 100 })),
      phases: phaseStats(endings.filter((e) => e.encounter === s.encounter)),
    })),
  });
}

// 每個 P 到達幾次、在那個 P 滅了幾次。結束在 P3 的那場也算到過 P1、P2。
// 只有一個階段的副本回傳空陣列
function phaseStats(rows) {
  const maxPhase = Math.max(0, ...rows.map((r) => r.phase ?? 0));
  if (maxPhase < 2) return [];
  const phases = [];
  for (let k = 1; k <= maxPhase; k++) {
    phases.push({
      phase: k,
      // 沒有階段資訊的 pull 當成只到過 P1
      reached: rows.filter((r) => Math.max(1, r.phase ?? 1) >= k).reduce((sum, r) => sum + r.n, 0),
      wiped: rows.filter((r) => !r.kill && Math.max(1, r.phase ?? 1) === k).reduce((sum, r) => sum + r.n, 0),
    });
  }
  return phases;
}

async function pulls(db, params) {
  const playerId = Number(params.get('player'));
  const encounter = Number(params.get('encounter'));
  if (!playerId || !encounter) return json({ error: '需要 player 和 encounter' }, 400);
  // 分頁游標是上一頁最後一筆的「開打時間:pull id」，同一秒開打的也不會漏掉
  const [beforeTime, beforeId] = (params.get('before') ?? '').split(':').map(Number);
  const cursorTime = beforeTime || Number.MAX_SAFE_INTEGER;
  const cursorId = beforeId || Number.MAX_SAFE_INTEGER;
  const { results } = await db
    .prepare(`
      SELECT u.id, u.kill, u.phase, u.boss, u.pct, u.start_time, u.duration, u.fight, r.code, pp.job
      FROM pull_players pp
      JOIN pulls u ON u.id = pp.pull_id
      JOIN reports r ON r.id = u.report_id
      WHERE pp.player_id = ?1 AND u.encounter = ?2
        AND (u.start_time < ?3 OR (u.start_time = ?3 AND u.id < ?4))
      ORDER BY u.start_time DESC, u.id DESC
      LIMIT ?5`)
    .bind(playerId, encounter, cursorTime, cursorId, PAGE_SIZE)
    .all();
  const last = results.at(-1);
  return json({
    pulls: results.map((r) => ({ id: r.id, ...pullView(r) })),
    next: results.length === PAGE_SIZE ? `${last.start_time}:${last.id}` : null,
  });
}

// ---------- 團滅分析（轉送 FFLogs） ----------

const FFLOGS_TOKEN_URL = 'https://www.fflogs.com/oauth/token';
const FFLOGS_API_URL = 'https://www.fflogs.com/api/v2/client';
const REPORT_CODE = /^[A-Za-z0-9]{16}$/;
// 跟掃描排程共用 FFLogs 每小時 1000 點的額度；本小時已用超過這個數字就先不分析，免得撞到 FFLogs 的上限
const ANALYZE_POINTS_CEILING = 940;
// 同一份 report 15 分鐘內再分析就用快取，不再花點數（直播上傳中的 report 也會在 15 分鐘後更新）
const ANALYZE_CACHE_SECONDS = 900;

// 一次查詢拿齊：場次、階段切換時間、整份 report 的死亡紀錄（translate: false 才會是台服的中文 Boss 名和技能名）
const ANALYZE_QUERY = `query ($code: String) {
  reportData {
    report(code: $code) {
      code title startTime endTime
      zone { name }
      fights(killType: Encounters, translate: false) {
        id encounterID name kill lastPhase lastPhaseIsIntermission bossPercentage fightPercentage
        startTime endTime phaseTransitions { id startTime }
      }
      table(dataType: Deaths, killType: Encounters, startTime: 0, endTime: 100000000000, translate: false)
    }
  }
}`;

// client credentials 的 token 有效一年，同一個 Worker 執行個體裡重複使用
let fflogsToken = null;

async function getFflogsToken(env) {
  if (fflogsToken && fflogsToken.expiresAt > Date.now() + 60_000) return fflogsToken.value;
  const res = await fetch(FFLOGS_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.FFLOGS_CLIENT_ID}:${env.FFLOGS_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`取得 FFLogs token 失敗：HTTP ${res.status}`);
  const body = await res.json();
  fflogsToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return fflogsToken.value;
}

async function fflogsRequest(env, query, variables = {}) {
  return fetch(FFLOGS_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getFflogsToken(env)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
}

async function analyze(db, params, env) {
  const code = params.get('code') ?? '';
  if (!REPORT_CODE.test(code)) return json({ error: 'report 代碼格式不對，應該是 16 個英數字' }, 400);
  if (!env.FFLOGS_CLIENT_ID || !env.FFLOGS_CLIENT_SECRET) return json({ error: '伺服器還沒設定 FFLogs 金鑰' }, 500);

  const rate = await (await fflogsRequest(env, '{ rateLimitData { pointsSpentThisHour pointsResetIn } }')).json();
  const { pointsSpentThisHour, pointsResetIn } = rate.data?.rateLimitData ?? {};
  if (pointsSpentThisHour > ANALYZE_POINTS_CEILING) {
    return json({ error: `FFLogs 這個小時的查詢額度快用完了，請 ${Math.ceil(pointsResetIn / 60)} 分鐘後再試` }, 429);
  }

  const res = await fflogsRequest(env, ANALYZE_QUERY, { code });
  if (!res.ok) return json({ error: `FFLogs 回應錯誤：HTTP ${res.status}` }, 502);
  // 不解析，直接轉送；report 不存在或是 private 時，網頁會從回應內容判斷
  return new Response(res.body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': `public, max-age=${ANALYZE_CACHE_SECONDS}`,
    },
  });
}

const ROUTES = {
  '/analyze': analyze,
  '/encounters': async () => json({ encounters: ENCOUNTERS }),
  '/search': search,
  '/player': player,
  '/pulls': pulls,
};

// GitHub 自己的排程不準時（新 repo 常常完全不觸發），改由 Cloudflare Cron Trigger 每 30 分鐘
// 呼叫 GitHub API 觸發掃描。GITHUB_TOKEN 是只有這個 repo「Actions: Read and write」權限的 token
const SCAN_WORKFLOW_URL =
  'https://api.github.com/repos/dj8ps3cfl/ff14-prog-tracker/actions/workflows/scan.yml/dispatches';

async function triggerScan(env) {
  if (!env.GITHUB_TOKEN) {
    console.error('沒有設定 GITHUB_TOKEN，無法觸發掃描');
    return;
  }
  const res = await fetch(SCAN_WORKFLOW_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ff14-prog-api',
    },
    body: JSON.stringify({ ref: 'master' }),
  });
  if (res.status !== 204) console.error(`觸發掃描失敗：HTTP ${res.status} ${await res.text()}`);
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(triggerScan(env));
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' },
      });
    }
    if (request.method !== 'GET') return json({ error: '只支援 GET' }, 405);

    const url = new URL(request.url);
    const handler = ROUTES[url.pathname];
    if (!handler) return json({ error: '沒有這個路徑' }, 404);

    // 本機開發（npm run dev 會帶 NO_CACHE）時不快取，改了程式馬上看得到
    const cache = env.NO_CACHE ? null : caches.default;
    const cached = await cache?.match(request);
    if (cached) return cached;

    let response;
    try {
      response = await handler(env.DB, url.searchParams, env);
    } catch (err) {
      console.error(err);
      return json({ error: '伺服器錯誤' }, 500);
    }
    if (cache && response.status === 200) ctx.waitUntil(cache.put(request, response.clone()));
    if (env.NO_CACHE) response.headers.set('Cache-Control', 'no-store');
    return response;
  },
};
