// 產生 docs/data/action-names.json：技能編號 → 中文名稱（國服名稱轉成台灣繁體）
//
// 團滅分析拿到的技能名稱來自台服客戶端，但有些技能在台服資料裡只有英文。
// 這份對照表用來把那些英文名稱換成中文；本來就是中文的台服名稱不換（台服、國服譯名常常不同）。
//
// 資料來源：thewakingsands/ffxiv-datamining-cn（國服遊戲資料，社群維護）的 Action.csv。
// 新版本的副本開放後重新跑一次：npm run build:action-names
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as OpenCC from 'opencc-js';

const SOURCE = 'https://raw.githubusercontent.com/thewakingsands/ffxiv-datamining-cn/master/Action.csv';
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

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`下載 Action.csv 失敗：HTTP ${res.status}`);
const rows = parseCsv((await res.text()).replace(/^﻿/, ''));

// 第 2 列是欄位名稱，第 4 列開始是資料
const header = rows[1];
const col = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`Action.csv 找不到欄位 ${name}`);
  return i;
};
const ID = col('#');
const NAME = col('Name');
const IS_PLAYER = col('IsPlayerAction');

// 只留怪物的技能：玩家技能不會是「致死技能」
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'twp' });
const names = {};
for (const row of rows.slice(3)) {
  const id = row[ID];
  const name = row[NAME]?.trim();
  if (!/^\d+$/.test(id) || !name || !CJK.test(name) || row[IS_PLAYER] === 'True') continue;
  names[id] = toTraditional(name);
}

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, JSON.stringify(names));
console.log(`寫入 ${Object.keys(names).length} 個技能名稱到 ${OUTPUT}`);
