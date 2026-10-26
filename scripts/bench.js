import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/server.js';

const CREATES = Number(process.env.CREATES ?? 1000);
const HITS = Number(process.env.HITS ?? 2000);

const dir = await mkdtemp(join(tmpdir(), 'shrink-bench-'));
const app = await start({
  port: 0,
  dataPath: join(dir, 'links.json'),
  logger: () => {},
  rateLimit: { max: 10_000_000, windowMs: 60_000 },
});

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

async function measure(n, task) {
  const samples = new Array(n);
  const startedAt = process.hrtime.bigint();
  for (let i = 0; i < n; i += 1) {
    const t0 = process.hrtime.bigint();
    await task(i);
    samples[i] = Number(process.hrtime.bigint() - t0) / 1e6;
  }
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    n,
    rps: n / (elapsedMs / 1000),
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    p99: pct(sorted, 99),
  };
}

const codes = [];
const creates = await measure(CREATES, async () => {
  const response = await fetch(`${app.url}/api/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `https://example.com/bench/${Math.random().toString(36).slice(2)}` }),
  });
  if (response.status !== 201) throw new Error(`create failed: ${response.status}`);
  codes.push((await response.json()).code);
});

const redirects = await measure(HITS, async (i) => {
  const response = await fetch(`${app.url}/${codes[i % codes.length]}`, { redirect: 'manual' });
  if (response.status !== 302) throw new Error(`redirect failed: ${response.status}`);
  await response.arrayBuffer();
});

const format = (stats) =>
  `n=${String(stats.n).padStart(4)}  rps=${stats.rps.toFixed(0).padStart(5)}  p50=${stats.p50.toFixed(2)}ms  p95=${stats.p95.toFixed(2)}ms  p99=${stats.p99.toFixed(2)}ms`;

console.log(`create    ${format(creates)}`);
console.log(`redirect  ${format(redirects)}`);

await app.close();
await rm(dir, { recursive: true, force: true });
