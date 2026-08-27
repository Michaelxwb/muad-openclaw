'use strict';

const { fetchMsswAssetOverview, fetchSecurityCheckReportStats, calculateAttackOverview, readMsswCookieInfo } = require('./mssw_client');

async function collectReportData(input) {
  if (input.msswCookiePath) {
    logInfo(input.logger, '使用 MSSW 主链路生成报告资产台账');
    const baseData = buildBaseReportData(input);
    const overviewData = await fetchMsswAssetOverview({
      logger: input.logger,
      projectBackground: {
        customerName: input.customer || '',
        customerId: input.customerId || null,
        startDate: input.start || '',
        endDate: input.end || ''
      },
      msswCookiePath: input.msswCookiePath,
      xdrCookiePath: input.xdrCookiePath,
      msswBaseUrl: input.msswBaseUrl,
      customerId: input.customerId,
      incidentFilePath: input.incidentFilePath,
      assetFilePath: input.assetFilePath,
      exploitIncidentIds: input.exploitIncidentIds
    });

    let merged = deepMerge(baseData, overviewData);
    // core_asset 改为由 Excel 资产表统计提供，不查接口
    merged.assetLedger.core_asset = 0;
    merged = applyAssetStatusStats(merged, input.assetStatusStats);
    merged = applyIncidentStatusStats(merged, input.incidentStatusStats);
    merged = await applyAttackOverview(merged, input);
    return merged;
  }

  logInfo(input.logger, '使用基础数据生成报告（跳过资产台账 API）');
  const baseData = buildBaseReportData(input);
  let merged = applyAssetStatusStats(baseData, input.assetStatusStats);
  merged = applyIncidentStatusStats(merged, input.incidentStatusStats);
  return merged;
}

/**
 * 调用安全体检报告统计接口，计算攻击态势总览数据并合并到 reportData.attackOverview。
 * 失败不阻断主流程，仅在日志中提示。
 */
async function applyAttackOverview(reportData, input) {
  const merged = { ...reportData };
  merged.attackOverview = buildEmptyAttackOverview();

  if (!input.msswCookiePath || !input.customerId || !input.start || !input.end) {
    logInfo(input.logger, '跳过攻击态势接口查询: 缺少 msswCookiePath/customerId/start/end');
    return merged;
  }

  try {
    const cookieInfo = await readMsswCookieInfo(input.msswCookiePath);
    const stats = await fetchSecurityCheckReportStats(
      cookieInfo,
      input.msswBaseUrl,
      input.customerId,
      input.customer,
      input.start,
      input.end
    );

    if (!stats) {
      logInfo(input.logger, '攻击态势接口返回空数据: 报告范围可能不在近 31 天内');
      return merged;
    }

    const overview = calculateAttackOverview(stats);
    if (overview) {
      merged.attackOverview = overview;
      logInfo(input.logger, `攻击态势数据已合并: total=${overview.total_attack_count}, dailyAvg=${overview.daily_avg}, night=${overview.night_attack_count}, ratio=${overview.night_ratio}%, days=${overview.trend_dates.length}`);
    }
  } catch (error) {
    logInfo(input.logger, `攻击态势接口调用失败（不影响主流程）: ${error.message}`);
  }

  return merged;
}

function buildEmptyAttackOverview() {
  return {
    total_attack_count: 0,
    night_attack_count: 0,
    workday_attack_count: 0,
    daily_avg: 0,
    night_ratio: '0',
    trend_dates: [],
    trend_values: [],
    error: ''
  };
}

function logInfo(logger, message) {
  if (typeof logger === 'function') {
    logger(message);
  }
}

function applyIncidentStatusStats(reportData, stats) {
  const existingRiskDetails = reportData && reportData.riskDetails ? reportData.riskDetails : {};

  // 如果 stats 没有显式提供消减率，但有事件总数和告警总数，则自动计算
  const hasExplicitAlertReduction = stats && stats.alertReductionRate !== undefined && stats.alertReductionRate !== null;
  let computedAlertReductionRate;
  if (hasExplicitAlertReduction) {
    computedAlertReductionRate = Number(stats.alertReductionRate);
  } else {
    const totalEvts = Number(stats && stats.totalEvents || 0);
    const alertTot = Number(existingRiskDetails.alertTotal || 0);
    if (alertTot > 0 && totalEvts > 0) {
      computedAlertReductionRate = Number((((alertTot - totalEvts) / alertTot) * 100).toFixed(2));
    } else {
      computedAlertReductionRate = existingRiskDetails.alertReductionRate || 0;
    }
  }

  const merged = stats ? deepMerge(reportData, {
    riskDetails: {
      totalEvents: Number(stats.totalEvents || 0),
      severeEvents: Number(stats.severeEvents || 0),
      highEvents: Number(stats.highEvents || 0),
      closedEvents: Number(stats.closedEvents || 0),
      processingEvents: Number(stats.processingEvents || 0),
      closeRate: Number(stats.closeRate || 0),
      alertReductionRate: computedAlertReductionRate,
      uniqueAssetCount: Number(stats.uniqueAssetCount || 0)
    }
  }) : reportData;

  if (merged && merged.riskOverview && merged.riskDetails) {
    merged.riskOverview.closeRate = merged.riskDetails.closeRate;
    merged.riskOverview.closedEvents = merged.riskDetails.closedEvents;
    merged.riskOverview.containedAlerts = merged.riskDetails.containedAlerts;
    merged.riskOverview.totalEvents = merged.riskDetails.totalEvents;
    merged.riskOverview.alertReductionRate = merged.riskDetails.alertReductionRate;
    merged.riskOverview.affectedAssetCount = merged.riskDetails.uniqueAssetCount;
  }

  // === ABCDE 派生计算（2 节风险总览总结文案）===
  recalcThreatPreventionRiskCount(merged);

  return merged;
}

function applyAssetStatusStats(reportData, stats) {
  if (!stats) {
    return reportData;
  }

  const merged = deepMerge(reportData, {
    assetLedger: {
      core_asset: Number(stats.core_asset || 0),
      core_managed_asset: Number(stats.core_managed_asset || 0),
      manage_asset: Number(stats.manage_asset || 0),
      currentAssetCount: Number(stats.currentAssetCount || 0),
      waitApproveAssetCount: Number(stats.waitApproveAssetCount || 0),
      typeDistribution: Array.isArray(stats.typeDistribution) ? stats.typeDistribution : [],
      protectionDistribution: Array.isArray(stats.protectionDistribution) ? stats.protectionDistribution : [],
      protectionStats: stats.protectionStats && typeof stats.protectionStats === 'object'
        ? {
            protected: Number(stats.protectionStats.protected || 0),
            unprotected: Number(stats.protectionStats.unprotected || 0),
            unprotected_breakdown: stats.protectionStats.unprotected_breakdown || {
              manual: 0,
              cloud_mirror: 0,
              manual_and_cloud_mirror: 0,
              empty: 0
            }
          }
        : {
            protected: 0,
            unprotected: 0,
            unprotected_breakdown: { manual: 0, cloud_mirror: 0, manual_and_cloud_mirror: 0, empty: 0 }
          },
      internetExposureTotal: Number(stats.internetExposureTotal || 0),
      internetExposureDistribution: Array.isArray(stats.internetExposureDistribution) ? stats.internetExposureDistribution : [],
      componentDistribution: Array.isArray(stats.componentDistribution) ? stats.componentDistribution : [],
      totalComponentCount: Number(stats.totalComponentCount || 0)
    }
  });

  if (merged && merged.assetLedger) {
    merged.assetLedger.assetTotal = Number(stats.assetTotal || stats.manage_asset || 0);
  }

  return merged;
}

function buildBaseReportData(input) {
  return {
    projectBackground: {
      customerName: input.customer,
      startDate: input.start,
      endDate: input.end,
      generatedAt: input.generatedAt || new Date().toISOString()
    },
    assetLedger: {},
    riskOverview: {},
    riskDetails: {}
  };
}

function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch;
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = isPlainObject(value) && isPlainObject(merged[key])
      ? deepMerge(merged[key], value)
      : value;
  }
  return merged;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 重新计算风险总览中的威胁预防相关派生字段。
 * 需在 summary 和 protection_effectiveness 数据均已就绪后调用。
 * 用于 data_client.js 内部（首次计算）及 health_report.js（预防数据就绪后覆盖）。
 */
function recalcThreatPreventionRiskCount(reportData) {
  if (!reportData) {
    return;
  }
  const s = reportData.summary || {};
  const internetRiskPorts = Number(s.internet?.exposure?.risk_ports || 0);
  const internetVulnTotal = Number(s.internet?.vuln?.total || 0);
  const internetWeakPwdTotal = Number(s.internet?.weak_pwd?.total || 0);
  const intranetVulnTotal = Number(s.intranet?.vuln?.total || 0);
  const intranetWeakPwdTotal = Number(s.intranet?.weak_pwd?.total || 0);
  const threatPreventionRiskCount = internetRiskPorts + internetVulnTotal + internetWeakPwdTotal + intranetVulnTotal + intranetWeakPwdTotal;

  const policyAbnormalCount = Number(reportData.protection_effectiveness?.policy_stats?.abnormal_count || 0);

  const totalRiskCount = Number(reportData.riskOverview?.totalEvents || 0) + threatPreventionRiskCount + policyAbnormalCount;

  if (reportData.riskOverview) {
    reportData.riskOverview.threatPreventionRiskCount = threatPreventionRiskCount;
    reportData.riskOverview.totalRiskCount = totalRiskCount;
  }
}

module.exports = {
  collectReportData,
  recalcThreatPreventionRiskCount
};
