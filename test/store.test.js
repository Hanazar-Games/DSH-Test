import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LinkStore } from '../src/store.js';

const START = 1_700_000_000_000;

async function withStore(fn, { flushMs = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'shrink-store-'));
  const filePath = join(dir, 'links.json');
  const clock = { t: START };
  const store = new LinkStore({ filePath, flushMs, now: () => clock.t });
  await store.open();
  try {
    await fn({ store, filePath, dir, clock });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('creates a link and reads it back', async () => {
  await withStore(async ({ store }) => {
    const record = store.create('https://example.com/docs');
    assert.match(record.code, /^[0-9A-Za-z]{7}$/);
    assert.equal(record.url, 'https://example.com/docs');
    assert.equal(record.expiresAt, null);

    const found = store.get(record.code);
    assert.equal(found.url, 'https://example.com/docs');
    assert.equal(found.hits, 0);
    assert.equal(store.get('nosuch'), null);
  });
});

test('records hits, recent history and referrers', async () => {
  await withStore(async ({ store, clock }) => {
    const { code } = store.create('https://example.com/hits');
    clock.t += 1_000;
    for (let i = 0; i < 25; i += 1) {
      store.hit(code, { referrer: i % 2 === 1 ? 'https://news.example' : null, userAgent: 'test-agent' });
    }

    const record = store.get(code);
    assert.equal(record.hits, 25);
    assert.equal(record.recent.length, 20, 'recent hits are capped');
    assert.equal(record.recent[0].userAgent, 'test-agent');
    assert.equal(record.referrers['https://news.example'], 12);
    assert.equal(record.lastHitAt, clock.t);
    assert.equal(store.hit('nosuch'), null);
  });
});

test('expires links and drops them from listings', async () => {
  await withStore(async ({ store, clock }) => {
    const { code } = store.create('https://example.com/short-lived', { ttlSeconds: 60 });
    assert.equal(store.get(code).expiresAt, START + 60_000);

    clock.t += 59_000;
    assert.ok(store.get(code), 'still alive before the deadline');

    clock.t += 1_000;
    assert.equal(store.get(code), null, 'deadline is exclusive');
    assert.deepEqual(store.totals(), { links: 0, hits: 0 });
  });
});

test('persists an atomic snapshot and reloads it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shrink-persist-'));
  const filePath = join(dir, 'links.json');
  const clock = { t: START };
  try {
    const store = await new LinkStore({ filePath, flushMs: 0, now: () => clock.t }).open();
    const { code } = store.create('https://example.com/persisted', { ttlSeconds: 3600 });
    store.hit(code, { referrer: 'https://ref.example/' });
    await store.close();

    const snapshot = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.links[code].hits, 1);
    assert.equal(snapshot.links[code].url, 'https://example.com/persisted');
    assert.equal(snapshot.links[code].expiresAt, START + 3_600_000);

    const reopened = await new LinkStore({ filePath, now: () => clock.t }).open();
    try {
      assert.equal(reopened.size, 1);
      assert.equal(reopened.get(code).hits, 1);
      assert.equal(reopened.get(code).referrers['https://ref.example/'], 1);
    } finally {
      await reopened.close();
    }

    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'temp file is renamed away');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('removes links and reports whether anything was deleted', async () => {
  await withStore(async ({ store }) => {
    const { code } = store.create('https://example.com/gone');
    assert.equal(store.remove(code), true);
    assert.equal(store.remove(code), false);
    assert.equal(store.get(code), null);
  });
});

test('lists newest first and honours the limit', async () => {
  await withStore(async ({ store, clock }) => {
    const codes = [];
    for (let i = 0; i < 5; i += 1) {
      codes.push(store.create(`https://example.com/${i}`).code);
      clock.t += 1_000;
    }

    const listed = store.list();
    assert.deepEqual(listed.map((link) => link.code), [...codes].reverse());
    assert.equal(store.list({ limit: 2 }).length, 2);
    assert.deepEqual(store.totals(), { links: 5, hits: 0 });
  });
});

test('rejects a corrupt data file instead of starting empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shrink-corrupt-'));
  const filePath = join(dir, 'links.json');
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, '{"version":1,"links":');
    await assert.rejects(() => new LinkStore({ filePath }).open(), /corrupt data file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
