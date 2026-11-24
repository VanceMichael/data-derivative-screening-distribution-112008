import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRightsModel, evaluateClearance } from '../src/rights.mjs';
import { parseInstant } from '../src/time.mjs';

const WINDOW = {
  windowStart: parseInstant('2026-12-05T09:00:00+08:00'),
  windowEnd: parseInstant('2026-12-05T18:00:00+08:00'),
};

const flat = (picture, sound) => ({ picture, sound });
const seg = (item, start, end) => ({ item, start, end, via: [] });

function entry(overrides) {
  return {
    id: overrides.id,
    owner: `owner-${overrides.id}`,
    item: overrides.item,
    track: overrides.track,
    start: overrides.start,
    end: overrides.end,
    venue: overrides.venue ?? 'web',
    use: overrides.use ?? 'public-web',
    validFrom: '2026-12-01T00:00:00Z',
    validUntil: '2026-12-07T00:00:00Z',
    ...(overrides.licenseNo ? { licenseNo: overrides.licenseNo } : {}),
  };
}

test('同一素材相邻有效区段可以共同覆盖', () => {
  const entries = [
    entry({ id: 'a', item: 'film', track: 'picture', start: 0, end: 5 }),
    entry({ id: 'b', item: 'film', track: 'picture', start: 5, end: 10 }),
  ];
  const model = buildRightsModel(entries, []);
  const result = evaluateClearance(
    flat([seg('film', 0, 10)], []),
    model,
    { venue: 'web', use: 'public-web', ...WINDOW },
  );
  assert.equal(result.verdict, 'cleared');
  assert.deepEqual(result.evidence[0].licenseNos, ['a', 'b']);
});

test('声音与画面各自需要证据：只授权画面不能放行混合版本', () => {
  const entries = [entry({ id: 'p', item: 'film', track: 'picture', start: 0, end: 10 })];
  const model = buildRightsModel(entries, []);
  const result = evaluateClearance(
    flat([seg('film', 0, 10)], [seg('voice', 0, 8)]),
    model,
    { venue: 'web', use: 'public-web', ...WINDOW },
  );
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.hardGaps[0].track, 'sound');
  assert.match(result.hardGaps[0].missingType, /声音使用许可/);
});

test('授权只覆盖同一介质、用途及地点', () => {
  const entries = [
    entry({ id: 'hall', item: 'film', track: 'picture', start: 0, end: 10, venue: 'hall', use: 'on-site' }),
  ];
  const model = buildRightsModel(entries, []);
  const result = evaluateClearance(
    flat([seg('film', 0, 10)], []),
    model,
    { venue: 'web', use: 'public-web', ...WINDOW },
  );
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.hardGaps.length, 1);
});

test('撤回按生效时点缩短授权范围，之后的窗口产生硬缺口', () => {
  const entries = [entry({ id: 'w', item: 'film', track: 'picture', start: 0, end: 10 })];
  const amendments = [{
    right: 'w',
    effective: '2026-12-05T10:00:00+08:00',
    action: 'withdraw',
  }];
  const model = buildRightsModel(entries, amendments);
  const result = evaluateClearance(
    flat([seg('film', 0, 10)], []),
    model,
    { venue: 'web', use: 'public-web', ...WINDOW },
  );
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.hardGaps[0].timeRange[0], parseInstant('2026-12-05T10:00:00+08:00'));
});

test('收窄到别的场地后原场地出现缺口，恢复后重新完整', () => {
  const entries = [entry({ id: 'w', item: 'film', track: 'picture', start: 0, end: 10 })];
  const amendments = [
    { right: 'w', effective: '2026-12-05T10:00:00+08:00', action: 'restrict', venue: 'hall' },
    { right: 'w', effective: '2026-12-05T14:00:00+08:00', action: 'restore' },
  ];
  const model = buildRightsModel(entries, amendments);
  const result = evaluateClearance(
    flat([seg('film', 0, 10)], []),
    model,
    { venue: 'web', use: 'public-web', ...WINDOW },
  );
  assert.equal(result.verdict, 'blocked');
  const gapStarts = result.hardGaps.map((gap) => gap.timeRange[0]);
  assert.ok(gapStarts.includes(parseInstant('2026-12-05T10:00:00+08:00')));
  // 恢复后 [14:00, 18:00) 重新有证据，最后一段不再有缺口。
  const tailGap = result.hardGaps.find(
    (gap) => gap.timeRange[1] === parseInstant('2026-12-05T18:00:00+08:00')
      && gap.timeRange[0] === parseInstant('2026-12-05T14:00:00+08:00'),
  );
  assert.equal(tailGap, undefined);
});

test('限定条款无法解释时只冻结并指出缺的使用许可类型', () => {
  const entries = [entry({ id: 'w', item: 'film', track: 'picture', start: 0, end: 10 })];
  const amendments = [{
    right: 'w',
    effective: '2026-12-05T10:00:00+08:00',
    action: 'add-special-term',
  }];
  const model = buildRightsModel(entries, amendments);
  const result = evaluateClearance(
    flat([seg('film', 0, 10)], []),
    model,
    { venue: 'web', use: 'public-web', ...WINDOW },
  );
  assert.equal(result.verdict, 'frozen');
  assert.equal(result.hardGaps.length, 0);
  assert.equal(result.freezeGaps[0].right, 'w');
  assert.match(result.freezeGaps[0].missingType, /待人工解释的限定条款/);
});

test('指向不存在授权的修订同样进入冻结而非误放行', () => {
  const model = buildRightsModel([], [{
    right: 'ghost',
    effective: '2026-12-05T10:00:00+08:00',
    action: 'withdraw',
  }]);
  const result = evaluateClearance(
    flat([seg('film', 0, 10)], []),
    model,
    { venue: 'web', use: 'public-web', ...WINDOW },
  );
  assert.equal(result.verdict, 'blocked'); // 本来就没有授权 -> 硬缺口
  assert.equal(model.freezes[0].right, 'ghost');
});

test('硬缺口优先于冻结结论', () => {
  const entries = [
    entry({ id: 'p', item: 'film', track: 'picture', start: 0, end: 10 }),
  ];
  const amendments = [{
    right: 'p',
    effective: '2026-12-05T10:00:00+08:00',
    action: 'mystery',
  }];
  const model = buildRightsModel(entries, amendments);
  const result = evaluateClearance(
    flat([seg('film', 0, 10)], [seg('voice', 0, 4)]),
    model,
    { venue: 'web', use: 'public-web', ...WINDOW },
  );
  assert.equal(result.verdict, 'blocked');
  assert.ok(result.freezeGaps.length > 0);
});
