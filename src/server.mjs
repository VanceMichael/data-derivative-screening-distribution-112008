// 策展端 HTTP 接口与本地控制台。
//
// 接口：
//   GET  /health
//   POST /sync                 拉取来源资料（不发布）
//   GET  /status?at=<带时区时刻> 编目位状态、许可依据与需人工联系的点
//   POST /reconcile?at=...     按当前资料发布上线/下线指令
//   GET  /screenings?screen=P1&slot=feature  按一次已发生的放映回看
//   GET  /plan?at=...          只计算、不发送的发布计划
//   GET  /events?since=N       审计事件增量
//   GET  /                     策展人控制台
//
// 时间一律用带时区的 ISO 字符串；未给 at 时使用服务自己的时钟。

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { CuratorService } from './curator.mjs';
import { createSourceClient } from './source-client.mjs';
import { createFilePersistence } from './persistence.mjs';
import { consolePage, consoleScript } from './console.mjs';

const json = (value) => JSON.stringify(value);

function writeJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(json(value));
}

export function createCuratorServer({
  sourceBaseUrl = process.env.SOURCE_URL ?? 'http://127.0.0.1:4173',
  now = () => new Date(),
  persistence = null,
  source = createSourceClient({ baseUrl: sourceBaseUrl }),
} = {}) {
  const curator = new CuratorService({ source, persistence, now });
  let syncing = null;

  const ensureSynced = async () => {
    if (curator.snapshot) return curator.snapshot;
    syncing = syncing ?? curator.sync().finally(() => { syncing = null; });
    return syncing;
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const clock = url.searchParams.get('at') ?? now().toISOString();
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        writeJson(response, 200, { status: 'ok', synced: Boolean(curator.snapshot), fetchedAt: curator.lastSync });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(consolePage());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/console.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        response.end(await consoleScript());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/sync') {
        const snapshot = await curator.sync();
        writeJson(response, 200, {
          fetchedAt: snapshot.fetchedAt,
          editions: [...snapshot.editions.keys()],
          schedule: snapshot.schedule.map((item) => item.key),
          errors: snapshot.errors,
        });
        return;
      }
      if (url.pathname === '/status' && request.method === 'GET') {
        await ensureSynced();
        writeJson(response, 200, curator.status(clock));
        return;
      }
      if (url.pathname === '/plan' && request.method === 'GET') {
        await ensureSynced();
        writeJson(response, 200, curator.plan(clock));
        return;
      }
      if (url.pathname === '/reconcile' && request.method === 'POST') {
        await ensureSynced();
        const result = await curator.reconcile(clock);
        writeJson(response, 200, result);
        return;
      }
      if (url.pathname === '/screenings' && request.method === 'GET') {
        await ensureSynced();
        const screen = url.searchParams.get('screen');
        const slot = url.searchParams.get('slot');
        if (!screen || !slot) {
          writeJson(response, 400, { error: '需要 screen 与 slot' });
          return;
        }
        const result = curator.screenings(screen, slot);
        if (!result) {
          writeJson(response, 404, { error: '没有这个编目位' });
          return;
        }
        writeJson(response, 200, result);
        return;
      }
      if (url.pathname === '/events' && request.method === 'GET') {
        await ensureSynced();
        const since = Number(url.searchParams.get('since') ?? 0);
        const start = Number.isInteger(since) && since >= 0 ? since : 0;
        writeJson(response, 200, { next: curator.audit.length, events: curator.audit.slice(start) });
        return;
      }
      writeJson(response, 404, { error: '没有这条路径' });
    } catch (error) {
      const status = error instanceof TypeError ? 400 : 502;
      writeJson(response, status, { error: error.message });
    }
  });

  server.curator = curator;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.CURATOR_PORT ?? process.env.PORT ?? 4174);
  const persistencePath = process.env.CURATOR_STATE ?? null;
  const server = createCuratorServer({
    sourceBaseUrl: process.env.SOURCE_URL ?? `http://127.0.0.1:${process.env.SOURCE_PORT ?? 4173}`,
    persistence: persistencePath ? createFilePersistence(persistencePath) : null,
  });
  server.listen(port, '127.0.0.1', function () {
    process.stdout.write(`策展控制台 http://127.0.0.1:${this.address().port}\n`);
  });
}
