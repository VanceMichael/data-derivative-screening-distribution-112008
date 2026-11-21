// 策展端：把编目、授权、展期与终端回执合成可执行的播出决定。
//
// 一次 sync() + reconcile(now) 会：
//   1. 拉取编目、派生素材对照、展期、授权、限定条款与终端回执；
//   2. 按成片实际用到的原始区段判断授权（声音、画面各自取证）；
//   3. 对每个编目位比较"应当播什么"与"终端已确认什么"；
//   4. 只冻结受影响的播放安排，并把缺的许可类型留给策展人；
//   5. 记录每次送出的命令、撤回原因与时点，供事后回看。

import { parseCatalog, parseLinks, resolveEdition } from './catalog.mjs';
import { applyAmendments, describeGaps, evaluateEdition, parseEntries } from './rights.mjs';
import { PlayerLedger } from './player.mjs';
import { makeInterval, toMillis, toIso } from './time.mjs';

const DEFAULT_LEAD_MS = 30 * 60 * 1000;

export class CuratorService {
  constructor({ source, persistence = null, now = () => new Date() }) {
    this.source = source;
    this.persistence = persistence;
    this.now = now;
    this.ledger = new PlayerLedger();
    this.snapshot = null;
    this.audit = [];
    this.lastSync = null;
    this.loadPersistence();
  }

  loadPersistence() {
    if (!this.persistence) return;
    const saved = this.persistence.load();
    if (!saved) return;
    // 先恢复已收到的回执，它们会建出对应的编目位台账。
    this.ledger.observeReceipts(saved.receipts ?? []);
    // 再按每个已发命令所属的编目位放回命令，不能只遍历已有编目位，
    // 否则"发过命令但还没收到回执"的编目位会丢掉序号。
    for (const command of saved.commands ?? []) {
      if (typeof command?.screen !== 'string' || typeof command?.slot !== 'string') continue;
      const entry = this.ledger.ensure(command.screen, command.slot);
      if (entry.commands.some((existing) => existing.sequence === command.sequence)) continue;
      const { evidence = null, ...rest } = command;
      entry.commands.push(rest);
      entry.lastSequence = Math.max(entry.lastSequence, command.sequence);
      if (evidence) entry.evidence.set(command.sequence, evidence);
    }
    for (const entry of this.ledger.slots.values()) {
      entry.commands.sort((a, b) => a.sequence - b.sequence);
    }
    this.audit = saved.audit ?? [];
  }

  savePersistence() {
    if (!this.persistence) return;
    const commands = [];
    for (const entry of this.ledger.slots.values()) {
      for (const command of entry.commands) {
        commands.push({ ...command, evidence: entry.evidence.get(command.sequence) ?? command.evidence ?? null });
      }
    }
    this.persistence.save({ commands, receipts: this.ledger.receipts(), audit: this.audit });
  }

  // 拉取并重整全部来源资料，不改变发布状态。
  //
  // 来源断档时沿用上一份成功读到的同类资料，但把该项标记为 gaps；
  // eligibility 会据此冻结受影响安排。这样既不会把"读不到"当成"没有授权"，
  // 也不会让一次抖动清空此前可用的展期与授权。
  async sync() {
    const fetchedAt = this.now().toISOString();
    const errors = [];
    const gaps = { schedule: false, rights: false, catalog: false, receipts: false };
    const previous = this.snapshot;
    const read = async (path, key, fallback, gapKey) => {
      try {
        return { key, value: await this.source.fetchJson(path), ok: true };
      } catch (error) {
        errors.push({ path, message: error.message });
        if (gapKey) gaps[gapKey] = true;
        return { key, value: fallback, ok: false };
      }
    };

    const [scheduleResult, entriesResult, amendmentsResult, linksResult] = await Promise.all([
      read('/exhibits/schedule', 'schedule', previous?.scheduleRaw ?? [], 'schedule'),
      read('/rights/entries', 'entries', previous?.rights?.rawEntries ?? [], 'rights'),
      read('/rights/amendments', 'amendments', previous?.rights?.rawAmendments ?? [], 'rights'),
      read('/catalog/links', 'links', previous?.links?.raw ?? [], 'catalog'),
    ]);

    let catalogHtml;
    try {
      catalogHtml = await this.source.fetchText('/catalog');
    } catch (error) {
      errors.push({ path: '/catalog', message: error.message });
      gaps.catalog = true;
      catalogHtml = previous?.catalogHtml ?? '';
    }

    let receipts = [];
    let receiptsOk = true;
    try {
      receipts = await this.source.fetchJson('/player/receipts');
    } catch (error) {
      errors.push({ path: '/player/receipts', message: error.message });
      gaps.receipts = true;
      receiptsOk = false;
    }
    if (receiptsOk) for (const receipt of Array.isArray(receipts) ? receipts : []) this.ledger.recordReceipt(receipt);

    const editions = parseCatalog(catalogHtml);
    const links = parseLinks(linksResult.value);
    if (linksResult.ok) links.raw = linksResult.value;
    const rightsParsed = parseEntries(entriesResult.value);
    const amendments = applyAmendments(rightsParsed.entries, amendmentsResult.value);

    // 正在生效的修订会影响后续判断；记入快照后即使只按当前状态检查也能提示变化点。
    const rights = {
      entries: rightsParsed.entries,
      timeline: amendments.timeline,
      problems: [...rightsParsed.problems, ...amendments.problems],
      unknown: amendments.unknown,
      applied: amendments.applied,
      pending: (Array.isArray(amendmentsResult.value) ? amendmentsResult.value : [])
        .filter((raw) => raw?.effective && raw?.right)
        .map((raw) => ({ right: raw.right, action: raw.action, effective: raw.effective, venue: raw.venue ?? null })),
      rawEntries: entriesResult.value,
      rawAmendments: amendmentsResult.value,
    };

    const resolved = new Map();
    for (const [id, edition] of editions) resolved.set(id, resolveEdition(edition, links));

    const schedule = (Array.isArray(scheduleResult.value) ? scheduleResult.value : []).map((raw, index) => {
      const problems = [];
      let from;
      let to;
      try {
        from = makeInterval(raw?.from, raw?.to, `展期第 ${index + 1} 项`);
      } catch (error) {
        problems.push(error.message);
      }
      if (typeof raw?.screen !== 'string' || typeof raw?.slot !== 'string') problems.push(`展期第 ${index + 1} 项缺少 screen 或 slot`);
      if (typeof raw?.venue !== 'string' || typeof raw?.use !== 'string') problems.push(`展期第 ${index + 1} 项缺少场地或用途`);
      return {
        key: `${raw?.screen}/${raw?.slot}`,
        screen: raw?.screen,
        slot: raw?.slot,
        venue: raw?.venue,
        use: raw?.use,
        edition: raw?.edition,
        alternative: raw?.alternative ?? null,
        from,
        to,
        raw,
        problems,
      };
    });

    this.snapshot = {
      fetchedAt,
      editions,
      links,
      rights,
      resolved,
      schedule,
      errors,
      gaps,
      catalogHtml,
      scheduleRaw: scheduleResult.value,
    };
    this.lastSync = fetchedAt;
    return this.snapshot;
  }

  // 判断一次放映是否仍有凭据：只看授权，不看终端。
  // at 是此刻；同时算出从此刻起授权连续有效的截止时刻（含半开区间语义）。
  eligibility(editionId, arrangement, at) {
    const snapshot = this.requireSnapshot();
    const resolved = snapshot.resolved.get(editionId);
    if (!resolved) {
      return {
        covered: false,
        frozen: [{ source: 'catalog', code: 'unknown-edition', edition: editionId }],
        tracks: [],
        missing: ['catalog'],
        basis: [],
        coveredUntil: null,
        nextChange: null,
      };
    }
    if (!arrangement.from) {
      return {
        covered: false,
        frozen: arrangement.problems.map((detail) => ({ source: 'schedule', detail })),
        tracks: [],
        missing: ['schedule'],
        basis: [],
        coveredUntil: null,
        nextChange: null,
      };
    }
    const scope = {
      venue: arrangement.venue,
      use: arrangement.use,
      fromMs: arrangement.from.start,
      toMs: arrangement.from.end,
      asOfMs: at,
    };
    const nowCheck = evaluateEdition(resolved, scope, snapshot.rights, at);

    // 来源断档时保守处理：宁可冻结，也不用不完整的资料放行。
    // 只冻结"即将或正在播放"的安排——展期外、还轮不到发布的安排本来就不会被
    // 放行，给它们加冻结只会让策展人以为所有场次都出了问题。
    const frozen = [...nowCheck.frozen];
    const playingSoon = at >= arrangement.from.start - DEFAULT_LEAD_MS && at < arrangement.from.end;
    if (playingSoon && snapshot.gaps.rights) {
      frozen.push({ source: 'source', code: 'rights-unavailable', detail: '授权登记未能完整读取，受影响安排已冻结' });
    }
    if (playingSoon && snapshot.gaps.catalog) {
      frozen.push({ source: 'source', code: 'catalog-unavailable', detail: '编目或派生素材对照未能完整读取，受影响安排已冻结' });
    }
    const covered = nowCheck.covered && frozen.length === 0;

    // 授权在展期内的变化点：修订生效时刻与各授权时段端点。
    const boundaries = new Set();
    for (const entry of snapshot.rights.entries) {
      boundaries.add(entry.valid.start);
      if (entry.valid.end !== Infinity) boundaries.add(entry.valid.end);
    }
    // 使用全部已收到的修订（包括尚未生效的）作为变化点，这样 booking 阶段就能
    // 提示"当前依据只到 10:00"，策展人可以提前准备替代成片。
    for (const applied of snapshot.rights.pending ?? []) boundaries.add(toMillis(applied.effective, '修订生效时刻'));

    const windowEnd = arrangement.from.end;
    let coveredUntil = covered ? windowEnd : null;
    if (covered) {
      const candidates = [...boundaries]
        .filter((time) => time > at && time < windowEnd)
        .sort((a, b) => a - b);
      for (const time of candidates) {
        const check = evaluateEdition(resolved, scope, snapshot.rights, time);
        if (!check.covered || snapshot.gaps.rights || snapshot.gaps.catalog) {
          coveredUntil = time;
          break;
        }
      }
    }

    return {
      ...nowCheck,
      covered,
      frozen,
      missing: [...new Set([...nowCheck.missing, ...frozen.map((item) => item.code ?? 'catalog')])],
      coveredUntil,
      coveredUntilText: coveredUntil === null ? null : toIso(coveredUntil),
      // 只在当前可用时才提示"从何时起将不再完整"，否则这条会与当前缺口混淆。
      nextChange: covered && coveredUntil !== null && coveredUntil < windowEnd ? toIso(coveredUntil) : null,
    };
  }

  requireSnapshot() {
    if (!this.snapshot) throw new Error('尚未同步来源资料');
    return this.snapshot;
  }

  // 决定每个编目位此刻该怎么发。不实际发命令。
  plan(at = this.now().toISOString()) {
    const snapshot = this.requireSnapshot();
    const atMs = toMillis(at, '判断时刻');
    const arrangements = [];
    const slots = new Map();

    for (const arrangement of snapshot.schedule) {
      const current = this.eligibility(arrangement.edition, arrangement, atMs);
      const alternative = arrangement.alternative
        ? this.eligibility(arrangement.alternative, arrangement, atMs)
        : null;
      const slotKey = `${arrangement.screen}/${arrangement.slot}`;
      const status = this.ledger.status(arrangement.screen, arrangement.slot, (edition) => {
        const check = this.eligibility(edition, arrangement, atMs);
        return check.covered;
      }, arrangement.edition);

      const withinWindow = arrangement.from ? atMs >= arrangement.from.start && atMs < arrangement.from.end : false;
      const upcoming = arrangement.from ? atMs < arrangement.from.start : false;
      const lead = arrangement.from ? arrangement.from.start - atMs <= DEFAULT_LEAD_MS : false;

      let action;
      let targetEdition = null;
      let reason = null;
      const confirmedCurrent = this.ledger.confirmedOn(arrangement.screen, arrangement.slot, arrangement.edition);
      const alternativeConfirmed = arrangement.alternative
        ? this.ledger.confirmedOn(arrangement.screen, arrangement.slot, arrangement.alternative)
        : false;

      if (!withinWindow && !(upcoming && lead)) {
        action = 'idle';
        reason = '不在展期内，暂不发布';
      } else if (current.covered) {
        action = confirmedCurrent ? 'none' : 'on';
        targetEdition = arrangement.edition;
        reason = action === 'on' ? '当前版授权完整' : null;
      } else if (alternative?.covered) {
        action = alternativeConfirmed ? 'none' : 'swap';
        targetEdition = arrangement.alternative;
        reason = `当前版冻结（${current.missing.join('、')}），替换版授权完整`;
      } else {
        action = 'off';
        reason = `当前版冻结（${current.missing.join('、')}）且替换版不可用`;
      }

      if (status.mayStillPlay && action === 'idle') {
        action = 'off';
        reason = '展期外但终端仍可能播出，需确认下线';
      } else if (status.mayStillPlay && action === 'none' && !confirmedCurrent) {
        action = 'off';
        reason = '终端仍可能播出没有当前授权的版本';
      }

      const item = {
        screen: arrangement.screen,
        slot: arrangement.slot,
        key: slotKey,
        venue: arrangement.venue,
        use: arrangement.use,
        window: arrangement.from ? { from: arrangement.from.startText, to: arrangement.from.endText } : null,
        state: !arrangement.from ? 'frozen'
          : withinWindow ? 'in-window'
            : upcoming ? 'upcoming' : 'past',
        edition: arrangement.edition,
        alternative: arrangement.alternative,
        current: summarize(current),
        alternativeCheck: alternative ? summarize(alternative) : null,
        confirmedCurrent,
        confirmedAlternative: alternativeConfirmed,
        action,
        targetEdition,
        reason,
        player: status,
      };
      arrangements.push(item);

      const bucket = slots.get(slotKey) ?? { screen: arrangement.screen, slot: arrangement.slot, arrangements: [] };
      bucket.arrangements.push(item);
      slots.set(slotKey, bucket);
    }

    return {
      at,
      fetchedAt: snapshot.fetchedAt,
      errors: snapshot.errors,
      arrangements,
      slots: [...slots.values()],
    };
  }

  // 执行一次发布：先下线受影响版本，再按计划上线。返回本次动作与仍需人工处理的点。
  async reconcile(at = this.now().toISOString()) {
    const plan = this.plan(at);
    const dispatched = [];

    for (const item of plan.arrangements) {
      if (item.action === 'idle') continue;
      const status = item.player;
      const confirmedTarget = item.targetEdition
        ? this.ledger.confirmedOn(item.screen, item.slot, item.targetEdition)
        : false;

      // 通道上已有同动作、同版号的命令在等待确认时不再重复下发：
      // 重复下发只会推高序号，并不会让终端更早停下。
      const pending = this.ledger.pendingIntent(item.screen, item.slot);

      if (item.action === 'off') {
        if (status.phase === 'off' && !status.mayStillPlay) continue;
        if (pending?.action === 'off' && pending.sequence > (status.confirmedSequence ?? 0)) continue;
        dispatched.push(await this.send({ screen: item.screen, slot: item.slot, action: 'off', reason: item.reason, at }));
        continue;
      }
      if (confirmedTarget) continue;
      if (pending?.action === 'on' && pending.edition === item.targetEdition
        && pending.sequence > (status.confirmedSequence ?? 0)) continue;

      if (item.action === 'swap' && status.mayStillPlay && item.targetEdition !== status.playingEdition) {
        dispatched.push(await this.send({
          screen: item.screen, slot: item.slot, action: 'off',
          reason: `替换 ${status.playingEdition ?? '当前版'} 前先确认停止`, at,
        }));
        continue;
      }
      if (status.phase === 'playing-unlicensed' || (status.phase === 'on' && status.playingEdition !== item.targetEdition)) {
        dispatched.push(await this.send({
          screen: item.screen, slot: item.slot, action: 'off',
          reason: `${status.playingEdition ?? '当前版'} 已不能继续，先确认停止再加新指令`, at,
        }));
        continue;
      }
      dispatched.push(await this.send({
        screen: item.screen,
        slot: item.slot,
        action: 'on',
        edition: item.targetEdition,
        reason: item.reason,
        at,
        evidence: item.targetEdition === item.alternative ? item.alternativeCheck : item.current,
      }));
    }

    this.savePersistence();
    return { at, plan, dispatched, status: this.status(at) };
  }

  async send({ screen, slot, action, edition = null, reason = null, at = null, evidence = null }) {
    const result = this.ledger.dispatch({ screen, slot, action, edition, reason, at, evidence });
    if (!result.ok) return { ...result, screen, slot, action };
    const record = {
      ok: true,
      screen,
      slot,
      sequence: result.sequence,
      action,
      edition,
      reason,
      at,
      dispatchedAt: result.command.dispatchedAt,
      sourceReply: null,
      sourceError: null,
    };
    try {
      record.sourceReply = await this.source.postCommand({
        screen, slot, sequence: result.sequence, action, ...(edition ? { edition } : {}),
      });
    } catch (error) {
      record.sourceError = error.message;
    }
    this.audit.push({ kind: 'command', ok: true, ...record });
    return record;
  }

  // 给策展人的总览：每个编目位的授权、确认状态与需人工联系的点。
  status(at = this.now().toISOString()) {
    const plan = this.plan(at);
    const attention = [];

    for (const item of plan.arrangements) {
      if (item.player.conflicts > 0) {
        attention.push({
          kind: 'receipt-conflict',
          state: item.state,
          screen: item.screen,
          slot: item.slot,
          venue: item.venue,
          detail: `有 ${item.player.conflicts} 条回执与本地命令的动作或版号不一致，不能据此确认终端状态`,
          mayStillPlay: item.player.mayStillPlay,
        });
      } else if (item.player.offline) {
        attention.push({
          kind: 'offline',
          state: item.state,
          screen: item.screen,
          slot: item.slot,
          venue: item.venue,
          detail: item.player.note,
          lastConfirmed: item.player.confirmedSequence,
          mayStillPlay: item.player.mayStillPlay,
        });
      } else if (item.player.mayStillPlay && item.action === 'off') {
        attention.push({
          kind: 'unconfirmed-stop',
          state: item.state,
          screen: item.screen,
          slot: item.slot,
          venue: item.venue,
          detail: item.player.note,
          lastConfirmed: item.player.confirmedSequence,
          mayStillPlay: true,
        });
      } else if (item.current.frozen.length > 0 || !item.current.covered) {
        attention.push({
          kind: 'rights',
          state: item.state,
          screen: item.screen,
          slot: item.slot,
          venue: item.venue,
          detail: item.reason,
          missing: item.current.missing,
          gaps: item.current.gaps,
        });
      }
    }

    return {
      at,
      fetchedAt: this.lastSync,
      sourceErrors: plan.errors,
      slots: plan.slots.map((slot) => ({
        screen: slot.screen,
        slot: slot.slot,
        arrangements: slot.arrangements.map((item) => ({
          screen: item.screen,
          slot: item.slot,
          venue: item.venue,
          use: item.use,
          window: item.window,
          state: item.state,
          edition: item.edition,
          alternative: item.alternative,
          material: this.materialView(item.edition),
          alternativeMaterial: item.alternative ? this.materialView(item.alternative) : null,
          covered: item.current.covered,
          coveredUntil: item.current.coveredUntilText ?? null,
          nextChange: item.current.nextChange,
          missing: item.current.missing,
          basis: item.current.basis,
          gaps: item.current.gaps,
          frozen: item.current.frozen,
          action: item.action,
          targetEdition: item.targetEdition,
          reason: item.reason,
          player: item.player,
          updated: this.ledger.confirmedOn(item.screen, item.slot, item.targetEdition ?? '')
            && item.targetEdition !== null,
        })),
      })),
      attention,
      audit: this.audit.slice(-200),
    };
  }

  // 成片实际用到的原始素材区段（已沿派生素材展开），供策展人核对片段。
  materialView(editionId) {
    const resolved = this.snapshot?.resolved.get(editionId);
    if (!resolved) return null;
    return {
      title: resolved.title,
      tracks: resolved.tracks.map((track) => ({
        track: track.track,
        references: track.references,
        segments: track.segments,
      })),
    };
  }

  // 按一次已发生的放映回看：当时用了哪版素材、哪条授权。
  screenings(screen, slot) {
    const plan = this.plan();
    const slotPlan = plan.slots.find((item) => item.screen === screen && item.slot === slot);
    if (!slotPlan) return null;
    const status = this.ledger.status(screen, slot);
    const sessions = this.ledger.sessions(screen, slot, status).map((session) => {
      const dispatchEvidence = this.ledger.evidenceFor(screen, slot, session.startedSequence);
      const arrangement = slotPlan.arrangements[0];
      const resolved = this.snapshot?.resolved.get(session.edition);

      // 没有本端下发记录时（例如回执来自别的发布者），按回执给出的放映时刻
      // 重新核对当时的授权，作为可复核的替代证据，并标明它是重建的。
      const reconstructed = dispatchEvidence ? null : this.reconstructBasis(session, arrangement);
      const rights = dispatchEvidence?.basis ?? reconstructed?.basis ?? [];

      return {
        ...session,
        venue: arrangement?.venue ?? null,
        use: arrangement?.use ?? null,
        material: resolved
          ? resolved.tracks.map((track) => ({
            track: track.track,
            segments: track.segments,
            references: track.references,
          }))
          : null,
        rights,
        evidenceSource: dispatchEvidence ? 'dispatch' : (reconstructed ? 'reconstructed' : 'missing'),
        coveredAtStart: dispatchEvidence?.covered ?? reconstructed?.covered ?? null,
        evidenceMissing: !dispatchEvidence && !reconstructed,
      };
    });
    return { screen, slot, sessions };
  }

  // 以放映开始时刻为准，回算该版在该安排下当时可用哪些授权。
  // arrangement 可以是由 plan 汇总过的视图，也可以是原始展期记录。
  reconstructBasis(session, arrangement) {
    if (!this.snapshot || !session.startedAt || !arrangement) return null;
    const source = this.snapshot.schedule.find((item) => item.screen === session.screen
      && item.slot === session.slot)
      ?? this.snapshot.schedule.find((item) => (item.screen ?? item.key?.split('/')[0]) === session.screen
        && (item.slot ?? item.key?.split('/')[1]) === session.slot);
    if (!source?.from) return null;
    let at;
    try {
      at = toMillis(session.startedAt, '回执时刻');
    } catch {
      return null;
    }
    const edition = session.edition ?? source.edition;
    const check = this.eligibility(edition, source, at);
    const tracks = this.snapshot.resolved.get(edition)?.tracks ?? [];
    return {
      basis: check.basis.map((right) => ({
        ...right,
        // 观影场次回看只需要"当时这一版覆盖了哪些素材"，不再区分后来的修订。
        note: `按 ${session.startedAt} 的授权状态回算`,
      })),
      covered: check.covered,
      tracks: tracks.map((track) => ({ track: track.track, segments: track.segments })),
    };
  }
}

function summarize(evaluation) {
  return {
    covered: evaluation.covered,
    missing: evaluation.missing,
    frozen: evaluation.frozen,
    basis: evaluation.basis,
    gaps: describeGaps(evaluation),
    pending: evaluation.tracks
      .filter((track) => !track.covered)
      .map((track) => track.track),
    coveredUntil: evaluation.coveredUntilText ?? null,
    nextChange: evaluation.nextChange ?? null,
  };
}

export { toIso };
