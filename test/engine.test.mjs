import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSource } from '../sources/source.mjs';
import { SourceClient } from '../src/client.mjs';
import { Journal } from '../src/journal.mjs';
import { CuratorEngine } from '../src/orchestrator.mjs';
import { buildScheduleView, buildPlaybackView } from '../src/views.mjs';

const PHASE_CLOCK = {
  booking: '2026-12-05T09:30:00+08:00',
  restrict: '2026-12-05T10:05:00+08:00',
  late: '2026-12-05T11:20:00+08:00',
  restore: '2026-12-05T14:05:00+08:00',
};

async function setup(context) {
  const server = createSource();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), 'curator-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const journalPath = join(dir, 'journal.jsonl');
  let clockNow = PHASE_CLOCK.booking;
  const engine = new CuratorEngine(new SourceClient(baseUrl), new Journal(journalPath), () => clockNow);
  const cycles = {};
  for (const phase of ['booking', 'restrict', 'late', 'restore']) {
    clockNow = PHASE_CLOCK[phase];
    await (await fetch(`${baseUrl}/_source_clock?step=${phase}`, { method: 'PUT' })).json();
    cycles[phase] = await engine.sync(phase);
  }
  return { cycles, journalPath, baseUrl };
}

test('booking：两套场地授权完整，分别向两台终端发出上线', async (context) => {
  const { cycles } = await setup(context);
  const cycle = cycles.booking;
  assert.deepEqual(cycle.issued.map((command) => command.screen).sort(), ['P1', 'P2']);
  for (const item of cycle.arrangements) assert.equal(item.clearance.verdict, 'cleared');
  // 声音与画面各自有独立凭据，画面覆盖多个原始素材。
  const web = cycle.arrangements.find((item) => item.screen === 'P2');
  const tracks = new Set(web.clearance.evidence.map((item) => item.track));
  assert.deepEqual([...tracks].sort(), ['picture', 'sound']);
  assert.ok(web.clearance.evidence.some((item) => item.item === 'photo'));
  assert.ok(web.clearance.evidence.some((item) => item.item === 'archive'));
  // 编目片段已还原到原始素材（含派生素材链路）。
  const items = web.fragments.picture.map((fragment) => fragment.item).sort();
  assert.deepEqual(items, ['archive', 'photo']);
});

test('restrict：网页成片因撤回与收窄被撤下，馆内放映不受影响', async (context) => {
  const { cycles } = await setup(context);
  const cycle = cycles.restrict;
  const hall = cycle.arrangements.find((item) => item.screen === 'P1');
  const web = cycle.arrangements.find((item) => item.screen === 'P2');
  assert.equal(hall.clearance.verdict, 'cleared');
  assert.equal(web.clearance.verdict, 'blocked');
  const gapItems = new Set(web.clearance.hardGaps.map((gap) => gap.item));
  assert.ok(gapItems.has('photo')); // web2 撤回
  assert.ok(gapItems.has('archive')); // web0 收窄到 hall
  // 只向网页终端下发下线，馆内 P1 没有新命令。
  assert.deepEqual(cycle.issued, [{
    screen: 'P2', slot: 'feature', sequence: 2, action: 'off',
    edition: 'cut1', sentAt: PHASE_CLOCK.restrict,
  }]);
  // offline 回执：确认下线前策展人必须知道它仍可能播出。
  const p2 = cycle.terminals.find((status) => status.screen === 'P2');
  assert.equal(p2.state, 'pending-offline');
  assert.equal(p2.mayPlay, true);
  assert.equal(cycle.manualContacts[0].screen, 'P2');
});

test('late：迟到的上线回执被忽略，下线应用后状态才转为停止', async (context) => {
  const { cycles } = await setup(context);
  const cycle = cycles.late;
  const ignored = cycle.receipts.find((receipt) => receipt.sequence === 1);
  const applied = cycle.receipts.find((receipt) => receipt.sequence === 2);
  assert.equal(ignored.ignored, true);
  assert.equal(ignored.ignoreReason, 'superseded-sequence');
  assert.equal(applied.ignored, false);
  const p2 = cycle.terminals.find((status) => status.screen === 'P2');
  assert.equal(p2.state, 'stopped');
  assert.equal(p2.mayPlay, false);
  // 馆内终端持续在播，没有被网页的权利变更波及。
  const p1 = cycle.terminals.find((status) => status.screen === 'P1');
  assert.equal(p1.state, 'playing');
  assert.equal(p1.confirmedEdition, 'cut1');
});

test('restore：新授权重新判断，替代成片完整且终端确认后编目位才更新', async (context) => {
  const { cycles } = await setup(context);
  const cycle = cycles.restore;
  const web = cycle.arrangements.find((item) => item.screen === 'P2');
  // cut1 仍有被撤回的 photo 授权，不能重新上线。
  assert.equal(web.clearance.verdict, 'blocked');
  assert.equal(web.replacement.edition, 'cut2');
  assert.equal(web.replacement.ready, true);
  const on = cycle.issued.find((command) => command.action === 'on');
  assert.deepEqual(on && { sequence: on.sequence, edition: on.edition, screen: on.screen }, {
    sequence: 3, edition: 'cut2', screen: 'P2',
  });
  const p2 = cycle.terminals.find((status) => status.screen === 'P2');
  assert.equal(p2.state, 'playing');
  assert.equal(p2.confirmedEdition, 'cut2');
  assert.equal(p2.slotUpdatedWithAlternative, true);
});

test('事件日志可回看某次放映当时实际在播的版本与授权依据', async (context) => {
  const { journalPath } = await setup(context);
  const events = (await readFile(journalPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  // 10:30 处于权利收窄后、下线应用前：P2 最近确认仍是 cut1 在播。
  const during = buildPlaybackView(events, 'P2', 'feature', '2026-12-05T10:30:00+08:00');
  assert.equal(during.editionPlayed, 'cut1');
  assert.equal(during.terminalStatusAtPoint.confirmedReceipt.sequence, 1);
  assert.equal(during.playedEdition.edition, 'cut1');
  assert.ok(during.playedEdition.fragments.sound.some((fragment) => fragment.item === 'oral'));
  // 11:30 下线已应用：不能再视为在播。
  const after = buildPlaybackView(events, 'P2', 'feature', '2026-12-05T11:30:00+08:00');
  assert.equal(after.editionPlayed, null);
  assert.equal(after.playedEdition, null);
  // 15:00 替代版本已确认在播：回看必须呈现实际在播的 cut2 而非安排里的 cut1。
  const restored = buildPlaybackView(events, 'P2', 'feature', '2026-12-05T15:00:00+08:00');
  assert.equal(restored.editionPlayed, 'cut2');
  assert.equal(restored.playedEdition.edition, 'cut2');
  assert.equal(restored.scheduledEdition.edition, 'cut1');
});

test('策展总览同时给出片段、依据、终端与人工联系点', async (context) => {
  const { journalPath } = await setup(context);
  const events = (await readFile(journalPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const view = buildScheduleView(events);
  assert.equal(view.arrangements.length, 2);
  const hall = view.arrangements.find((item) => item.screen === 'P1');
  assert.equal(hall.terminal.state, 'playing');
  assert.equal(hall.needsManualContact, false);
  assert.ok(view.manualContacts.every((contact) => contact.screen !== 'P1'));
});
