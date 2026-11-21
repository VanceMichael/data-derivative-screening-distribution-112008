// 带时区时间的解析、半开区间运算与时间线采样。
//
// 约定：所有对外时刻都带明确偏移（如 +08:00 或 Z），内部统一换成 epoch
// 毫秒做比较；对外输出使用来源原样的 ISO 字符串，避免把时区信息丢掉。

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isZonedInstant(value) {
  return typeof value === 'string' && ISO_WITH_ZONE.test(value) && Number.isFinite(Date.parse(value));
}

export function toMillis(value, label = '时刻') {
  if (!isZonedInstant(value)) throw new TypeError(`${label} 必须带时区：${JSON.stringify(value)}`);
  return Date.parse(value);
}

export function toIso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

// 半开区间 [start, end)。start 必填；end 为空表示向未来敞开。
export function makeInterval(start, end, label = '区间') {
  const startMs = toMillis(start, `${label}起点`);
  const endMs = end === undefined || end === null ? Infinity : toMillis(end, `${label}终点`);
  if (!(startMs < endMs)) throw new TypeError(`${label}必须是半开区间且起点早于终点`);
  return { start: startMs, end: endMs, startText: start, endText: end ?? null };
}

export function contains(interval, millis) {
  return interval.start <= millis && millis < interval.end;
}

export function intersect(a, b) {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? { start, end, startText: toIso(start), endText: end === Infinity ? null : toIso(end) } : null;
}

// 把若干半开区间合并；首尾相接（前一段 end === 后一段 start）视为可共同覆盖。
// 只有 keyOf 相同的片段才合并：授权时间线用 key 区分实际场地/用途，避免把
// 收窄后的片段与登记范围混在一起。
export function mergeIntervals(intervals, keyOf = () => '') {
  const sorted = [...intervals]
    .map((interval) => ({ interval, key: keyOf(interval) }))
    .sort((a, b) => a.interval.start - b.interval.start || a.interval.end - b.interval.end);
  const merged = [];
  for (const { interval, key } of sorted) {
    const last = merged.at(-1);
    if (last && last.key === key && interval.start <= last.interval.end) {
      last.interval.end = Math.max(last.interval.end, interval.end);
    } else {
      merged.push({ key, interval: { ...interval } });
    }
  }
  return merged.map((item) => item.interval);
}

