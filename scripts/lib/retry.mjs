// 暫時性錯誤（網路斷線、伺服器 5xx、被限流）時等一下再試
const DELAYS = [2_000, 5_000, 15_000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// shouldRetry(err) 回傳 true 才重試；waitFor(err) 可以指定這次要等多久（例如 Retry-After）
export async function withRetry(label, fn, { shouldRetry = () => true, waitFor = () => null } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= DELAYS.length || !shouldRetry(err)) throw err;
      const wait = waitFor(err) ?? DELAYS[attempt];
      console.log(`  ↻ ${label} 失敗（${err.message.split('\n')[0]}），${Math.round(wait / 1000)} 秒後重試…`);
      await sleep(wait);
    }
  }
}

// 會重試的 HTTP 狀態：限流和伺服器端錯誤
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

class HttpError extends Error {
  constructor(res, text) {
    super(`HTTP ${res.status}：${text.slice(0, 300)}`);
    this.status = res.status;
    this.retryAfter = Number(res.headers.get('retry-after')) || null;
  }
}

// fetch 加上重試：網路錯誤（fetch failed）和 RETRYABLE_STATUS 會重試，其他狀態直接回傳給呼叫端處理
export function fetchWithRetry(label, url, init) {
  return withRetry(
    label,
    async () => {
      const res = await fetch(url, init);
      if (RETRYABLE_STATUS.has(res.status)) throw new HttpError(res, await res.text());
      return res;
    },
    {
      // 網路層錯誤是 TypeError（fetch failed），HTTP 錯誤是 HttpError
      shouldRetry: (err) => err instanceof TypeError || err instanceof HttpError,
      // 限流時照伺服器說的秒數等，但最多等一分鐘
      waitFor: (err) => (err.retryAfter ? Math.min(err.retryAfter, 60) * 1000 : null),
    }
  );
}
