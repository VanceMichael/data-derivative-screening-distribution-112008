// 编目解析：把成片版本实际用到的素材递归还原为“原始素材上的区段”。
// 编目页约定（见 README）：
//   data-edition 成片版号；data-track picture|sound；data-part 被引用素材；
//   data-in/data-out 为引用素材上以秒计的半开区间。
// /catalog/links：derived 派生素材上的 [from,to) 对应原始素材 source 上
//   从 at 开始的同长度区段，不跨增速或倒放。

const TRACKS = ['picture', 'sound'];

function parseInteger(value, label) {
  if (!/^\d+$/.test(value)) throw new TypeError(`编目字段 ${label} 不是非负整数：${value}`);
  return Number(value);
}

/** 解析编目 HTML，返回 { edition -> { picture, sound } 的直接引用列表 }。 */
export function parseCatalog(html) {
  const editions = new Map();
  const articlePattern = /<article\b[^>]*data-edition="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g;
  let articleMatch;
  while ((articleMatch = articlePattern.exec(html)) !== null) {
    const edition = articleMatch[1];
    const body = articleMatch[2];
    const refs = { picture: [], sound: [] };
    const spanPattern = /<span\b([^>]*)>(?:[^<]*)<\/span>/g;
    let spanMatch;
    while ((spanMatch = spanPattern.exec(body)) !== null) {
      const attributes = spanMatch[1];
      const get = (name) => {
        const match = attributes.match(new RegExp(`data-${name}="([^"]*)"`));
        return match ? match[1] : null;
      };
      const track = get('track');
      const part = get('part');
      if (!TRACKS.includes(track)) throw new TypeError(`编目 ${edition} 出现未知介质：${String(track)}`);
      if (!part) throw new TypeError(`编目 ${edition} 的引用缺少 data-part`);
      const start = parseInteger(get('in'), 'data-in');
      const end = parseInteger(get('out'), 'data-out');
      if (end <= start) throw new TypeError(`编目 ${edition}/${part} 的区段不是半开区间 [in,out)`);
      refs[track].push({ part, start, end });
    }
    editions.set(edition, refs);
  }
  if (editions.size === 0) throw new TypeError('编目页没有解析出任何成片版本');
  return editions;
}

/**
 * 依据派生链接把引用区段递归展开到原始素材。
 * 返回 { picture, sound }，每个元素为
 * { item, start, end, via:[{part,start,end}] }，区段均在原始素材坐标上。
 */
export function flattenEdition(editionRefs, links) {
  const result = { picture: [], sound: [] };
  for (const track of TRACKS) {
    const stack = editionRefs[track].map((ref) => ({ ...ref, via: [] }));
    const seen = new Set();
    while (stack.length > 0) {
      const node = stack.pop();
      const identity = `${node.part}:${node.start}:${node.end}`;
      if (seen.has(identity)) throw new TypeError(`派生素材 ${node.part} 存在循环引用`);
      seen.add(identity);
      const matching = links.filter((link) => link.derived === node.part);
      if (matching.length === 0) {
        result[track].push({ item: node.part, start: node.start, end: node.end, via: node.via });
        continue;
      }
      for (const link of matching) {
        const overlapStart = Math.max(node.start, link.from);
        const overlapEnd = Math.min(node.end, link.to);
        if (overlapStart >= overlapEnd) continue;
        const offset = link.at + (overlapStart - link.from);
        stack.push({
          part: link.source,
          start: offset,
          end: offset + (overlapEnd - overlapStart),
          via: [...node.via, { part: node.part, start: overlapStart, end: overlapEnd }],
        });
      }
    }
    result[track].sort((a, b) => a.item.localeCompare(b.item) || a.start - b.start);
  }
  return result;
}

/** 便捷入口：解析编目页并展开指定版本。 */
export function resolveEdition(html, links, edition) {
  const editions = parseCatalog(html);
  const refs = editions.get(edition);
  if (!refs) throw new TypeError(`编目中不存在成片版本：${edition}`);
  return flattenEdition(refs, links);
}
