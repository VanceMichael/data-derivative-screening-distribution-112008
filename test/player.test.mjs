import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlayerLedger } from '../src/player.mjs';

test('同一终端、同一编目位只接受递增发布序号', () => {
  const ledger = new PlayerLedger();
  assert.equal(ledger.dispatch({ screen: 'P1', slot: 'feature', action: 'on', edition: 'cut1' }).sequence, 1);
  const lower = ledger.dispatch({ screen: 'P1', slot: 'feature', sequence: 1, action: 'off' });
  assert.equal(lower.ok, false);
  assert.equal(lower.code, 'non-monotonic');
  assert.equal(ledger.dispatch({ screen: 'P1', slot: 'feature', action: 'off' }).sequence, 2);
  // 另一个编目位独立计数。
  assert.equal(ledger.dispatch({ screen: 'P1', slot: 'trailer', action: 'on', edition: 'cut1' }).sequence, 1);
});

test('迟到的旧上线回执不能把已撤销版本改回可播放', () => {
  const ledger = new PlayerLedger();
  ledger.dispatch({ screen: 'P2', slot: 'feature', action: 'on', edition: 'cut1' });
  ledger.recordReceipt({ screen: 'P2', slot: 'feature', sequence: 1, action: 'on', state: 'offline' });
  ledger.dispatch({ screen: 'P2', slot: 'feature', action: 'off' });
  ledger.dispatch({ screen: 'P2', slot: 'feature', action: 'on', edition: 'cut2' });
  // 先确认 stop（序号 2），随后旧序号 1 的"已应用"回执才到。
  ledger.recordReceipt({ screen: 'P2', slot: 'feature', sequence: 2, action: 'off', state: 'applied', at: '2026-12-05T11:15:00+08:00' });
  const late = ledger.recordReceipt({ screen: 'P2', slot: 'feature', sequence: 1, action: 'on', state: 'applied', at: '2026-12-05T09:35:00+08:00' });
  assert.equal(late.stale, true);
  const status = ledger.status('P2', 'feature', () => true);
  assert.equal(status.phase, 'starting-pending');
  assert.equal(status.playing, false);
  assert.notEqual(status.confirmedEdition, 'cut1');
  assert.equal(status.confirmedSequence, 2);
});

test('已确认的旧上线回执遇到撤回后不再算可播放', () => {
  const ledger = new PlayerLedger();
  ledger.dispatch({ screen: 'P1', slot: 'feature', action: 'on', edition: 'cut1' });
  ledger.observeReceipts([{ screen: 'P1', slot: 'feature', sequence: 1, action: 'on', state: 'applied' }]);
  // 授权侧认为 cut1 已不能完整播出。
  const status = ledger.status('P1', 'feature', () => false);
  assert.equal(status.phase, 'playing-unlicensed');
  assert.equal(status.playing, false);
  assert.equal(status.mayStillPlay, true);
});

test('终端失联不能当作已停止', () => {
  const ledger = new PlayerLedger();
  ledger.dispatch({ screen: 'P2', slot: 'feature', action: 'on', edition: 'cut1' });
  ledger.recordReceipt({ screen: 'P2', slot: 'feature', sequence: 1, action: 'on', state: 'applied' });
  ledger.dispatch({ screen: 'P2', slot: 'feature', action: 'off' });
  ledger.recordReceipt({ screen: 'P2', slot: 'feature', sequence: 2, action: 'off', state: 'offline' });
  const status = ledger.status('P2', 'feature', () => true);
  assert.equal(status.phase, 'offline');
  assert.equal(status.mayStillPlay, true);
  assert.equal(status.offline, true);
  assert.equal(status.playing, false);
});

test('离线回执后续变为已应用时不推进已确认序号以外的状态', () => {
  const ledger = new PlayerLedger();
  ledger.dispatch({ screen: 'P2', slot: 'feature', action: 'on', edition: 'cut1' });
  ledger.recordReceipt({ screen: 'P2', slot: 'feature', sequence: 1, action: 'on', state: 'offline' });
  ledger.recordReceipt({ screen: 'P2', slot: 'feature', sequence: 1, action: 'on', state: 'applied', at: '2026-12-05T09:35:00+08:00' });
  const status = ledger.status('P2', 'feature', () => true);
  assert.equal(status.phase, 'on');
  assert.equal(status.confirmedEdition, 'cut1');
  assert.equal(status.offline, false);
});

test('下线已发出但未确认时仍标记可能播出', () => {
  const ledger = new PlayerLedger();
  ledger.observeReceipts([{ screen: 'P2', slot: 'feature', sequence: 1, action: 'on', state: 'applied' }]);
  ledger.dispatch({ screen: 'P2', slot: 'feature', action: 'on', edition: 'cut1' });
  ledger.dispatch({ screen: 'P2', slot: 'feature', action: 'off' });
  const status = ledger.status('P2', 'feature', () => true);
  assert.equal(status.phase, 'stopping-pending');
  assert.equal(status.mayStillPlay, true);
});

test('按回执还原放映场次，失联不算结束', () => {
  const ledger = new PlayerLedger();
  ledger.dispatch({ screen: 'P2', slot: 'feature', action: 'on', edition: 'cut1' });
  ledger.recordReceipt({ screen: 'P2', slot: 'feature', sequence: 1, action: 'on', state: 'applied', at: '2026-12-05T09:35:00+08:00' });
  ledger.dispatch({ screen: 'P2', slot: 'feature', action: 'off' });
  ledger.recordReceipt({ screen: 'P2', slot: 'feature', sequence: 2, action: 'off', state: 'offline' });
  const status = ledger.status('P2', 'feature', () => true);
  const sessions = ledger.sessions('P2', 'feature', status);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].edition, 'cut1');
  assert.equal(sessions[0].endedAt, null);
  assert.match(sessions[0].endReason, /失联/);
});

test('已确认的放映在收到下线回执后结束', () => {
  const ledger = new PlayerLedger();
  ledger.observeReceipts([
    { screen: 'P2', slot: 'feature', sequence: 1, action: 'on', state: 'applied', at: '2026-12-05T09:35:00+08:00' },
    { screen: 'P2', slot: 'feature', sequence: 2, action: 'off', state: 'applied', at: '2026-12-05T11:15:00+08:00' },
  ]);
  const status = ledger.status('P2', 'feature', () => true);
  const sessions = ledger.sessions('P2', 'feature', status);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].endedSequence, 2);
  assert.equal(sessions[0].endedAt, '2026-12-05T11:15:00+08:00');
});

test('回执时刻必须带时区', () => {
  const ledger = new PlayerLedger();
  const result = ledger.recordReceipt({ screen: 'P1', slot: 'feature', sequence: 1, action: 'on', state: 'applied', at: '2026-12-05T09:35:00' });
  assert.equal(result.ok, false);
  assert.match(result.error, /带时区/);
});

test('重复回执不重复计入', () => {
  const ledger = new PlayerLedger();
  const receipt = { screen: 'P1', slot: 'feature', sequence: 1, action: 'on', state: 'applied', at: '2026-12-05T09:35:00+08:00' };
  ledger.recordReceipt(receipt);
  const duplicate = ledger.recordReceipt(receipt);
  assert.equal(duplicate.duplicate, true);
  assert.equal(ledger.status('P1', 'feature', () => true).history.receipts.length, 1);
});
