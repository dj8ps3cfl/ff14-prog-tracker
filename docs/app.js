// 開荒進度網頁：搜尋角色、角色頁（各副本進度、開荒曲線、每一場 pull）
// 網址格式：#/ 首頁，#/p/<伺服器>/<角色名> 角色頁

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const API_BASE = LOCAL ? 'http://127.0.0.1:8811' : 'https://ff14-prog-api.dj8ps3cfl.workers.dev';

const RECENT_KEY = 'recent-players';
const RECENT_LIMIT = 8;
const SEARCH_DELAY = 250;

// FFLogs 職業名 → 縮寫與職能
const JOBS = {
  Paladin: ['PLD', 'tank'], Warrior: ['WAR', 'tank'], DarkKnight: ['DRK', 'tank'], Gunbreaker: ['GNB', 'tank'],
  WhiteMage: ['WHM', 'healer'], Scholar: ['SCH', 'healer'], Astrologian: ['AST', 'healer'], Sage: ['SGE', 'healer'],
  Monk: ['MNK', 'dps'], Dragoon: ['DRG', 'dps'], Ninja: ['NIN', 'dps'], Samurai: ['SAM', 'dps'],
  Reaper: ['RPR', 'dps'], Viper: ['VPR', 'dps'], Bard: ['BRD', 'dps'], Machinist: ['MCH', 'dps'],
  Dancer: ['DNC', 'dps'], BlackMage: ['BLM', 'dps'], Summoner: ['SMN', 'dps'], RedMage: ['RDM', 'dps'],
  Pictomancer: ['PCT', 'dps'], BlueMage: ['BLU', 'dps'],
};

const app = document.getElementById('app');
let encounters = [];
let renderToken = 0;

// ---------- 工具 ----------

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path) {
  const res = await fetch(API_BASE + path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body;
}

const dateFmt = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const fmtDate = (ms) => dateFmt.format(ms);
const fmtDateTime = (ms) => dateTimeFmt.format(ms);
const fmtDuration = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const fmtPct = (v) => `${v.toFixed(1)}%`;

const playerHash = (server, name) => `#/p/${encodeURIComponent(server)}/${encodeURIComponent(name)}`;

// 進度描述，例如「通關」、「P2 · Boss 剩 42.6%」
function progressLabel(p) {
  if (p.kill) return '通關';
  const parts = [];
  if (p.phase) parts.push(`P${p.phase}${p.intermission ? ' 轉場' : ''}`);
  if (p.boss != null) parts.push(`Boss 剩 ${fmtPct(p.boss)}`);
  return parts.join(' · ') || '滅團';
}

// fightPercentage 是「還剩多少」，進度條要顯示「打了多少」
const progressWidth = (p) => (p.kill ? 100 : Math.max(2, 100 - (p.pct ?? 100)));

const shortName = (e) => (e.category === '零式' ? e.name.split(' ')[0] : e.name);

function jobBadge(job) {
  const [abbr, role] = JOBS[job] ?? [job ?? '?', ''];
  return `<span class="job ${role}" title="${escapeHtml(job ?? '')}">${escapeHtml(abbr)}</span>`;
}

// ---------- 最近查看（只存在這個瀏覽器） ----------

function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) ?? [];
  } catch {
    return [];
  }
}

function saveRecent(player) {
  try {
    const list = loadRecent().filter((p) => !(p.name === player.name && p.server === player.server));
    list.unshift({ name: player.name, server: player.server });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_LIMIT)));
  } catch {
    // 無痕模式等情況存不了，不影響使用
  }
}

// ---------- 首頁與搜尋 ----------

function renderHome(query = '') {
  const recent = loadRecent();
  app.innerHTML = `
    <section class="hero">
      <h1>你練到哪裡了？</h1>
      <p>查詢繁中服角色在零式和絕本的開荒進度。沒通關的紀錄也算，每一場都能連到 FFLogs 看死亡紀錄。</p>
      <form class="hero-search" id="hero-search" role="search">
        <input type="search" name="q" placeholder="輸入角色名，例如：乾太" autocomplete="off" aria-label="角色名" value="${escapeHtml(query)}" />
      </form>
    </section>
    <div id="results"></div>
    ${recent.length ? `
      <h2 class="section-title">最近查看</h2>
      <div class="recent">
        ${recent.map((p) => `<a href="${playerHash(p.server, p.name)}">${escapeHtml(p.name)}<span class="result-server"> · ${escapeHtml(p.server)}</span></a>`).join('')}
      </div>` : ''}
  `;
  const input = app.querySelector('#hero-search input');
  bindSearch(app.querySelector('#hero-search'), input);
  if (query) runSearch(query);
  else input.focus();
}

let searchTimer;
let searchSeq = 0;

function bindSearch(form, input) {
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(input.value), SEARCH_DELAY);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(searchTimer);
    runSearch(input.value);
  });
}

async function runSearch(raw) {
  const q = raw.trim();
  const box = document.getElementById('results');
  if (!box) return;
  if (!q) {
    box.innerHTML = '';
    return;
  }
  const seq = ++searchSeq;
  try {
    const { players } = await api(`/search?q=${encodeURIComponent(q)}`);
    if (seq !== searchSeq) return;
    box.innerHTML = players.length
      ? `<h2 class="section-title">搜尋結果</h2><ul class="result-list">${players.map(resultItem).join('')}</ul>`
      : `<p class="notice">找不到名字以「${escapeHtml(q)}」開頭的角色。<br />只收錄出現在公開 FFLogs report 裡的繁中服角色。</p>`;
  } catch (err) {
    if (seq === searchSeq) box.innerHTML = `<p class="notice error">搜尋失敗：${escapeHtml(err.message)}</p>`;
  }
}

function resultItem(p) {
  const byId = new Map(p.encounters.map((e) => [e.id, e]));
  const chips = encounters
    .filter((e) => byId.has(e.id))
    .map((e) => {
      const s = byId.get(e.id);
      const kill = s.kills > 0;
      // bestPct 是整場戰鬥還剩多少（不是 Boss 血量），換成「打了多少」跟進度條一致
      const label = kill ? '通關' : `進度 ${Math.floor(100 - s.bestPct)}%`;
      return `<span class="chip ${kill ? 'kill' : ''}">${escapeHtml(shortName(e))} ${label}</span>`;
    })
    .join('');
  return `
    <li>
      <a class="result" href="${playerHash(p.server, p.name)}">
        <span class="result-name">${escapeHtml(p.name)}</span>
        <span class="result-server">${escapeHtml(p.server)}</span>
        <span class="result-chips">${chips}</span>
      </a>
    </li>`;
}

// ---------- 角色頁 ----------

async function renderPlayer(server, name, token) {
  app.innerHTML = '<p class="notice">讀取中…</p>';
  let data;
  try {
    data = await api(`/player?name=${encodeURIComponent(name)}&server=${encodeURIComponent(server)}`);
  } catch (err) {
    if (token !== renderToken) return;
    app.innerHTML =
      err.status === 404
        ? `<p class="notice">找不到 ${escapeHtml(name)}（${escapeHtml(server)}）。<br />只收錄出現在公開 FFLogs report 裡的繁中服角色。</p>`
        : `<p class="notice error">讀取失敗：${escapeHtml(err.message)}</p>`;
    return;
  }
  if (token !== renderToken) return;
  saveRecent(data.player);
  document.title = `${data.player.name}（${data.player.server}）| 開荒進度`;

  // 照副本清單的順序排，並依分類分組
  const order = new Map(encounters.map((e, i) => [e.id, i]));
  const list = [...data.encounters].sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
  const totalPulls = list.reduce((sum, e) => sum + e.pulls, 0);
  const groups = [];
  for (const e of list) {
    const category = e.category ?? '其他';
    let g = groups.find((x) => x.category === category);
    if (!g) groups.push((g = { category, items: [] }));
    g.items.push(e);
  }

  app.innerHTML = `
    <div class="player-head">
      <h1>${escapeHtml(data.player.name)}</h1>
      <span class="server">${escapeHtml(data.player.server)}</span>
    </div>
    <p class="player-summary">${list.length} 個副本有紀錄 · 共 ${totalPulls} 場 pull</p>
    ${groups.map((g) => `
      <h2 class="section-title">${escapeHtml(g.category)}</h2>
      <div class="enc-grid">${g.items.map((e) => encounterCard(e, data.player.id)).join('')}</div>
    `).join('')}
  `;
  app.querySelectorAll('[data-pulls]').forEach((btn) => btn.addEventListener('click', () => togglePulls(btn)));
}

function encounterCard(e, playerId) {
  const kill = e.kills > 0;
  const best = e.best;
  const facts = [
    ['場數', e.pulls],
    ['開荒天數', e.daily.length],
    ['首次 pull', fmtDate(e.firstPull)],
    kill ? ['首次通關', `<a href="${escapeHtml(e.firstKill.url)}" target="_blank" rel="noopener">${fmtDate(e.firstKill.at)}</a>`] : ['最近 pull', fmtDate(e.lastPull)],
  ];
  if (kill) facts.splice(1, 0, ['通關次數', e.kills]);

  return `
    <article class="enc">
      <div class="enc-head">
        <h3>${escapeHtml(e.name ?? `副本 ${e.id}`)}</h3>
        <span class="status ${kill ? 'kill' : ''}">${escapeHtml(progressLabel(best))}</span>
      </div>
      <div class="bar ${kill ? 'kill' : ''}" role="img" aria-label="進度 ${progressWidth(best).toFixed(0)}%" title="整場戰鬥進度 ${progressWidth(best).toFixed(0)}%">
        <span style="width:${progressWidth(best)}%"></span>
      </div>
      <dl class="facts">
        ${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}
      </dl>
      ${phaseChart(e)}
      ${progressChart(e.daily)}
      <div class="enc-actions">
        <a href="${escapeHtml(best.url)}" target="_blank" rel="noopener">${kill ? '通關那場' : '最佳一場'}的死亡紀錄 ↗</a>
        <button class="btn" type="button" data-pulls data-player="${playerId}" data-encounter="${e.id}">所有 pull（${e.pulls}）</button>
      </div>
      <div class="pulls" hidden></div>
    </article>`;
}

// 各階段到達次數的橫條圖，長度是佔總場數的比例
function phaseChart(e) {
  if (!e.phases?.length) return '';
  // wiped 是 null 代表「通關」那一列
  const row = (label, count, wiped) => {
    const note = wiped === null ? `通關 ${count} 次` : `到達 ${label} ${count} 次，在這裡滅團 ${wiped} 次`;
    return `
      <div class="phase-row ${wiped === null ? 'kill' : ''}" title="${escapeHtml(note)}">
        <span class="phase-label">${label}</span>
        <span class="phase-bar"><span style="width:${count ? Math.max(1, (count / e.pulls) * 100) : 0}%"></span></span>
        <span class="phase-num">${count} 次${wiped === null ? '' : `<span class="phase-wiped"> · 滅 ${wiped}</span>`}</span>
      </div>`;
  };
  return `
    <div class="phases">
      <div class="chart-title">各階段到達次數</div>
      ${e.phases.map((p) => row(`P${p.phase}`, p.reached, p.wiped)).join('')}
      ${row('通關', e.kills, null)}
    </div>`;
}

// 每日最佳進度的折線圖，橫軸依實際日期間隔
function progressChart(daily) {
  if (daily.length < 2) return '';
  // 寬度接近卡片實際寬度，座標文字才不會被縮得太小
  const W = 400;
  const H = 110;
  const pad = { l: 34, r: 8, t: 8, b: 20 };
  const day = (d) => Date.parse(`${d}T00:00:00+08:00`);
  const t0 = day(daily[0].date);
  const span = Math.max(1, day(daily.at(-1).date) - t0);
  const x = (d) => pad.l + ((day(d) - t0) / span) * (W - pad.l - pad.r);
  const y = (progress) => pad.t + (1 - progress / 100) * (H - pad.t - pad.b);
  const pts = daily.map((d) => ({ ...d, progress: d.kills > 0 ? 100 : 100 - d.bestPct }));

  const grid = [0, 50, 100]
    .map((v) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" /><text class="axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`)
    .join('');
  const line = pts.map((p) => `${x(p.date).toFixed(1)},${y(p.progress).toFixed(1)}`).join(' ');
  const dots = pts
    .map((p) => {
      const label = p.kills > 0 ? `通關 ${p.kills} 次` : `最佳進度 ${p.progress.toFixed(1)}%`;
      return `<circle class="dot ${p.kills > 0 ? 'kill' : ''}" cx="${x(p.date).toFixed(1)}" cy="${y(p.progress).toFixed(1)}" r="4"><title>${p.date.slice(5)}：${p.pulls} 場，${label}</title></circle>`;
    })
    .join('');
  const labels = [pts[0], pts.at(-1)]
    .map((p, i) => `<text class="axis" x="${x(p.date)}" y="${H - 4}" text-anchor="${i ? 'end' : 'start'}">${p.date.slice(5).replace('-', '/')}</text>`)
    .join('');

  return `
    <div class="chart">
      <div class="chart-title">每日最佳進度</div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="每日最佳進度折線圖">${grid}<polyline class="line" points="${line}" />${dots}${labels}</svg>
    </div>`;
}

async function togglePulls(btn) {
  const box = btn.closest('.enc').querySelector('.pulls');
  if (!box.hidden) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (!box.dataset.loaded) {
    box.dataset.loaded = '1';
    box.innerHTML = `
      <table class="pull-table">
        <thead><tr><th>時間</th><th>職業</th><th>結果</th><th class="num hide-sm">時長</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
      <div class="pulls-more"></div>`;
    await loadPulls(box, btn.dataset.player, btn.dataset.encounter);
  }
}

async function loadPulls(box, player, encounter, before) {
  const more = box.querySelector('.pulls-more');
  more.innerHTML = '<span class="result-server">讀取中…</span>';
  try {
    const { pulls, next } = await api(
      `/pulls?player=${player}&encounter=${encounter}${before ? `&before=${encodeURIComponent(before)}` : ''}`
    );
    box.querySelector('tbody').insertAdjacentHTML(
      'beforeend',
      pulls
        .map(
          (p) => `
          <tr>
            <td>${fmtDateTime(p.at)}</td>
            <td>${jobBadge(p.job)}</td>
            <td class="result-cell ${p.kill ? 'kill' : ''}">${escapeHtml(progressLabel(p))}</td>
            <td class="num hide-sm">${fmtDuration(p.duration)}</td>
            <td class="num"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener"><span class="hide-sm">死亡</span>紀錄 ↗</a></td>
          </tr>`
        )
        .join('')
    );
    more.innerHTML = next ? '<button class="btn" type="button">載入更多</button>' : '';
    more.querySelector('button')?.addEventListener('click', () => loadPulls(box, player, encounter, next));
  } catch (err) {
    more.innerHTML = `<span class="notice error">讀取失敗：${escapeHtml(err.message)}</span>`;
  }
}

// ---------- 路由 ----------

async function route() {
  const token = ++renderToken;
  window.scrollTo(0, 0);
  const match = location.hash.match(/^#\/p\/([^/]+)\/(.+)$/);
  if (match) {
    await renderPlayer(decodeURIComponent(match[1]), decodeURIComponent(match[2]), token);
  } else {
    document.title = '開荒進度 | FFXIV 繁中服';
    const q = new URLSearchParams(location.hash.split('?')[1] ?? '').get('q') ?? '';
    renderHome(q);
  }
}

// 頁首的搜尋框：在首頁直接搜，在其他頁就帶著關鍵字回首頁
const headerForm = document.getElementById('header-search');
headerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = headerForm.q.value.trim();
  if (!q) return;
  headerForm.q.value = '';
  location.hash = `#/?q=${encodeURIComponent(q)}`;
});

window.addEventListener('hashchange', route);

try {
  ({ encounters } = await api('/encounters'));
} catch {
  // 副本清單拿不到只影響排序和標籤，頁面照樣能用
}
route();
