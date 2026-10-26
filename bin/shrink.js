#!/usr/bin/env node
import { start } from '../src/server.js';

const HELP = `shrink — zero-dependency url shortener

Usage: shrink [options]

Options:
  -p, --port <n>     port to listen on (default: 3000, env PORT)
  -H, --host <addr>  address to bind (default: 127.0.0.1)
  -d, --data <file>  data file (default: data/links.json, env SHRINK_DATA)
  -h, --help         show this help

API:
  POST   /api/links         { "url": "...", "ttlSeconds": 3600? } -> 201
  GET    /api/links         list links + totals
  GET    /api/links/:code   link metadata and hit stats
  DELETE /api/links/:code   delete a link
  GET    /api/stats         { links, hits }
  GET    /:code             302 redirect
  GET    /healthz           liveness probe
`;

function fail(message) {
  console.error(`shrink: ${message}\nTry 'shrink --help'.`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) fail(`${arg} requires a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case '-p':
      case '--port':
        options.port = Number(value());
        break;
      case '-H':
      case '--host':
        options.host = value();
        break;
      case '-d':
      case '--data':
        options.dataPath = value();
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const port = options.port ?? Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`invalid port: ${options.port}`);

const host = options.host ?? process.env.HOST ?? '127.0.0.1';
const dataPath = options.dataPath ?? process.env.SHRINK_DATA ?? 'data/links.json';

const app = await start({ port, host, dataPath });
console.log(`shrink listening on ${app.url}`);
console.log(`dashboard: ${app.url}/   data: ${dataPath}`);

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (closing) process.exit(1);
    closing = true;
    console.log('shrink: flushing data and shutting down');
    await app.close();
    process.exit(0);
  });
}
