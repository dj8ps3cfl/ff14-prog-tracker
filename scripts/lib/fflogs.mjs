// FFLogs API v2 的最小 client：client credentials 取 token + GraphQL 查詢
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const TOKEN_URL = 'https://www.fflogs.com/oauth/token';
const API_URL = 'https://www.fflogs.com/api/v2/client';

const ROOT = new URL('../../', import.meta.url);
const ENV_FILE = fileURLToPath(new URL('.env', ROOT));
const CACHE_DIR = new URL('.cache/', ROOT);
const TOKEN_CACHE = new URL('token.json', CACHE_DIR);

export function loadCredentials() {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // 沒有 .env 時改用既有的環境變數（例如 GitHub Actions secrets）
  }
  const id = process.env.FFLOGS_CLIENT_ID?.trim();
  const secret = process.env.FFLOGS_CLIENT_SECRET?.trim();
  if (!id || !secret) {
    throw new Error(
      '找不到 FFLOGS_CLIENT_ID / FFLOGS_CLIENT_SECRET。\n' +
        '請把 .env.example 複製成 .env 並填入 client 資料。'
    );
  }
  return { id, secret };
}

async function readCachedToken() {
  try {
    const cached = JSON.parse(await readFile(TOKEN_CACHE, 'utf8'));
    // 留一分鐘緩衝，避免剛好在查詢途中過期
    if (cached.access_token && cached.expires_at > Date.now() + 60_000) return cached;
  } catch {
    // 沒有快取或快取壞掉都當作沒有
  }
  return null;
}

async function requestToken({ id, secret }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`取得 token 失敗（HTTP ${res.status}）：${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text);
  const token = {
    access_token: json.access_token,
    expires_at: Date.now() + json.expires_in * 1000,
  };
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(TOKEN_CACHE, JSON.stringify(token));
  return token;
}

export async function getToken({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = await readCachedToken();
    if (cached) return { ...cached, fromCache: true };
  }
  const token = await requestToken(loadCredentials());
  return { ...token, fromCache: false };
}

export async function gql(query, variables = {}) {
  let token = await getToken();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    // 快取的 token 失效（例如 client 被重建）就清掉重拿一次
    if (res.status === 401 && attempt === 0) {
      await rm(TOKEN_CACHE, { force: true });
      token = await getToken({ forceRefresh: true });
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GraphQL 請求失敗（HTTP ${res.status}）：${text.slice(0, 300)}`);
    }
    const json = JSON.parse(text);
    if (json.errors?.length) {
      throw new Error('GraphQL 錯誤：' + json.errors.map((e) => e.message).join('；'));
    }
    return json.data;
  }
}

export function fightUrl(code, fightId, type = 'deaths') {
  return `https://www.fflogs.com/reports/${code}#fight=${fightId}&type=${type}`;
}
