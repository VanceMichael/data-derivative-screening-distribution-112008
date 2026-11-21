#!/usr/bin/env node
// 本地演练：启动合成来源与策展端，按演练阶段走一遍并打印策展人视角的结果。
// 全部在进程内完成，不接触真实影音或外部服务。
//
//   node scripts/demo.mjs
//
// 输出依次覆盖：预约阶段 → 权利方收窄 → 迟到回执 → 恢复。

import { once } from 'node:events';
import { createSource } from '../sources/source.mjs';
import { createSourceClient } from '../src/source-client.mjs';
import { CuratorService } from '../src/curator.mjs';

const SOURCE = createSource();
SOURCE.listen(0, '127.0.0.1');
await once(SOURCE, 'listening');
const baseUrl = `http://127.0.0.1:${SOURCE.address().port}`;
const service = new CuratorService({ source: createSourceClient({ baseUrl }) });

async function step(name) {
  await fetch(`${baseUrl}/_source_clock?step=${name}`, { method: 'PUT' });
  await service.sync();
}

function line(text = '') {
  process.stdout.write(text + '\n');
}

function describe(at) {
  const plan = service.plan(at);
  line(`  判断时刻 ${at}`);
  for (const item of plan.arrangements) {
    line(`  ${item.screen}/${item.slot}（${item.venue} · ${item.use}）`);
    line(`    当前版 ${item.edition}：${item.current.covered ? '授权完整' : '授权不足'}`
      + (item.current.nextChange ? `，依据只到 ${item.current.nextChange}` : ''));
    for (const gap of item.current.gaps) {
      line(`    缺口：${gap.track === 'sound' ? '声音' : '画面'} ${gap.item} `
        + `${gap.material.start}–${gap.material.end} 秒 · ${gap.missingLabel}`);
    }
    if (item.alternativeCheck) {
      line(`    替换版 ${item.alternative}：${item.alternativeCheck.covered ? '可用' : '不可用'}`);
    }
    line(`    终端：${item.player.phase}${item.player.note ? ` · ${item.player.note}` : ''}`);
    line(`    建议动作：${item.action}${item.targetEdition ? ` → ${item.targetEdition}` : ''}`
      + (item.reason ? `（${item.reason}）` : ''));
  }
  for (const item of service.status(at).attention) {
    line(`  ⚠ 需要人工处理 [${item.kind}] ${item.screen}/${item.slot}：${item.detail}`);
  }
}

line('== 预约阶段（booking）');
await step('booking');
describe('2026-12-05T09:30:00+08:00');
const first = await service.reconcile('2026-12-05T09:30:00+08:00');
line(`  已发出命令 ${first.dispatched.length} 条`);

line('\n== 权利方收窄（restrict）');
await step('restrict');
describe('2026-12-05T10:30:00+08:00');
const second = await service.reconcile('2026-12-05T10:30:00+08:00');
line(`  已发出命令 ${second.dispatched.length} 条`);

line('\n== 迟到回执（late）');
await step('late');
describe('2026-12-05T11:30:00+08:00');

line('\n== 恢复（restore）');
await step('restore');
describe('2026-12-05T14:30:00+08:00');
const third = await service.reconcile('2026-12-05T14:30:00+08:00');
line(`  已发出命令 ${third.dispatched.length} 条`);

line('\n== 按一次已发生的放映回看 P2/feature');
const lookup = service.screenings('P2', 'feature');
if (!lookup || lookup.sessions.length === 0) {
  line('  没有放映记录');
} else {
  for (const session of lookup.sessions) {
    line(`  ${session.edition}：${session.startedAt ?? '（时刻未标注）'} → ${session.endedAt ?? '未确认停止'}`);
    line(`    结束原因：${session.endReason}`);
    if (session.material) {
      for (const track of session.material) {
        line(`    ${track.track === 'sound' ? '声音' : '画面'}：`
          + track.segments.map((segment) => `${segment.item} ${segment.start}–${segment.end} 秒`).join('；'));
      }
    }
    const source = { dispatch: '下发时记录', reconstructed: '按回执时刻回算', missing: '无记录' }[session.evidenceSource];
    line(`    当时依据的授权（${source}）：${(session.rights ?? []).map((right) => right.id).join('、') || '（无记录）'}`);
  }
}

line('\n== 已发出的命令（审计）');
for (const record of service.audit.filter((entry) => entry.kind === 'command')) {
  line(`  ${record.screen}/${record.slot} #${record.sequence} ${record.action}`
    + `${record.edition ? ` ${record.edition}` : ''} · ${record.reason ?? ''}`);
}

// 把每条命令与终端回执对上：只有动作与版号一致的"已应用"回执才算确认。
line('\n== 命令与回执核对');
for (const slot of service.plan('2026-12-05T14:30:00+08:00').slots) {
  const item = slot.arrangements[0];
  for (const command of item.player.history.commands) {
    const confirmed = item.player.history.latestReceipts.find((receipt) => receipt.sequence === command.sequence
      && receipt.state === 'applied' && receipt.action === command.action);
    line(`  ${command.screen}/${command.slot} #${command.sequence} ${command.action}`
      + `${command.edition ? ` ${command.edition}` : ''}：${confirmed ? '已确认' : '未见一致回执'}`);
  }
  for (const conflict of item.player.history.conflicts) {
    line(`  ⚠ #${conflict.receipt.sequence} 回执（${conflict.receipt.action}${conflict.receipt.edition ? ` ${conflict.receipt.edition}` : ''}）`
      + `与本地命令（${conflict.command.action}${conflict.command.edition ? ` ${conflict.command.edition}` : ''}）不一致，已拒绝采信`);
  }
}

SOURCE.close();
