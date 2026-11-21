import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createSource } from '../sources/source.mjs';
import { createSourceClient } from '../src/source-client.mjs';
import { CuratorService } from '../src/curator.mjs';

const BASE_TIME = '2026-12-05T09:30:00+08:00';

async function harness() {
  const sourceServer = createSource();
  sourceServer.listen(0, '127.0.0.1');
  await once(sourceServer, 'listening');
  const baseUrl = `http://127.0.0.1:${sourceServer.address().port}`;
  const step = (name) => fetch(`${baseUrl}/_source_clock?step=${name}`, { method: 'PUT' });
  const service = new CuratorService({ source: createSourceClient({ baseUrl }) });
  return { sourceServer, baseUrl, step, service };
}

function find(plan, screen, slot = 'feature') {
  return plan.arrangements.find((item) => item.screen === screen && item.slot === slot);
}

test('网页版在撤回生效后只冻结受影响安排，馆内继续放映', async (context) => {
  const { sourceServer, step, service } = await harness();
  context.after(() => sourceServer.close());

  await service.sync();
  const booking = service.plan(BASE_TIME);
  assert.equal(find(booking, 'P1').current.covered, true);
  assert.equal(find(booking, 'P2').current.covered, true);

  // booking 阶段尚未收到修订，无法预知之后的变化点。
  assert.equal(find(booking, 'P2').current.nextChange, null);

  // restrict 阶段收到 12-05 10:00（+08:00）生效的撤回：当前依据只到那一刻。
  await step('restrict');
  await service.sync();
  const early = service.plan('2026-12-05T09:30:00+08:00');
  assert.equal(find(early, 'P2').current.covered, true);
  assert.equal(find(early, 'P2').current.nextChange, '2026-12-05T02:00:00.000Z');
  assert.equal(find(early, 'P1').current.nextChange, null);

  await step('restrict');
  await service.sync();
  const after = service.plan('2026-12-05T10:30:00+08:00');
  assert.equal(find(after, 'P1').current.covered, true, '馆内使用馆藏与口述录音，仍有凭据');
  assert.equal(find(after, 'P2').current.covered, false, '网页成片用了被撤回的照片');
  // 网页版画面由馆藏与照片组成：撤回的照片与一并收回的馆藏区段都受影响，
  // 但口述录音授权仍在，缺口只出现在画面轨。
  assert.deepEqual(find(after, 'P2').current.gaps.map((gap) => [gap.track, gap.item]),
    [['picture', 'photo'], ['picture', 'archive']]);
  for (const gap of find(after, 'P2').current.gaps) {
    assert.equal(gap.track, 'picture');
    assert.equal(gap.missingLabel, '许可不在本时段生效或已撤回');
  }
  assert.equal(find(after, 'P2').current.gaps.length, 2);
});

test('restrict 阶段网页两版都冻结，恢复后才改用巡展版', async (context) => {
  const { sourceServer, step, service } = await harness();
  context.after(() => sourceServer.close());

  await service.sync();
  await service.reconcile(BASE_TIME);

  // restrict 把 web0 收窄到馆内：cut1 与 cut2 都用到 archive 7-10，网页两版都冻结。
  await step('restrict');
  await service.sync();
  const frozen = find(service.plan('2026-12-05T10:30:00+08:00'), 'P2');
  assert.equal(frozen.action, 'off');
  assert.equal(frozen.current.covered, false);
  assert.equal(frozen.alternativeCheck.covered, false);
  assert.ok(frozen.alternativeCheck.gaps.some((gap) => gap.item === 'archive'));

  // 终端失联：不能把编目位标为已更新，P2 要列入需人工联系的点。
  const offlineStatus = service.status('2026-12-05T10:30:00+08:00');
  const webStatus = offlineStatus.slots.find((slot) => slot.screen === 'P2').arrangements[0];
  assert.equal(webStatus.updated, false);
  assert.ok(offlineStatus.attention.some((item) => item.kind === 'offline' && item.screen === 'P2'));

  // restore 在 14:00 重新开放原场地后，巡展版成为可用替换。
  // 来源在 restore 阶段预置了终端已应用 cut2 的回执（序号 3），因此不再需要换版。
  await step('restore');
  await service.sync();
  const plan = service.plan('2026-12-05T14:30:00+08:00');
  const web = find(plan, 'P2');
  assert.equal(web.alternativeCheck.covered, true);
  assert.equal(web.action, 'none');
  assert.equal(web.targetEdition, 'cut2');
  assert.equal(web.player.confirmedEdition, 'cut2');
  assert.equal(web.current.covered, false, '原版仍冻结，不能因为替换版在播而放宽');
});

test('迟到的旧上线回执不能把网页版改回可播放', async (context) => {
  const { sourceServer, step, service } = await harness();
  context.after(() => sourceServer.close());

  await service.sync();
  await service.reconcile(BASE_TIME);
  await step('restrict');
  await service.sync();
  await service.reconcile('2026-12-05T10:30:00+08:00');

  await step('late');
  await service.sync();
  const plan = service.plan('2026-12-05T11:30:00+08:00');
  const web = find(plan, 'P2');
  // 序号 1 的上线回执（cut1）晚到；即使它先推进了确认状态，随后序号 2 的下线
  // 回执也会接管。两种情况都不允许把已撤回的 cut1 当作可播放。
  assert.notEqual(web.player.playingEdition, 'cut1');
  assert.equal(web.player.playing, false);
  if (web.player.confirmedSequence === 2) {
    assert.equal(web.player.phase, 'off');
    assert.equal(web.player.confirmedEdition, null);
  } else {
    assert.equal(web.player.phase, 'stopping-pending');
    assert.equal(web.player.mayStillPlay, true);
  }
  // 晚到的上线回执留在审计里，没有被丢弃。
  assert.ok(web.player.history.receipts.some((receipt) => receipt.sequence === 1
    && receipt.state === 'applied' && receipt.edition === 'cut1'));
});

test('没有终端回执的"已发出"不能当做停止或上线', async (context) => {
  const { sourceServer, service } = await harness();
  context.after(() => sourceServer.close());
  await service.sync();

  const result = await service.reconcile(BASE_TIME);
  const dispatched = result.dispatched.filter((item) => item.ok);
  assert.ok(dispatched.length > 0);
  const status = service.status(BASE_TIME);
  const notConfirmed = status.slots.flatMap((slot) => slot.arrangements)
    .filter((item) => dispatched.some((command) => command.screen === item.player.screen
      && command.slot === item.player.slot && command.action === 'on'));
  assert.ok(notConfirmed.length > 0, '应至少有一条刚发出的上线命令');
  for (const item of notConfirmed) {
    // 演练来源的 P1 回执来自外部发布者；本进程刚发出的命令仍须等回执。
    assert.equal(item.player.phase, 'starting-pending');
    assert.equal(item.updated, false);
  }
});

test('撤销后恢复只重开仍有授权依据的放映', async (context) => {
  const { sourceServer, step, service } = await harness();
  context.after(() => sourceServer.close());

  await service.sync();
  await step('restore');
  await service.sync();
  const plan = service.plan('2026-12-05T14:30:00+08:00');
  // 恢复的是馆内授权；网页照片仍处在撤回状态。
  assert.equal(find(plan, 'P1').current.covered, true);
  assert.equal(find(plan, 'P2').current.covered, false);
  assert.equal(find(plan, 'P2').targetEdition, 'cut2');
});

test('按一次已发生的放映回看当时使用的素材与授权', async (context) => {
  const { sourceServer, step, service } = await harness();
  context.after(() => sourceServer.close());

  await service.sync();
  await service.reconcile(BASE_TIME);
  await step('restore');
  await service.sync();
  await service.reconcile('2026-12-05T14:30:00+08:00');

  const lookup = service.screenings('P2', 'feature');
  assert.ok(lookup.sessions.length >= 1);
  const session = lookup.sessions.find((item) => item.edition === 'cut2');
  assert.ok(session, '巡展版的放映应有回执记录');
  assert.equal(session.venue, 'web');
  assert.equal(session.use, 'public-web');
  assert.ok(session.material.some((track) => track.track === 'picture'));
  assert.ok(session.rights.length > 0 || session.evidenceMissing);
});

test('来源断档时只冻结受影响安排并指出缺失来源', async (context) => {
  const { sourceServer, baseUrl, service } = await harness();
  context.after(() => sourceServer.close());
  await service.sync();

  // 先拿到正常状态，再让来源在 rights 上失败。
  const healthy = service.plan(BASE_TIME);
  assert.equal(find(healthy, 'P1').current.covered, true);

  sourceServer.close();
  await once(sourceServer, 'close');
  // 同一实例改用失联的来源客户端：保留上一份资料，但标记断档并冻结。
  service.source = createSourceClient({ baseUrl, timeoutMs: 300 });
  await service.sync();
  const plan = service.plan(BASE_TIME);
  for (const item of plan.arrangements) {
    assert.equal(item.current.covered, false);
    assert.ok(item.current.frozen.some((problem) => problem.code === 'rights-unavailable'));
  }
  // 断档不等于账本清空：仍然能列出编目位与展期，只是不能放行。
  assert.equal(plan.arrangements.length, 2);
});

test('发布序号跨多次发布递增，替换前的下线先确认', async (context) => {
  const { sourceServer, baseUrl, step, service } = await harness();
  context.after(() => sourceServer.close());

  await service.sync();
  await step('restrict');
  await service.sync();
  // 先把 P2 标记为已确认在播 cut1（来源 late 阶段会带这条回执）。
  await step('late');
  await service.sync();
  const before = service.plan('2026-12-05T11:30:00+08:00').arrangements.find((item) => item.screen === 'P2');
  assert.equal(before.player.phase, 'off');

  await step('restore');
  await service.sync();
  await service.reconcile('2026-12-05T14:30:00+08:00');
  const commands = await (await fetch(`${baseUrl}/_source_calls`)).json();
  const posted = commands.filter((call) => call.path === '/player/commands').map((call) => JSON.parse(call.body));
  const sequences = posted.filter((command) => command.screen === 'P2').map((command) => command.sequence);
  for (let index = 1; index < sequences.length; index += 1) {
    assert.ok(sequences[index] > sequences[index - 1], `序号应递增：${sequences}`);
  }
});
