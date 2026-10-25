// 透過 wrangler 存取遠端 D1。本機用 `wrangler login` 的登入，
// GitHub Actions 用 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID 環境變數
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { withRetry } from './retry.mjs';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CACHE_DIR = join(ROOT, '.cache');
export const DATABASE = 'ff14-prog';

// Windows 的指令列長度上限約 32KB，查詢要切得比這小
const MAX_COMMAND_LENGTH = 20_000;
// D1 單一 SQL 敘述上限 100KB，批次寫入時切得比這小
const MAX_STATEMENT_LENGTH = 80_000;
// 一個 INSERT 列數太多 D1 會回 SQLITE_NOMEM（實測 2000 列可以、6000 列失敗）
const MAX_ROWS_PER_STATEMENT = 500;

async function wrangler(args) {
  try {
    const { stdout } = await run(process.execPath, [WRANGLER, ...args], {
      cwd: ROOT,
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const output = `${err.stderr ?? ''}\n${err.stdout ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
    // 加了 --json 時，D1 的錯誤是一段 JSON（例如超過每日額度的 code 7500），整段印出來
    const jsonError = output.match(/\{[\s\S]*"code"[\s\S]*\}/)?.[0];
    const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
    const errors = lines.filter((l) => /ERROR|✘/.test(l));
    const detail =
      jsonError?.replace(/\s+/g, ' ') ||
      (errors.length ? errors : lines.slice(-8)).join(' | ') ||
      `結束代碼 ${err.code ?? '?'}：${err.message.split('\n')[0]}`;
    // 整段放在同一行，重試的紀錄（只印第一行）也看得到原因
    throw new Error(`wrangler ${args.slice(0, 2).join(' ')} 失敗：${detail}`);
  }
}

export function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'NULL';
    return String(Math.round(v));
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replaceAll("'", "''")}'`;
}

// 資料庫資訊，包含過去 24 小時的讀寫列數（rows_written_24h 等）
// 讀取失敗會重試；寫入（executeStatements）不重試：萬一其實已寫入只是回應掉了，
// 重試會撞到主鍵重複而失敗，不如讓下一輪掃描重新處理
export async function info() {
  const stdout = await withRetry('讀取 D1 資訊', () => wrangler(['d1', 'info', DATABASE, '--json']));
  return JSON.parse(stdout.slice(stdout.indexOf('{')));
}

// 執行唯讀查詢，回傳每個敘述的結果列
export async function query(sql) {
  const stdout = await withRetry('D1 查詢', () =>
    wrangler(['d1', 'execute', DATABASE, '--remote', '--json', '--command', sql])
  );
  const json = JSON.parse(stdout.slice(stdout.indexOf('[')));
  return json.map((r) => r.results);
}

// 把 IN (...) 的值切成好幾次查詢，結果合併回傳
export async function queryIn(buildSql, values) {
  const rows = [];
  let chunk = [];
  let length = 0;
  const flush = async () => {
    if (!chunk.length) return;
    const [results] = await query(buildSql(chunk.map(sqlValue).join(',')));
    rows.push(...results);
    chunk = [];
    length = 0;
  };
  for (const v of values) {
    const literal = sqlValue(v);
    if (length + literal.length > MAX_COMMAND_LENGTH - 500) await flush();
    chunk.push(v);
    length += literal.length + 1;
  }
  await flush();
  return rows;
}

// 把多列資料組成幾個 INSERT 敘述，每個不超過長度上限
export function insertStatements(prefix, rows, suffix = '') {
  const statements = [];
  let values = [];
  let length = prefix.length + suffix.length;
  for (const row of rows) {
    const tuple = `(${row.map(sqlValue).join(',')})`;
    if (values.length && (length + tuple.length > MAX_STATEMENT_LENGTH || values.length >= MAX_ROWS_PER_STATEMENT)) {
      statements.push(`${prefix} VALUES ${values.join(',')} ${suffix};`);
      values = [];
      length = prefix.length + suffix.length;
    }
    values.push(tuple);
    length += tuple.length + 1;
  }
  if (values.length) statements.push(`${prefix} VALUES ${values.join(',')} ${suffix};`);
  return statements;
}

// 把一批寫入敘述存成 SQL 檔再一次執行
export async function executeStatements(statements) {
  if (!statements.length) return;
  await mkdir(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `write-${Date.now()}.sql`);
  await writeFile(file, statements.join('\n'));
  await wrangler(['d1', 'execute', DATABASE, '--remote', '--yes', '--file', file]);
}
