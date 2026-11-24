// 策展人 CLI：
//   schedule                 查看展期安排、片段、许可依据、终端与人工联系点
//   contacts                 只看待人工联系的点位
//   playback <screen> <slot> --at <iso>  按一次已发生的放映回看
// 默认读取 var/demo-journal.jsonl，可用 --journal 指定，可用 --json 输出机器可读结果。

import { Journal } from './journal.mjs';
import { buildScheduleView, buildPlaybackView } from './views.mjs';
import { renderSchedule, renderPlayback } from './render.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        index += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;
const journalPath = flags.journal ?? new URL('../var/demo-journal.jsonl', import.meta.url).pathname;
const events = new Journal(journalPath).read();

if (command === 'schedule') {
  const view = buildScheduleView(events);
  process.stdout.write(flags.json ? `${JSON.stringify(view, null, 2)}\n` : renderSchedule(view));
} else if (command === 'contacts') {
  const view = buildScheduleView(events);
  const contacts = view.arrangements.filter((item) => item.needsManualContact)
    .map((item) => ({
      screen: item.screen,
      slot: item.slot,
      reason: item.manualReason,
      terminal: item.terminal,
      gaps: item.clearance.gaps,
    }));
  process.stdout.write(flags.json ? `${JSON.stringify(contacts, null, 2)}\n` : renderSchedule({ ...view, arrangements: view.arrangements.filter((item) => item.needsManualContact) }));
} else if (command === 'playback') {
  const [screen, slot] = rest;
  const at = flags.at;
  if (!screen || !slot || !at) {
    process.stderr.write('用法：playback <screen> <slot> --at <带时区的 ISO 时间>\n');
    process.exitCode = 1;
  } else {
    const view = buildPlaybackView(events, screen, slot, at);
    process.stdout.write(flags.json ? `${JSON.stringify(view, null, 2)}\n` : renderPlayback(view));
  }
} else {
  process.stderr.write('用法：node src/cli.mjs <schedule|contacts|playback ...> [--journal path] [--json]\n');
  process.exitCode = 1;
}
