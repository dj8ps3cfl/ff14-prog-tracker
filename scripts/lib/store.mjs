// data/ 底下 JSON 檔的讀寫。這些檔案會被 commit，網頁直接讀它們
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));

export async function readJson(relPath, fallback) {
  try {
    return JSON.parse(await readFile(join(DATA_DIR, relPath), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function writeJson(relPath, value) {
  const file = join(DATA_DIR, relPath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

// Windows 不能用在檔名裡的字元換掉（FF14 角色名正常不會有，保險起見）
const safeSegment = (s) => s.replace(/[<>:"/\\|?*]/g, '_');

export const playerPath = (name, server) => `players/${safeSegment(server)}/${safeSegment(name)}.json`;

// 玩家檔用到才讀，最後只寫回有變動的
export class PlayerStore {
  #cache = new Map();
  #dirty = new Set();

  async get(name, server) {
    const key = `${name}@${server}`;
    if (!this.#cache.has(key)) {
      const player = await readJson(playerPath(name, server), null);
      this.#cache.set(key, player ?? { name, server, encounters: {} });
    }
    return this.#cache.get(key);
  }

  markDirty(player) {
    this.#dirty.add(`${player.name}@${player.server}`);
  }

  get dirtyPlayers() {
    return [...this.#dirty].map((key) => this.#cache.get(key));
  }

  async flush() {
    for (const player of this.dirtyPlayers) {
      player.updatedAt = Date.now();
      await writeJson(playerPath(player.name, player.server), player);
    }
    const count = this.#dirty.size;
    this.#dirty.clear();
    return count;
  }
}
