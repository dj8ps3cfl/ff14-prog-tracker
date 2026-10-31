// 產生 docs/data/action-names.json：技能編號 → 中文名稱，格式是 { tc: {...}, cn: {...} }
//
// 團滅分析拿到的技能名稱來自台服客戶端，但有些技能在 FFLogs 的紀錄裡只有英文。
// 這份對照表用來把那些英文名稱換成中文：
// - tc：繁中服官方譯名（thewakingsands/ffxiv-datamining-tc）
// - cn：繁中服資料裡沒有、或還是加密佔位字串（_rsv_…，新副本開放前後常見）的技能，
//       改用國服譯名轉成台灣繁體（thewakingsands/ffxiv-datamining-cn），網頁上會標註是國服譯名
//
// 繁中服或國服更新後重新跑一次：npm run build:action-names
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as OpenCC from 'opencc-js';

const SOURCES = {
  tc: 'https://raw.githubusercontent.com/thewakingsands/ffxiv-datamining-tc/main/Action.csv',
  cn: 'https://raw.githubusercontent.com/thewakingsands/ffxiv-datamining-cn/master/Action.csv',
};
const OUTPUT = fileURLToPath(new URL('../docs/data/action-names.json', import.meta.url));
const CJK = /[㐀-鿿]/;

// 支援引號內含逗號、換行的 CSV 解析
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

// 下載一份 Action.csv，回傳 技能編號 → 名稱（只留怪物的技能：玩家技能不會是「致死技能」）
async function loadActionNames(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載 ${url} 失敗：HTTP ${res.status}`);
  const rows = parseCsv((await res.text()).replace(/^﻿/, ''));

  // 第 2 列是欄位名稱，第 4 列開始是資料
  const header = rows[1];
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`${url} 找不到欄位 ${name}`);
    return i;
  };
  const ID = col('#');
  const NAME = col('Name');
  const IS_PLAYER = col('IsPlayerAction');

  const names = {};
  for (const row of rows.slice(3)) {
    const id = row[ID];
    const name = row[NAME]?.trim();
    // 沒開放的內容名稱是加密的佔位字串 _rsv_…，不含中文，這裡一起濾掉
    if (!/^\d+$/.test(id) || !name || !CJK.test(name) || row[IS_PLAYER] === 'True') continue;
    names[id] = name;
  }
  return names;
}

const tc = await loadActionNames(SOURCES.tc);
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'twp' });
const cn = {};
for (const [id, name] of Object.entries(await loadActionNames(SOURCES.cn))) {
  if (!tc[id]) cn[id] = toTraditional(name);
}

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, JSON.stringify({ tc, cn }));
console.log(`寫入繁中服譯名 ${Object.keys(tc).length} 個、國服譯名 ${Object.keys(cn).length} 個到 ${OUTPUT}`);
