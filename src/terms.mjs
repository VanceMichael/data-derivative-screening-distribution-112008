// 限定条款解释。
//
// 授权登记可能补传一条正文式的限定条款（terms）。我们只接受一个很小的、可复核的
// 语法；解释不了时明确返回 ok:false，由策展端冻结依赖这条授权的安排，而不是猜。

import { isZonedInstant } from './time.mjs';

// 按最长匹配优先。每个短语同时给出它收窄的场地与/或用途。
const PHRASES = [
  { text: '仅限馆内放映', venue: 'hall', use: 'on-site' },
  { text: '仅限现场放映', venue: 'hall', use: 'on-site' },
  { text: '馆内放映', venue: 'hall', use: 'on-site' },
  { text: '现场放映', venue: 'hall', use: 'on-site' },
  { text: '仅限公开网页', venue: 'web', use: 'public-web' },
  { text: '公开网页', venue: 'web', use: 'public-web' },
  { text: '仅限网页', venue: 'web', use: 'public-web' },
  { text: '仅限馆内', venue: 'hall' },
  { text: '仅限现场', venue: 'hall' },
  { text: '仅限展厅', venue: 'hall' },
  { text: '馆内', venue: 'hall' },
  { text: '现场', venue: 'hall' },
  { text: '展厅', venue: 'hall' },
  { text: '网页', venue: 'web', use: 'public-web' },
  { text: 'on-site', venue: 'hall', use: 'on-site' },
  { text: 'public-web', venue: 'web', use: 'public-web' },
  { text: 'hall', venue: 'hall' },
  { text: 'web', venue: 'web', use: 'public-web' },
].sort((a, b) => b.text.length - a.text.length);

const FILLER = /仅限(?:在|于)?|只(?:能|可)在|只(?:能|可)用于|使用|播放|传播|范围|场地|用途|的|和|与|，|,|。|；|;|\s/gu;

function scan(text) {
  let rest = text;
  let venue;
  let use;
  for (const phrase of PHRASES) {
    if (!rest.toLowerCase().includes(phrase.text.toLowerCase())) continue;
    venue ??= phrase.venue;
    use ??= phrase.use;
    rest = rest.replace(new RegExp(phrase.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), ' ');
  }
  return { rest, venue, use };
}

// 支持：
//   * 结构化对象 { venue?, use?, from?, until? }；
//   * 文本 "仅限馆内放映"、"仅限公开网页"、"自 2026-12-05T10:00:00+08:00 起" 等。
// 返回 { ok:true, venue?, use?, validFrom?, validUntil? } 或 { ok:false, reason }。
export function interpretClause(terms) {
  if (terms === undefined || terms === null || terms === '') return { ok: true };
  if (typeof terms === 'object' && !Array.isArray(terms)) {
    const { venue, use, from, until } = terms;
    if (venue !== undefined && typeof venue !== 'string') return { ok: false, reason: '限定条款的 venue 不是字符串' };
    if (use !== undefined && typeof use !== 'string') return { ok: false, reason: '限定条款的 use 不是字符串' };
    if (from !== undefined && !isZonedInstant(from)) return { ok: false, reason: '限定条款的起始时刻不带时区' };
    if (until !== undefined && !isZonedInstant(until)) return { ok: false, reason: '限定条款的结束时刻不带时区' };
    return { ok: true, venue, use, validFrom: from, validUntil: until };
  }
  if (typeof terms !== 'string') return { ok: false, reason: '限定条款既不是结构化对象也不是文本' };

  const text = terms.trim();
  if (text === '') return { ok: true };

  let rest = text;
  let validFrom;
  let validUntil;

  const fromMatch = /(?:自|从)\s*([0-9T:.+\-Z]+)\s*(?:起|开始)/.exec(rest);
  if (fromMatch) {
    if (!isZonedInstant(fromMatch[1])) return { ok: false, reason: '限定条款的起始时刻不带时区' };
    validFrom = fromMatch[1];
    rest = rest.replace(fromMatch[0], ' ');
  }
  const untilMatch = /(?:至|到)\s*([0-9T:.+\-Z]+)\s*(?:止|结束)/.exec(rest);
  if (untilMatch) {
    if (!isZonedInstant(untilMatch[1])) return { ok: false, reason: '限定条款的结束时刻不带时区' };
    validUntil = untilMatch[1];
    rest = rest.replace(untilMatch[0], ' ');
  }

  const scanned = scan(rest);
  rest = scanned.rest.replace(FILLER, '');
  if (rest !== '') return { ok: false, reason: `限定条款含无法识别的约束：${text}` };
  if (scanned.venue === undefined && scanned.use === undefined && !validFrom && !validUntil) {
    return { ok: false, reason: `限定条款没有可执行的约束：${text}` };
  }
  if (scanned.venue !== undefined && scanned.use !== undefined) {
    const expectedUse = scanned.venue === 'hall' ? 'on-site' : 'public-web';
    if (scanned.use !== expectedUse) {
      return { ok: false, reason: `限定条款把场地 ${scanned.venue} 与用途 ${scanned.use} 混在一起` };
    }
  }
  return { ok: true, venue: scanned.venue, use: scanned.use, validFrom, validUntil };
}
