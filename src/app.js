import { createRateLimiter } from './rate-limit.js';
import { toPublic } from './store.js';

const MAX_BODY_BYTES = 8 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
const CODE_RE = /^[0-9A-Za-z]{1,16}$/;

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function createApp({ store, dashboard = '', logger = defaultLogger, rateLimit = {} } = {}) {
  if (!store) throw new Error('store is required');
  const limiter = createRateLimiter(rateLimit);

  return async function handler(req, res) {
    const startedAt = process.hrtime.bigint();
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      await route(req, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error('[shrink] unhandled error:', err);
      if (!res.headersSent) {
        json(req, res, status, {
          error: {
            code: err.code ?? 'internal_error',
            message: status >= 500 ? 'internal server error' : err.message,
          },
        }, err.headers);
      } else {
        res.destroy();
      }
    } finally {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger({ at: new Date().toISOString(), method: req.method, path: req.url, status: res.statusCode, ms: Math.round(ms * 10) / 10 });
    }
  };

  async function route(req, res) {
    const { pathname } = new URL(req.url, 'http://placeholder');
    const method = req.method === 'HEAD' ? 'GET' : req.method;

    if (pathname === '/healthz') {
      json(req, res, 200, { ok: true, uptime: Math.round(process.uptime()) });
      return;
    }
    if (pathname === '/' && method === 'GET') {
      html(req, res, 200, dashboard);
      return;
    }
    if (pathname === '/api/stats') {
      allowMethod(req, method, ['GET']);
      json(req, res, 200, store.totals());
      return;
    }
    if (pathname === '/api/links') {
      allowMethod(req, method, ['GET', 'POST']);
      if (method === 'POST') return createLink(req, res);
      json(req, res, 200, { links: store.list(), totals: store.totals() });
      return;
    }

    const match = /^\/api\/links\/([^/]+)$/.exec(pathname);
    if (match) {
      return handleLinkItem(req, res, match[1]);
    }

    if (method === 'GET' && pathname.length > 1 && !pathname.slice(1).includes('/')) {
      return redirect(req, res, pathname.slice(1));
    }
    throw new HttpError(404, 'not_found', `no route for ${req.method} ${pathname}`);
  }

  async function createLink(req, res) {
    const verdict = limiter.take(clientKey(req));
    if (!verdict.ok) {
      throw new HttpError(429, 'rate_limited', 'too many links created, slow down', {
        'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)),
      });
    }

    const body = await readJson(req);
    const target = parseTarget(body.url);
    const ttlSeconds = parseTtl(body.ttlSeconds);
    const record = store.create(target, { ttlSeconds });

    json(req, res, 201, { ...toPublic(record), shortUrl: `${baseUrl(req)}/${record.code}` }, {
      location: `/api/links/${record.code}`,
    });
  }

  function handleLinkItem(req, res, code) {
    if (!CODE_RE.test(code)) throw new HttpError(404, 'not_found', 'resource not found');
    const method = req.method === 'HEAD' ? 'GET' : req.method;

    if (method === 'GET') {
      const record = store.get(code);
      if (!record) throw new HttpError(404, 'not_found', `no link for code "${code}"`);
      json(req, res, 200, toPublic(record));
      return;
    }
    if (method === 'DELETE') {
      if (!store.remove(code)) throw new HttpError(404, 'not_found', `no link for code "${code}"`);
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    throw new HttpError(405, 'method_not_allowed', `${req.method} is not allowed on /api/links/:code`, {
      allow: 'GET, DELETE',
    });
  }

  function redirect(req, res, code) {
    const record = req.method === 'HEAD'
      ? store.get(code)
      : store.hit(code, {
        referrer: header(req, 'referer'),
        userAgent: header(req, 'user-agent'),
      });
    if (!record) throw new HttpError(404, 'not_found', `no link for code "${code}"`);

    res.writeHead(302, {
      location: record.url,
      'cache-control': 'no-store',
      'referrer-policy': 'unsafe-url',
    });
    res.end();
  }
}

function allowMethod(req, method, allowed) {
  if (!allowed.includes(method)) {
    throw new HttpError(405, 'method_not_allowed', `${req.method} is not allowed on ${new URL(req.url, 'http://x').pathname}`, {
      allow: allowed.join(', '),
    });
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'payload_too_large', `body must be at most ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};

  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'body must be valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_json', 'body must be a JSON object');
  }
  return parsed;
}

function parseTarget(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'invalid_url', 'url is required and must be a string');
  }
  const raw = value.trim();
  if (raw.length > MAX_URL_LENGTH) {
    throw new HttpError(400, 'invalid_url', `url must be at most ${MAX_URL_LENGTH} characters`);
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(400, 'invalid_url', 'url must be absolute, e.g. https://example.com/path');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, 'invalid_url', 'only http and https urls are supported');
  }
  return parsed.href;
}

function parseTtl(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TTL_SECONDS) {
    throw new HttpError(400, 'invalid_ttl', `ttlSeconds must be an integer between 1 and ${MAX_TTL_SECONDS}`);
  }
  return value;
}

function clientKey(req) {
  return req.socket.remoteAddress ?? 'unknown';
}

function header(req, name) {
  const value = req.headers[name];
  if (typeof value !== 'string' || value === '') return null;
  return value.slice(0, 200);
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${req.headers.host ?? 'localhost'}`;
}

function bodyless(req) {
  return req.method === 'HEAD';
}

function json(req, res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(bodyless(req) ? undefined : body);
}

function html(req, res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(bodyless(req) ? undefined : body);
}

function defaultLogger(entry) {
  if (process.env.SHRINK_LOG === 'off') return;
  console.log(JSON.stringify(entry));
}
