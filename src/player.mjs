// 分发侧对每台终端、每个编目位的发布台账。
//
// 设计要点：
//   * 发布序号（sequence）按 screen+slot 严格递增，旧序号既不能下发也不认回执；
//   * 回执可能晚于下一次权利变更到达，所以"最近一次成功上线"不能直接等于
//     "现在可播放"：还要看之后是否已有下线意图、版本是否仍有授权；
//   * 设备失联时 state=offline，只能算"未确认停止"，不能用本地已发出冒充停止；
//   * 替换成片可以先行准备，但只有授权完整且终端回执确认后才能标为已更新。
//
// 台账本身不判断授权，由调用方传入 isAllowed(edition) 或从 status 结果自行判断。

import { isZonedInstant } from './time.mjs';

const VALID_ACTIONS = new Set(['on', 'off']);
const VALID_RECEIPT_STATES = new Set(['received', 'applied', 'offline']);

function keyOf(screen, slot) {
  return `${screen}\u0000${slot}`;
}

function normalizeReceipt(raw) {
  const sequence = Number(raw?.sequence);
  const state = raw?.state;
  const action = raw?.action;
  if (!Number.isInteger(sequence) || sequence < 1) return { error: '回执缺少正整数序号' };
  if (!VALID_RECEIPT_STATES.has(state)) return { error: '回执状态必须是 received、applied 或 offline' };
  if (!VALID_ACTIONS.has(action)) return { error: '回执动作必须是 on 或 off' };
  if (raw.at !== undefined && raw.at !== null && !isZonedInstant(raw.at)) {
    return { error: '回执时刻必须带时区' };
  }
  return {
    receipt: {
      screen: raw.screen,
      slot: raw.slot,
      sequence,
      action,
      edition: typeof raw?.edition === 'string' && raw.edition !== '' ? raw.edition : null,
      state,
      at: typeof raw?.at === 'string' ? raw.at : null,
      reason: typeof raw?.reason === 'string' ? raw.reason : null,
    },
  };
}

export class PlayerLedger {
  constructor() {
    this.slots = new Map();
    this.rejections = [];
  }

  ensure(screen, slot) {
    const key = keyOf(screen, slot);
    let entry = this.slots.get(key);
    if (!entry) {
      entry = {
        screen,
        slot,
        lastSequence: 0,
        commands: [],
        // 按序号保留每个序号最后一次被看到的回执（离线后转应用会覆盖）。
        bySequence: new Map(),
        receiptLog: [],
        staleReceipts: [],
        conflicts: [],
        lastApplied: null,
        evidence: new Map(),
      };
      this.slots.set(key, entry);
    }
    return entry;
  }

  // 从已有回执初始化序号与确认状态，避免新进程用更小的序号覆盖终端上更高的发布号。
  observeReceipts(list) {
    const results = [];
    for (const raw of Array.isArray(list) ? list : []) results.push(this.recordReceipt(raw));
    return results;
  }

  dispatch({ screen, slot, sequence, action, edition, reason = null, at = null, evidence = null }) {
    if (typeof screen !== 'string' || typeof slot !== 'string') {
      return { ok: false, error: '发布命令缺少 screen 或 slot', code: 'invalid-command' };
    }
    if (!VALID_ACTIONS.has(action)) {
      return { ok: false, error: '发布命令动作必须是 on 或 off', code: 'invalid-command' };
    }
    if (action === 'on' && (typeof edition !== 'string' || edition === '')) {
      return { ok: false, error: '上线命令缺少版号', code: 'invalid-command' };
    }
    const entry = this.ensure(screen, slot);
    const next = sequence === undefined ? entry.lastSequence + 1 : Number(sequence);
    if (!Number.isInteger(next) || next < 1) {
      return { ok: false, error: '发布序号必须是正整数', code: 'invalid-sequence' };
    }
    if (next <= entry.lastSequence) {
      const error = `编目位 ${screen}/${slot} 只接受递增序号：${next} ≤ 已用 ${entry.lastSequence}`;
      this.rejections.push({ screen, slot, sequence: next, error, at: new Date().toISOString() });
      return { ok: false, error, code: 'non-monotonic' };
    }
    entry.lastSequence = next;
    const command = {
      screen,
      slot,
      sequence: next,
      action,
      edition: action === 'on' ? edition : (edition ?? null),
      reason,
      at,
      dispatchedAt: new Date().toISOString(),
    };
    entry.commands.push(command);
    if (evidence && action === 'on') entry.evidence.set(next, evidence);
    return { ok: true, sequence: next, command };
  }

  // 记录一次回执。序号较小的"已应用"回执晚到时只做审计，不改变当前状态。
  recordReceipt(raw) {
    if (typeof raw?.screen !== 'string' || typeof raw?.slot !== 'string') {
      return { ok: false, error: '回执缺少 screen 或 slot' };
    }
    const normalized = normalizeReceipt(raw);
    if (normalized.error) return { ok: false, error: normalized.error };
    const receipt = { ...normalized.receipt, receivedAt: new Date().toISOString() };
    const entry = this.ensure(raw.screen, raw.slot);

    if (receipt.sequence > entry.lastSequence) entry.lastSequence = receipt.sequence;

    const previous = entry.bySequence.get(receipt.sequence);
    if (previous && previous.state === receipt.state && previous.at === receipt.at
      && previous.edition === receipt.edition) {
      return { ok: true, duplicate: true, receipt: previous };
    }

    // 身份冲突：该序号在本台账里有命令，但回执的动作或版号与命令不一致。
    // 这可能是别的发布者用了同一序号，或回执串台；无论哪种都不能当作本命令
    // 的确认，否则"已发出下线"会被一条上线回执伪装成已执行。
    const command = this.commandFor(entry, receipt.sequence);
    const conflicting = command
      && (command.action !== receipt.action
        || (command.action === 'on' && receipt.edition !== null && command.edition !== receipt.edition));
    if (conflicting) {
      entry.receiptLog.push(receipt);
      entry.conflicts.push({ receipt, command });
      return { ok: false, conflict: true, receipt, command };
    }

    // "迟到"的判据：该已应用回执的序号小于当前已确认的最高序号。
    // 它只证明"当时曾应用过"，不能把随后已达成的下线或换版改回去；
    // 保留在 staleReceipts 里作为审计证据。
    // 比已确认序号高、但小于最后下发序号的回执仍然有效（例如下线回执晚到），
    // 会推进已确认状态；未确认的新命令由 status 单独标出。
    const confirmedBefore = entry.lastApplied?.sequence ?? null;
    const isStale = receipt.state === 'applied'
      && confirmedBefore !== null && receipt.sequence < confirmedBefore;
    entry.receiptLog.push(receipt);
    entry.bySequence.set(receipt.sequence, receipt);

    if (isStale) {
      entry.staleReceipts.push(receipt);
      return { ok: true, stale: true, receipt };
    }

    // 只有更高的已应用序号才能推进确认状态；同一序号以最后一次看到的状态为准。
    if (receipt.state === 'applied') {
      if (entry.lastApplied === null || receipt.sequence >= entry.lastApplied.sequence) {
        entry.lastApplied = receipt;
      }
    }
    return { ok: true, stale: false, receipt };
  }

  // 只有"最新观察到的回执"才是离线，不能拿已被后续应用覆盖的旧离线回执。
  latestOffline(entry) {
    let latest = null;
    for (const receipt of entry.bySequence.values()) {
      if (!latest || receipt.sequence > latest.sequence) latest = receipt;
    }
    return latest?.state === 'offline' ? latest : null;
  }

  // 通道上最近一次"意图"：本地命令与来源回执都算。用于避免重复下发——
  // 若终端通道上已经有一条同动作（含版号）的命令在等待确认，再发一条只会
  // 推高序号并制造身份冲突。
  pendingIntent(screen, slot) {
    const entry = this.ensure(screen, slot);
    const candidates = [];
    for (const command of entry.commands) {
      candidates.push({
        sequence: command.sequence,
        action: command.action,
        edition: command.edition,
        source: 'command',
      });
    }
    for (const receipt of entry.bySequence.values()) {
      if (this.commandFor(entry, receipt.sequence)) continue;
      candidates.push({
        sequence: receipt.sequence,
        action: receipt.action,
        edition: receipt.action === 'on' ? this.resolveReceiptEdition(entry, receipt) : null,
        state: receipt.state,
        source: 'receipt',
      });
    }
    candidates.sort((a, b) => a.sequence - b.sequence);
    return candidates.at(-1) ?? null;
  }

  latestReceipt(entry) {
    let latest = null;
    for (const receipt of entry.bySequence.values()) {
      if (!latest || receipt.sequence > latest.sequence) latest = receipt;
    }
    return latest;
  }

  commandFor(entry, sequence) {
    return entry.commands.find((command) => command.sequence === sequence) ?? null;
  }

  // 回执未带版号时，用该序号的命令补全；该序号没有命令时再看该终端最近一次上线命令。
  resolveReceiptEdition(entry, receipt, fallbackEdition = null) {
    return receipt.edition
      ?? this.commandFor(entry, receipt.sequence)?.edition
      ?? [...entry.commands].reverse().find((command) => command.action === 'on')?.edition
      ?? fallbackEdition;
  }

  // 给策展人的总览：每个编目位的授权、确认状态与需人工联系的点。
  //
  // 判断顺序（与业务规则一致）：
  //   1. 最近一次观察到的回执是 offline → 失联，不能视为停止；
  //   2. 没有任何已应用回执 → 只有"命令已发出"，不能视为上线或停止；
  //   3. 已确认停止（最后一条已应用回执是 off）→ off；
  //   4. 已应用回执是 on：若之后已有更高序号的下线意图且未确认 → 仍可能播出；
  //      若该版当前不能完整授权 → 不算可播放，需下线；
  //      否则 on。
  status(screen, slot, isAllowed = () => true, fallbackEdition = null) {
    const entry = this.ensure(screen, slot);
    const latestCommand = entry.commands.at(-1) ?? null;
    const applied = entry.lastApplied;
    const offline = this.latestOffline(entry);

    const appliedEdition = applied
      ? this.resolveReceiptEdition(entry, applied, applied.action === 'on' ? fallbackEdition : null)
      : null;
    const confirmedOn = applied?.action === 'on';
    const playingEdition = confirmedOn ? appliedEdition : null;

    let phase;
    let mayStillPlay = false;
    let playing = false;
    let note = null;

    const offIntent = latestCommand?.action === 'off' && (!applied || latestCommand.sequence > applied.sequence);

    if (offline) {
      phase = 'offline';
      mayStillPlay = Boolean(confirmedOn);
      note = confirmedOn
        ? `终端失联，最后一次确认在播 ${appliedEdition ?? '（版号未标注）'}（序号 ${applied.sequence}），不能视为已停止`
        : '终端失联，尚无确认的播出状态';
    } else if (!applied) {
      phase = latestCommand?.action === 'off' ? 'stopping-pending' : 'starting-pending';
      mayStillPlay = latestCommand?.action === 'off';
      note = latestCommand ? '命令已发出但终端尚未确认' : '尚无回执';
    } else if (applied.action === 'off') {
      if (latestCommand && latestCommand.sequence > applied.sequence && latestCommand.action === 'on') {
        phase = 'starting-pending';
        note = `上线命令序号 ${latestCommand.sequence} 尚未确认（已确认停止到 ${applied.sequence}）`;
      } else if (latestCommand && latestCommand.sequence > applied.sequence && latestCommand.action === 'off') {
        phase = 'off';
        note = `已确认停止（序号 ${applied.sequence}）`;
      } else {
        phase = 'off';
        note = '已确认停止';
      }
    } else if (offIntent) {
      phase = 'stopping-pending';
      mayStillPlay = true;
      note = `序号 ${latestCommand.sequence} 的下线尚未确认（已确认到 ${applied.sequence}），仍可能播出`;
    } else if (latestCommand && latestCommand.sequence > applied.sequence && latestCommand.action === 'on'
      && latestCommand.edition !== appliedEdition) {
      // 更高序号的上线命令尚未确认：旧版回执仍是当前唯一确认的播出状态。
      phase = 'starting-pending';
      mayStillPlay = true;
      playing = false;
      note = `序号 ${latestCommand.sequence} 的上线尚未确认，终端仍可能播出 ${appliedEdition ?? '旧版'}（序号 ${applied.sequence}）`;
    } else if (!isAllowed(appliedEdition)) {
      // 旧回执证明"曾确认在播"，但它不能把已失去授权的版本变成现在可播放。
      phase = 'playing-unlicensed';
      mayStillPlay = true;
      playing = false;
      note = `${appliedEdition ?? '当前版'} 的回执仍在，但该版已不能完整授权，需下线并等待回执`;
    } else {
      phase = 'on';
      playing = true;
      note = `已确认在播 ${appliedEdition ?? '（版号未标注）'}`;
    }

    return {
      screen,
      slot,
      phase,
      mayStillPlay,
      playing,
      playingEdition: phase === 'on' ? playingEdition : (mayStillPlay ? playingEdition : null),
      confirmedSequence: applied?.sequence ?? null,
      confirmedAction: applied?.action ?? null,
      // 只有已确认的"上线"回执才对应一个在播版号；已确认停止时没有在播版号。
      confirmedEdition: confirmedOn ? appliedEdition : null,
      confirmedAt: applied?.at ?? null,
      confirmedState: applied?.state ?? null,
      lastSequence: entry.lastSequence,
      lastCommand: latestCommand,
      offline: Boolean(offline),
      offlineAt: offline?.at ?? null,
      conflicts: entry.conflicts.length,
      note,
      history: this.history(screen, slot),
    };
  }

  // 终端是否已经应用并确认当前编目位在播指定版号。
  confirmedOn(screen, slot, edition) {
    const entry = this.slots.get(keyOf(screen, slot));
    const applied = entry?.lastApplied;
    if (!applied || applied.action !== 'on' || applied.state !== 'applied') return false;
    const resolved = this.resolveReceiptEdition(entry, applied, edition);
    if (resolved !== edition) return false;
    const latestCommand = entry.commands.at(-1);
    if (!latestCommand) return true;
    // 只有"旧回执 + 更新的本地命令"这种组合才说明终端状态可能已变。
    // 回执序号本身更新（例如别的发布者用更高序号确认了同一版）时应当采信回执，
    // 不能反过来要求旧命令的版号也与之一致。
    if (latestCommand.sequence > applied.sequence) return false;
    return true;
  }

  evidenceFor(screen, slot, sequence) {
    return this.slots.get(keyOf(screen, slot))?.evidence.get(sequence) ?? null;
  }

  // 当前与旧序号回执的完整快照，供持久化后重建。
  receipts() {
    const list = [];
    for (const entry of this.slots.values()) {
      list.push(...entry.receiptLog);
      for (const receipt of entry.staleReceipts) {
        if (!entry.receiptLog.includes(receipt)) list.push(receipt);
      }
    }
    return list;
  }

  // 转成对外的可序列化形式，并补上回执本身没带、但发布台账知道的版号。
  history(screen, slot) {
    const entry = this.ensure(screen, slot);
    const withEdition = (receipt) => (receipt.action === 'on' && !receipt.edition
      ? { ...receipt, edition: this.resolveReceiptEdition(entry, receipt) }
      : receipt);
    return {
      commands: [...entry.commands],
      receipts: entry.receiptLog.map(withEdition),
      staleReceipts: entry.staleReceipts.map(withEdition),
      conflicts: entry.conflicts.map((item) => ({ receipt: withEdition(item.receipt), command: item.command })),
      latestReceipts: [...entry.bySequence.values()].map(withEdition),
    };
  }

  // 按回执还原一次实际放映：从一条 applied 的上线回执，到其后同一编目位的下一条
  // applied 下线回执（或仍未确认停止）。用于"按一次已发生的放映回看"。
  sessions(screen, slot, status) {
    const entry = this.ensure(screen, slot);
    const applied = status.history.latestReceipts
      .filter((receipt) => receipt.state === 'applied')
      .map((receipt) => (receipt.action === 'on' && !receipt.edition
        ? { ...receipt, edition: this.resolveReceiptEdition(entry, receipt) }
        : receipt))
      .sort((a, b) => a.sequence - b.sequence);
  const sessions = [];
  let open = null;
  const closeOpen = (receipt, reason) => {
    if (!open) return;
    open.endedSequence = receipt?.sequence ?? null;
    open.endedAt = receipt?.at ?? null;
    open.endReason = reason;
    sessions.push(open);
    open = null;
  };
  for (const receipt of applied) {
    if (receipt.action === 'on') {
      closeOpen(null, '被下一次上线取代（未见到下线回执）');
      open = {
        screen,
        slot,
        edition: receipt.edition ?? null,
        startedSequence: receipt.sequence,
        startedAt: receipt.at,
        endedSequence: null,
        endedAt: null,
        endReason: null,
      };
    } else {
      closeOpen(receipt, '已确认停止');
    }
  }
  if (open) {
    // 用最新回执判断是否失联：失联不等于停止。
    if (status.phase === 'offline') open.endReason = '终端失联，停止未确认';
    else if (status.phase === 'stopping-pending') open.endReason = '下线已发出但尚未确认';
    else if (status.phase === 'off') open.endReason = '已确认停止';
    else open.endReason = '当前仍可能播出';
    sessions.push(open);
  }
  return sessions;
  }
}

// 兼容旧的独立函数签名：从台账取一次放映场次。
export function screeningSessions(screen, slot, status, ledger = null) {
  if (ledger) return ledger.sessions(screen, slot, status);
  return status.history?.sessions ?? [];
}
