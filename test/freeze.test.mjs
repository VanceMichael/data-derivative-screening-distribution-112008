import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SourceClient } from '../src/client.mjs';
import { Journal } from '../src/journal.mjs';
import { CuratorEngine } from '../src/orchestrator.mjs';

const HTML = '<main><article data-edition="c1">'
  + '<span data-track="picture" data-part="film" data-in="0" data-out="5"></span>'
  + '<span data-track="sound" data-part="voice" data-in="0" data-out="5"></span>'
  + '</article></main>';

function fakeSource(routes) {
  return createServer(async (request, response) => {
    const body = await new Promise((resolve) => {
      let data = '';
      request.on('data', (chunk) => { data += chunk; });
      request.on('end', () => resolve(data));
    });
    const payload = routes[`${request.method} ${request.url}`];
    if (!payload) {
      response.writeHead(404);
      response.end('{}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

const baseRoutes = {
  'GET /catalog': HTML,
  'GET /catalog/links': [],
  'GET /exhibits/schedule': [{
    screen: 'P9', slot: 'feature', venue: 'web', use: 'public-web', edition: 'c1',
    from: '2026-12-05T09:00:00+08:00', to: '2026-12-05T18:00:00+08:00',
  }],
  'GET /rights/entries': [
    {
      id: 'r1', owner: 'R1', item: 'film', track: 'picture', start: 0, end: 5,
      venue: 'web', use: 'public-web',
      validFrom: '2026-12-01T00:00:00Z', validUntil: '2026-12-07T00:00:00Z',
    },
    {
      id: 'r2', owner: 'R2', item: 'voice', track: 'sound', start: 0, end: 5,
      venue: 'web', use: 'public-web',
      validFrom: '2026-12-01T00:00:00Z', validUntil: '2026-12-07T00:00:00Z',
    },
  ],
  'GET /player/receipts': [],
  'POST /player/commands': { state: 'arrived' },
};

test('限定条款无法解释时只冻结受影响安排，不自动下线并指明缺口类型', async (context) => {
  const server = fakeSource({
    ...baseRoutes,
    'GET /rights/amendments': [{
      right: 'r1',
      effective: '2026-12-05T10:00:00+08:00',
      action: 'add-unknown-restriction',
    }],
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const dir = await mkdtemp(join(tmpdir(), 'freeze-'));
  context.after(() => rm(dir, { recursive: true, force: true }));

  const engine = new CuratorEngine(
    new SourceClient(`http://127.0.0.1:${server.address().port}`),
    new Journal(join(dir, 'j.jsonl')),
    () => '2026-12-05T10:05:00+08:00',
  );
  const cycle = await engine.sync('freeze');
  const item = cycle.arrangements[0];
  assert.equal(item.clearance.verdict, 'frozen');
  assert.equal(item.clearance.hardGaps.length, 0);
  assert.equal(item.clearance.freezeGaps[0].track, 'picture');
  assert.match(item.clearance.freezeGaps[0].missingType, /待人工解释的限定条款/);
  // 冻结不触发自动上下线。
  assert.deepEqual(cycle.issued, []);
  // 终端本身未失联，但冻结安排必须进入人工联系清单并指明缺口类型。
  assert.equal(cycle.terminals[0].manualContact, false);
  assert.equal(item.decision.action, 'hold');
  assert.equal(cycle.manualContacts[0].screen, 'P9');
  assert.match(cycle.manualContacts[0].gaps[0].missingType, /画面使用许可|限定条款/);
});

test('来源断档（授权登记完全缺失）产生硬缺口并撤下，而非误放行', async (context) => {
  const server = fakeSource({
    ...baseRoutes,
    'GET /rights/entries': [],
    'GET /rights/amendments': [],
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const dir = await mkdtemp(join(tmpdir(), 'gap-'));
  context.after(() => rm(dir, { recursive: true, force: true }));

  const engine = new CuratorEngine(
    new SourceClient(`http://127.0.0.1:${server.address().port}`),
    new Journal(join(dir, 'j.jsonl')),
    () => '2026-12-05T10:05:00+08:00',
  );
  const cycle = await engine.sync('gap');
  const item = cycle.arrangements[0];
  assert.equal(item.clearance.verdict, 'blocked');
  const tracks = new Set(item.clearance.hardGaps.map((gap) => gap.track));
  assert.deepEqual([...tracks].sort(), ['picture', 'sound']);
  // 从未上线过的编目位无需下发下线，只保持不可播放。
  assert.deepEqual(cycle.issued, []);
  assert.equal(cycle.terminals[0].mayPlay, false);
});
