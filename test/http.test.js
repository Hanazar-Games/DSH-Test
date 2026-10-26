import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { start } from '../src/server.js';

async function withServer(fn, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'shrink-http-'));
  const app = await start({
    port: 0,
    dataPath: join(dir, 'links.json'),
    logger: () => {},
    ...options,
  });
  try {
    await fn(app);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function createLink(app, body) {
  return fetch(`${app.url}/api/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('shortens a url, redirects it and counts the hit', async () => {
  await withServer(async (app) => {
    const response = await createLink(app, { url: 'https://example.com/a/b?c=1#frag' });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('location')?.startsWith('/api/links/'), true);

    const link = await response.json();
    assert.match(link.code, /^[0-9A-Za-z]{7}$/);
    assert.equal(link.url, 'https://example.com/a/b?c=1#frag');
    assert.equal(link.shortUrl, `${app.url}/${link.code}`);
    assert.equal(link.hits, 0);

    const redirect = await fetch(`${app.url}/${link.code}`, {
      redirect: 'manual',
      headers: { referer: 'https://ref.example/page' },
    });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), 'https://example.com/a/b?c=1#frag');
    assert.equal(redirect.headers.get('cache-control'), 'no-store');

    const meta = await (await fetch(`${app.url}/api/links/${link.code}`)).json();
    assert.equal(meta.hits, 1);
    assert.equal(meta.referrers['https://ref.example/page'], 1);
    assert.equal(meta.recent.length, 1);

    const stats = await (await fetch(`${app.url}/api/stats`)).json();
    assert.deepEqual(stats, { links: 1, hits: 1 });
  });
});

test('serves the dashboard and health probe', async () => {
  await withServer(async (app) => {
    const page = await fetch(`${app.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /<title>shrink<\/title>/);
    assert.match(html, /POST \/api\/links/);

    const probe = await fetch(`${app.url}/healthz`);
    const health = await probe.json();
    assert.equal(health.ok, true);
    assert.equal(typeof health.uptime, 'number');

    const head = await fetch(`${app.url}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  });
});

test('rejects bad payloads with machine-readable errors', async () => {
  await withServer(async (app) => {
    const cases = [
      { body: { url: '' }, code: 'invalid_url' },
      { body: { url: 'notaurl' }, code: 'invalid_url' },
      { body: { url: 'ftp://example.com/file' }, code: 'invalid_url' },
      { body: { url: 42 }, code: 'invalid_url' },
      { body: { url: 'https://example.com', ttlSeconds: 0 }, code: 'invalid_ttl' },
      { body: { url: 'https://example.com', ttlSeconds: 1.5 }, code: 'invalid_ttl' },
    ];

    for (const { body, code } of cases) {
      const response = await createLink(app, body);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      const payload = await response.json();
      assert.equal(payload.error.code, code);
      assert.equal(typeof payload.error.message, 'string');
    }

    const malformed = await fetch(`${app.url}/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"url":',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'invalid_json');

    const empty = await fetch(`${app.url}/api/links`, { method: 'POST' });
    assert.equal(empty.status, 400);

    const stats = await (await fetch(`${app.url}/api/stats`)).json();
    assert.deepEqual(stats, { links: 0, hits: 0 }, 'nothing was persisted');
  });
});

test('404s for unknown codes and malformed paths', async () => {
  await withServer(async (app) => {
    for (const path of ['/zzzzzzz', '/knowhere', '/api/links/zzzzzzz', '/api/links/bad%20code']) {
      const response = await fetch(`${app.url}${path}`, { redirect: 'manual' });
      assert.equal(response.status, 404, path);
      assert.equal((await response.json()).error.code, 'not_found');
    }
  });
});

test('deletes links and 405s unsupported methods', async () => {
  await withServer(async (app) => {
    const { code } = await (await createLink(app, { url: 'https://example.com/tmp' })).json();

    const del = await fetch(`${app.url}/api/links/${code}`, { method: 'DELETE' });
    assert.equal(del.status, 204);

    const gone = await fetch(`${app.url}/api/links/${code}`);
    assert.equal(gone.status, 404);

    const twice = await fetch(`${app.url}/api/links/${code}`, { method: 'DELETE' });
    assert.equal(twice.status, 404);

    const put = await fetch(`${app.url}/api/links`, { method: 'PUT', body: '{}' });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get('allow'), 'GET, POST');
  });
});

test('rate limits link creation per client', async () => {
  await withServer(async (app) => {
    for (let i = 0; i < 2; i += 1) {
      assert.equal((await createLink(app, { url: `https://example.com/${i}` })).status, 201);
    }
    const limited = await createLink(app, { url: 'https://example.com/3' });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, 'rate_limited');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  }, { rateLimit: { max: 2, windowMs: 60_000 } });
});

test('survives a restart with data intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shrink-restart-'));
  const dataPath = join(dir, 'links.json');
  try {
    const first = await start({ port: 0, dataPath, logger: () => {} });
    const { code } = await (await createLink(first, { url: 'https://example.com/restart' })).json();
    await fetch(`${first.url}/${code}`, { redirect: 'manual' });
    await first.close();

    const second = await start({ port: 0, dataPath, logger: () => {} });
    try {
      const meta = await (await fetch(`${second.url}/api/links/${code}`)).json();
      assert.equal(meta.url, 'https://example.com/restart');
      assert.equal(meta.hits, 1);
    } finally {
      await second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
