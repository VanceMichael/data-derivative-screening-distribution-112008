// 策展查询：从事件日志重建“现在能看到什么”与“某次放映当时用了什么”。

import { parseInstant, instantToIso } from './time.mjs';
import { DistributionLedger } from './distribution.mjs';
import { replayJournal } from './journal.mjs';

const VERDICT_LABEL = {
  cleared: '依据完整，可播放',
  blocked: '授权缺口，须撤下',
  frozen: '限定条款待解释，已冻结',
};

/** 展期安排视图：成片片段、当前许可依据、已确认终端、需要人工联系的点位。 */
export function buildScheduleView(events) {
  const { cycles, ledger } = replayJournal(events, DistributionLedger);
  const latest = cycles.at(-1);
  if (!latest) return { generatedAt: null, arrangements: [], manualContacts: [] };

  const arrangements = latest.arrangements.map((item) => {
    const terminal = ledger.status(item.screen, item.slot);
    const frozen = item.clearance.verdict === 'frozen';
    const blocked = item.clearance.verdict === 'blocked';
    return {
      screen: item.screen,
      slot: item.slot,
      venue: item.venue,
      use: item.use,
      edition: item.edition,
      window: item.window,
      fragments: item.fragments,
      clearance: {
        verdict: item.clearance.verdict,
        label: VERDICT_LABEL[item.clearance.verdict],
        evidence: item.clearance.evidence,
        gaps: [...item.clearance.hardGaps, ...item.clearance.freezeGaps],
      },
      terminal,
      needsManualContact: terminal.manualContact || frozen,
      manualReason: terminal.manualContact
        ? '等待终端确认下线，设备仍可能播出'
        : frozen
          ? '限定条款或来源断档待人工解释'
          : null,
      replacement: item.replacement && {
        edition: item.replacement.edition,
        ready: item.replacement.ready,
        verdict: item.replacement.verdict,
        // 替代成片必须使用范围完整并得到终端确认后，编目位才算已更新。
        slotUpdated: terminal.state === 'playing' && terminal.confirmedEdition === item.replacement.edition,
        gaps: [...item.replacement.hardGaps, ...item.replacement.freezeGaps],
      },
      decision: item.decision,
    };
  });

  return {
    generatedAt: latest.at,
    phase: latest.phase,
    arrangements,
    manualContacts: latest.manualContacts,
  };
}

/**
 * 按一次已发生的放映回看：给定屏幕、编目位与时点，
 * 返回当时终端实际确认在播的版本、该版本的原始片段与当时的授权依据。
 */
export function buildPlaybackView(events, screen, slot, atIso) {
  const point = parseInstant(atIso);
  const { cycles, ledger } = replayJournal(events, DistributionLedger);

  // 时点之前最后一个已确认的设备状态。
  const status = ledger.status(screen, slot);
  let confirmedAt = null;
  let confirmedAtPoint = null;
  for (const event of events) {
    if (event.kind !== 'receipt') continue;
    const receipt = event.payload;
    if (receipt.screen !== screen || receipt.slot !== slot || receipt.state !== 'applied') continue;
    const appliedAt = parseInstant(receipt.at ?? event.at);
    if (appliedAt <= point && (confirmedAtPoint === null || appliedAt > confirmedAtPoint)) {
      confirmedAtPoint = appliedAt;
      // 回执可能不重复版号（合成源如此），从同序号命令回填实际版本。
      const command = events.find(
        (item) => item.kind === 'command'
          && item.payload.screen === screen
          && item.payload.slot === slot
          && item.payload.sequence === receipt.sequence,
      );
      confirmedAt = { ...receipt, edition: receipt.edition ?? command?.payload.edition ?? null, eventAt: event.at };
    }
  }

  // 时点所属展期窗口与当时最近一轮判断。
  const cycleAtPoint = cycles
    .filter((cycle) => parseInstant(cycle.at) <= point)
    .at(-1) ?? null;
  const arrangementAtPoint = cycleAtPoint?.arrangements
    .find((item) => item.screen === screen && item.slot === slot) ?? null;

  const playing = confirmedAt?.action === 'on' ? confirmedAt.edition : null;

  // 实际在播版本（可能是替代成片）在时点之前最近一次同步中的片段与授权依据。
  let playedEdition = null;
  if (playing) {
    for (let index = cycles.length - 1; index >= 0; index -= 1) {
      if (parseInstant(cycles[index].at) > point) continue;
      const arrangement = cycles[index].arrangements
        .find((item) => item.screen === screen && item.slot === slot);
      if (!arrangement) continue;
      if (arrangement.edition === playing) {
        playedEdition = {
          edition: arrangement.edition,
          venue: arrangement.venue,
          use: arrangement.use,
          fragments: arrangement.fragments,
          clearanceAtCycle: arrangement.clearance,
          evidence: arrangement.clearance.evidence,
        };
        break;
      }
      if (arrangement.replacement?.edition === playing) {
        playedEdition = {
          edition: arrangement.replacement.edition,
          venue: arrangement.venue,
          use: arrangement.use,
          fragments: arrangement.replacement.fragments,
          clearanceAtCycle: {
            verdict: arrangement.replacement.verdict,
            evidence: arrangement.replacement.evidence,
            hardGaps: arrangement.replacement.hardGaps,
            freezeGaps: arrangement.replacement.freezeGaps,
          },
          evidence: arrangement.replacement.evidence,
        };
        break;
      }
    }
  }

  return {
    screen,
    slot,
    at: atIso,
    terminalStatusAtPoint: {
      playing: Boolean(playing),
      confirmedReceipt: confirmedAt
        ? {
            sequence: confirmedAt.sequence,
            action: confirmedAt.action,
            edition: confirmedAt.edition ?? null,
            appliedAt: confirmedAt.at ?? instantToIso(confirmedAtPoint),
          }
        : null,
      currentLedgerStatus: status,
    },
    editionPlayed: playing,
    playedEdition,
    scheduledEdition: arrangementAtPoint && {
      edition: arrangementAtPoint.edition,
      venue: arrangementAtPoint.venue,
      use: arrangementAtPoint.use,
      window: arrangementAtPoint.window,
    },
    note: playing
      ? '该时点终端确认在播上述版本；授权依据取自时点之前最近一次同步判断。'
      : '该时点没有找到“上线已应用”的终端确认，不能视为已放映。',
  };
}
