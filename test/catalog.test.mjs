import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCatalog, flattenEdition, resolveEdition } from '../src/catalog.mjs';

const html = `<!doctype html><main>
<article data-edition="cut1">
  <span data-track="picture" data-part="derivative" data-in="1" data-out="13">画面</span>
  <span data-track="sound" data-part="oral" data-in="12" data-out="20">声音</span>
</article>
<article data-edition="cut2">
  <span data-track="picture" data-part="archive" data-in="7" data-out="13">画面</span>
  <span data-track="sound" data-part="oral" data-in="12" data-out="20">声音</span>
</article>
</main>`;

const links = [
  { derived: 'derivative', from: 0, to: 8, source: 'archive', at: 6 },
  { derived: 'derivative', from: 8, to: 14, source: 'photo', at: 0 },
];

test('编目页解析出版本与两条介质的直接引用', () => {
  const editions = parseCatalog(html);
  assert.deepEqual(editions.get('cut1').picture, [{ part: 'derivative', start: 1, end: 13 }]);
  assert.deepEqual(editions.get('cut1').sound, [{ part: 'oral', start: 12, end: 20 }]);
  assert.deepEqual(editions.get('cut2').picture, [{ part: 'archive', start: 7, end: 13 }]);
});

test('派生素材递归还原为原始素材上的半开区段', () => {
  const flat = resolveEdition(html, links, 'cut1');
  // derivative[1,8) -> archive[7,14)；derivative[8,13) -> photo[0,5)
  assert.deepEqual(flat.picture, [
    { item: 'archive', start: 7, end: 14, via: [{ part: 'derivative', start: 1, end: 8 }] },
    { item: 'photo', start: 0, end: 5, via: [{ part: 'derivative', start: 8, end: 13 }] },
  ]);
  // 无派生链接的素材保持自身坐标。
  assert.deepEqual(flat.sound, [
    { item: 'oral', start: 12, end: 20, via: [] },
  ]);
});

test('只与引用部分相交的派生链接按交集映射', () => {
  const refs = { picture: [{ part: 'derivative', start: 6, end: 10, via: [] }], sound: [] };
  const flat = flattenEdition(refs, links);
  assert.deepEqual(flat.picture, [
    { item: 'archive', start: 12, end: 14, via: [{ part: 'derivative', start: 6, end: 8 }] },
    { item: 'photo', start: 0, end: 2, via: [{ part: 'derivative', start: 8, end: 10 }] },
  ]);
});

test('循环派生引用会被识别并报错', () => {
  const cyclic = [
    { derived: 'a', from: 0, to: 4, source: 'b', at: 0 },
    { derived: 'b', from: 0, to: 4, source: 'a', at: 0 },
  ];
  assert.throws(
    () => flattenEdition({ picture: [{ part: 'a', start: 0, end: 4, via: [] }], sound: [] }, cyclic),
    /循环引用/,
  );
});
