// 端到端演练：进程内启动合成上游，按 booking/restrict/late/restore 推进，
// 逐轮采集、判断、下发、收回执，并落追加日志；最后给出策展视图与放映回看。
// 不传输真实影音，全部为本地合成数据。

import { once } from 'node:events';
import { createSource } from '../sources/source.mjs';
import { SourceClient } from './client.mjs';
import { Journal } from './journal.mjs';
import { CuratorEngine } from './orchestrator.mjs';
import { buildScheduleView, buildPlaybackView } from './views.mjs';
import { renderSchedule, renderPlayback } from './render.mjs';

const PHASE_CLOCK = {
  booking: '2026-12-05T09:30:00+08:00',
  restrict: '2026-12-05T10:05:00+08:00',
  late: '2026-12-05T11:20:00+08:00',
  restore: '2026-12-05T14:05:00+08:00',
};

export async function runDemo({ journalPath = null, port = 0, phases = Object.keys(PHASE_CLOCK), playbackAt = '2026-12-05T10:30:00+08:00' } = {}) {
  const server = createSource();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new SourceClient(baseUrl);
  const journal = new Journal(journalPath);
  const engine = new CuratorEngine(client, journal, () => clockNow);
  const cycles = [];
  let clockNow = PHASE_CLOCK[phases[0]];

  try {
    await client.health();
    for (const phase of phases) {
      clockNow = PHASE_CLOCK[phase];
      const switched = await fetch(`${baseUrl}/_source_clock?step=${phase}`, { method: 'PUT' });
      if (!switched.ok) throw new Error(`演练时钟推进失败：${phase}`);
      cycles.push(await engine.sync(phase));
    }
    const events = journal.read();
    const scheduleView = buildScheduleView(events);
    const playbackView = buildPlaybackView(events, 'P2', 'feature', playbackAt);
    return { baseUrl, cycles, scheduleView, playbackView, journalPath };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const journalPath = process.env.JOURNAL_PATH ?? new URL('../var/demo-journal.jsonl', import.meta.url).pathname;
  const result = await runDemo({ journalPath });
  process.stdout.write(renderSchedule(result.scheduleView));
  process.stdout.write('\n');
  process.stdout.write(renderPlayback(result.playbackView));
  process.stdout.write(`\n事件日志：${journalPath}\n`);
}
