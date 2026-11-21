// 授权登记与修订。
//
// 一条授权（entry）是权利人给出的许可：素材（或指定区段）、场地、用途、时段。
// 修订（amendment）按 effective 时刻生效：
//   withdraw  自该时刻起删除所指授权的生效范围；
//   restrict  自该时刻起把所指授权收窄到某个场地（或按限定条款收窄场地/用途）；
//   restore   撤销此前的收窄，恢复登记时的场地/用途。
//
// 两个坐标轴必须分开：
//   1. 素材轴（秒）：一条授权覆盖原始素材的 [start, end)；
//   2. 时间轴（带时区的时刻）：一条授权只在 [validFrom, validUntil) 内有效。
// 判断能否播出，要同时满足两份证据，且声音、画面分别判断。

import { contains, intersect, makeInterval, mergeIntervals, toMillis, toIso } from './time.mjs';
import { interpretClause } from './terms.mjs';

export function parseEntry(raw, index) {
  const problems = [];
  const id = raw?.id;
  if (typeof id !== 'string' || id === '') problems.push(`第 ${index + 1} 条授权缺少 id`);
  if (typeof raw?.owner !== 'string' || raw.owner === '') problems.push(`${id} 缺少权利人`);
  if (typeof raw?.item !== 'string' || raw.item === '') problems.push(`${id} 缺少素材`);
  const track = raw?.track;
  if (track !== 'picture' && track !== 'sound') problems.push(`${id} 的轨道必须是 picture 或 sound`);
  const start = Number(raw?.start);
  const end = Number(raw?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(start < end)) problems.push(`${id} 的素材区间无效`);
  if (typeof raw?.venue !== 'string' || raw.venue === '') problems.push(`${id} 缺少场地`);
  if (typeof raw?.use !== 'string' || raw.use === '') problems.push(`${id} 缺少用途`);

  // 补传的限定条款只能进一步收窄这条授权；解析失败时送礼安排依赖它，需要冻结。
  const clause = interpretClause(raw?.terms ?? raw?.clause);
  let venue = raw?.venue;
  let use = raw?.use;
  if (raw?.terms !== undefined || raw?.clause !== undefined) {
    if (!clause.ok) problems.push({ code: 'clause-unreadable', right: id, detail: clause.reason });
    else {
      if (clause.venue !== undefined) {
        if (venue !== undefined && venue !== clause.venue) {
          problems.push({ code: 'clause-conflict', right: id, detail: `登记场地 ${venue} 与限定条款 ${clause.venue} 不一致` });
        }
        venue = clause.venue;
      }
      if (clause.use !== undefined) {
        if (use !== undefined && use !== clause.use) {
          problems.push({ code: 'clause-conflict', right: id, detail: `登记用途 ${use} 与限定条款 ${clause.use} 不一致` });
        }
        use = clause.use;
      }
    }
  }

  let valid;
  try {
    valid = makeInterval(clause.ok && clause.validFrom ? clause.validFrom : raw?.validFrom,
      clause.ok && clause.validUntil ? clause.validUntil : raw?.validUntil,
      `${id} 的授权时段`);
  } catch (error) {
    problems.push(error.message);
  }
  return {
    entry: {
      id,
      owner: raw?.owner,
      item: raw?.item,
      track,
      start,
      end,
      venue,
      use,
      valid,
      clause,
      raw,
    },
    problems,
  };
}

export function parseEntries(body) {
  const entries = [];
  const problems = [];
  for (const [index, raw] of (Array.isArray(body) ? body : []).entries()) {
    const parsed = parseEntry(raw, index);
    entries.push(parsed.entry);
    problems.push(...parsed.problems);
  }
  return { entries, problems };
}

// 修订折叠成每条授权的时间线片段：
//   { start, end, venue, use, restricted }
// venue/use 是该片段实际可用的范围（收窄后与登记值不同）。
export function applyAmendments(entries, amendments) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const base = (entry) => ({ start: entry.valid.start, end: entry.valid.end, venue: entry.venue, use: entry.use, restricted: false });
  const fragments = new Map(entries.map((entry) => [entry.id, [base(entry)]]));
  const problems = [];
  const unknown = [];
  const applied = [];
  const affected = new Set();

  const sorted = [...(Array.isArray(amendments) ? amendments : [])]
    .map((raw, index) => ({ raw, index }))
    .filter(({ raw }) => {
      const ok = typeof raw?.right === 'string'
        && ['withdraw', 'restrict', 'restore'].includes(raw?.action)
        && raw?.effective !== undefined;
      if (!ok) problems.push({ code: 'amendment-unreadable', detail: `第 ${index + 1} 条修订缺少 right/action/effective` });
      return ok;
    })
    .sort((a, b) => toMillis(a.raw.effective, '修订生效时刻') - toMillis(b.raw.effective, '修订生效时刻') || a.index - b.index);

  for (const { raw } of sorted) {
    const entry = byId.get(raw.right);
    const effective = toMillis(raw.effective, '修订生效时刻');
    if (!entry) {
      unknown.push({
        right: raw.right,
        action: raw.action,
        effective: raw.effective,
        terms: raw.terms ?? raw.clause ?? null,
        detail: `修订指向未知授权 ${raw.right}，无法判断影响范围`,
      });
      continue;
    }
    const clause = interpretClause(raw.terms ?? raw.clause);
    if ((raw.terms !== undefined || raw.clause !== undefined) && !clause.ok) {
      problems.push({ code: 'clause-unreadable', right: entry.id, detail: clause.reason });
      affected.add(entry.id);
      continue;
    }
    if (raw.action === 'restrict' && typeof raw.venue !== 'string' && clause.ok && clause.venue === undefined) {
      problems.push({ code: 'amendment-unreadable', right: entry.id, detail: `修订 ${entry.id} 的 restrict 没有给出场地` });
      affected.add(entry.id);
      continue;
    }
    affected.add(entry.id);

    if (raw.action === 'withdraw') {
      fragments.set(entry.id, fragments.get(entry.id).flatMap((piece) => {
        if (piece.start >= effective) return [];
        if (piece.end <= effective) return [piece];
        return [{ ...piece, end: effective }];
      }));
    } else if (raw.action === 'restrict') {
      const venue = clause.ok && clause.venue !== undefined ? clause.venue : raw.venue;
      const use = clause.ok && clause.use !== undefined ? clause.use : entry.use;
      fragments.set(entry.id, fragments.get(entry.id).flatMap((piece) => {
        if (piece.end <= effective) return [piece];
        const front = piece.start >= effective ? [] : [{ ...piece, end: effective }];
        const back = [{
          ...piece,
          start: Math.max(piece.start, effective),
          venue,
          use,
          restricted: true,
          restrictedBy: entry.id,
        }];
        return [...front, ...back];
      }));
    } else {
      fragments.set(entry.id, fragments.get(entry.id).flatMap((piece) => {
        if (piece.end <= effective) return [piece];
        const front = piece.start >= effective ? [] : [{ ...piece, end: effective }];
        const back = [{
          ...piece,
          start: Math.max(piece.start, effective),
          venue: entry.venue,
          use: entry.use,
          restricted: false,
        }];
        return [...front, ...back];
      }));
    }
    applied.push({ right: entry.id, action: raw.action, effective: raw.effective, venue: raw.venue ?? null, terms: raw.terms ?? raw.clause ?? null });
  }

  // 相邻且实际范围相同的片段可以合并；范围不同的片段保持分开。
  const timeline = new Map();
  for (const [id, pieces] of fragments) {
    timeline.set(id, mergeIntervals(pieces, (piece) => `${piece.venue}\u0000${piece.use}`));
  }
  return { timeline, problems, unknown, applied, affected };
}

// 某条授权在哪些时段、以什么范围可用。
export function usableFragments(entry, pieces) {
  const windows = [];
  for (const piece of pieces ?? []) {
    const window = intersect(entry.valid, piece);
    if (window) windows.push({ ...window, venue: piece.venue, use: piece.use, restricted: Boolean(piece.restricted) });
  }
  // 只按实际场地与用途区分：是否被收窄过不影响可用性。
  return mergeIntervals(windows, (window) => `${window.venue}\u0000${window.use}`);
}

function missingMaterial(start, end, ranges) {
  const holes = [];
  let cursor = start;
  for (const range of mergeIntervals(ranges)) {
    if (range.end <= cursor) continue;
    if (range.start >= end) break;
    if (range.start > cursor) holes.push({ start: cursor, end: Math.min(range.start, end) });
    cursor = Math.max(cursor, range.end);
    if (cursor >= end) break;
  }
  if (cursor < end) holes.push({ start: cursor, end });
  return holes;
}

function coversMaterial(ranges, start, end) {
  let cursor = start;
  for (const range of mergeIntervals(ranges)) {
    if (range.end <= cursor) continue;
    if (range.start > cursor) break;
    cursor = Math.max(cursor, range.end);
    if (cursor >= end) return true;
  }
  return cursor >= end;
}

function rightView(entry, windows) {
  return {
    id: entry.id,
    owner: entry.owner,
    item: entry.item,
    track: entry.track,
    start: entry.start,
    end: entry.end,
    venue: entry.venue,
    use: entry.use,
    windows: windows.map((window) => ({
      start: toIso(window.start),
      end: window.end === Infinity ? null : toIso(window.end),
      venue: window.venue,
      use: window.use,
    })),
  };
}

// 评估一部成片在一个安排下、at 时刻能否完整播出。
export function evaluateEdition(resolved, scope, rights, at = scope.asOfMs) {
  const frozen = [...resolved.problems.map((problem) => ({ source: 'catalog', ...problem }))];

  for (const problem of rights.problems ?? []) {
    if (problem.right && arrangementUsesRight(resolved, rights, problem.right)) {
      frozen.push({ source: 'amendment', ...problem });
    }
  }
  for (const unknown of rights.unknown ?? []) {
    // 指向未知授权的修订无法判断影响谁；只有涉及本安排所用素材时才冻结。
    if (arrangementUsesItem(resolved, unknown)) {
      frozen.push({ source: 'amendment', code: 'unknown-right', ...unknown });
    }
  }

  const tracks = resolved.tracks.map((track) => evaluateTrack(track, scope, rights, at));
  const covered = tracks.every((track) => track.covered) && frozen.length === 0;
  return {
    covered,
    frozen,
    tracks,
    missing: [...new Set(tracks.flatMap((track) => track.gaps.map((gap) => gap.reason)))],
    basis: collectBasis(tracks),
  };
}

function arrangementUsesRight(resolved, rights, rightId) {
  const entry = rights.entries.find((item) => item.id === rightId);
  if (!entry) return false;
  return resolved.tracks.some((track) => track.track === entry.track
    && track.segments.some((segment) => segment.item === entry.item));
}

// 未知授权时，只能按"本安排是否用到同轨道同素材"做保守判断。
function arrangementUsesItem(resolved, unknown) {
  return resolved.tracks.some((track) => track.segments.some((segment) => segment.item === unknown.item));
}

function evaluateTrack(track, scope, rights, at) {
  const gaps = [];
  const usedRights = new Map();

  const view = (entry) => rightView(entry, usableFragments(entry, rights.timeline.get(entry.id))
    .filter((window) => window.venue === scope.venue && window.use === scope.use));

  for (const segment of track.segments) {
    const sameItem = rights.entries.filter((entry) => entry.track === track.track && entry.item === segment.item);
    const active = sameItem
      .map((entry) => ({
        entry,
        windows: usableFragments(entry, rights.timeline.get(entry.id))
          .filter((window) => contains(window, at) && window.venue === scope.venue && window.use === scope.use),
      }))
      .filter((item) => item.windows.length > 0);

    const ranges = active.map((item) => ({ start: item.entry.start, end: item.entry.end }));
    if (coversMaterial(ranges, segment.start, segment.end)) {
      for (const item of active) {
        if (item.entry.end > segment.start && item.entry.start < segment.end) {
          usedRights.set(item.entry.id, rightView(item.entry, item.windows));
        }
      }
      continue;
    }

    // 缺口逐段归因：同一素材可能一部分被收窄、另一部分压根没登记。
    // 归因时优先看"本场地本用途"的登记，避免把别处（如馆内）的授权
    // 误当作本安排的依据。
    const everScoped = (entry) => usableFragments(entry, rights.timeline.get(entry.id))
      .some((window) => window.venue === scope.venue && window.use === scope.use);
    const inScope = sameItem.filter(everScoped);
    const scopedEntries = inScope.length > 0 ? inScope : sameItem;

    const holes = missingMaterial(segment.start, segment.end, ranges).map((hole) => {
      const covering = scopedEntries.filter((entry) => entry.start <= hole.start && entry.end >= hole.end);
      let reason;
      // 有登记但从不覆盖本场地/用途 → scope；覆盖本场地但此刻不在生效时段 → time；
      // 其余情况是该素材登记区段本身不够长 → material。
      if (sameItem.length === 0) reason = 'unregistered';
      else if (inScope.length === 0) reason = 'scope';
      else if (covering.length > 0) reason = 'time';
      else reason = 'material';
      return {
        start: hole.start,
        end: hole.end,
        reason,
        missingLabel: REASON_LABELS[reason],
        relatedRights: (covering.length > 0 ? covering : scopedEntries).map((entry) => entry.id),
      };
    });

    const priority = ['unregistered', 'scope', 'time', 'material'];
    const reason = [...holes].sort((a, b) => priority.indexOf(a.reason) - priority.indexOf(b.reason))[0].reason;
    gaps.push({
      track: track.track,
      item: segment.item,
      start: segment.start,
      end: segment.end,
      reason,
      holes,
      missing: holes.map((hole) => ({ start: hole.start, end: hole.end })),
      activeRights: active.map((item) => view(item.entry)),
      relatedRights: scopedEntries.map((entry) => entry.id),
    });
  }

  return {
    track: track.track,
    covered: gaps.length === 0,
    gaps,
    rights: [...usedRights.values()],
  };
}

function collectBasis(tracks) {
  const basis = new Map();
  for (const track of tracks) {
    for (const right of track.rights) basis.set(right.id, right);
  }
  return [...basis.values()];
}

export function describeGaps(evaluation) {
  return evaluation.tracks.flatMap((track) => track.gaps.map((gap) => ({
    track: gap.track,
    item: gap.item,
    material: { start: gap.start, end: gap.end },
    reason: gap.reason,
    missingMaterial: gap.missing,
    missingLabel: REASON_LABELS[gap.reason] ?? gap.reason,
    // 逐段归因：策展人需要知道缺的是哪一秒、属于哪类许可。
    missingParts: gap.holes.map((hole) => ({
      start: hole.start,
      end: hole.end,
      reason: hole.reason,
      label: hole.missingLabel,
      relatedRights: hole.relatedRights,
    })),
    relatedRights: gap.relatedRights,
  })));
}

export const REASON_LABELS = {
  unregistered: '没有登记该素材的这项权利',
  scope: '该素材没有登记本场地、本用途的许可',
  time: '许可不在本时段生效或已撤回',
  material: '已登记的素材区段不足以覆盖成片',
  catalog: '编目素材区段无法完整还原',
  amendment: '限定条款无法解释，相关安排被冻结',
};
