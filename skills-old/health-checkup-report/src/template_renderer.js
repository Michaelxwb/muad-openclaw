'use strict';

const fs = require('fs/promises');
const path = require('path');

const DATA_FIELD_MAP = {
  'ops.devices-v': 'riskOverview.devices',
  'ops.sangfor-v': 'riskDetails.sangfor',
  'ops.af-v': 'riskDetails.af',
  'ops.aes-v': 'riskDetails.aes',
  'ops.sip-v': 'riskDetails.sip',
  'ops.sta-v': 'riskDetails.sta',
  'ops.other_sf-v': 'riskDetails.other_sf',
  'ops.third-v': 'riskDetails.third',
  'ops.log_reduce-v': 'ops.logReduce',
  'ops.alert_reduce-v': 'ops.alertReduce',
  'ops.severe-v': 'ops.severe',
  'ops.high-v': 'ops.high',
  'riskBiz': 'riskOverview.riskBusinessCount',
  'riskAssets': 'riskOverview.riskAssetCount',
  'impactAssets': 'riskOverview.affectedAssetCount'
};

const SECTION_RENDERERS = {
  'assetLedger.summary': renderAssetLedgerSummary,
  'riskOverview.topRiskAssetsSummary': renderTopRiskAssetsSummary,
  'riskOverview.topRiskAssetsSummaryFallback': renderTopRiskAssetsSummaryFallback,
  'keyRisks.01.desc': renderThreatActorRiskDescription,
  'keyRisks.02.desc': renderVulnAttackRiskDescription,
  'riskDetails.caseStudy': renderCaseStudySection,
  'riskDetails.potentialLoss': renderPotentialLoss,
  'riskDetail.severeHighEventsPhrase': renderSevereHighEventsPhrase,
  'riskDetail.sangforDeviceBreakdown': renderSangforDeviceBreakdown,
  'riskDetail.severeHighEventsTail': renderSevereHighEventsTail,
  'riskDetail.internetSummary': renderInternetRiskSummary,
  'riskDetail.intranetSummary': renderIntranetRiskSummary,
  'internet.vuln.levelDetail': renderInternetVulnLevelDetail,
  'internet.vuln.prioritySummary': renderInternetVulnPrioritySummary,
  'internet.vuln.topAssetsBlock': renderInternetVulnTopAssetsBlock,
  'internet.exposure.description': renderInternetExposureDescription,
  'intranet.vuln.levelDetail': renderIntranetVulnLevelDetail,
  'intranet.vuln.description': renderIntranetVulnDescription,
  'intranet.vuln.prioritySummary': renderIntranetVulnPrioritySummary,
  'intranet.vuln.bizTopBlock': renderIntranetVulnBizTopBlock,
  'intranet.vuln.assetTopBlock': renderIntranetVulnAssetTopBlock
};

const REPEAT_RENDERERS = {
  'riskOverview.keyRisks': renderKeyRiskRows,
  'riskOverview.topRiskAssets': renderTopRiskAssetRows,
  'riskDetails.highRiskIncidentExamples.vulnExploits': renderVulnExploitRows,
  'riskDetails.highRiskIncidentExamples.viruses': renderVirusRows,
  'riskDetails.highRiskIncidentExamples.c2Connections': renderC2Rows,
  'protection_effectiveness.policy_stats.by_device': renderPolicyByDeviceRows,
  'protection_effectiveness.policy_stats.policy_check_example': renderPolicyCheckExampleRows
};

async function renderReportToFile({ templatePath, outputDir, reportData }) {
  const template = await fs.readFile(templatePath, 'utf8');
  const gradeAssets = extractGradeAssets(template);
  const html = renderTemplate(template, reportData, gradeAssets);
  await fs.mkdir(outputDir, { recursive: true });

  const filename = buildOutputFilename(reportData);
  const outputPath = path.join(outputDir, filename);
  await fs.writeFile(outputPath, html, 'utf8');

  return {
    ok: true,
    html_path: outputPath,
    customer: getProjectBackground(reportData).customerName,
    start: getProjectBackground(reportData).startDate,
    end: getProjectBackground(reportData).endDate
  };
}

function extractGradeAssets(template) {
  const assets = {};
  const re = /'([优劣中差])':\s*'(data:image\/png;base64,[^']+)'/g;
  let m;
  while ((m = re.exec(template)) !== null) {
    assets[m[1]] = m[2];
  }
  return assets;
}

function renderTemplate(template, reportData, gradeAssets) {
  let html = template;

  // 文档信息表动态化：制作/复审日期取报告生成日期（docName 复用封面 projectBackground.customerName，HTML 模板内拼接）
  const _pb = getProjectBackground(reportData);
  const _genDate = new Date(_pb.generatedAt || Date.now());
  const _pad = (n) => String(n).padStart(2, '0');
  const _dateStr = `${_genDate.getFullYear()}-${_pad(_genDate.getMonth() + 1)}-${_pad(_genDate.getDate())}`;
  reportData.copyright = {
    ...(reportData.copyright || {}),
    createdAt: _dateStr,
    reviewedAt: _dateStr,
  };

  html = replaceHandlebarsTokens(html, reportData);
  html = renderSections(html, reportData);
  html = renderRepeats(html, reportData);
  html = patchKnownText(html, reportData);
  html = patchKeyRisk01Advice(html, reportData);
  html = patchDataFields(html, reportData);
  html = patchIntranetVulnChallengeNote(html, reportData);
  html = patchPolicyCheckKpiCards(html, reportData);
  html = patchWeakPwdSections(html, reportData);
  html = patchGrade(html, reportData, gradeAssets);
  html = injectReportData(html, reportData);
  html = patchOps3DeviceCells(html, reportData);
  html = syncPipelineDeviceData(html, reportData);

  return html;
}

function patchGrade(html, data, gradeAssets) {
  const grade = getPath(data, 'scoring.grade');
  if (!grade) return html;

  const gradeText = String(grade).trim();
  if (!['优', '良', '中', '差'].includes(gradeText)) return html;

  html = html.replace(
    /(<html[^>]*\sdata-report-grade=")([^"]*)(")/,
    (match, before, _old, after) => `${before}${gradeText}${after}`
  );

  html = html.replace(
    /(<span[^>]*class="[^"]*sr-grade--)(优|良|中|差)([^"]*"[^>]*data-field="sections\.riskOverview\.grade"[^>]*>)([^<]*)(<\/span>)/,
    (match, prefix, _oldGrade, mid, _oldText, close) => `${prefix}${gradeText}${mid}${gradeText}${close}`
  );

  html = html.replace(
    /(<div[^>]*id="ro5-gauge-card"[^>]*\sdata-grade=")([^"]*)(")/,
    (match, before, _old, after) => `${before}${gradeText}${after}`
  );

  if (gradeAssets && gradeAssets[gradeText]) {
    const newSrc = gradeAssets[gradeText];
    html = html.replace(
      /(<img[^>]*id="ro5-gauge-img"[^>]*\ssrc=")([^"]*)(")/,
      (match, before, _old, after) => `${before}${newSrc}${after}`
    );
  }

  return html;
}

function replaceHandlebarsTokens(html, data) {
  return html.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, keyPath) => {
    const value = getPath(data, keyPath);
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return escapeHtml(String(value));
  });
}

function patchKnownText(html, data) {
  const projectBackground = getProjectBackground(data);
  const riskDetails = data && data.riskDetails ? data.riskDetails : {};
  const customer = projectBackground.customerName || '';
  const start = projectBackground.startDate || '';
  const end = projectBackground.endDate || '';
  const title = projectBackground.title || '安全体检报告';
  const period = `${start} ~ ${end}`;

  html = html
    .replace(/<meta name="report-data-mode" content="[^"]*">/, '<meta name="report-data-mode" content="generated">')
    .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(title)} - ${escapeHtml(customer)}</title>`)
    .replace(/<h1>安全体检报告<\/h1>/, `<h1>${escapeHtml(title)}</h1>`)
    .replace(/示例科技有限公司 · 2026-01-01 ~ 2026-03-31/g, `${escapeHtml(customer)} · ${escapeHtml(period)}`)
    .replace(/「示例科技有限公司」/g, `「${escapeHtml(customer)}」`)
    .replace(/示例科技有限公司/g, escapeHtml(customer))
    .replace(/2026-01-01 ~ 2026-03-31/g, escapeHtml(period));

  // 3.2.4 无内容时，3.2.5 若有内容则顺延为 3.2.4，正文标题、目录和导航同步更新。
  if (riskDetails.highRiskEventsSectionHide === true && riskDetails.caseStudySectionHide !== true) {
    html = html
      .replace(/(data-nav="sec-case-study"[^>]*>)3\.2\.5 典型案例/g, '$1' + '3.2.4 典型案例')
      .replace(/(<span class="sr-toc-index">)3\.2\.5(<\/span>\s*<span class="sr-toc-label">典型案例)/g, '$1' + '3.2.4$2')
      .replace(/(<h4 class="sr-h4" id="sec-case-study">)3\.2\.5 典型案例/g, '$1' + '3.2.4 典型案例');
  }

  return html;
}

function patchDataFields(html, data) {
  return html.replace(/(<[^>]+data-field="([^"]+)"[^>]*>)(.*?)(<\/[^>]+>)/g, (match, open, field, inner, close) => {
    const keyPath = DATA_FIELD_MAP[field] || field;
    const value = getPath(data, keyPath);
    return value === undefined || value === null ? match : `${open}${escapeHtml(String(value))}${close}`;
  });
}

// 策略检查章节 KPI 卡与表格：当 total/total_component_count 为 0（无数据）时，
// 隐藏对应 KPI 卡及其数据表（total→策略检查项卡+异常项表，total_component_count→涉及组件卡+组件汇总表）
function patchPolicyCheckKpiCards(html, data) {
  const policyStats = getPath(data, 'protection_effectiveness.policy_stats') || {};
  const total = Number(policyStats.total || 0);
  const totalComponent = Number(policyStats.total_component_count || 0);

  if (total === 0 && totalComponent === 0) {
    // 两张 KPI 卡都无数据：整块移除外层图表插槽（含内部两张卡），避免残留空容器
    html = removePolicyCheckSlot(html);
  } else {
    // 仅策略检查项无：移除策略检查项卡；仅涉及组件无：移除涉及组件卡
    html = hidePolicyKpiCard(html, 'protection_effectiveness.policy_stats.abnormal_count', total === 0);
    html = hidePolicyKpiCard(html, 'protection_effectiveness.policy_stats.abnormal_component_count', totalComponent === 0);
  }

  // 涉及组件卡对应的组件汇总表（by_device）：total_component_count 为 0 时隐藏（含引导语）
  if (totalComponent === 0) {
    html = html.replace(
      /(<p class="report-body sr-p">组件全部检查项风险统计：<\/p>\s*<table class="report-table sr-tbl sr-component-summary-tbl">[\s\S]*?<\/table>)/,
      ''
    );
  }
  // 策略检查项卡对应的异常项明细表（policy_check_example）：total 为 0 时隐藏（含引导语）
  if (total === 0) {
    html = html.replace(
      /(<p class="report-body sr-p">各组件策略检查异常项如下（部分）：<\/p>\s*<table class="report-table sr-tbl sr-component-check-tbl">[\s\S]*?<\/table>)/,
      ''
    );
  }
  return html;
}

// 通过 div 开闭标签配对，整块移除指定 id 的图表插槽
function removeSlotById(html, slotId) {
  const slotStart = html.indexOf(`id="${slotId}"`);
  if (slotStart < 0) return html;
  // 向前回退到该 div 的开始标签起点（<div）
  const tagStart = html.lastIndexOf('<div', slotStart);
  if (tagStart < 0) return html;
  let depth = 0;
  let pos = tagStart;
  while (pos < html.length) {
    const nextOpen = html.indexOf('<div', pos);
    const nextClose = html.indexOf('</div>', pos);
    if (nextOpen === -1 && nextClose === -1) break;
    if (nextOpen !== -1 && (nextClose === -1 || nextOpen < nextClose)) {
      depth++;
      pos = nextOpen + 4;
    } else {
      depth--;
      pos = nextClose + 6;
      if (depth === 0) return html.slice(0, tagStart) + html.slice(pos);
    }
  }
  return html;
}

// 通过 div 开闭标签配对，整块移除「安全组件策略检查」图表插槽（slot-component-check-rings）
function removePolicyCheckSlot(html) {
  return removeSlotById(html, 'slot-component-check-rings');
}

// 按卡内 data-field 锚点定位整张 KPI 卡（策略检查项卡 / 涉及组件卡）并移除
// 结构: <div class="sr-kpi-card"> <div class="sr-kpi-card-hd">...</div> <div class="sr-kpi-val">...</div> <div class="sr-kpi-lbl">...</div> </div>
function hidePolicyKpiCard(html, dataField, shouldHide) {
  if (!shouldHide) return html;
  const escaped = dataField.replace(/\./g, '\\.');
  const anchorRe = new RegExp('data-field="' + escaped + '"');
  const m = anchorRe.exec(html);
  if (!m) return html;
  const anchorIdx = m.index;
  // 向前找最近的卡起点
  const cardStart = html.lastIndexOf('<div class="sr-kpi-card">', anchorIdx);
  if (cardStart < 0) return html;
  // 从锚点向后：val div 闭合 → lbl div → 卡闭合 </div>
  const afterField = html.indexOf('</div>', anchorIdx);
  const lblStart = html.indexOf('<div class="sr-kpi-lbl">', afterField);
  if (lblStart < 0) return html;
  const lblClose = html.indexOf('</div>', lblStart);
  // 卡闭合是 lbl 闭合之后的下一个 </div>，需从 lblClose 之后开始找，避免取到同一个 </div>
  const cardClose = html.indexOf('</div>', lblClose + 6);
  const end = cardClose + '</div>'.length;
  return html.slice(0, cardStart) + html.slice(end);
}

// 弱口令章节：当某范围弱口令总数 total_count 为 0 时，
// 1) 引言句去掉「分布如下：」；
// 2) 整块移除下方图表插槽（含「弱口令发现 / 业务影响」KPI 卡及分布图）；
// 3) 详情注释去掉「见《弱口令清单.xlsx》，也」，仅保留访问入口。
function patchWeakPwdSections(html, data) {
  html = patchWeakPwdScope(html, data, 'internet');
  html = patchWeakPwdScope(html, data, 'intranet');
  return html;
}

function patchWeakPwdScope(html, data, scope) {
  const wp = (data[scope] && data[scope].weak_pwd) || {};
  if (Number(wp.total_count || 0) !== 0) return html;

  const slotId = scope === 'internet' ? 'slot-internet-weak' : 'slot-intranet-weak';
  const slotAnchor = `id="${slotId}"`;
  if (html.indexOf(slotAnchor) >= 0) {
    html = removeSlotById(html, slotId);
  }

  // 仅在当前范围的弱口令小节内去掉「分布如下：」
  // （互联网 / 内网弱口令引言结构相同，须按小节边界圈定，避免误伤另一范围）
  const startAnchor = scope === 'internet'
    ? '<h5 class="sr-h5" id="sec-internet-weak">弱口令</h5>'
    : '<h5 class="sr-h5" id="sec-intranet-weak">弱口令</h5>';
  const endAnchor = scope === 'internet'
    ? '<h4 class="sr-h4" id="sec-intranet">'
    : '<h4 class="sr-h4" id="sec-protection-effectiveness">';
  const start = html.indexOf(startAnchor);
  const end = start >= 0 ? html.indexOf(endAnchor, start + 1) : -1;
  if (start < 0 || end < 0) return html;

  const section = html.slice(start, end);
  const patchedSection = section
    // 引言句去掉「分布如下：」
    .replace(
      /(本次体检共发现 <strong>[^<]*<\/strong> 个资产存在弱口令 <strong>[^<]*<\/strong> 个，)分布如下：/g,
      '$1'
    )
    // 弱口令数为 0 时详情注释不再指向清单：去掉「见《弱口令清单.xlsx》，也」
    .replace(/见《弱口令清单\.xlsx》，也/g, '');
  return html.slice(0, start) + patchedSection + html.slice(end);
}

function renderSections(html, data) {
  return html.replace(/<([a-zA-Z0-9]+)([^>]*)data-section="([^"]+)"([^>]*)><\/\1>/g, (match, tag, before, sectionName, after) => {
    const renderer = SECTION_RENDERERS[sectionName];
    if (!renderer) {
      return match;
    }

    return `<${tag}${before}data-section="${sectionName}"${after}>${renderer(data)}</${tag}>`;
  });
}

// 关键风险 #01 网络防护动态话术：替换 <ul data-dynamic-advice="keyRisk01"> 内的静态 <li>
// 依据 riskOverview.keyRisk01NetworkAdvice（{ optimal, afPhrase, sipPhrase }）动态生成
// advice 缺失（如 mock 流程）时不做任何改动，保留模板原静态文案
function patchKeyRisk01Advice(html, data) {
  const advice = data && data.riskOverview && data.riskOverview.keyRisk01NetworkAdvice;
  if (!advice) {
    return html;
  }

  const items = [];
  if (advice.optimal) {
    items.push('<li>您的防护效果达到最优</li>');
  }
  if (advice.afPhrase) {
    items.push(`<li>${escapeHtml(advice.afPhrase)}</li>`);
  }
  if (advice.sipPhrase) {
    items.push(`<li>${escapeHtml(advice.sipPhrase)}</li>`);
  }
  const listHtml = items.join('\n                  ');

  return html.replace(
    /(<ul[^>]*data-dynamic-advice="keyRisk01"[^>]*>)([\s\S]*?)(<\/ul>)/,
    (match, open, _old, close) => `${open}\n                  ${listHtml}\n                ${close}`
  );
}

function renderRepeats(html, data) {
  return html.replace(/<tbody([^>]*)data-repeat="([^"]+)"([^>]*)><\/tbody>/g, (match, before, repeatName, after) => {
    const renderer = REPEAT_RENDERERS[repeatName];
    if (!renderer) {
      return match;
    }

    const rows = getPath(data, repeatName) || [];
    return `<tbody${before}data-repeat="${repeatName}"${after}>${renderer(rows)}</tbody>`;
  });
}

function renderAssetLedgerSummary(data) {
  const assetLedger = data.assetLedger || {};
  return [
    paragraph(`【资产统计】台账资产${displayValue(assetLedger.assetTotal)}个，核心资产${displayValue(assetLedger.core_asset)}个（已托管${displayValue(assetLedger.core_managed_asset)}个），7天内即将退库${displayValue(assetLedger.ready_to_outbound)}个，安全组件接入${displayValue(assetLedger.totalComponentCount)}个`),
    paragraph(`【资产类型分布】${formatNameValueList(assetLedger.typeDistribution)}`),
    paragraph(`【资产防护统计】${formatNameValueList(assetLedger.protectionDistribution)}`),
    paragraph(`【安全组件分布】${formatNameValueList(assetLedger.componentDistribution)}`)
  ].join('');
}

function renderSevereHighEventsPhrase(data) {
  const details = data.riskDetails || {};
  const severe = Number(details.severeEvents || 0);
  const high = Number(details.highEvents || 0);

  const parts = [];
  if (severe > 0) parts.push(`严重事件 <strong>${severe}</strong> 起`);
  if (high > 0) parts.push(`高危事件 <strong>${high}</strong> 起`);

  if (!parts.length) return '';
  return `（${parts.join('、')}）`;
}

function renderSangforDeviceBreakdown(data) {
  const details = data.riskDetails || {};
  const items = [
    { label: 'AF', value: Number(details.af || 0) },
    { label: 'EDR', value: Number(details.aes || 0) },
    { label: 'SIP', value: Number(details.sip || 0) },
    { label: 'STA', value: Number(details.sta || 0) },
    { label: '其它', value: Number(details.other_sf || 0) }
  ];

  const parts = items.filter((it) => it.value > 0).map((it) => `${it.label} <strong>${it.value}</strong> 个`);
  if (!parts.length) return '';
  return `（${parts.join('、')}）`;
}

function renderSevereHighEventsTail(data) {
  const details = data.riskDetails || {};
  const severe = Number(details.severeEvents || 0);
  const high = Number(details.highEvents || 0);

  const parts = [];
  if (severe > 0) parts.push(`严重事件 <strong>${severe}</strong> 起`);
  if (high > 0) parts.push(`高危事件 <strong>${high}</strong> 起`);

  if (!parts.length) return '';
  return `，其中${parts.join('、')}`;
}

// 总评分等级 → 核心业务系统概述话术（不含业务名与结尾修复建议）
const CORE_BUSINESS_SUMMARY_BY_GRADE = {
  '差': '综上，贵公司安全建设存在明显短板，整体防护能力严重不足。现有防护机制难以抵御常见网络攻击，极易发生核心数据泄露、系统被入侵破坏、核心业务全面中断等重大安全事件，将直接造成大额经济损失、品牌信誉崩塌、行业公信力丧失等不可逆的致命后果。',
  '中': '综上，贵公司安全建设存在多处短板，整体防护能力不足。若遭遇针对性网络攻击，存在数据泄露、局部系统故障、关键业务短时中断等安全隐患，一旦发生安全事件，会产生直接经济损耗、企业口碑下滑、公众信任度降低等负面影响。',
  '良': '综上，贵公司安全建设基本满足运营要求，仅存在部分薄弱环节。少概率会出现数据泄露、业务短暂卡顿等问题，带来一定业务损失。',
  '优': '综上，贵公司安全建设处于行业较好，当前无重大安全风险，发生重大安全事故的概率较低。',
};

function renderKeyRiskRows(rows) {
  if (!rows.length) {
    return '<tr><td colspan="5">暂无关键风险数据</td></tr>';
  }

  return rows.map((row) => [
    '<tr>',
    `<td>${escapeHtml(row.risk || '')}</td>`,
    `<td>${escapeHtml(row.description || '')}</td>`,
    `<td>${escapeHtml(row.impact || '')}</td>`,
    `<td>${formatLines(row.strategy)}</td>`,
    `<td>${formatLines(row.status)}</td>`,
    '</tr>'
  ].join('')).join('');
}


function renderTopRiskAssetsSummary(data) {
  const rows = Array.isArray(data && data.riskOverview && data.riskOverview.topRiskAssets)
    ? data.riskOverview.topRiskAssets.filter(Boolean)
    : [];
  if (!rows.length) {
    return '';
  }

  const grade = String(getPath(data, 'scoring.grade') || '').trim();
  const summaryText = CORE_BUSINESS_SUMMARY_BY_GRADE[grade]
    || CORE_BUSINESS_SUMMARY_BY_GRADE['中'];

  // 取上面风险资产 TOP5 的 IP，按资产排序顺序去重
  const allTargets = rows
    .map((row) => String(row.ip || '').trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
  // 超过 3 个时只展示前 3 个，结尾加"等资产"
  const showCount = 3;
  const truncated = allTargets.length > showCount;
  const topTargets = allTargets.slice(0, showCount);

  let targetText = topTargets.length
    ? topTargets.map((name) => `<strong>${escapeHtml(name)}</strong>`).join('、')
    : '<strong>重点风险资产</strong>';
  if (truncated) {
    targetText += '等资产';
  }

  return `${summaryText}修复方案重点针对 ${targetText}。`;
}

// 2.2 节隐藏时章节 2 末尾的兜底段落：仅展示按评级的基础 summaryText，
// 去掉「修复方案重点针对 xxx 等资产。」半句（无 topRiskAssets 数据时无从针对具体资产）。
function renderTopRiskAssetsSummaryFallback(data) {
  const grade = String(getPath(data, 'scoring.grade') || '').trim();
  const summaryText = CORE_BUSINESS_SUMMARY_BY_GRADE[grade]
    || CORE_BUSINESS_SUMMARY_BY_GRADE['中'];
  return summaryText;
}

function renderThreatActorRiskDescription(data) {
  const stats = data && data.riskOverview && data.riskOverview.incidentGptStats
    ? data.riskOverview.incidentGptStats
    : {};
  const total = Number(stats.total || 0);
  const actors = Array.isArray(stats.threatActorStats)
    ? stats.threatActorStats
      .filter((item) => item && Number(item.count || 0) > 0)
      .map((item) => ({
        count: Number(item.count),
        name: String(item.name || '').trim()
      }))
      .filter((item) => item.name)
      .map((item) => `<strong>${item.count}</strong>起${escapeHtml(item.name)}事件`)
    : [];
  const breakdown = actors.length ? `（其中${actors.join('、')}）` : '';

  return `贵公司共发生<strong>${total}</strong>起病毒木马与C2外联事件${breakdown}，此类事件会造成主机失陷，可能引发员工的财务损失。`;
}

// 关键风险 #02 漏洞利用动态文案：按事件表"处置状态"列的"处置完成/处置中"统计已闭环 A 起、处置中 B 起
// 文案规则见 安全体检报告2.0-需求与交互设计评审.md §P4「关键风险 #02 动态文案」
function renderVulnAttackRiskDescription(data) {
  const exploitStats = (data && data.riskOverview && data.riskOverview.exploitStats) || {};
  const total = Number(exploitStats.total || 0);
  const closedCount = Number(exploitStats.closedCount || 0);
  const processingCount = Number(exploitStats.processingCount || 0);

  let dispositionPhrase;
  if (closedCount > 0) {
    dispositionPhrase = `，其中已闭环<strong>${closedCount}</strong>起，处置中<strong>${processingCount}</strong>起`;
  } else {
    dispositionPhrase = `，其中处置中<strong>${processingCount}</strong>起`;
  }

  return `当前贵公司累计发生<strong>${total}</strong>起网站攻击与漏洞攻击${dispositionPhrase}`;
}

function renderCaseStudySection(data) {
  const caseStudy = (data && data.riskDetails && data.riskDetails.caseStudy) || {};
  const attackTimeline = Array.isArray(caseStudy.attackTimeline) ? caseStudy.attackTimeline : [];
  const defenseTimeline = Array.isArray(caseStudy.defenseTimeline) ? caseStudy.defenseTimeline : [];

  if (!attackTimeline.length && !defenseTimeline.length) {
    return '';
  }

  const attackGroups = groupAttackTimelineByStage(attackTimeline);
  const rowCount = Math.max(attackGroups.length, defenseTimeline.length);
  const rows = [];

  for (let index = 0; index < rowCount; index += 1) {
    const attackGroup = attackGroups[index];
    const defenseItem = defenseTimeline[index];
    rows.push([
      '<div class="tm-row">',
      attackGroup ? renderAttackTimelineColumn(attackGroup, index) : '<div class="tm-left"></div>',
      `<div class="tm-dot ${resolveCaseStudyDotClass(attackGroup, defenseItem)}"></div>`,
      defenseItem ? renderDefenseTimelineColumn(defenseItem) : '<div class="tm-right"></div>',
      '</div>'
    ].join(''));
  }

  return `<div class="sr-attack-chain"><div class="tm">${rows.join('')}</div></div>`;
}

function renderPotentialLoss(data) {
  const sourceType = (data && data.riskDetails && data.riskDetails.caseStudy && data.riskDetails.caseStudy.selectedSourceType)
    ? String(data.riskDetails.caseStudy.selectedSourceType).trim()
    : '';

  if (!sourceType || (sourceType !== 'c2' && sourceType !== 'virus' && sourceType !== 'exploit')) {
    return '';
  }

  if (sourceType === 'exploit') {
    return renderExploitPotentialLoss(data);
  }

  return renderSilverFoxPotentialLoss(data);
}

function renderExploitPotentialLoss(data) {
  const exploitStats = (data && data.riskOverview && data.riskOverview.exploitStats) || {};
  const n = Math.max(0, Number(exploitStats.total || 0));
  const total = n * 100;

  return '<table class="report-table sr-tbl" data-col-widths="28.5,141.5">' +
    '<thead><tr><th>潜在损失</th><th>漏洞利用攻击如果未及时发现和对抗，可能导致核心系统敏感数据泄露、主机被控挖矿、数据勒索加密等重大危害事件</th></tr></thead>' +
    '<tbody>' +
    '<tr><td>潜在损失规避评估（影响面）</td><td><strong>' + n + '</strong>个高危可利用漏洞*100万元≈<strong>' + total + '</strong>万元（基于行业公开事例评估测算，单个漏洞利用攻击入侵成功导致的平均安全损失约<strong>100</strong>万元）</td></tr>' +
    '<tr><td>实际案例损失情况</td><td>当前规模化的 RaaS 攻击手段主要探测识别 <strong>1</strong>DAY 高危可利用漏洞后进行自动化利用攻击。<br><strong>捷豹路虎遭勒索攻击致全球系统瘫痪</strong><br>日期：<strong>2025.9</strong> 至 2025.10.8<br>事件概要："Scattered Lapsus$ Hunters" 黑客组织利用 SAP NetWeaver（CVE-2025-31324）远程执行漏洞入侵内部网络，部署勒索软件并窃取数据。<br>影响描述：全球 IT 系统关闭，生产、销售、售后服务全面瘫痪；<strong>33,000</strong> 名员工被安排休假；财务损失达 <strong>1.96</strong> 亿英镑；<strong>10</strong> 月 <strong>8</strong> 日才完成系统重启。<br>基于国内安全咨询机构及厂商综合披露的数据显示，国内政企勒索支付的中位数为 <strong>100</strong> 万元</td></tr>' +
    '</tbody>' +
    '</table>';
}

function renderSilverFoxPotentialLoss(data) {
  const igs = (data && data.riskOverview && data.riskOverview.incidentGptStats) || {};
  const c2Count = Math.max(0, Number((igs.hostCompromise && igs.hostCompromise.total) || 0));
  const virusCount = Math.max(0, Number((igs.virusTrojan && igs.virusTrojan.total) || 0));
  const n = c2Count + virusCount;
  const total = Math.round(n * 0.2 * 10) / 10;

  return '<table class="report-table sr-tbl" data-col-widths="28.5,141.5">' +
    '<thead><tr><th>潜在损失</th><th>主机外联成功将被感染银狐木马，利用主机的即时通讯软件在单位内部执行诈骗，或以内部员工合法身份窃取内部敏感数据</th></tr></thead>' +
    '<tbody>' +
    '<tr><td>潜在损失规避评估（影响面）</td><td><strong>' + n + '</strong>起银狐外联*2000元≈<strong>' + total + '</strong>万元（基于深信服安全运营中心2025年统计，平均每起银狐木马攻击造成的个人损失约2000元）</td></tr>' +
    '<tr><td>实际案例损失情况</td><td>2025 年，银狐木马以远程控制+财务诈骗+数据窃取为主，非传统勒索加密，但造成企业直接经济损失超20亿元、受害企事业单位超 1000 家，以下为权威披露的典型高损失案例：<br><strong>杭州某跨境电商（2025年5月，损失800万元）</strong><br>攻击路径：伪装成银行账户年审通知钓鱼邮件，财务电脑中招，木马潜伏两周。<br>作案手法：监控微信聊天，自动篡改指令：将财务汇报的"暂不付款"篡改为"立即支付"，并伪造老板"已阅"回复。<br>损失：15分钟内800万货款转至境外账户，追回难度极大。<br>来源：浙江警方（2025年经济犯罪典型案例）。</td></tr>' +
    '</tbody>' +
    '</table>';
}

function renderTopRiskAssetRows(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return '<tr><td colspan="3">暂无风险资产 TOP5 数据</td></tr>';
  }

  return rows.slice(0, 5).map((row) => {
    const ip = String(row.ip || '').trim();
    const businessSystem = String(row.businessSystem || '').trim();
    const riskCount = Number(row.riskCount || 0);
    const detailLines = Array.isArray(row.detailLines) && row.detailLines.length
      ? row.detailLines.map((line) => String(line))
      : [
        businessSystem ? `所属业务：${escapeHtml(businessSystem)}` : '所属业务：暂无'
      ];

    return [
      '<tr>',
      `<td class="sr-top5-asset"><div class="sr-top5-asset-ip-row"><span class="sr-top5-asset-ip">${escapeHtml(ip)}</span></div>${businessSystem ? `<div class="sr-top5-asset-biz">${escapeHtml(businessSystem)}</div>` : ''}</td>`,
      `<td><strong>${riskCount}</strong></td>`,
      `<td>${detailLines.join('<br>')}</td>`,
      '</tr>'
    ].join('');
  }).join('');
}

function renderVulnExploitRows(rows) {
  if (!rows.length) {
    return '<tr><td colspan="4">暂无漏洞利用事件</td></tr>';
  }

  return rows.slice(0, 5).map((row) => [
    '<tr>',
    `<td><span class="sr-event-name">${escapeHtml(row.eventName || '')}</span></td>`,
    `<td>${escapeHtml(row.affectedAsset || '')}</td>`,
    `<td class="sr-no-wrap">${escapeHtml(row.lastOccurredAt || '')}</td>`,
    `<td>${renderStatusTag(row.disposalStatus)}</td>`,
    '</tr>'
  ].join('')).join('');
}

function renderVirusRows(rows) {
  if (!rows.length) {
    return '<tr><td colspan="4">暂无病毒木马事件</td></tr>';
  }

  return rows.slice(0, 5).map((row) => [
    '<tr>',
    `<td>${escapeHtml(row.affectedAsset || '')}</td>`,
    `<td><span class="sr-event-name">${formatMultiValueCell(row.md5 || '')}</span></td>`,
    `<td class="sr-no-wrap">${escapeHtml(row.lastOccurredAt || '')}</td>`,
    `<td>${renderStatusTag(row.disposalStatus)}</td>`,
    '</tr>'
  ].join('')).join('');
}

function renderC2Rows(rows) {
  if (!rows.length) {
    return '<tr><td colspan="4">暂无 C2 外联事件</td></tr>';
  }

  return rows.slice(0, 5).map((row) => [
    '<tr>',
    `<td>${escapeHtml(row.affectedAsset || '')}</td>`,
    `<td><span class="sr-event-name">${formatMultiValueCell(row.ioc || '')}</span></td>`,
    `<td class="sr-no-wrap">${escapeHtml(row.lastOccurredAt || '')}</td>`,
    `<td>${renderStatusTag(row.disposalStatus)}</td>`,
    '</tr>'
  ].join('')).join('');
}

function renderPolicyByDeviceRows(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return '<tr><td colspan="4">暂无策略检查数据</td></tr>';
  }

  return rows.map((row, index) => {
    const checkCount = Number(row && row.check_count) || 0;
    const abnormalCount = Number(row && row.abnormal_count) || 0;
    const riskSpan = abnormalCount > 0
      ? `<span class="sr-stat-risk">（<span class="sr-text-danger"><strong>${abnormalCount}</strong></span>）</span>`
      : '';
    return [
      '<tr>',
      `<td>${index + 1}</td>`,
      `<td>${escapeHtml(row.dev_type || '')}</td>`,
      `<td>${escapeHtml(row.dev_name || '')}</td>`,
      `<td><strong>${checkCount}</strong>${riskSpan}</td>`,
      '</tr>'
    ].join('');
  }).join('');
}

function renderPolicyCheckExampleRows(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return '<tr><td colspan="6">暂无策略检查异常项</td></tr>';
  }

  return rows.map((row, index) => {
    const devTypeTag = renderDevTypeTag(row.dev_type);
    const statusTag = renderPolicyStatusTag(row.policy_status);
    return [
      '<tr>',
      `<td>${index + 1}</td>`,
      `<td><div class="sr-component-name-row"><span class="sr-component-name">${escapeHtml(row.dev_name || '')}</span>${devTypeTag}</div></td>`,
      `<td>${escapeHtml(row.name || '')}</td>`,
      `<td>${statusTag}</td>`,
      `<td>${escapeHtml(row.description || '')}</td>`,
      `<td>${escapeHtml(row.risk_desc || '')}</td>`,
      '</tr>'
    ].join('');
  }).join('');
}

function renderDevTypeTag(devType) {
  const text = String(devType || '').trim();
  if (!text || text === '未知') return '';
  return `<span class="sr-tag sr-tag--light sr-tag--blue">${escapeHtml(text)}</span>`;
}

function renderPolicyStatusTag(status) {
  const text = String(status || '').trim();
  if (!text) return '';
  const level = policyStatusLevel(text);
  return `<span class="sr-tag sr-tag--light sr-tag--${level}">${escapeHtml(text)}</span>`;
}

function policyStatusLevel(text) {
  if (/异常|失败|过期|未开通|未启用/.test(text)) return 'high';
  if (/仅上报|不处置|未处置|待处置/.test(text)) return 'medium';
  if (/正常|生效|已处置|完成/.test(text)) return 'success';
  return 'medium';
}

function paragraph(text) {
  return `<p class="sr-p">${text}</p>`;
}

function num(value) {
  return escapeHtml(String(value === undefined || value === null ? 0 : value));
}

function displayValue(value) {
  return escapeHtml(String(value === undefined || value === null ? '暂无数据' : value));
}

function formatNameValueList(items) {
  if (!Array.isArray(items) || !items.length) {
    return '暂无数据';
  }

  return items.map((item) => `${escapeHtml(String(item.name || '未命名'))}${num(item.value)}个`).join('，');
}

function formatLines(value) {
  const lines = Array.isArray(value) ? value : [value || ''];
  return lines.map((line, index) => `${index + 1}.${escapeHtml(String(line))}`).join('<br>');
}

function formatMultiValueCell(value) {
  return String(value || '')
    .split('、')
    .map((item) => escapeHtml(item.trim()))
    .filter(Boolean)
    .join('<br>');
}

function renderStatusTag(status) {
  const text = String(status || '').trim();
  const level = eventStatusLevel(text);
  return `<span class="sr-tag sr-tag--light sr-tag--${level}">${escapeHtml(text)}</span>`;
}

function eventStatusLevel(text) {
  if (/待处置/.test(text)) return 'high';
  if (/处置中/.test(text)) return 'warning';
  if (/处置完成|已处置/.test(text)) return 'success';
  if (/挂起/.test(text)) return 'medium-low';
  if (/已忽略/.test(text)) return 'info';
  if (/已遏制/.test(text)) return 'medium';
  return 'info';
}

function groupAttackTimelineByStage(rows) {
  const groups = [];
  const groupMap = new Map();

  rows.forEach((row) => {
    if (!row) return;
    const stageId = String(row.stageId || '').trim();
    const stageName = String(row.stageName || '').trim();
    const key = `${stageId}::${stageName}`;
    if (!groupMap.has(key)) {
      const group = { stageId, stageName, items: [] };
      groupMap.set(key, group);
      groups.push(group);
    }
    groupMap.get(key).items.push(row);
  });

  return groups;
}

function renderAttackTimelineColumn(group, index) {
  const stageName = String(group.stageName || group.stageId || '未知阶段').trim();
  const stageLabel = `阶段${formatChineseStageIndex(index + 1)}：${escapeHtml(stageName)}`;
  const entries = group.items.map((item) => {
    const time = formatCaseStudyTimestamp(item && item.timestamp);
    const narrative = escapeHtml(String((item && item.narrative) || '').trim());
    return [
      time ? `<div class="tm-time">${time}</div>` : '',
      narrative ? `<div class="tm-desc">${narrative}</div>` : ''
    ].join('');
  }).join('');

  return [
    '<div class="tm-left">',
    '<div class="tm-card atk">',
    `<div class="tm-tag">${stageLabel}</div>`,
    entries || '<div class="tm-desc">暂无攻击侧时间线</div>',
    '<span class="tm-arrow"></span>',
    '</div>',
    '</div>'
  ].join('');
}

function renderDefenseTimelineColumn(item) {
  const label = escapeHtml(String((item && item.label) || '防守时间线').trim());
  const timeEntries = Array.isArray(item && item.timeEntries) ? item.timeEntries : [];

  let timeHtml;
  if (timeEntries.length > 0) {
    timeHtml = timeEntries.map((entry) => {
      const time = formatCaseStudyTimestamp(entry && entry.timestamp);
      const desc = escapeHtml(String(entry && entry.desc || '').trim());
      return time && desc ? `<div class="tm-time">${time} ${desc}</div>` : '';
    }).filter(Boolean).join('');
  }

  return [
    '<div class="tm-right">',
    '<div class="tm-card def">',
    `<div class="tm-tag">${label}</div>`,
    timeHtml || '<div class="tm-time">暂无时间</div>',
    '<span class="tm-arrow"></span>',
    '</div>',
    '</div>'
  ].join('');
}

function resolveCaseStudyDotClass(attackGroup, defenseItem) {
  if (attackGroup) return 'rd';
  if (defenseItem) return 'bl';
  return 'gn';
}

function formatCaseStudyTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return '';

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
}

function formatChineseStageIndex(index) {
  const numerals = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  if (index <= 10) {
    return numerals[index] || String(index);
  }
  if (index < 20) {
    return `十${numerals[index - 10] || ''}`;
  }
  if (index === 20) {
    return '二十';
  }
  return String(index);
}

function injectReportData(html, data) {
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');
  const script = `<script>window.SECURITY_REPORT_DATA=${payload};</script>`;

  if (html.includes('window.SECURITY_REPORT_DATA=')) {
    return html.replace(/<script>window\.SECURITY_REPORT_DATA=.*?<\/script>/, script);
  }

  return html.replace('</head>', `${script}\n</head>`);
}

function patchOps3DeviceCells(html, data) {
  // 4.1.1 设备格子：值为0的服务端直接删除元素，不依赖浏览器端JS
  // 匹配设备格子: <div class="ops3-device-cell" data-hide-ops3="riskDetails.XX"><span class="nm">XX</span><span class="nv">0</span></div>
  html = html.replace(
    /<div\s+class="ops3-device-cell"\s+data-hide-ops3="riskDetails\.\w+"\s*>\s*<span\s+class="nm">[^<]*<\/span>\s*<span\s+class="nv">0<\/span>\s*<\/div>/g,
    ''
  );

  // 第三方合计格子（class 中有 ops3-layer ops3-device-third 两个类名）
  html = html.replace(
    /<div\s+class="[^"]*ops3-device-third[^"]*"\s+data-hide-ops3="riskDetails\.\w+"\s*>\s*<span\s+class="nm">[^<]*<\/span>\s*<span\s+class="nv">0<\/span>\s*<\/div>/g,
    ''
  );

  // 如果第三方设备为0，也隐藏"第三方设备"标签
  const rd = data.riskDetails || {};
  if (Number(rd.third) === 0) {
    html = html.replace(
      /<p\s+class="ops3-layer ops3-ingest-label ops3-ingest-label--3rd">[^<]*<\/p>/g,
      ''
    );
  }

  // 如果深信服设备为0，也隐藏"深信服设备"标签
  if (Number(rd.sangfor) === 0) {
    html = html.replace(
      /<p\s+class="ops3-layer ops3-ingest-label ops3-ingest-label--sf">[^<]*<\/p>/g,
      ''
    );
  }

  return html;
}

function syncPipelineDeviceData(html, data) {
  // 在 bootPipeline 函数开头注入代码，从 SECURITY_REPORT_DATA 同步设备数据到 XDR_PIPELINE_DATA
  // 确保 Canvas 管道图的 buildDeviceSources 能读到正确的设备数量
  const syncCode = `      var reportRd = (window.SECURITY_REPORT_DATA || {}).riskDetails || {};
      if (reportRd.devices !== undefined) window.XDR_PIPELINE_DATA.devices = Number(reportRd.devices) || window.XDR_PIPELINE_DATA.devices;
      if (reportRd.af !== undefined) window.XDR_PIPELINE_DATA.af = Number(reportRd.af) || 0;
      if (reportRd.aes !== undefined) window.XDR_PIPELINE_DATA.aes = Number(reportRd.aes) || 0;
      if (reportRd.sip !== undefined) window.XDR_PIPELINE_DATA.sip = Number(reportRd.sip) || 0;
      if (reportRd.sta !== undefined) window.XDR_PIPELINE_DATA.sta = Number(reportRd.sta) || 0;
      if (reportRd.other_sf !== undefined) window.XDR_PIPELINE_DATA.other_sf = Number(reportRd.other_sf) || 0;
      if (reportRd.third !== undefined) window.XDR_PIPELINE_DATA.third = Number(reportRd.third) || 0;
      if (reportRd.sangfor !== undefined) window.XDR_PIPELINE_DATA.sangfor = Number(reportRd.sangfor) || 0;
      syncKpiDom();`;

  // 注入到 bootPipeline 函数体中，在 renderPipeline(0) 之前
  html = html.replace(
    /(function bootPipeline\(\)\s*\{\s*if\s*\(\!pipelineReady\(\)\)\s*\{\s*requestAnimationFrame\(bootPipeline\);\s*return;\s*\})/,
    '$1\n' + syncCode + '\n'
  );

  return html;
}

function buildOutputFilename(data) {
  const projectBackground = getProjectBackground(data);
  const customerName = projectBackground.customerName || '客户';
  const generatedAt = projectBackground.generatedAt ? new Date(projectBackground.generatedAt) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${generatedAt.getFullYear()}${pad(generatedAt.getMonth() + 1)}${pad(generatedAt.getDate())}${pad(generatedAt.getHours())}${pad(generatedAt.getMinutes())}`;
  const raw = `【深信服】安全体检报告-${customerName}-${timestamp}.html`;
  return raw.replace(/[\\/:*?"<>|]/g, '_');
}

function getPath(obj, keyPath) {
  const normalizedPath = keyPath.startsWith('report.')
    ? `projectBackground.${keyPath.slice('report.'.length)}`
    : keyPath;
  return normalizedPath.split('.').reduce((current, key) => {
    if (current && Object.prototype.hasOwnProperty.call(current, key)) {
      return current[key];
    }
    return undefined;
  }, obj);
}

function getProjectBackground(data) {
  return data.projectBackground || data.report || {};
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderInternetExposureDescription(data) {
  const exp = (data.internet && data.internet.exposure) || {};
  const assetCount = Number(exp.risk_asset_count || 0);
  const portCount = Number(exp.port_count || 0);
  const vulnCount = Number(exp.vuln_count || 0);

  // 风险端口数（从 2 节风险总览的 summary 取）
  const riskPorts = Number((data.summary && data.summary.internet && data.summary.internet.exposure && data.summary.internet.exposure.risk_ports) || 0);

  // 评分公式：1个资产或1个风险端口=5分，1个漏洞=35分
  const score = (assetCount + riskPorts) * 5 + vulnCount * 35;

  // 风险等级判定（三级：良好 / 一般 / 较低）
  let level;
  if (score <= 30) level = '良好';
  else if (score <= 70) level = '一般';
  else level = '较低';

  // 分支 1：0 资产 且 0 端口
  if (assetCount === 0 && portCount === 0) {
    if (vulnCount === 0) {
      // 子分支 1a：全为 0，score=0 → 等级必然为"良好"
      return '互联网业务风险良好，没有发现风险暴露面和互联网漏洞。';
    } else {
      // 子分支 1b：0 资产 0 端口 X 漏洞，XX 按 score 算
      return `互联网业务风险${level}，存在${vulnCount}个互联网漏洞。`;
    }
  }

  // 分支 2：X 资产 或 X 端口（默认场景），XX 按 score 算
  // 末句统一"存在 V 个互联网漏洞"，不再按 score 区分表述
  const weakPwdCount = Number((data.internet && data.internet.weak_pwd && data.internet.weak_pwd.total_count) || 0);
  return (
    `互联网业务风险${level}，存在一些对外暴露的端口与服务。` +
    `其中有<strong>${assetCount}</strong>个资产暴露了<strong>${portCount}</strong>个端口` +
    `（风险端口<strong>${riskPorts}</strong>个），存在<strong>${vulnCount}</strong>个互联网漏洞，存在<strong>${weakPwdCount}</strong>个弱口令。`
  );
}

function renderInternetRiskSummary(data) {
  const rd = (data.risk_detail && data.risk_detail.internet) || {};
  const main = (
    `互联网业务总计发现风险 <strong>${num(rd.total)}</strong> 个` +
    `（风险暴露面 <strong>${num(rd.exposure)}</strong> 个、` +
    `漏洞 <strong>${num(rd.vuln)}</strong> 个、` +
    `弱口令 <strong>${num(rd.weak_pwd)}</strong> 个）`
  );
  const tail = rd.high_above
    ? `，其中高危及以上风险 <strong>${num(rd.high_above)}</strong> 个。`
    : `。`;
  return paragraph(main + tail);
}

function renderIntranetRiskSummary(data) {
  const rd = (data.risk_detail && data.risk_detail.intranet) || {};
  const main = (
    `内网核心业务总计发现风险 <strong>${num(rd.total)}</strong> 个` +
    `（漏洞 <strong>${num(rd.vuln)}</strong> 个、` +
    `弱口令 <strong>${num(rd.weak_pwd)}</strong> 个）`
  );
  const tail = rd.high
    ? `，其中高危及以上风险 <strong>${num(rd.high)}</strong> 个。`
    : `。`;
  return paragraph(main + tail);
}

function renderInternetVulnLevelDetail(data) {
  const v = (data.internet && data.internet.vuln) || {};
  if (!v.total) return '';
  return (
    `（严重 <strong>${num(v.critical)}</strong> 个、` +
    `高危 <strong>${num(v.high)}</strong> 个、` +
    `中危 <strong>${num(v.medium)}</strong> 个、` +
    `低危 <strong>${num(v.low)}</strong> 个）`
  );
}

function renderInternetVulnPrioritySummary(data) {
  const v = (data.internet && data.internet.vuln) || {};
  if (!v.total) return '';
  return paragraph(
    `从漏洞修复优先级视角统计，` +
    `急需修复 <strong>${num(v.priority_urgent)}</strong> 个、` +
    `尽快修复 <strong>${num(v.priority_soon)}</strong> 个、` +
    `建议修复 <strong>${num(v.priority_suggest)}</strong> 个。`
  );
}

function renderInternetVulnTopAssetsBlock(data) {
  const v = (data.internet && data.internet.vuln) || {};
  if (!v.related_assets) return '';

  const rows = Array.isArray(v.top_rows) ? v.top_rows : [];
  const tableRows = rows.map((r, i) =>
    '<tr>' +
    `<td>${i + 1}</td>` +
    `<td>${escapeHtml(r.asset)}<br>${escapeHtml(r.vuln_asset_name || '')}</td>` +
    '<td class="sr-vuln-priority-stats">' +
    `<div>急需修复：<strong>${num(r.urgent)}</strong>个</div>` +
    `<div>尽快修复：<strong>${num(r.soon)}</strong>个</div>` +
    `<div>建议修复：<strong>${num(r.suggest)}</strong>个</div>` +
    '</td></tr>'
  ).join('');

  return (
    '<p class="report-body sr-p">互联网漏洞风险资产TOP 5如下：</p>\n' +
    '<table class="report-table sr-tbl" id="tbl-internet-vuln-top">' +
    '<thead><tr><th>序号</th><th>风险资产</th><th>漏洞修复优先级</th></tr></thead>' +
    `<tbody>${tableRows}</tbody></table>`
  );
}

function renderIntranetVulnDescription(data) {
  const v = (data.intranet && data.intranet.vuln) || {};
  const w = (data.intranet && data.intranet.weak_pwd) || {};
  const critical = Number(v.critical || 0);
  const high = Number(v.high || 0);
  const medium = Number(v.medium || 0) + Number(w.total_count || 0);
  const low = Number(v.low || 0);

  const hasAny = critical + high + medium + low > 0;

  if (!hasAny) {
    return '当前内网业务整体安全状况优良，本次检测未识别到漏洞。';
  }

  let level;
  if (critical > 0 || high > 0) {
    level = '较低';
  } else if (medium > 0) {
    level = '一般';
  } else {
    level = '良好';
  }

  return `当前内网业务整体风险${level}，按照修复优先级来修复。`;
}

function renderIntranetVulnLevelDetail(data) {
  const v = (data.intranet && data.intranet.vuln) || {};
  if (!v.total) return '';
  // 某等级数量为0时，不展示该等级的“其中可利用X个”
  const levelPart = (count, exploitable) =>
    `<strong>${num(count)}</strong> 个` +
    (Number(count) > 0 ? `，其中可利用 <strong>${num(exploitable)}</strong> 个` : '');
  return (
    `（严重 ${levelPart(v.critical, v.critical_exploitable)}；` +
    `高危 ${levelPart(v.high, v.high_exploitable)}；` +
    `中危 ${levelPart(v.medium, v.medium_exploitable)}；` +
    `低危 ${levelPart(v.low, v.low_exploitable)}）`
  );
}

function renderIntranetVulnPrioritySummary(data) {
  const v = (data.intranet && data.intranet.vuln) || {};
  if (!v.total) return '';
  return paragraph(
    `从漏洞修复优先级视角统计，` +
    `急需修复 <strong>${num(v.priority_urgent)}</strong> 个、` +
    `尽快修复 <strong>${num(v.priority_soon)}</strong> 个、` +
    `建议修复 <strong>${num(v.priority_suggest)}</strong> 个。`
  );
}

function renderIntranetVulnBizTopBlock(data) {
  const v = (data.intranet && data.intranet.vuln) || {};
  if (!v.related_biz) return '';

  const bizRows = Array.isArray(v.biz_top_rows) ? v.biz_top_rows : [];
  const bizTableRows = bizRows.map((r, i) =>
    '<tr>' +
    `<td>${i + 1}</td>` +
    `<td>${escapeHtml(r.asset)}</td>` +
    '<td class="sr-vuln-priority-stats">' +
    `<div>急需修复：<strong>${num(r.urgent)}</strong>个</div>` +
    `<div>尽快修复：<strong>${num(r.soon)}</strong>个</div>` +
    `<div>建议修复：<strong>${num(r.suggest)}</strong>个</div>` +
    '</td></tr>'
  ).join('');

  return (
    '<p class="report-body sr-p">业务系统TOP 5如下：</p>\n' +
    '<table class="report-table sr-tbl" id="tbl-biz-vuln-top">' +
    '<thead><tr><th>序号</th><th>风险业务系统</th><th>漏洞修复优先级</th></tr></thead>' +
    `<tbody>${bizTableRows}</tbody></table>`
  );
}

function renderIntranetVulnAssetTopBlock(data) {
  const v = (data.intranet && data.intranet.vuln) || {};
  if (!v.related_assets) return '';

  const assetRows = Array.isArray(v.asset_top_rows) ? v.asset_top_rows : [];
  const assetTableRows = assetRows.map((r, i) =>
    '<tr>' +
    `<td>${i + 1}</td>` +
    `<td>${escapeHtml(r.asset)}<br>${escapeHtml(r.vuln_asset_name || '')}</td>` +
    '<td class="sr-vuln-priority-stats">' +
    `<div>急需修复：<strong>${num(r.urgent)}</strong>个</div>` +
    `<div>尽快修复：<strong>${num(r.soon)}</strong>个</div>` +
    `<div>建议修复：<strong>${num(r.suggest)}</strong>个</div>` +
    '</td></tr>'
  ).join('');

  return (
    '<p class="report-body sr-p">内网漏洞风险资产TOP 5如下：</p>\n' +
    '<table class="report-table sr-tbl" id="tbl-intra-vuln-top">' +
    '<thead><tr><th>序号</th><th>风险资产</th><th>漏洞修复优先级</th></tr></thead>' +
    `<tbody>${assetTableRows}</tbody></table>`
  );
}

// 内网漏洞详情引导语：当内网漏洞数量为 0 时，《漏洞清单.xlsx》无实际数据，
// 省略“详情见《漏洞清单.xlsx》”的说法，仅保留 XDR 平台查询入口
function patchIntranetVulnChallengeNote(html, data) {
  const v = (data.intranet && data.intranet.vuln) || {};
  const total = Number(v.total || 0);
  if (total !== 0) {
    return html;
  }
  const original = '内网漏洞详情见《漏洞清单.xlsx》，也可访问 XDR 平台-->脆弱性-->风险视角-->漏洞';
  const zeroText = '内网漏洞详情可访问 XDR 平台-->脆弱性-->风险视角-->漏洞';
  return html.replace(original, zeroText);
}

module.exports = {
  renderReportToFile,
  renderTemplate,
  getPath
};
