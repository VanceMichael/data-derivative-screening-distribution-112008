// 时间与区段工具：生效时段一律为带时区的半开区间 [start, end)。

const MILLIS = 1n;

export function parseInstant(value) {
  if (value === undefined || value === null || value === '') return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw new TypeError(`无法解析的时间值：${String(value)}`);
  }
  return BigInt(time) * MILLIS;
}

export function instantToIso(instant) {
  return new Date(Number(instant / MILLIS)).toISOString();
}

/** 按给定偏移（分钟）格式化为带时区的半开区间时间字符串，例如 +08:00。 */
export function instantWithOffset(instant, offsetMinutes = 480) {
  if (instant === null) return null;
  const shifted = new Date(Number(instant / MILLIS) + offsetMinutes * 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return shifted.toISOString().replace('Z', offset);
}

/** 判断 instant 是否落在半开区间 [start, end) 内；空端点表示无界。 */
export function containsInterval(start, end, instant) {
  return (start === null || instant >= start) && (end === null || instant < end);
}

/**
 * 把若干生效半开区间在时间轴上切分，返回互不重叠的小半开区间。
 * 每个返回区间内，任意时点的“生效授权集合”保持不变。
 */
export function splitTimeline(validityIntervals, windowStart, windowEnd) {
  const boundaries = new Set([windowStart, windowEnd]);
  for (const [start, end] of validityIntervals) {
    if (start !== null && start > windowStart && start < windowEnd) boundaries.add(start);
    if (end !== null && end > windowStart && end < windowEnd) boundaries.add(end);
  }
  const points = [...boundaries].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const pieces = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    if (points[index] < points[index + 1]) pieces.push([points[index], points[index + 1]]);
  }
  return pieces;
}

/** 整数秒区段的半开区间工具。 */
export function mergeRanges(ranges) {
  const sorted = ranges
    .map((range) => ({ ...range, start: Math.trunc(range.start), end: Math.trunc(range.end) }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    // 相邻（last.end === range.start）允许共同覆盖，因此直接合并。
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** 在 mergeRanges 的结果上求缺口；无缺口返回 []。 */
export function missingRanges(covered, wantedStart, wantedEnd) {
  const gaps = [];
  let cursor = wantedStart;
  for (const range of mergeRanges(covered)) {
    if (range.start > cursor) gaps.push({ start: cursor, end: Math.min(range.start, wantedEnd) });
    cursor = Math.max(cursor, range.end);
    if (cursor >= wantedEnd) break;
  }
  if (cursor < wantedEnd) gaps.push({ start: cursor, end: wantedEnd });
  return gaps;
}
