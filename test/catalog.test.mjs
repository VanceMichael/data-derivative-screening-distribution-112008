import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCatalog, parseLinks, resolveEdition } from '../src/catalog.mjs';

const HTML = `<!doctype html><main>
<article data-edition="cut1"><h2>第一版</h2>
  <span data-track="picture" data-part="derivative" data-in="1" data-out="13">画面</span>
  <span data-track="sound" data-part="oral" data-in="12" data-out="20">声音</span>
</article>
<article data-edition="cut2"><h2>第二版</h2>
  <span data-track="picture" data-part="archive" data-in="7" data-out="13">画面</span>
  <span data-track="sound" data-part="oral" data-in="12" data-out="20">声音</span>
</article>
</main>`;

const LINKS = [
  { derived: 'derivative', from: 0, to: 8, source: 'archive', at: 6 },
  { derived: 'derivative', from: 8, to: 14, source: 'photo', at: 0 },
];

test('编目页按成片版号解析素材引用', () => {
  const editions = parseCatalog(HTML);
  assert.deepEqual([...editions.keys()], ['cut1', 'cut2']);
  assert.equal(editions.get('cut1').title, '第一版');
  assert.deepEqual(editions.get('cut1').parts, [
    { track: 'picture', part: 'derivative', start: 1, end: 13 },
    { track: 'sound', part: 'oral', start: 12, end: 20 },
  ]);
});

test('派生素材按 at 映射回原始区段，不向下取整', () => {
  const editions = parseCatalog(HTML);
  const links = parseLinks(LINKS);
  const resolved = resolveEdition(editions.get('cut1'), links);
  const picture = resolved.tracks.find((track) => track.track === 'picture');
  // derivative 1-8 秒 → archive 7-14；derivative 8-13 秒 → photo 0-5。
  assert.deepEqual(picture.segments, [
    { item: 'photo', track: 'picture', start: 0, end: 5 },
    { item: 'archive', track: 'picture', start: 7, end: 14 },
  ]);
  const sound = resolved.tracks.find((track) => track.track === 'sound');
  assert.deepEqual(sound.segments, [{ item: 'oral', track: 'sound', start: 12, end: 20 }]);
});

test('派生素材只用到一部分时按实际秒段裁剪', () => {
  const editions = parseCatalog(`<article data-edition="x"><span data-track="picture" data-part="derivative" data-in="9" data-out="12">片段</span></article>`);
  const resolved = resolveEdition(editions.get('x'), parseLinks(LINKS));
  assert.deepEqual(resolved.tracks[0].segments, [{ item: 'photo', track: 'picture', start: 1, end: 4 }]);
});

test('派生素材区段对照有洞时记录问题，不静默少算', () => {
  const editions = parseCatalog(`<article data-edition="x"><span data-track="picture" data-part="derivative" data-in="0" data-out="20">片段</span></article>`);
  const links = parseLinks([{ derived: 'derivative', from: 0, to: 8, source: 'archive', at: 6 }]);
  const resolved = resolveEdition(editions.get('x'), links);
  assert.equal(resolved.problems[0].code, 'derived-gap');
  assert.deepEqual(resolved.tracks[0].segments, [{ item: 'archive', track: 'picture', start: 6, end: 14 }]);
});

test('派生素材形成环路时记录问题而不是死循环', () => {
  const editions = parseCatalog(`<article data-edition="x"><span data-track="picture" data-part="a" data-in="0" data-out="4">x</span></article>`);
  const links = parseLinks([
    { derived: 'a', from: 0, to: 4, source: 'b', at: 0 },
    { derived: 'b', from: 0, to: 4, source: 'a', at: 0 },
  ]);
  const resolved = resolveEdition(editions.get('x'), links);
  assert.ok(resolved.problems.some((problem) => problem.code === 'derived-cycle'));
});

test('无效的素材引用不会让整个编目失败', () => {
  const editions = parseCatalog(`<article data-edition="x">
    <span data-track="picture" data-part="a" data-in="5" data-out="2">倒置</span>
    <span data-track="sound" data-part="b" data-in="0" data-out="1">声音</span>
  </article><article data-edition="y"><span data-track="picture" data-part="c" data-in="0" data-out="1">ok</span></article>`);
  assert.equal(editions.get('x').problems[0].code, 'invalid-part');
  assert.equal(editions.get('x').parts.length, 1);
  assert.equal(editions.get('y').parts.length, 1);
});
