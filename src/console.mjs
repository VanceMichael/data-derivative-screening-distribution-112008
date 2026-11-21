// 策展人控制台（单页、无构建、无外部资源）。
// 页面只调用本服务的接口；来源资料、回执与审计都在服务端完成。

export function consolePage() {
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>展陈授权与终端发布</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, "Noto Sans CJK SC", sans-serif; }
  body { margin: 0; padding: 1.25rem; line-height: 1.5; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
  .bar { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: .75rem 0; }
  input, select, button { font: inherit; padding: .3rem .5rem; }
  button { cursor: pointer; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent); padding: .4rem .5rem; text-align: left; vertical-align: top; }
  th { font-weight: 600; }
  .pill { display: inline-block; border-radius: 999px; padding: .05rem .5rem; font-size: .8rem; border: 1px solid currentColor; }
  .ok { color: #16794a; } .warn { color: #9a5b00; } .bad { color: #b3261e; } .muted { opacity: .65; }
  details { margin: .25rem 0; } summary { cursor: pointer; }
  code { font-size: .85em; }
  .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
  .card { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: .5rem; padding: .75rem; }
</style>
<h1>展陈授权与终端发布</h1>
<p class="muted">用成片实际用到的原始素材区段核对授权；只冻结受影响的播放安排。时间为带时区的半开区间。</p>

<div class="bar">
  <label>判断时刻 <input id="at" size="30" placeholder="2026-12-05T10:30:00+08:00"></label>
  <button id="sync">同步来源</button>
  <button id="refresh">查看状态</button>
  <button id="reconcile">按状态发布</button>
  <span id="msg" class="muted"></span>
</div>

<h2>编目位</h2>
<div id="slots" class="grid"></div>

<h2>需要人工联系 / 处理</h2>
<div id="attention"></div>

<h2>按已发生的放映回看</h2>
<div class="bar">
  <label>终端 <input id="screen" size="6" value="P2"></label>
  <label>编目位 <input id="slot" size="10" value="feature"></label>
  <button id="lookup">回看</button>
</div>
<div id="screenings"></div>

<script type="module" src="/console.js"></script>
`;
}

export async function consoleScript() {
  return SCRIPT;
}

const SCRIPT = String.raw`
const $ = (id) => document.getElementById(id);
const at = () => $('at').value.trim() || undefined;
const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const when = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';

function say(text, kind = 'muted') { $('msg').className = kind; $('msg').textContent = text; }

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

const PHASES = {
  on: ['已确认在播', 'ok'],
  off: ['已确认停止', 'muted'],
  'starting-pending': ['上线未确认', 'warn'],
  'stopping-pending': ['下线未确认', 'bad'],
  offline: ['终端失联', 'bad'],
  'playing-unlicensed': ['回执已失效', 'bad'],
  unknown: ['无回执', 'muted'],
};

function phasePill(player) {
  const [label, tone] = PHASES[player.phase] ?? [player.phase, 'muted'];
  return '<span class="pill ' + tone + '">' + esc(label) + '</span>';
}

function arrangementCard(item) {
  const missing = item.missing?.length ? '<div class="bad">缺：' + item.missing.map((m) => esc({ time: '时段许可', scope: '场地/用途许可', unregistered: '素材登记', material: '素材区段', catalog: '编目区段', rights: '授权登记', amendment: '限定条款' }[m] ?? m)).join('、') + '</div>' : '';
  const until = item.nextChange ? '<div class="warn">当前依据仅到 ' + esc(when(item.nextChange)) + '</div>' : '';
  const gaps = (item.gaps ?? []).flatMap((gap) => {
    const head = esc(gap.track === 'sound' ? '声音' : '画面') + ' ' + esc(gap.item);
    const parts = gap.missingParts?.length ? gap.missingParts : [{ start: gap.material?.start, end: gap.material?.end, label: gap.missingLabel }];
    return parts.map((part) => '<li>' + head + ' ' + esc(part.start) + '–' + esc(part.end) + ' 秒：' + esc(part.label ?? gap.missingLabel ?? gap.reason) + '</li>');
  }).join('');
  const basis = (item.basis ?? []).map((right) => '<li>' + esc(right.id) + '（' + esc(right.owner) + '，' + esc(right.item) + ' ' + esc(right.start) + '–' + esc(right.end) + ' 秒）</li>').join('');
  const material = (view) => {
    if (!view) return '';
    const rows = view.tracks.map((track) => '<li>' + esc(track.track === 'sound' ? '声音' : '画面') + '：'
      + track.segments.map((seg) => esc(seg.item) + ' ' + esc(seg.start) + '–' + esc(seg.end) + ' 秒').join('；') + '</li>').join('');
    return '<details><summary>成片片段（' + esc(view.title || '') + '）</summary><ul>' + rows + '</ul></details>';
  };
  return '<div class="card">'
    + '<div><strong>' + esc(item.screen) + ' / ' + esc(item.slot) + '</strong> ' + phasePill(item.player) + '</div>'
    + '<div class="muted">' + esc(item.venue) + ' · ' + esc(item.use) + ' · ' + esc(item.state) + '</div>'
    + '<div>当前版 <code>' + esc(item.edition) + '</code>' + (item.alternative ? '，替换 <code>' + esc(item.alternative) + '</code>' : '') + '</div>'
    + '<div>动作：' + esc(item.action) + (item.targetEdition ? ' → <code>' + esc(item.targetEdition) + '</code>' : '') + '</div>'
    + (item.reason ? '<div class="muted">' + esc(item.reason) + '</div>' : '')
    + '<div>' + (item.covered ? '<span class="ok">授权完整</span>' : '<span class="bad">授权不足</span>') + (item.updated ? ' · <span class="ok">编目位已更新</span>' : '') + '</div>'
    + (missing ? '<div>' + missing + '</div>' : '')
    + until
    + material(item.material)
    + (item.alternativeMaterial ? material(item.alternativeMaterial) : '')
    + (gaps ? '<details><summary>缺口</summary><ul>' + gaps + '</ul></details>' : '')
    + (basis ? '<details><summary>当前许可依据</summary><ul>' + basis + '</ul></details>' : '')
    + '<div class="muted">' + esc(item.player.note ?? '') + '</div>'
    + '<div class="muted">已确认序号 ' + esc(item.player.confirmedSequence ?? '—') + '</div>'
    + '</div>';
}

function render(status) {
  document.querySelectorAll('[data-slot]').forEach((node) => node.remove());
  const slots = $('slots');
  slots.innerHTML = '';
  if (!status.slots?.length) { slots.innerHTML = '<p class="muted">还没有可用的展期安排，请先同步来源。</p>'; return; }
  for (const slot of status.slots) {
    for (const item of slot.arrangements) slots.insertAdjacentHTML('beforeend', arrangementCard(item));
  }
  const attention = $('attention');
  if (!status.attention?.length) attention.innerHTML = '<p class="ok">没有需要人工处理的点。</p>';
  else attention.innerHTML = '<table><tr><th>类型</th><th>终端/位</th><th>说明</th></tr>' + status.attention.map((item) =>
    '<tr><td>' + esc({ offline: '失联', 'unconfirmed-stop': '停止未确认', rights: '授权缺口' }[item.kind] ?? item.kind) + '</td><td>' + esc(item.screen + '/' + item.slot) + '</td><td>' + esc(item.detail ?? item.missing?.join('、')) + '</td></tr>').join('') + '</table>';
}

async function refresh() {
  try {
    const query = at() ? '?at=' + encodeURIComponent(at()) : '';
    const status = await api('/status' + query);
    render(status);
    say('已更新 ' + when(status.fetchedAt));
  } catch (error) { say(error.message, 'bad'); }
}

$('sync').onclick = async () => {
  try { const result = await api('/sync', { method: 'POST' }); say('已同步 ' + result.editions.length + ' 个成片版号' + (result.errors.length ? '（有 ' + result.errors.length + ' 项来源错误）' : '')); await refresh(); }
  catch (error) { say(error.message, 'bad'); }
};
$('refresh').onclick = refresh;
$('reconcile').onclick = async () => {
  try {
    const query = at() ? '?at=' + encodeURIComponent(at()) : '';
    const result = await api('/reconcile' + query, { method: 'POST' });
    say('已发出 ' + result.dispatched.length + ' 条命令');
    render(result.status);
  } catch (error) { say(error.message, 'bad'); }
};

$('lookup').onclick = async () => {
  try {
    const data = await api('/screenings?screen=' + encodeURIComponent($('screen').value.trim()) + '&slot=' + encodeURIComponent($('slot').value.trim()));
    const target = $('screenings');
    if (!data.sessions.length) { target.innerHTML = '<p class="muted">没有回执记录。</p>'; return; }
    target.innerHTML = data.sessions.map((session) =>
      '<div class="card"><div><strong>' + esc(session.edition) + '</strong> ' + esc(when(session.startedAt)) + ' → ' + esc(when(session.endedAt)) + '</div>'
      + '<div class="muted">' + esc(session.endReason) + '</div>'
      + '<details><summary>当时使用的素材区段</summary><ul>' + (session.material ?? []).map((track) =>
        '<li>' + esc(track.track === 'sound' ? '声音' : '画面') + '：' + track.segments.map((s) => esc(s.item) + ' ' + esc(s.start) + '–' + esc(s.end) + ' 秒').join('；') + '</li>').join('') + '</ul></details>'
      + '<details><summary>当时依据的授权</summary><ul>' + (session.rights ?? []).map((right) =>
        '<li>' + esc(right.id) + '（' + esc(right.owner) + '，' + esc(right.item) + '）</li>').join('') + '</ul></details>'
      + '</div>').join('');
  } catch (error) { say(error.message, 'bad'); }
};

refresh();
`;
