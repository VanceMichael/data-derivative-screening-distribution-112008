import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createSource } from '../sources/source.mjs';
import { createCuratorServer } from '../src/server.mjs';

async function start() {
  const source = createSource();
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  const sourceBaseUrl = `http://127.0.0.1:${source.address().port}`;
  const server = createCuratorServer({ sourceBaseUrl });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    source,
    server,
    sourceBaseUrl,
    base,
    async step(name) {
      const response = await fetch(`${sourceBaseUrl}/_source_clock?step=${name}`, { method: 'PUT' });
      assert.equal(response.status, 200);
    },
    async close() {
      server.close();
      source.close();
      await Promise.all([once(server, 'close'), once(source, 'close')]);
    },
  };
}

const at = (value) => encodeURIComponent(value);

test('HTTP 接口按带时区时刻返回状态、计划与回看', async (context) => {
  const app = await start();
  context.after(() => app.close());

  assert.equal((await fetch(`${app.base}/health`)).status, 200);

  const sync = await (await fetch(`${app.base}/sync`, { method: 'POST' })).json();
  assert.deepEqual(sync.editions.sort(), ['cut1', 'cut2']);
  assert.equal(sync.errors.length, 0);

  const status = await (await fetch(`${app.base}/status?at=${at('2026-12-05T09:30:00+08:00')}`)).json();
  assert.equal(status.slots.length, 2);
  const hall = status.slots.find((slot) => slot.screen === 'P1').arrangements[0];
  assert.equal(hall.covered, true);
  assert.equal(hall.venue, 'hall');
  assert.ok(hall.basis.length > 0, '应给出当前许可依据');

  const plan = await (await fetch(`${app.base}/plan?at=${at('2026-12-05T09:30:00+08:00')}`)).json();
  assert.equal(plan.arrangements.length, 2);

  const reconcile = await (await fetch(`${app.base}/reconcile?at=${at('2026-12-05T09:30:00+08:00')}`, { method: 'POST' })).json();
  assert.ok(reconcile.dispatched.length > 0);
  assert.ok(reconcile.dispatched.every((item) => item.ok));

  const events = await (await fetch(`${app.base}/events`)).json();
  assert.ok(events.events.length >= 1);
  assert.equal(events.next, events.events.length);

  const lookup = await (await fetch(`${app.base}/screenings?screen=P2&slot=feature`)).json();
  assert.equal(lookup.screen, 'P2');

  assert.equal((await fetch(`${app.base}/screenings?screen=P2`)).status, 400);
  assert.equal((await fetch(`${app.base}/not-a-route`)).status, 404);
});

test('HTTP 接口拒绝不带时区的判断时刻', async (context) => {
  const app = await start();
  context.after(() => app.close());
  await fetch(`${app.base}/sync`, { method: 'POST' });
  const response = await fetch(`${app.base}/status?at=${at('2026-12-05T09:30:00')}`);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /带时区/);
});

test('控制台页面与脚本可离线加载', async (context) => {
  const app = await start();
  context.after(() => app.close());
  const page = await fetch(`${app.base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /展陈授权与终端发布/);
  assert.match(html, /\/console\.js/);
  const script = await fetch(`${app.base}/console.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /reconcile/);
});

test('阶段切换后网页只撤下受影响编目位', async (context) => {
  const app = await start();
  context.after(() => app.close());
  await fetch(`${app.base}/sync`, { method: 'POST' });
  await app.step('restrict');
  await fetch(`${app.base}/sync`, { method: 'POST' });

  const status = await (await fetch(`${app.base}/status?at=${at('2026-12-05T10:30:00+08:00')}`)).json();
  const hall = status.slots.find((slot) => slot.screen === 'P1').arrangements[0];
  const web = status.slots.find((slot) => slot.screen === 'P2').arrangements[0];
  assert.equal(hall.covered, true);
  assert.equal(web.covered, false);
  assert.ok(web.gaps.every((gap) => gap.track === 'picture'));
  assert.ok(status.attention.some((item) => item.screen === 'P2'));
});
