// 编排引擎：把编目、授权、展期安排与终端回执串成一个个同步周期。
// 每个周期都重新采集并重新判断；历史只追加到日志，不覆盖。

import { parseCatalog, flattenEdition } from './catalog.mjs';
import { buildRightsModel, evaluateClearance } from './rights.mjs';
import { DistributionLedger } from './distribution.mjs';
import { instantWithOffset, parseInstant } from './time.mjs';
import { receiptFingerprint } from './journal.mjs';

export class CuratorEngine {
  constructor(client, journal, clock = () => new Date().toISOString()) {
    this.client = client;
    this.journal = journal;
    this.clock = clock;
    this.ledger = new DistributionLedger();
    this.seenReceipts = new Set();
    this.lastCycle = null;
  }

  async #collect() {
    const [catalogHtml, links, schedule, entries, amendments, receipts] = await Promise.all([
      this.client.getCatalog(),
      this.client.getLinks(),
      this.client.getSchedule(),
      this.client.getRightsEntries(),
      this.client.getAmendments(),
      this.client.getReceipts(),
    ]);
    return { catalogHtml, links, schedule, entries, amendments, receipts };
  }

  #fragments(flattened) {
    const describe = (segments) => segments.map((segment) => ({
      item: segment.item,
      range: [segment.start, segment.end],
      via: segment.via.map((step) => ({ part: step.part, range: [step.start, step.end] })),
    }));
    return { picture: describe(flattened.picture), sound: describe(flattened.sound) };
  }

  #gapView(gap) {
    return {
      track: gap.track,
      item: gap.item,
      materialRange: [gap.range.start, gap.range.end],
      // 以展期所在时区（+08:00）呈现半开生效时段，避免 UTC 换算造成误读。
      effectiveFrom: instantWithOffset(gap.timeRange[0]),
      effectiveTo: instantWithOffset(gap.timeRange[1]),
      missingType: gap.missingType,
      ...(gap.right ? { right: gap.right } : {}),
    };
  }

  #nextCommandFor(arrangement, current, replacement, now) {
    const status = this.ledger.status(arrangement.screen, arrangement.slot);
    const inWindow = parseInstant(arrangement.from) <= now && now < parseInstant(arrangement.to);
    if (!inWindow) return null;

    const targetEdition = arrangement.edition;
    const playingTarget = status.state === 'playing' && status.confirmedEdition === targetEdition;
    const pendingTarget = status.pending?.action === 'on' && status.pending?.edition === targetEdition;
    const pendingOff = status.pending?.action === 'off';

    if (current.verdict === 'cleared') {
      if (playingTarget || pendingTarget) return null;
      if (pendingOff) return null; // 先等下线确认，避免同一编目位命令交错
      return { action: 'on', edition: targetEdition };
    }
    if (current.verdict === 'blocked') {
      // 主版本须撤下：先保证停止，再考虑授权完整的替代成片。
      if (!(status.state === 'stopped' || status.state === 'never-issued' || status.state === 'idle')) {
        if (pendingOff) return null;
        return { action: 'off', edition: status.confirmedEdition ?? targetEdition };
      }
      if (replacement?.ready) {
        const playingAlt = status.state === 'playing' && status.confirmedEdition === replacement.edition;
        const pendingAlt = status.pending?.action === 'on' && status.pending?.edition === replacement.edition;
        if (!playingAlt && !pendingAlt) return { action: 'on', edition: replacement.edition };
      }
      return null;
    }
    // frozen：只冻结受影响的播放安排，不自动上下线，转人工联系。
    return null;
  }

  async sync(phase) {
    const at = this.clock();
    const now = parseInstant(at);
    const collected = await this.#collect();
    const editions = parseCatalog(collected.catalogHtml);
    const model = buildRightsModel(collected.entries, collected.amendments);

    const arrangements = [];
    const issued = [];

    for (const arrangement of collected.schedule) {
      const refs = editions.get(arrangement.edition);
      if (!refs) throw new TypeError(`展期安排引用了不存在的版本：${arrangement.edition}`);
      const flattened = flattenEdition(refs, collected.links);

      // 只就“当前时刻之后仍需播出”的窗口重新判断；历史缺口留给回看，不触发新命令。
      const windowStart = parseInstant(arrangement.from) > now ? parseInstant(arrangement.from) : now;
      const windowEnd = parseInstant(arrangement.to);
      const clearance = evaluateClearance(flattened, model, {
        venue: arrangement.venue,
        use: arrangement.use,
        windowStart,
        windowEnd,
      });

      const record = {
        screen: arrangement.screen,
        slot: arrangement.slot,
        venue: arrangement.venue,
        use: arrangement.use,
        edition: arrangement.edition,
        alternative: arrangement.alternative ?? null,
        window: { from: arrangement.from, to: arrangement.to },
        fragments: this.#fragments(flattened),
        clearance: {
          verdict: clearance.verdict,
          evidence: clearance.evidence,
          hardGaps: clearance.hardGaps.map((gap) => this.#gapView(gap)),
          freezeGaps: clearance.freezeGaps.map((gap) => this.#gapView(gap)),
        },
      };

      let replacement = null;
      if (arrangement.alternative) {
        const altRefs = editions.get(arrangement.alternative);
        const altFlat = flattenEdition(altRefs, collected.links);
        const altClearance = evaluateClearance(altFlat, model, {
          venue: arrangement.venue,
          use: arrangement.use,
          windowStart,
          windowEnd,
        });
        replacement = {
          edition: arrangement.alternative,
          verdict: altClearance.verdict,
          fragments: this.#fragments(altFlat),
          evidence: altClearance.evidence,
          hardGaps: altClearance.hardGaps.map((gap) => this.#gapView(gap)),
          freezeGaps: altClearance.freezeGaps.map((gap) => this.#gapView(gap)),
          ready: altClearance.verdict === 'cleared',
        };
      }
      const decision = this.#nextCommandFor(arrangement, clearance, replacement, now);
      record.replacement = replacement;
      record.decision = decision ? { ...decision, reason: clearance.verdict } : { action: 'hold', reason: clearance.verdict };
      arrangements.push(record);

      if (decision) {
        const sequence = this.ledger.status(arrangement.screen, arrangement.slot).sequence + 1;
        const command = {
          screen: arrangement.screen,
          slot: arrangement.slot,
          sequence,
          action: decision.action,
          edition: decision.edition,
          sentAt: at,
        };
        const result = this.ledger.issueCommand(command);
        if (result.accepted) {
          this.journal.append('command', command, at);
          let arrival = null;
          try {
            arrival = await this.client.postCommand({
              screen: command.screen,
              slot: command.slot,
              sequence: command.sequence,
              action: command.action,
              edition: command.edition,
            });
            this.ledger.markArrived(command.screen, command.slot, command.sequence, at);
            this.journal.append('arrived', {
              screen: command.screen,
              slot: command.slot,
              sequence: command.sequence,
              arrivedAt: at,
              response: arrival,
            }, at);
          } catch (error) {
            this.journal.append('command-error', { ...command, error: error.message }, at);
          }
          issued.push(command);
        }
      }
    }

    // 采集回执：迟到回执按序号规则处理，绝不复活已撤回版本。
    // 完全相同的轮询回报去重；同一命令“失联 -> 已应用”的状态推进必须继续处理。
    const receiptResults = [];
    for (const receipt of collected.receipts) {
      const fingerprint = receiptFingerprint(receipt);
      if (this.seenReceipts.has(fingerprint)) continue;
      this.seenReceipts.add(fingerprint);
      this.journal.append('receipt', receipt, receipt.at ?? at);
      receiptResults.push({ receipt, result: this.ledger.acceptReceipt(receipt, receipt.at ?? at) });
    }

    // 快照覆盖本轮全部展期安排，即使该编目位从未建账（如冻结/无授权）也要可见。
    const terminals = arrangements.map((arrangement) => {
      const status = this.ledger.status(arrangement.screen, arrangement.slot);
      const updated = status.state === 'playing'
        && arrangement.alternative
        && status.confirmedEdition === arrangement.alternative;
      return { ...status, slotUpdatedWithAlternative: updated };
    });

    const cycle = {
      phase,
      at,
      arrangements,
      issued,
      receipts: receiptResults.map((item) => ({
        ...item.receipt,
        ignored: item.result.ignored ?? false,
        ignoreReason: item.result.reason ?? null,
        needsManualContact: item.result.needsManualContact ?? false,
      })),
      terminals,
      manualContacts: [
        ...terminals
          .filter((status) => status.manualContact)
          .map((status) => ({
            screen: status.screen,
            slot: status.slot,
            reason: '下线尚未得到终端确认，设备仍可能播出；掉线不能以“已发出”冒充停止',
            pending: status.pending,
          })),
        ...arrangements
          .filter((item) => item.clearance.verdict === 'frozen')
          .map((item) => ({
            screen: item.screen,
            slot: item.slot,
            reason: '限定条款或来源断档待人工解释，播放安排已冻结',
            gaps: item.clearance.freezeGaps,
          })),
      ],
    };
    this.journal.append('cycle', cycle, at);
    this.lastCycle = cycle;
    return cycle;
  }
}
