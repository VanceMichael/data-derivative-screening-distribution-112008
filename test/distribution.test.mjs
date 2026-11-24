import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DistributionLedger } from '../src/distribution.mjs';

const T1 = '2026-12-05T09:30:00+08:00';
const T2 = '2026-12-05T10:05:00+08:00';
const T3 = '2026-12-05T11:15:00+08:00';

test('同一终端同一编目位只接受递增发布序号', () => {
  const ledger = new DistributionLedger();
  assert.equal(ledger.issueCommand({ screen: 'P2', slot: 'feature', sequence: 1, action: 'on', edition: 'cut1', sentAt: T1 }).accepted, true);
  assert.equal(ledger.issueCommand({ screen: 'P2', slot: 'feature', sequence: 1, action: 'on', edition: 'cut1', sentAt: T1 }).accepted, false);
  const rejected = ledger.issueCommand({ screen: 'P2', slot: 'feature', sequence: 3, action: 'off', edition: 'cut1', sentAt: T2 });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.expected, 2);
});

test('命令到达不等于设备应用：未收回执前上线仍是待确认', () => {
  const ledger = new DistributionLedger();
  ledger.issueCommand({ screen: 'P2', slot: 'feature', sequence: 1, action: 'on', edition: 'cut1', sentAt: T1 });
  ledger.markArrived('P2', 'feature', 1, T1);
  const status = ledger.status('P2', 'feature');
  assert.equal(status.state, 'pending-activation');
  assert.equal(status.mayPlay, false);
});

test('下线确认前仍可能播出，失联不能以已发出冒充停止', () => {
  const ledger = new DistributionLedger();
  ledger.issueCommand({ screen: 'P2', slot: 'feature', sequence: 1, action: 'on', edition: 'cut1', sentAt: T1 });
  ledger.acceptReceipt({ screen: 'P2', slot: 'feature', sequence: 1, action: 'on', state: 'applied' }, T1);
  ledger.issueCommand({ screen: 'P2', slot: 'feature', sequence: 2, action: 'off', edition: 'cut1', sentAt: T2 });
  const offline = ledger.acceptReceipt(
    { screen: 'P2', slot: 'feature', sequence: 2, action: 'off', state: 'offline' },
    T2,
  );
  assert.equal(offline.needsManualContact, true);
  const status = ledger.status('P2', 'feature');
  assert.equal(status.state, 'pending-offline');
  assert.equal(status.mayPlay, true);
  assert.equal(status.manualContact, true);

  ledger.acceptReceipt(
    { screen: 'P2', slot: 'feature', sequence: 2, action: 'off', state: 'applied', at: T3 },
    T3,
  );
  const stopped = ledger.status('P2', 'feature');
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.mayPlay, false);
});

test('先前成功的上线回执迟到，不能把随后撤回的版本改回可播放', () => {
  const ledger = new DistributionLedger();
  ledger.issueCommand({ screen: 'P2', slot: 'feature', sequence: 1, action: 'on', edition: 'cut1', sentAt: T1 });
  ledger.acceptReceipt({ screen: 'P2', slot: 'feature', sequence: 1, action: 'on', state: 'applied', at: T1 }, T1);
  ledger.issueCommand({ screen: 'P2', slot: 'feature', sequence: 2, action: 'off', edition: 'cut1', sentAt: T2 });
  ledger.acceptReceipt({ screen: 'P2', slot: 'feature', sequence: 2, action: 'off', state: 'applied', at: T2 }, T2);

  // 序号 1 的上线回执因网络原因晚到：留痕但必须被忽略。
  const late = ledger.acceptReceipt(
    { screen: 'P2', slot: 'feature', sequence: 1, action: 'on', state: 'applied', at: T3 },
    T3,
  );
  assert.equal(late.ignored, true);
  assert.equal(late.reason, 'superseded-sequence');
  assert.equal(ledger.status('P2', 'feature').state, 'stopped');
  assert.equal(ledger.status('P2', 'feature').mayPlay, false);
});

test('替代成片在终端确认后才把编目位记为已更新', () => {
  const ledger = new DistributionLedger();
  ledger.issueCommand({ screen: 'P2', slot: 'feature', sequence: 1, action: 'on', edition: 'cut1', sentAt: T1 });
  ledger.acceptReceipt({ screen: 'P2', slot: 'feature', sequence: 1, action: 'on', state: 'applied' }, T1);
  ledger.issueCommand({ screen: 'P2', slot: 'feature', sequence: 2, action: 'off', edition: 'cut1', sentAt: T2 });
  ledger.acceptReceipt({ screen: 'P2', slot: 'feature', sequence: 2, action: 'off', state: 'applied' }, T2);
  ledger.issueCommand({ screen: 'P2', slot: 'feature', sequence: 3, action: 'on', edition: 'cut2', sentAt: T3 });
  assert.equal(ledger.status('P2', 'feature').state, 'pending-activation');
  ledger.acceptReceipt(
    { screen: 'P2', slot: 'feature', sequence: 3, action: 'on', edition: 'cut2', state: 'applied', at: T3 },
    T3,
  );
  const status = ledger.status('P2', 'feature');
  assert.equal(status.state, 'playing');
  assert.equal(status.confirmedEdition, 'cut2');
});

test('账本可由历史命令与回执重放重建', () => {
  const history = [
    { kind: 'command', payload: { screen: 'P1', slot: 'feature', sequence: 1, action: 'on', edition: 'cut1', sentAt: T1 } },
    { kind: 'receipt', payload: { screen: 'P1', slot: 'feature', sequence: 1, action: 'on', state: 'applied' }, receivedAt: T1 },
  ];
  const ledger = DistributionLedger.replay(history);
  assert.equal(ledger.status('P1', 'feature').state, 'playing');
});
