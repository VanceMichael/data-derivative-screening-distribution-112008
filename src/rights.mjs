// 授权判断：以成片实际用到的“原始素材区段”为准，声音与画面分别取证。
// 授权登记给出权利人、素材或指定区段、场地、用途、半开生效时段与授权编号；
// 修订（amendment）可补传限定条款或撤回授权。
//
// 判定结论：
//   cleared  展期窗口内每一原始区段、每一介质都有连续有效授权覆盖
//   blocked  存在硬缺口（无授权/被撤回/场地用途不符），应撤下
//   frozen   授权来源断档或限定条款无法解释，只冻结相关播放安排，等待人工联系
// 硬缺口优先于冻结；任何一类缺口都按介质分别列出，单一已授权来源不能放行混合版本。

import { containsInterval, missingRanges, mergeRanges, parseInstant, splitTimeline } from './time.mjs';

const KNOWN_ACTIONS = new Set(['withdraw', 'restrict', 'restore']);

/**
 * 预处理授权与修订，生成：
 *  entries  授权编号 -> 原始登记条目（即使被撤回也可回查）
 *  segments 每条授权在时间轴上的生效片段（含场地/用途/编号）
 *  freezes  无法解释的限定条款造成的冻结标记
 */
export function buildRightsModel(entries, amendments) {
  const segments = [];
  const freezes = [];
  const byRight = new Map();

  for (const entry of entries) {
    byRight.set(entry.id, { entry, amendments: [] });
  }

  for (const amendment of amendments) {
    const owner = byRight.get(amendment.right);
    const reason = explainProblem(amendment, owner?.entry);
    if (reason) {
      freezes.push({ right: amendment.right, at: parseInstant(amendment.effective), reason, amendment });
      continue;
    }
    owner.amendments.push(amendment);
  }

  for (const { entry, amendments: list } of byRight.values()) {
    let current = {
      rightId: entry.id,
      owner: entry.owner,
      item: entry.item,
      track: entry.track,
      start: entry.start,
      end: entry.end,
      venue: entry.venue,
      use: entry.use,
      licenseNo: entry.licenseNo ?? entry.id,
      from: parseInstant(entry.validFrom),
      until: parseInstant(entry.validUntil),
    };
    let openedAt = current.from;
    const ordered = [...list].sort((a, b) => {
      const ta = parseInstant(a.effective);
      const tb = parseInstant(b.effective);
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    for (const amendment of ordered) {
      const at = parseInstant(amendment.effective);
      if (at > openedAt) {
        segments.push({ ...current, from: openedAt, until: at });
        openedAt = at;
      }
      if (amendment.action === 'withdraw') {
        current = null;
        break;
      }
      if (amendment.action === 'restrict') current = { ...current, venue: amendment.venue };
      else if (amendment.action === 'restore') current = { ...current, venue: entry.venue, use: entry.use };
    }
    if (current) segments.push({ ...current, from: openedAt, until: current.until });
  }
  return {
    entries: new Map([...byRight].map(([id, value]) => [id, value.entry])),
    segments,
    freezes,
  };
}

function explainProblem(amendment, entry) {
  if (!entry) return `修订指向不存在的授权编号 ${amendment.right}`;
  if (!KNOWN_ACTIONS.has(amendment.action)) return `无法解释的限定条款动作：${String(amendment.action)}`;
  if (Number.isNaN(Date.parse(amendment.effective ?? ''))) return '修订缺少可解析的生效时间';
  if (amendment.action === 'restrict' && !amendment.venue) return '收窄授权缺少新的场地限定';
  return null;
}

function requirementKey(requirement) {
  return `${requirement.track}|${requirement.item}`;
}

/**
 * 评估一次播放安排。
 * @param flattened  flattenEdition 的结果（picture/sound 原始区段）
 * @param model      buildRightsModel 的结果
 * @param context    { venue, use, windowStart, windowEnd } 时间均为 BigInt 毫秒
 */
export function evaluateClearance(flattened, model, context) {
  const { venue, use, windowStart, windowEnd } = context;
  const requirements = [];
  for (const track of ['picture', 'sound']) {
    for (const segment of flattened[track]) requirements.push({ ...segment, track });
  }

  const validityIntervals = model.segments
    .filter((segment) => segment.venue === venue && segment.use === use)
    .map((segment) => [segment.from, segment.until]);
  const pieces = splitTimeline(validityIntervals, windowStart, windowEnd);
  const hardGaps = [];
  const freezeGaps = [];
  const evidenceByRequirement = new Map();

  for (const [pieceStart, pieceEnd] of pieces) {
    for (const requirement of requirements) {
      const key = requirementKey(requirement);
      const evidence = evidenceByRequirement.get(key) ?? new Set();
      const covering = model.segments.filter((segment) => (
        segment.track === requirement.track
        && segment.item === requirement.item
        && segment.venue === venue
        && segment.use === use
        && segment.end > requirement.start
        && segment.start < requirement.end
        && containsInterval(segment.from, segment.until, pieceStart)
        && (segment.until === null || segment.until >= pieceEnd)
      ));
      for (const segment of covering) evidence.add(segment.licenseNo);
      if (evidence.size > 0) evidenceByRequirement.set(key, evidence);
      const covered = mergeRanges(covering.map((segment) => ({
        start: Math.max(segment.start, requirement.start),
        end: Math.min(segment.end, requirement.end),
      })));
      for (const gap of missingRanges(covered, requirement.start, requirement.end)) {
        hardGaps.push({
          track: requirement.track,
          item: requirement.item,
          range: gap,
          timeRange: [pieceStart, pieceEnd],
          missingType: `${venue}/${use} 的${requirement.track === 'sound' ? '声音' : '画面'}使用许可`,
        });
      }
    }
  }

  // 限定条款无法解释：凡可能作用于本次安排（素材/介质/场地/用途相关）的条款，
  // 自其生效时点起冻结对应安排，由策展人确认缺的是哪类使用许可。
  for (const freeze of model.freezes) {
    if (freeze.at === null || freeze.at >= windowEnd) continue;
    const candidate = model.entries.get(freeze.right);
    for (const requirement of requirements) {
      if (candidate) {
        const relevant = candidate.track === requirement.track
          && candidate.item === requirement.item
          && candidate.end > requirement.start
          && candidate.start < requirement.end
          && candidate.venue === venue
          && candidate.use === use;
        if (!relevant) continue;
      }
      freezeGaps.push({
        track: requirement.track,
        item: requirement.item,
        range: { start: requirement.start, end: requirement.end },
        timeRange: [freeze.at > windowStart ? freeze.at : windowStart, windowEnd],
        missingType: `待人工解释的限定条款（${freeze.reason}）`,
        right: freeze.right,
      });
    }
  }

  const evidence = [...evidenceByRequirement.entries()].map(([key, licenses]) => {
    const [track, item] = key.split('|');
    return { track, item, licenseNos: [...licenses].sort() };
  }).sort((a, b) => a.track.localeCompare(b.track) || a.item.localeCompare(b.item));

  const verdict = hardGaps.length > 0 ? 'blocked' : freezeGaps.length > 0 ? 'frozen' : 'cleared';
  return { verdict, hardGaps, freezeGaps, evidence };
}
