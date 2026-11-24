// 分发账本：管理每台终端、每个编目位的发布序号与回执状态。
// 规则：
//  - 同一 (screen, slot) 只接受严格递增的 sequence；旧序号命令直接拒绝；
//  - 命令入口返回 arrived 只代表请求到达，可播放状态以设备回执为准；
//  - 迟到的“上线成功”回执序号若低于最新命令，仅留痕，不能复活已撤回版本；
//  - 下线在收到 applied 回执前仍是 may-play，offline/失联需要人工联系；
//  - 替代成片只有在对应使用范围完整且终端确认后，编目位才能记为 updated。

export class DistributionLedger {
  #entries = new Map();

  static key(screen, slot) {
    return `${screen}::${slot}`;
  }

  #ensure(screen, slot) {
    const key = DistributionLedger.key(screen, slot);
    if (!this.#entries.has(key)) {
      this.#entries.set(key, {
        screen,
        slot,
        sequence: 0,
        pending: null,
        confirmed: null,
        commands: [],
        receipts: [],
      });
    }
    return this.#entries.get(key);
  }

  /** 登记一条准备下发（或已下发）的命令，返回是否被序号规则接受。 */
  issueCommand({ screen, slot, sequence, action, edition, sentAt }) {
    const entry = this.#ensure(screen, slot);
    if (!Number.isInteger(sequence) || sequence <= 0) {
      return { accepted: false, reason: 'bad-sequence', expected: entry.sequence + 1 };
    }
    if (sequence !== entry.sequence + 1) {
      // 同一终端、同一编目位只接受严格递增且连续的发布序号；旧序号与跳号都拒绝。
      return { accepted: false, reason: sequence <= entry.sequence ? 'stale-sequence' : 'skipped-sequence', expected: entry.sequence + 1 };
    }
    const command = { screen, slot, sequence, action, edition: edition ?? null, sentAt, arrivedAt: null };
    entry.sequence = sequence;
    entry.pending = command;
    entry.commands.push(command);
    return { accepted: true, command };
  }

  /** 命令入口的 202/arrived 只表示到达分发服务。 */
  markArrived(screen, slot, sequence, arrivedAt) {
    const entry = this.#entries.get(DistributionLedger.key(screen, slot));
    const command = entry?.commands.find((item) => item.sequence === sequence);
    if (command && !command.arrivedAt) command.arrivedAt = arrivedAt;
    return Boolean(command);
  }

  /**
   * 处理一条设备回执。
   * @returns {applied, ignored, reason} ignored 时回执仍会留痕。
   */
  acceptReceipt(receipt, receivedAt) {
    const { screen, slot, sequence, action, state } = receipt;
    const entry = this.#ensure(screen, slot);
    const stored = { ...receipt, receivedAt };
    entry.receipts.push(stored);
    if (!Number.isInteger(sequence) || sequence <= 0) {
      return { applied: false, ignored: true, reason: 'bad-sequence' };
    }
    const command = entry.commands.find((item) => item.sequence === sequence);
    if (!command) {
      return { applied: false, ignored: true, reason: 'unknown-sequence' };
    }
    if (action !== command.action) {
      return { applied: false, ignored: true, reason: 'action-mismatch' };
    }
    if (sequence < entry.sequence) {
      // 迟到回执：序号已被后续命令超过，绝不能改写当前可播放状态。
      return { applied: false, ignored: true, reason: 'superseded-sequence' };
    }
    if (state === 'applied') {
      entry.confirmed = {
        screen,
        slot,
        sequence,
        action,
        edition: receipt.edition ?? command.edition,
        appliedAt: receipt.at ?? receivedAt,
      };
      entry.pending = null;
      return { applied: true, ignored: false, status: this.status(screen, slot) };
    }
    // offline（失联/未应用）：保持 pending，终端在确认下线前仍可能播出。
    if (state === 'offline') {
      entry.pending = { ...command, offlineSince: receipt.at ?? receivedAt };
      return { applied: false, ignored: false, needsManualContact: true, status: this.status(screen, slot) };
    }
    return { applied: false, ignored: true, reason: `unknown-state:${state}` };
  }

  status(screen, slot) {
    const entry = this.#entries.get(DistributionLedger.key(screen, slot));
    if (!entry) {
      return {
        screen,
        slot,
        sequence: 0,
        state: 'never-issued',
        mayPlay: false,
        manualContact: false,
        confirmedEdition: null,
        lastAppliedSequence: null,
        pending: null,
      };
    }
    const confirmed = entry.confirmed;
    const pending = entry.pending;
    let state;
    let mayPlay;
    if (pending && pending.action === 'off') {
      state = 'pending-offline';      // 下线指令未确认，仍可能播出
      mayPlay = true;
    } else if (pending && pending.action === 'on') {
      state = 'pending-activation';
      mayPlay = Boolean(confirmed?.action === 'on');
    } else if (confirmed?.action === 'on') {
      state = 'playing';
      mayPlay = true;
    } else if (confirmed?.action === 'off') {
      state = 'stopped';
      mayPlay = false;
    } else {
      state = 'idle';
      mayPlay = false;
    }
    return {
      screen,
      slot,
      sequence: entry.sequence,
      state,
      mayPlay,
      manualContact: state === 'pending-offline',
      confirmedEdition: confirmed?.action === 'on' ? confirmed.edition : null,
      lastAppliedSequence: confirmed?.sequence ?? null,
      pending: pending ? {
        sequence: pending.sequence,
        action: pending.action,
        edition: pending.edition ?? null,
        offlineSince: pending.offlineSince ?? null,
      } : null,
    };
  }

  /** 重放历史命令/回执重建账本（用于按时间回看与服务重启）。 */
  static replay(history) {
    const ledger = new DistributionLedger();
    for (const item of history) {
      if (item.kind === 'command') ledger.issueCommand(item.payload);
      else if (item.kind === 'receipt') ledger.acceptReceipt(item.payload, item.receivedAt);
      else if (item.kind === 'arrived') ledger.markArrived(item.screen, item.slot, item.sequence, item.arrivedAt);
    }
    return ledger;
  }
}
