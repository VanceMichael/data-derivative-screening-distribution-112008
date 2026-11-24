// 追加式事件日志：每次同步的判断、下发命令、到达回执与设备回执都只追加不改写。
// 同一条设备回执可能在多次同步中重复出现，按回执指纹去重后再落账。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class Journal {
  constructor(path) {
    this.path = path;
    this.memory = path ? null : [];
  }

  append(kind, payload, at) {
    const event = { kind, at, payload };
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(event)}\n`);
    } else {
      this.memory.push(event);
    }
  }

  read() {
    if (!this.path) return this.memory;
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }
}

export function receiptFingerprint(receipt) {
  // 标识“哪条命令的哪一次状态回报”：同一序号先 offline 后 applied 是两次回报，
  // 都要入账；完全重复的轮询结果才去重。
  return [
    receipt.screen,
    receipt.slot,
    receipt.sequence,
    receipt.action,
    receipt.state,
    receipt.at ?? '',
  ].join('|');
}

/** 按时间轴重放日志，返回逐轮决策与终端状态，供“按一次放映回看”。 */
export function replayJournal(events, ledgerClass) {
  const ledger = new ledgerClass();
  const cycles = [];
  for (const event of events) {
    if (event.kind === 'cycle') cycles.push({ ...event.payload, at: event.at });
    else if (event.kind === 'command') ledger.issueCommand(event.payload);
    else if (event.kind === 'arrived') {
      ledger.markArrived(event.screen, event.slot, event.sequence, event.arrivedAt);
    } else if (event.kind === 'receipt') {
      ledger.acceptReceipt(event.payload, event.at);
    }
  }
  return { cycles, ledger };
}
