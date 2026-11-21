// 编目页与派生素材对照。
//
// 成片（edition）由若干素材引用（part）组成，每个引用带轨道和半开秒区间。
// 素材可能本身是派生素材：/catalog/links 用 at 与同长度区段把它映射回原始素材。
// 授权必须以映射后的原始素材区段为准，因此这里把每次引用递归展开到原始素材。

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(value) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function parseAttributes(text) {
  const attributes = {};
  const pattern = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    attributes[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function textOf(html) {
  return decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function seconds(attributes, name) {
  const raw = attributes[name];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// 解析编目页。返回 Map<版号, { edition, title, parts, problems }>。
// 单个版号的问题留在该版号上，不会让其他版号一起失效。
export function parseCatalog(html) {
  const editions = new Map();
  const articles = /<article\b([^>]*)>([\s\S]*?)<\/article>/gi;
  let article;
  while ((article = articles.exec(html)) !== null) {
    const attributes = parseAttributes(article[1]);
    const edition = attributes['data-edition'];
    if (!edition) continue;
    const current = editions.get(edition) ?? { edition, title: '', parts: [], problems: [] };
    if (editions.has(edition)) current.problems.push({ code: 'duplicate-edition', edition });
    const body = article[2];
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(body);
    if (heading) current.title = textOf(heading[1]);

    const spans = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
    let span;
    while ((span = spans.exec(body)) !== null) {
      const partAttributes = parseAttributes(span[1]);
      const track = partAttributes['data-track'];
      const part = partAttributes['data-part'];
      const start = seconds(partAttributes, 'data-in');
      const end = seconds(partAttributes, 'data-out');
      if (!track || !part || start === null || end === null || !(start < end)) {
        current.problems.push({
          code: 'invalid-part',
          edition,
          track: track ?? null,
          part: part ?? null,
          detail: `素材引用需要 data-track、data-part、data-in < data-out：${span[1].trim()}`,
        });
        continue;
      }
      current.parts.push({ track, part, start, end });
    }
    if (current.parts.length === 0 && current.problems.length === 0) {
      current.problems.push({ code: 'empty-edition', edition });
    }
    editions.set(edition, current);
  }
  return editions;
}

// 校验 /catalog/links：数字字段、非空区间、同一派生区段不重叠。
export function parseLinks(body) {
  const problems = [];
  const byDerived = new Map();
  const list = Array.isArray(body) ? body : [];
  for (const raw of list) {
    const link = {
      derived: raw?.derived,
      from: Number(raw?.from),
      to: Number(raw?.to),
      source: raw?.source,
      at: Number(raw?.at),
    };
    if (typeof link.derived !== 'string' || typeof link.source !== 'string'
      || !Number.isFinite(link.from) || !Number.isFinite(link.to) || !Number.isFinite(link.at)
      || !(link.from < link.to)) {
      problems.push({ code: 'invalid-link', link: raw });
      continue;
    }
    const bucket = byDerived.get(link.derived) ?? [];
    bucket.push(link);
    byDerived.set(link.derived, bucket);
  }
  for (const [derived, links] of byDerived) {
    links.sort((a, b) => a.from - b.from);
    for (let index = 1; index < links.length; index += 1) {
      if (links[index].from < links[index - 1].to) {
        problems.push({
          code: 'overlapping-links',
          derived,
          detail: `${links[index - 1].from}-${links[index - 1].to} 与 ${links[index].from}-${links[index].to} 重叠`,
        });
      }
    }
  }
  return { byDerived, problems };
}

function mergeSegments(segments) {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const segment of sorted) {
    const last = merged.at(-1);
    if (last && last.item === segment.item && last.track === segment.track && segment.start <= last.end) {
      last.end = Math.max(last.end, segment.end);
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

function linkCoverage(links, start, end) {
  const pieces = [];
  let cursor = start;
  for (const link of links) {
    if (link.to <= cursor) continue;
    if (link.from > cursor) break;
    pieces.push([cursor, Math.min(end, link.to)]);
    cursor = Math.max(cursor, link.to);
    if (cursor >= end) break;
  }
  const complete = cursor >= end;
  return { pieces, complete, missing: complete ? [] : [[cursor, end]] };
}

// 把一个素材引用递归展开为原始素材区段。
// 派生素材未覆盖到的部分会记录问题，而不是悄悄少算一段授权。
export function resolvePart(part, links, options = {}) {
  const { track, start, end } = part;
  const depth = options.depth ?? 0;
  const stack = options.stack ?? [];
  const problems = [];
  if (depth > 16) {
    return { segments: [], problems: [{ code: 'derived-depth', part: part.part }] };
  }
  if (stack.includes(part.part)) {
    return { segments: [], problems: [{ code: 'derived-cycle', part: part.part, detail: [...stack, part.part].join(' → ') }] };
  }
  const linksForPart = links.byDerived.get(part.part);
  if (!linksForPart) {
    return { segments: [{ item: part.part, track, start, end }], problems };
  }
  const coverage = linkCoverage(linksForPart, start, end);
  if (coverage.pieces.length === 0) {
    return {
      segments: [],
      problems: [{
        code: 'derived-gap',
        part: part.part,
        detail: `派生素材 ${part.part} 的 ${start}-${end} 秒没有区段对照`,
        missing: coverage.missing,
      }],
    };
  }
  if (!coverage.complete) {
    problems.push({
      code: 'derived-gap',
      part: part.part,
      detail: `派生素材 ${part.part} 的 ${start}-${end} 秒只有部分区段对照`,
      missing: coverage.missing,
    });
  }
  const segments = [];
  for (const [from, to] of coverage.pieces) {
    const link = linksForPart.find((item) => item.from <= from && from < item.to);
    const sourceStart = link.at + (from - link.from);
    const sourceEnd = sourceStart + (to - from);
    const nested = resolvePart(
      { track, part: link.source, start: sourceStart, end: sourceEnd },
      links,
      { depth: depth + 1, stack: [...stack, part.part] },
    );
    segments.push(...nested.segments);
    problems.push(...nested.problems);
  }
  return { segments: mergeSegments(segments), problems };
}

// 解析一部成片的全部引用，得到按轨道分组的原始素材需求。
export function resolveEdition(edition, links) {
  const problems = [...(edition.problems ?? [])];
  const byTrack = new Map();
  for (const part of edition.parts) {
    const resolved = resolvePart(part, links);
    problems.push(...resolved.problems);
    const bucket = byTrack.get(part.track) ?? { track: part.track, references: [], segments: [] };
    bucket.references.push({ part: part.part, start: part.start, end: part.end });
    bucket.segments.push(...resolved.segments);
    byTrack.set(part.track, bucket);
  }
  const tracks = [...byTrack.values()].map((item) => ({
    ...item,
    segments: mergeSegments(item.segments),
  }));
  return { edition: edition.edition, title: edition.title, tracks, problems };
}
