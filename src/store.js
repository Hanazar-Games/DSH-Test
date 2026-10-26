import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CODE_LENGTH, randomCode } from './id.js';

const FORMAT_VERSION = 1;
const RECENT_LIMIT = 20;
const REFERRER_LIMIT = 10;
const CODE_ATTEMPTS = 8;

export class LinkStore {
  #filePath;
  #flushMs;
  #now;
  #links = new Map();
  #timer = null;
  #writing = Promise.resolve();
  #closed = false;

  constructor({ filePath, flushMs = 250, now = Date.now } = {}) {
    if (!filePath) throw new Error('filePath is required');
    this.#filePath = filePath;
    this.#flushMs = flushMs;
    this.#now = now;
  }

  get size() {
    return this.#links.size;
  }

  async open() {
    await mkdir(dirname(this.#filePath), { recursive: true });
    let raw = '';
    try {
      raw = await readFile(this.#filePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (raw.trim() !== '') {
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`corrupt data file: ${this.#filePath}`);
      }
      if (data.version !== FORMAT_VERSION) {
        throw new Error(`unsupported data version ${data.version} in ${this.#filePath}`);
      }
      for (const [code, record] of Object.entries(data.links ?? {})) {
        this.#links.set(code, record);
      }
    }
    this.prune();
    return this;
  }

  create(url, { ttlSeconds = null } = {}) {
    const at = this.#now();
    let code = randomCode(CODE_LENGTH);
    for (let i = 0; i < CODE_ATTEMPTS && this.#links.has(code); i += 1) {
      code = randomCode(CODE_LENGTH);
    }
    if (this.#links.has(code)) throw new Error('could not allocate a unique code');

    const record = {
      code,
      url,
      createdAt: at,
      expiresAt: ttlSeconds === null ? null : at + ttlSeconds * 1000,
      hits: 0,
      lastHitAt: null,
      recent: [],
      referrers: {},
    };
    this.#links.set(code, record);
    this.#scheduleFlush();
    return record;
  }

  get(code, at = this.#now()) {
    const record = this.#links.get(code);
    if (!record) return null;
    if (record.expiresAt !== null && record.expiresAt <= at) {
      this.#links.delete(code);
      this.#scheduleFlush();
      return null;
    }
    return record;
  }

  hit(code, { referrer = null, userAgent = null } = {}) {
    const record = this.get(code);
    if (!record) return null;

    const at = this.#now();
    record.hits += 1;
    record.lastHitAt = at;
    record.recent.unshift({ at, referrer, userAgent });
    if (record.recent.length > RECENT_LIMIT) record.recent.length = RECENT_LIMIT;

    if (referrer) {
      record.referrers[referrer] = (record.referrers[referrer] ?? 0) + 1;
      const top = Object.entries(record.referrers)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, REFERRER_LIMIT);
      record.referrers = Object.fromEntries(top);
    }
    this.#scheduleFlush();
    return record;
  }

  remove(code) {
    if (!this.#links.delete(code)) return false;
    this.#scheduleFlush();
    return true;
  }

  prune() {
    const at = this.#now();
    let removed = 0;
    for (const [code, record] of this.#links) {
      if (record.expiresAt !== null && record.expiresAt <= at) {
        this.#links.delete(code);
        removed += 1;
      }
    }
    if (removed > 0) this.#scheduleFlush();
    return removed;
  }

  list({ limit = 50 } = {}) {
    this.prune();
    return [...this.#links.values()]
      .sort((a, b) => b.createdAt - a.createdAt || a.code.localeCompare(b.code))
      .slice(0, limit)
      .map(toPublic);
  }

  totals() {
    this.prune();
    let hits = 0;
    for (const record of this.#links.values()) hits += record.hits;
    return { links: this.#links.size, hits };
  }

  flush() {
    this.#writing = this.#writing.catch(() => {}).then(() => this.#write());
    return this.#writing;
  }

  async close() {
    this.#closed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.flush();
  }

  #scheduleFlush() {
    if (this.#closed || this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush().catch((err) => console.error('[shrink] flush failed:', err));
    }, this.#flushMs);
    this.#timer.unref?.();
  }

  // Write to a unique temp file then rename: a crash mid-write cannot truncate the snapshot,
  // and concurrent writers (e.g. two processes on one file) never race on the same temp name.
  async #write() {
    const snapshot = JSON.stringify({
      version: FORMAT_VERSION,
      links: Object.fromEntries(this.#links),
    });
    const tmpPath = `${this.#filePath}.${process.pid}.${randomCode(6)}.tmp`;
    try {
      await writeFile(tmpPath, snapshot);
      await rename(tmpPath, this.#filePath);
    } catch (err) {
      await rm(tmpPath, { force: true });
      throw err;
    }
  }
}

export function toPublic(record) {
  return {
    code: record.code,
    url: record.url,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    hits: record.hits,
    lastHitAt: record.lastHitAt,
    recent: record.recent,
    referrers: record.referrers,
  };
}
