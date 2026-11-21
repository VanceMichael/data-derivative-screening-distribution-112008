import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAmendments, evaluateEdition, parseEntries, usableFragments } from '../src/rights.mjs';
import { interpretClause } from '../src/terms.mjs';

const T = (text) => Date.parse(text);

function rightsOf(entries, amendments = []) {
  const parsed = parseEntries(entries);
  const folded = applyAmendments(parsed.entries, amendments);
  return { entries: parsed.entries, timeline: folded.timeline, problems: [...parsed.problems, ...folded.problems], applied: folded.applied };
}

const entry = (overrides) => ({
  id: 'r1',
  owner: 'R',
  item: 'archive',
  track: 'picture',
  start: 0,
  end: 10,
  venue: 'hall',
  use: 'on-site',
  validFrom: '2026-12-01T00:00:00+08:00',
  validUntil: '2026-12-07T00:00:00+08:00',
  ...overrides,
});

const resolved = (tracks) => ({
  edition: 'cut',
  title: '测试',
  problems: [],
  tracks: tracks.map(([track, segments]) => ({
    track,
    references: [],
    segments: segments.map(([item, start, end]) => ({ item, track, start, end })),
  })),
});

const scope = { venue: 'hall', use: 'on-site', asOfMs: T('2026-12-05T08:00:00+08:00') };

test('相邻有效区段可以共同覆盖素材区间', () => {
  const rights = rightsOf([
    entry({ id: 'a', start: 0, end: 5 }),
    entry({ id: 'b', start: 5, end: 10 }),
  ]);
  const result = evaluateEdition(resolved([['picture', [['archive', 0, 10]]]]), scope, rights);
  assert.equal(result.covered, true);
  assert.deepEqual(result.basis.map((item) => item.id).sort(), ['a', 'b']);
});

test('区段之间有空隙时不算覆盖，缺口落在正确秒段', () => {
  const rights = rightsOf([
    entry({ id: 'a', start: 0, end: 4 }),
    entry({ id: 'b', start: 6, end: 10 }),
  ]);
  const result = evaluateEdition(resolved([['picture', [['archive', 0, 10]]]]), scope, rights);
  assert.equal(result.covered, false);
  assert.equal(result.missing[0], 'material');
  assert.deepEqual(result.tracks[0].gaps[0].missing, [{ start: 4, end: 6 }]);
});

test('单靠已授权的画面来源不能放行混合版本', () => {
  const rights = rightsOf([entry({ id: 'pic', start: 0, end: 10 })]);
  const result = evaluateEdition(
    resolved([['picture', [['archive', 0, 10]]], ['sound', [['oral', 0, 8]]]]),
    scope,
    rights,
  );
  assert.equal(result.covered, false);
  assert.deepEqual(result.missing, ['unregistered']);
  assert.equal(result.tracks.find((track) => track.track === 'sound').covered, false);
  assert.equal(result.tracks.find((track) => track.track === 'picture').covered, true);
});

test('同一素材的轨道不通用：画面授权不能替代声音授权', () => {
  const rights = rightsOf([entry({ id: 'pic', track: 'picture', item: 'oral', start: 0, end: 10 })]);
  const result = evaluateEdition(resolved([['sound', [['oral', 0, 10]]]]), scope, rights);
  assert.equal(result.covered, false);
  assert.equal(result.tracks[0].gaps[0].reason, 'unregistered');
});

test('授权只覆盖同一场地和用途', () => {
  const rights = rightsOf([entry({ id: 'web', venue: 'web', use: 'public-web', start: 0, end: 10 })]);
  const result = evaluateEdition(resolved([['picture', [['archive', 0, 10]]]]), scope, rights);
  assert.equal(result.covered, false);
  assert.equal(result.tracks[0].gaps[0].reason, 'scope');
});

test('撤回按其 effective 生效：之前可用、之后不可用', () => {
  const rights = rightsOf(
    [entry({ id: 'r1', start: 0, end: 10 })],
    [{ right: 'r1', action: 'withdraw', effective: '2026-12-05T10:00:00+08:00' }],
  );
  const before = evaluateEdition(resolved([['picture', [['archive', 0, 10]]]]), scope, rights);
  assert.equal(before.covered, true);
  const after = evaluateEdition(
    resolved([['picture', [['archive', 0, 10]]]]),
    { ...scope, asOfMs: T('2026-12-05T10:00:00+08:00') },
    rights,
  );
  assert.equal(after.covered, false);
  assert.equal(after.tracks[0].gaps[0].reason, 'time');
});

test('撤回收窄到馆内后，馆内仍可用而网页不可用', () => {
  const rights = rightsOf(
    [entry({ id: 'hall', venue: 'hall', use: 'on-site', start: 0, end: 10 })],
    [{ right: 'hall', action: 'restrict', venue: 'hall', effective: '2026-12-05T10:00:00+08:00' }],
  );
  const hall = evaluateEdition(
    resolved([['picture', [['archive', 0, 10]]]]),
    { ...scope, asOfMs: T('2026-12-05T11:00:00+08:00') },
    rights,
  );
  assert.equal(hall.covered, true);
  // 收窄到馆内没有改变实际场地/用途，两段连续合并为一段。
  assert.equal(usableFragments(rights.entries[0], rights.timeline.get('hall')).length, 1);
});

test('恢复只撤销收窄，不会把已撤回的授权重新打开', () => {
  const rights = rightsOf(
    [entry({ id: 'r1', start: 0, end: 10, validUntil: '2026-12-05T12:00:00+08:00' })],
    [
      { right: 'r1', action: 'withdraw', effective: '2026-12-05T10:00:00+08:00' },
      { right: 'r1', action: 'restore', effective: '2026-12-05T11:00:00+08:00' },
    ],
  );
  const windows = usableFragments(rights.entries[0], rights.timeline.get('r1'));
  assert.deepEqual(windows.map((window) => [new Date(window.start).toISOString(), new Date(window.end).toISOString()]), [
    ['2026-11-30T16:00:00.000Z', '2026-12-05T02:00:00.000Z'],
  ]);
});

test('收窄后的恢复重新开放原场地', () => {
  const rights = rightsOf(
    [entry({ id: 'r1', start: 0, end: 10 })],
    [
      { right: 'r1', action: 'restrict', venue: 'hall', effective: '2026-12-05T10:00:00+08:00' },
      { right: 'r1', action: 'restore', effective: '2026-12-05T11:00:00+08:00' },
    ],
  );
  const windows = usableFragments(rights.entries[0], rights.timeline.get('r1'));
  // 收窄前后的片段对馆内仍然连续，恢复后应重新合并为一段。
  assert.equal(windows.length, 1);
  assert.equal(new Date(windows[0].start).toISOString(), '2026-11-30T16:00:00.000Z');
  assert.equal(new Date(windows[0].end).toISOString(), '2026-12-06T16:00:00.000Z');
});

test('限定条款可以收窄用途，无法解释时给出明确原因', () => {
  assert.deepEqual(interpretClause('仅限馆内放映'), {
    ok: true, venue: 'hall', use: 'on-site', validFrom: undefined, validUntil: undefined,
  });
  assert.deepEqual(interpretClause('仅限公开网页'), {
    ok: true, venue: 'web', use: 'public-web', validFrom: undefined, validUntil: undefined,
  });
  const bad = interpretClause('不得用于任何商业宣传');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /无法识别/);
  assert.equal(interpretClause({ venue: 'hall', from: '2026-12-05T10:00:00' }).ok, false);
});

test('无法解释的限定条款只冻结依赖它的安排', () => {
  const parsed = parseEntries([
    entry({ id: 'bad', item: 'archive', terms: '不得用于任何商业宣传' }),
    entry({ id: 'other', item: 'photo', start: 0, end: 5 }),
  ]);
  assert.ok(parsed.problems.some((problem) => problem.code === 'clause-unreadable'));
  const folded = applyAmendments(parsed.entries, []);
  const rights = { entries: parsed.entries, timeline: folded.timeline, problems: parsed.problems, applied: [] };
  const bad = evaluateEdition(resolved([['picture', [['archive', 0, 10]]]]), scope, rights);
  assert.equal(bad.covered, false);
  const good = evaluateEdition(resolved([['picture', [['photo', 0, 5]]]]), scope, rights);
  assert.equal(good.covered, true);
});

test('未知授权的修订被记录，不会静默丢弃', () => {
  const rights = rightsOf([entry({ id: 'r1' })], [{ right: 'missing', action: 'withdraw', effective: '2026-12-05T10:00:00+08:00' }]);
  assert.equal(rights.problems.length, 0);
  const parsed = parseEntries([entry({ id: 'r1' })]);
  const folded = applyAmendments(parsed.entries, [{ right: 'missing', action: 'withdraw', effective: '2026-12-05T10:00:00+08:00' }]);
  assert.equal(folded.unknown.length, 1);
  assert.equal(folded.unknown[0].right, 'missing');
});

test('不带时区的授权时段被拒绝', () => {
  const parsed = parseEntries([entry({ id: 'r1', validFrom: '2026-12-01T00:00:00' })]);
  assert.match(parsed.problems[0], /带时区/);
});
