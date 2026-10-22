// 查詢用的 API：網頁從這裡讀 D1 的資料。全部唯讀，回應會快取 30 分鐘
//
//   GET /encounters                       追蹤中的副本清單
//   GET /search?q=<名字開頭>                搜尋角色（最多 20 筆）
//   GET /player?name=<角色名>&server=<伺服器>  角色的各副本進度與每日進度
//   GET /pulls?player=<id>&encounter=<id>[&before=<上一頁的 next>]
//                                         角色在某副本的每一場 pull，依開打時間新到舊，每頁 100 筆
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

  const [{ results: stats }, { results: daily }] = await db.batch([
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
    })),
  });
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

const ROUTES = {
  '/encounters': async () => json({ encounters: ENCOUNTERS }),
  '/search': search,
  '/player': player,
  '/pulls': pulls,
};

export default {
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
      response = await handler(env.DB, url.searchParams);
    } catch (err) {
      console.error(err);
      return json({ error: '伺服器錯誤' }, 500);
    }
    if (cache && response.status === 200) ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  },
};
