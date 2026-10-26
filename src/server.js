import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { LinkStore } from './store.js';

const DEFAULT_DASHBOARD = new URL('../public/index.html', import.meta.url);

export async function start({
  port = 0,
  host = '127.0.0.1',
  dataPath = 'data/links.json',
  dashboardPath = DEFAULT_DASHBOARD,
  logger,
  rateLimit,
  now,
} = {}) {
  const store = new LinkStore({ filePath: dataPath, ...(now ? { now } : {}) });
  await store.open();

  const dashboard = await readFile(dashboardPath, 'utf8');
  const app = createApp({
    store,
    dashboard,
    ...(logger ? { logger } : {}),
    ...(rateLimit ? { rateLimit } : {}),
  });

  const server = createServer(app);
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const actualPort = server.address().port;
  return {
    server,
    store,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
      await store.close();
    },
  };
}
