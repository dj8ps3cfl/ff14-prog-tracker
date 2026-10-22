// 本機開發：同時啟動 Worker（API，讀本機 D1）和網頁伺服器
//   API  http://127.0.0.1:8811
//   網頁 http://127.0.0.1:8812
// 本機 D1 要先有資料，見 README 的「本機測試」
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SITE_DIR = join(ROOT, 'docs');
const API_PORT = 8811;
const SITE_PORT = 8812;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = normalize(join(SITE_DIR, path.endsWith('/') ? `${path}index.html` : path));
  if (!file.startsWith(SITE_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(SITE_PORT, '127.0.0.1', () => console.log(`網頁 http://127.0.0.1:${SITE_PORT}`));

const wrangler = spawn(
  process.execPath,
  [join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'dev', '--port', String(API_PORT), '--var', 'NO_CACHE:1'],
  { cwd: ROOT, stdio: 'inherit' }
);
wrangler.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => wrangler.kill(signal));
