// 策展报告渲染（纯文本，中文）。机器可读结果请直接使用 views.mjs 返回的对象。

const TRACK_LABEL = { picture: '画面', sound: '声音' };

function line(ch = '─', count = 72) {
  return ch.repeat(count);
}

function renderFragments(fragments) {
  const rows = [];
  for (const track of ['picture', 'sound']) {
    for (const fragment of fragments[track]) {
      const via = fragment.via.length
        ? `（经 ${fragment.via.map((step) => `${step.part}[${step.range[0]},${step.range[1]})`).join('、')} 还原）`
        : '';
      rows.push(`    · ${TRACK_LABEL[track]} 原始素材 ${fragment.item}[${fragment.range[0]},${fragment.range[1]})${via}`);
    }
  }
  return rows.join('\n');
}

function renderEvidence(evidence) {
  if (!evidence.length) return '    · 无任何授权凭据';
  return evidence
    .map((item) => `    · ${TRACK_LABEL[item.track]} ${item.item}：授权编号 ${item.licenseNos.join('、') || '（缺）'}`)
    .join('\n');
}

function renderGaps(gaps, indent = '    ') {
  if (!gaps.length) return `${indent}无缺口`;
  return gaps.map((gap) => {
    const range = `${gap.materialRange[0]},${gap.materialRange[1]})`;
    return `${indent}· ${TRACK_LABEL[gap.track]} ${gap.item}[${range} 自 ${gap.effectiveFrom} 起：${gap.missingType}`
      + (gap.right ? `（涉及授权 ${gap.right}）` : '');
  }).join('\n');
}

function renderTerminal(terminal) {
  const stateLabel = {
    playing: '已确认在播',
    stopped: '已确认停止',
    'pending-offline': '下线待确认（仍可能播出）',
    'pending-activation': '上线待确认',
    idle: '空闲',
    'never-issued': '尚未发布',
  }[terminal.state] ?? terminal.state;
  const edition = terminal.confirmedEdition ? `，版本 ${terminal.confirmedEdition}` : '';
  return `    终端 ${terminal.screen}/${terminal.slot}：${stateLabel}${edition}，最新序号 ${terminal.sequence ?? 0}`;
}

export function renderSchedule(view) {
  const out = [];
  out.push(line('═'));
  out.push(`展期安排总览（判断时点 ${view.generatedAt ?? '无数据'}，阶段 ${view.phase ?? '-'}）`);
  out.push(line('═'));
  for (const item of view.arrangements) {
    out.push(`\n[${item.screen}/${item.slot}] 场地=${item.venue} 用途=${item.use} 版本=${item.edition}`);
    out.push(`  展期窗口：${item.window.from} 至 ${item.window.to}（半开）`);
    out.push('  成片实际使用的原始片段：');
    out.push(renderFragments(item.fragments));
    out.push(`  当前许可依据：${item.clearance.label}`);
    out.push(renderEvidence(item.clearance.evidence));
    if (item.clearance.gaps.length) {
      out.push('  缺口/冻结明细：');
      out.push(renderGaps(item.clearance.gaps, '    '));
    }
    out.push(renderTerminal(item.terminal));
    if (item.replacement) {
      const status = item.replacement.slotUpdated
        ? '编目位已按替代版本更新'
        : item.replacement.ready
          ? '替代版本授权完整，等待终端确认后更新编目位'
          : '替代版本授权尚不完整，仅预备';
      out.push(`  替代成片 ${item.replacement.edition}：${status}`);
      if (item.replacement.gaps.length) out.push(renderGaps(item.replacement.gaps, '    '));
    }
    if (item.needsManualContact) out.push(`  ⚠ 需要人工联系：${item.manualReason}`);
  }
  out.push('\n' + line());
  out.push('需要人工联系的点位：');
  if (!view.manualContacts.length) out.push('  无');
  for (const contact of view.manualContacts) {
    out.push(`  · ${contact.screen}/${contact.slot}：${contact.reason}`);
  }
  return out.join('\n') + '\n';
}

export function renderPlayback(view) {
  const out = [];
  out.push(line('═'));
  out.push(`放映回看：${view.screen}/${view.slot} @ ${view.at}`);
  out.push(line('═'));
  const receipt = view.terminalStatusAtPoint.confirmedReceipt;
  if (receipt) {
    out.push(`当时终端确认：${receipt.action === 'on' ? '在播' : '停止'}，版本 ${receipt.edition ?? '（未注明）'}，回执序号 ${receipt.sequence}，应用于 ${receipt.appliedAt}`);
  } else {
    out.push('当时没有“上线已应用”的终端确认，不能视为已放映。');
  }
  if (view.scheduledEdition) {
    out.push(`展期安排版本：${view.scheduledEdition.edition}（${view.scheduledEdition.venue}/${view.scheduledEdition.use}）`);
  }
  if (view.playedEdition) {
    out.push(`实际在播版本：${view.playedEdition.edition}`);
    out.push('当时使用的原始片段：');
    out.push(renderFragments(view.playedEdition.fragments));
    out.push('当时的授权凭据：');
    out.push(renderEvidence(view.playedEdition.evidence));
  }
  out.push(view.note);
  return out.join('\n') + '\n';
}
