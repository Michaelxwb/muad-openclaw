#!/usr/bin/env node
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');

// 阶段耗时收集器：记录每个关键阶段的耗时，用于最终汇总文字说明瓶颈。
// 由 timedPhase 自动记录；耗时数据始终随结果输出到 timing_summary（排查瓶颈的后门数据），
// 默认不展示给客户，是否展示由 skill 层按用户是否特别说明决定。
const PHASE_TIMINGS = [];

// 阶段耗时打印辅助：包裹一个 async 函数，打印开始/结束及耗时，并记录到收集器。
async function timedPhase(name, fn) {
  const t0 = Date.now();
  console.log(`[耗时] >>> ${name} 开始`);
  try {
    const r = await fn();
    PHASE_TIMINGS.push({ name, ms: Date.now() - t0, failed: false });
    console.log(`[耗时] <<< ${name} 完成，耗时 ${Date.now() - t0} ms`);
    return r;
  } catch (err) {
    PHASE_TIMINGS.push({ name, ms: Date.now() - t0, failed: true });
    console.log(`[耗时] !!! ${name} 失败，耗时 ${Date.now() - t0} ms`);
    throw err;
  }
}

// 生成纯文字的阶段耗时汇总（按耗时降序，只列出主要阶段 + 总耗时）。
function buildTimingSummary(totalMs) {
  const lines = [`本次报告生成总耗时 ${formatMs(totalMs)}`];
  const sortable = PHASE_TIMINGS.slice().sort((a, b) => b.ms - a.ms);
  const major = sortable.filter((t) => t.ms >= 1000 || sortable.length <= 6);
  (major.length ? major : sortable).forEach((t) => {
    const pct = totalMs > 0 ? `(${Math.round((t.ms / totalMs) * 100)}%)` : '';
    lines.push(`- ${t.name}: ${formatMs(t.ms)}${pct}${t.failed ? '（失败）' : ''}`);
  });
  return lines.join('\n');
}

function formatMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
const { parseArgs, requireArgs } = require('./src/args');
const { mapLimit } = require('./src/parallel');
const session = require('./src/session');
const { collectReportData, recalcThreatPreventionRiskCount } = require('./src/data_client');
const { summarizeAssetTable, summarizeDeviceComponents } = require('./src/asset_excel_stats');
const { summarizeIncidentStatus, extractExploitStats, extractVulnExploitExamples, summarizeManagedAssetIncidents, extractIncidentTypeStats, summarizeTopRiskAssetDetails, extractIncidentDirectStats, annotateIncidentGptConclusion } = require('./src/incident_excel_stats');
const { exportMsswIncidentList, exportMsswAssetList, exportMsswDeviceList, findMsswCustomerIdByName, fetchDefaultProjectTimeRange, readMsswCookieInfo, collectMsswDeviceCategoryCounts, parseLocalDate, removeIncidentSensitiveColumns, processRiskListTable, fetchContainedAlertCount } = require('./src/mssw_client');
const { collectPreventionTableExports, getTmpExportDir } = require('./src/prevention_exports');
const { calculatePreventionData } = require('./src/prevention_data');
const { calculateRiskAssetCount } = require('./src/risk_asset_count');
const { runBranch1ReportStage, mergeBranch1ReportPatch, exportBranch1Word, getDefaultDeviceJsonPath } = require('./src/branch1_adapter');
const { renderReportToFile } = require('./src/template_renderer');

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const logger = createLogger(options);
  const emitJson = options.json === true || options.json === 'true';

  if (command === 'help' || options.help) {
    printHelp();
    return;
  }

  const reportGeneratedAt = new Date();
  // 登录态：优先显式 --mssw-cookie-path（本地调试）；否则经 session-manager 取 mssw + mssp（muad 运行）
  if (!options['mssw-cookie-path'] && options.mock !== true && options.mock !== 'true') {
    const creds = await session.resolveSessions(logger);
    options['mssw-cookie-path'] = creds.msswCookiePath;
    options['easm-cookie-path'] = options['easm-cookie-path'] || creds.msspCookiePath;
    options['mssw-base-url'] = options['mssw-base-url'] || session.MSSW_BASE_URL;
    options['soar-base-url'] = options['soar-base-url'] || session.MSSP_BASE_URL;
    logger('[session] 已经 session-manager 注入 mssw/mssp 登录态');
  }
  // 统一查一次 customerId（只接受 --customer 自动查）
  let customerId = '';
  let msswCookie = null;
  if (options['mssw-cookie-path'] && options.customer) {
    try {
      msswCookie = await readMsswCookieInfo(options['mssw-cookie-path']);
      customerId = await findMsswCustomerIdByName(msswCookie, options['mssw-base-url'], options.customer);
      logger(`已自动获取 company_id: ${customerId}`);
    } catch (err) {
      logger(`自动查询 company_id 失败: ${err.message}`);
    }
  }

  if (command && command !== 'generate') {
    if (command === 'mssw-asset-export') {
      requireArgs(options, ['mssw-cookie-path', 'customer-id']);
      const result = await timedPhase('MSSW 资产表分页导出', () => exportMsswAssetList({
        msswCookiePath: options['mssw-cookie-path'],
        msswBaseUrl: options['mssw-base-url'],
        downloadDir: options['download-dir'],
        customerId: options['customer-id'],
        logger
      }));
      outputResult(result, emitJson, logger, `MSSW 资产表已导出: ${result.filePath}`);
      return;
    }

    throw new Error(`Unsupported command: ${command}`);
  }

  requireArgs(options, ['customer']);
  requireArgs(options, ['af', 'sip']);

  const afRaw = String(options.af).toLowerCase();
  const sipRaw = String(options.sip).toLowerCase();
  if (!['true', 'false'].includes(afRaw) || !['true', 'false'].includes(sipRaw)) {
    throw new Error('--af and --sip must be true or false');
  }
  const afSubscribed = afRaw === 'true';
  const sipSubscribed = sipRaw === 'true';

  // XDR cookie 链路已移除（session-manager 无 XDR 平台，不参与主线取数）

  const __main_t0 = Date.now();
  await timedPhase('MSSW 设备列表导出', () => exportMsswDeviceList({
    msswCookiePath: options['mssw-cookie-path'],
    msswBaseUrl: options['mssw-base-url'],
    customerId,
    logger
  }));

  const effectiveTimeRange = await resolveEffectiveTimeRange({
    options,
    customerId,
    msswCookie,
    reportGeneratedAt,
    logger
  });

  const root = __dirname;
  const templatePath = options.template || path.join(root, 'security-report-preview.html');
  const outputDir = options['output-dir'] || session.outputDir();
  const runExportDir = await createRunExportWorkspace(root, reportGeneratedAt, logger);
  let branch1Result = null;
  let preventionTables = null;

  logger(`开始生成: ${options.customer} ${effectiveTimeRange.start} ~ ${effectiveTimeRange.end}`);

  const tableExports = await timedPhase('MSSW XDR 表导出', () => exportConfiguredXdrTables({
    msswCookiePath: options['mssw-cookie-path'],
    msswBaseUrl: options['mssw-base-url'],
    downloadDir: options['download-dir'],
    start: effectiveTimeRange.start,
    end: effectiveTimeRange.end,
    xdrTables: options['xdr-tables'],
    customerId,
    assetIds: [],
    timeoutMs: options['timeout-ms'] ? Number(options['timeout-ms']) : undefined,
    pollIntervalMs: options['poll-interval-ms'] ? Number(options['poll-interval-ms']) : undefined,
    mock: options.mock === true || options.mock === 'true',
    outputDir: runExportDir,
    logger
  }));
  if (Object.keys(tableExports).length) {
    logger(`MSSW 导表完成: ${Object.keys(tableExports).join(', ')}`);
  } else {
    logger('跳过 MSSW 导表');
  }

  // 资产/事件状态统计读取两个独立 xlsx、纯本地计算，无共享状态，并行以缩短耗时。
  const [assetStatusStats, incidentStatusStats] = await Promise.all([
    summarizeExportedAssetStatus(tableExports, logger),
    summarizeExportedIncidentStatus(tableExports, logger)
  ]);

  // 从事件表提取漏洞利用统计（不阻断主流程）
  let exploitStats = null;
  let vulnExploitExamples = [];
  let topRiskDirectIncidentStats = null;
  let incidentFilePath = await resolveIncidentFilePath(options, tableExports);
  if (incidentFilePath) {
    try {
      topRiskDirectIncidentStats = await extractIncidentDirectStats(incidentFilePath);
      logger(`风险资产 TOP5 事件表直读分类: C2 ${topRiskDirectIncidentStats.hostCompromiseIds.length} 起, 病毒木马 ${topRiskDirectIncidentStats.virusTrojanIds.length} 起, 漏洞利用 ${topRiskDirectIncidentStats.exploitIds.length} 起`);
    } catch (error) {
      logger(`风险资产 TOP5 事件表直读分类失败（不影响主流程）: ${error.message}`);
    }

    try {
      exploitStats = await extractExploitStats(incidentFilePath);
      logger(`漏洞利用事件统计: 共 ${exploitStats.total} 起, 已闭环 ${exploitStats.closedCount} 起, 处置中 ${exploitStats.processingCount} 起, 影响资产 ${exploitStats.highRiskAsset || '无'}`);
    } catch (error) {
      logger(`提取漏洞利用事件统计失败（不影响主流程）: ${error.message}`);
    }

    try {
      const exploitExamples = await extractVulnExploitExamples(incidentFilePath, exploitStats ? exploitStats.incidentIds : []);
      vulnExploitExamples = Array.isArray(exploitExamples.vulnExploits) ? exploitExamples.vulnExploits : [];
      logger(`漏洞利用事件举例已提取: ${vulnExploitExamples.length} 条`);
    } catch (error) {
      logger(`提取漏洞利用事件举例失败（不影响主流程）: ${error.message}`);
    }
  }

  // 从资产表和事件表提取托管资产安全事件统计（不阻断主流程）
  const resolvedAssetFilePath = await resolveAssetFilePath({
    options,
    tableExports,
    logger
  });
  const assetFilePath = resolvedAssetFilePath;
  let managedAssetIncidentStats = null;
  if (assetFilePath && incidentFilePath) {
    try {
      managedAssetIncidentStats = await summarizeManagedAssetIncidents(assetFilePath, incidentFilePath);
      logger(`全量事件响应时间统计: AvgResponseTime=${managedAssetIncidentStats.AvgResponseTime}分钟, 托管资产数=${managedAssetIncidentStats.managedAssetCount}`);
    } catch (error) {
      logger(`托管资产事件统计失败（不影响主流程）: ${error.message}`);
    }
  }
  // 从 API 查询已遏制告警数量
  let containedAlerts = 0;
  if (msswCookie && customerId && effectiveTimeRange.start && effectiveTimeRange.end) {
    try {
      containedAlerts = await fetchContainedAlertCount(msswCookie, options['mssw-base-url'], customerId, {
        start: effectiveTimeRange.start,
        end: effectiveTimeRange.end
      });
      logger(`API 查询已遏制告警数量: ${containedAlerts} 起`);
    } catch (error) {
      logger(`API 查询已遏制告警数量失败（设为 0）: ${error.message}`);
    }
  }

  let reportData = await timedPhase('收集报告数据 collectReportData', () => collectReportData({
    customer: options.customer,
    customerId,
    start: effectiveTimeRange.start,
    end: effectiveTimeRange.end,
    generatedAt: reportGeneratedAt.toISOString(),
    xdrCookiePath: options['xdr-cookie-path'],
    msswCookiePath: options['mssw-cookie-path'],
    msswBaseUrl: options['mssw-base-url'],
    assetStatusStats,
    incidentStatusStats,
    incidentFilePath: incidentFilePath || undefined,
    assetFilePath: resolvedAssetFilePath || undefined,
    exploitIncidentIds: exploitStats && Array.isArray(exploitStats.incidentIds) ? exploitStats.incidentIds : [],
    logger
  }));

  // 合并漏洞利用统计到报告数据
  if (exploitStats) {
    reportData.riskOverview.exploitStats = exploitStats;
    logger(`漏洞利用数据已合并: total=${exploitStats.total}, closedCount=${exploitStats.closedCount}, processingCount=${exploitStats.processingCount}`);
  }

  if (!reportData.riskDetails.highRiskIncidentExamples || typeof reportData.riskDetails.highRiskIncidentExamples !== 'object') {
    reportData.riskDetails.highRiskIncidentExamples = {};
  }
  reportData.riskDetails.highRiskIncidentExamples.vulnExploits = vulnExploitExamples;

    // 通过 API 写入已遏制告警数量
  reportData.riskDetails.containedAlerts = containedAlerts;
  reportData.riskOverview.containedAlerts = containedAlerts;

// 合并全量事件响应时间统计到报告数据（始终写入默认值，有数据时覆盖）
  Object.assign(reportData.riskDetails, {
    AvgResponseTime: 0,
    topEventType: '',
    top3BusinessSystems: '',
    businessSystemEventDistribution: [],
    managedAssetCount: 0,
  });
  if (managedAssetIncidentStats) {
    Object.assign(reportData.riskDetails, {
      AvgResponseTime: managedAssetIncidentStats.AvgResponseTime,
      managedAssetCount: managedAssetIncidentStats.managedAssetCount,
      topEventType: managedAssetIncidentStats.topEventType,
      top3BusinessSystems: managedAssetIncidentStats.top3BusinessSystems,
      businessSystemEventDistribution: managedAssetIncidentStats.businessSystemEventDistribution
    });
    logger(`全量事件响应时间已合并: AvgResponseTime=${managedAssetIncidentStats.AvgResponseTime}分钟`);
    logger(`最多类型事件: ${managedAssetIncidentStats.topEventType}`);
    logger(`TOP3业务系统: ${managedAssetIncidentStats.top3BusinessSystems}`);
    logger(`业务系统安全事件分布: ${JSON.stringify(managedAssetIncidentStats.businessSystemEventDistribution)}`);
  }

  // 从事件表独立计算安全事件类型分布（不依赖资产表）
  if (incidentFilePath) {
    try {
      const incidentTypeStats = await extractIncidentTypeStats(incidentFilePath);
      reportData.riskDetails.topEventType = incidentTypeStats.topEventType;
      reportData.riskDetails.eventTypeDistribution = incidentTypeStats.eventTypeDistribution;
      logger(`安全事件类型分布已计算: topEventType=${incidentTypeStats.topEventType}`);
    } catch (error) {
      logger(`提取安全事件类型分布失败（不影响主流程）: ${error.message}`);
    }
  }

  // 事件类型分布超过 5 项时才在末尾补充"其它"（取值 = 总事件数 - 已有类型事件数之和）
  const dist = reportData.riskDetails.eventTypeDistribution;
  if (Array.isArray(dist) && dist.length >= 5) {
    const sum = dist.reduce((acc, item) => acc + (item.value || 0), 0);
    const otherValue = (reportData.riskDetails.totalEvents || 0) - sum;
    dist.push({ name: '其它', value: otherValue >= 0 ? otherValue : 0 });
    logger(`事件类型分布已补充"其它": ${otherValue} 起`);
  }

  if (options['mssw-cookie-path']) {
    try {
      const loadedMsswCookie = msswCookie || await readMsswCookieInfo(options['mssw-cookie-path']);
      logger(`MSSW Cookie 已加载: ${loadedMsswCookie.resolvedPath}`);

      // 通过 MSSW 接口查询设备分类数量
      try {
        logger('正在通过 MSSW 查询设备分类数量...');
        const deviceCounts = await collectMsswDeviceCategoryCounts(
          loadedMsswCookie,
          options['mssw-base-url'],
          customerId,
          logger
        );
        reportData.riskDetails = Object.assign(reportData.riskDetails || {}, deviceCounts);
        reportData.riskOverview = Object.assign(reportData.riskOverview || {}, {
          devices: deviceCounts.devices
        });
        logger(`MSSW 设备总数: ${deviceCounts.devices}，深信服: ${deviceCounts.sangfor}（AF: ${deviceCounts.af}, AES: ${deviceCounts.aes}, SIP: ${deviceCounts.sip}, STA: ${deviceCounts.sta}, 其他: ${deviceCounts.other_sf}），第三方: ${deviceCounts.third}`);

        // 第三方设备数量来自独立接口（不在 device.json 里），需要重新计算组件分布
        // 把 deviceCounts.third 传给 device_component_stats.py，更新 assetLedger 的组件分布
        if (Number(deviceCounts.third) > 0) {
          try {
            const deviceJsonPath = require('./src/workdir').deviceJsonPath();
            let deviceJsonExists = false;
            try { await fs.stat(deviceJsonPath); deviceJsonExists = true; } catch (_) {}
            if (deviceJsonExists) {
              const componentStats = await summarizeDeviceComponents(deviceJsonPath, Number(deviceCounts.third));
              if (reportData.assetLedger) {
                reportData.assetLedger.componentDistribution = componentStats.componentDistribution;
                reportData.assetLedger.totalComponentCount = componentStats.total;
              }
              logger(`安全组件分布已更新（含第三方 ${deviceCounts.third} 个）: total=${componentStats.total}`);
            }
          } catch (error) {
            logger(`更新安全组件分布失败（含第三方）: ${error.message}`);
          }
        }
        // 关键风险 #01 网络防护动态话术：设备数量为0时即使订阅参数为开启也按"无设备"处理
        const advice = buildNetworkAdvice({
          afSubscribed,
          sipSubscribed,
          afDeviceCount: Number(deviceCounts.af || 0),
          sipDeviceCount: Number(deviceCounts.sip || 0)
        });
        reportData.riskOverview = Object.assign(reportData.riskOverview || {}, {
          keyRisk01NetworkAdvice: advice
        });
        logger(`关键风险#01 网络防护话术: optimal=${advice.optimal} afStatus=${advice.afStatus} sipStatus=${advice.sipStatus}`);
      } catch (error) {
        logger(`通过 MSSW 获取设备分类数量失败: ${error.message}，将跳过设备分类统计`);
      }
    } catch (error) {
      logger(`加载 MSSW Cookie 失败: ${error.message}`);
    }
  }

  const preventionEnabled = await shouldRunPreventionStage(options, tableExports);
  if (preventionEnabled) {
    if (!incidentFilePath) {
      throw new Error('威胁预防数据计算失败: 缺少事件表，请检查本次事件表导出结果');
    }
    if (!resolvedAssetFilePath) {
      throw new Error('威胁预防数据计算失败: 缺少资产表，请先准备 tmp/exports 中可用的资产表');
    }

    logger('开始准备威胁预防所需表格...');
    preventionTables = options.mock === true || options.mock === 'true'
      ? (logger('威胁预防表格使用本地文件（mock 模式）'),
        {
          weakpwd: { filePath: path.join(__dirname, '弱口令清单.xlsx'), source: 'local' },
          vuln:    { filePath: path.join(__dirname, '漏洞清单.xlsx'),    source: 'local' },
          exposure:{ filePath: path.join(__dirname, '暴露面清单.xlsx'), source: 'local' },
        })
      : await collectPreventionTableExports({
          customer: options.customer,
          start: effectiveTimeRange.start,
          end: effectiveTimeRange.end,
          soarCookiePath: options['easm-cookie-path'] || options['cookie-path'],
          msswCookiePath: options['mssw-cookie-path'],
          msswBaseUrl: options['mssw-base-url'],
          soarBaseUrl: options['soar-base-url'],
          outputDir: runExportDir,
          logger
        });
    logger(`威胁预防表格已就绪: weakpwd=${preventionTables.weakpwd.filePath}, vuln=${preventionTables.vuln.filePath}, exposure=${preventionTables.exposure.filePath}`);

    const preventionData = await calculatePreventionData({
      assetPath: resolvedAssetFilePath,
      incidentPath: incidentFilePath,
      weakpwdPath: preventionTables.weakpwd.filePath,
      vulnPath: preventionTables.vuln.filePath,
      exposurePath: preventionTables.exposure.filePath
    });
    Object.assign(reportData, preventionData);
    logger('威胁预防 JSON 已合并到 report-data');

    branch1Result = await timedPhase('分支1 报告阶段 runBranch1ReportStage', () => runBranch1ReportStage({
      customer: options.customer,
      companyId: customerId,
      start: effectiveTimeRange.start,
      end: effectiveTimeRange.end,
      assetPath: resolvedAssetFilePath,
      eventPath: incidentFilePath,
      weakpwdPath: preventionTables.weakpwd.filePath,
      vulnPath: preventionTables.vuln.filePath,
      exposurePath: preventionTables.exposure.filePath,
      devicePath: getDefaultDeviceJsonPath(),
      msswCookiePath: options['mssw-cookie-path'],
      msswBaseUrl: options['mssw-base-url'],
      outputDir: require('./src/workdir').branch1WorkDir(),
      mock: options.mock === true || options.mock === 'true'
    }));
    reportData = mergeBranch1ReportPatch(reportData, branch1Result.reportPatch);
    logger('分支1 JSON 已合并到 report-data');

    // 此时 summary（来自 calculatePreventionData）已有值，重新计算威胁预防派生字段
    recalcThreatPreventionRiskCount(reportData);
    logger(`威胁预防风险总数已重新计算: ${reportData.riskOverview.threatPreventionRiskCount}`);

    // 最后落盘前将统一分类追加到 GPT研判结论，再删除敏感实体列。
    try {
      const annotatedResult = await annotateIncidentGptConclusion(
        incidentFilePath,
        path.join(runExportDir, 'incident-classification')
      );
      incidentFilePath = annotatedResult.filePath; // eslint-disable-line no-param-reassign
      logger(`事件表 GPT研判结论已追加分类: C2=${annotatedResult.classified.C2外联 || 0}, 病毒木马=${annotatedResult.classified.病毒木马 || 0}`);
    } catch (error) {
      logger(`追加事件 GPT研判分类失败（不阻断主流程）: ${error.message}`);
    }

    // 再删除事件表中的"外网IP地址"、"域名"、"文件"三列
    try {
      const strippedResult = await removeIncidentSensitiveColumns(incidentFilePath, runExportDir);
      logger(`事件表已删除敏感列: ${strippedResult.filePath}`);
      incidentFilePath = strippedResult.filePath;  // 使用剥离后的文件作为最终落盘文件  // eslint-disable-line no-param-reassign
    } catch (error) {
      logger(`删除事件表敏感列失败（不阻断主流程）: ${error.message}`);
    }

    const archivedFiles = await timedPhase('归档风险清单 archiveRiskListFiles', () => archiveRiskListFiles({
      root,
      outputDir,
      incidentPath: incidentFilePath,
      assetPath: resolvedAssetFilePath,
      exposurePath: preventionTables.exposure.filePath,
      weakpwdPath: preventionTables.weakpwd.filePath,
      vulnPath: preventionTables.vuln.filePath,
      policyCheckPath: branch1Result.artifacts.policyExcelPath,
      logger
    }));
    if (tableExports.incident) {
      tableExports.incident.filePath = archivedFiles.incidentPath;
    }
    if (tableExports.asset) {
      tableExports.asset.filePath = archivedFiles.assetPath;
    }
    preventionTables.exposure.filePath = archivedFiles.exposurePath;
    preventionTables.weakpwd.filePath = archivedFiles.weakpwdPath;
    preventionTables.vuln.filePath = archivedFiles.vulnPath;
    const incidentGptStatsForTopAssets = reportData.riskOverview && reportData.riskOverview.incidentGptStats
      ? reportData.riskOverview.incidentGptStats
      : {};
    const topRiskC2Ids = uniqueStrings([
      ...(incidentGptStatsForTopAssets.hostCompromise && Array.isArray(incidentGptStatsForTopAssets.hostCompromise.confirmedIncidentIds)
        ? incidentGptStatsForTopAssets.hostCompromise.confirmedIncidentIds
        : []),
      ...(topRiskDirectIncidentStats && Array.isArray(topRiskDirectIncidentStats.hostCompromiseIds)
        ? topRiskDirectIncidentStats.hostCompromiseIds
        : [])
    ]);
    const topRiskVirusIds = uniqueStrings([
      ...(incidentGptStatsForTopAssets.virusTrojan && Array.isArray(incidentGptStatsForTopAssets.virusTrojan.confirmedIncidentIds)
        ? incidentGptStatsForTopAssets.virusTrojan.confirmedIncidentIds
        : []),
      ...(topRiskDirectIncidentStats && Array.isArray(topRiskDirectIncidentStats.virusTrojanIds)
        ? topRiskDirectIncidentStats.virusTrojanIds
        : [])
    ]);
    const topRiskExploitIds = uniqueStrings([
      ...(exploitStats && Array.isArray(exploitStats.incidentIds) ? exploitStats.incidentIds : []),
      ...(topRiskDirectIncidentStats && Array.isArray(topRiskDirectIncidentStats.exploitIds)
        ? topRiskDirectIncidentStats.exploitIds
        : [])
    ]);
    const topRiskIncidentIds = [
      ...topRiskC2Ids,
      ...topRiskVirusIds,
      ...topRiskExploitIds
    ];

    const riskAssetStats = await calculateRiskAssetCount({
      eventPath: archivedFiles.incidentPath,
      assetPath: archivedFiles.assetPath,
      weakPasswordPath: archivedFiles.weakpwdPath,
      vulnerabilityPath: archivedFiles.vulnPath,
      exposurePath: archivedFiles.exposurePath,
      topRiskIncidentIds
    });
    let topRiskAssets = Array.isArray(riskAssetStats.riskAssetTop5)
      ? riskAssetStats.riskAssetTop5
      : [];
    if (topRiskAssets.length) {
      try {
        const topRiskAssetDetails = await summarizeTopRiskAssetDetails({
          incidentExcelPath: archivedFiles.incidentPath,
          weakPasswordExcelPath: archivedFiles.weakpwdPath,
          vulnerabilityExcelPath: archivedFiles.vulnPath,
          exposureExcelPath: archivedFiles.exposurePath,
          topAssets: topRiskAssets,
          c2Ids: topRiskC2Ids,
          virusIds: topRiskVirusIds,
          exploitIds: topRiskExploitIds
        });
        const detailMap = topRiskAssetDetails.assets || {};
        topRiskAssets = topRiskAssets.map((asset) => {
          const detail = detailMap[asset.ip] || null;
          return detail
            ? {
              ...asset,
              riskDetails: detail,
              detailLines: Array.isArray(detail.detailLines) ? detail.detailLines : []
            }
            : asset;
        });
        logger('风险资产 TOP5 风险详情已按事件表和资产表补齐');
      } catch (error) {
        logger(`统计风险资产 TOP5 风险详情失败（不影响主流程）: ${error.message}`);
      }
    }

    reportData.riskOverview = Object.assign({}, reportData.riskOverview || {}, {
      riskAssetCount: Number(riskAssetStats.affectedAssetCount || 0),
      riskBusinessCount: Number(riskAssetStats.riskBusinessCount || 0),
      topRiskAssets
    });
    logger(`风险总览统计已更新: 风险业务数 ${reportData.riskOverview.riskBusinessCount} 个，风险资产数 ${reportData.riskOverview.riskAssetCount} 个（按风险清单五表综合统计）`);
  } else {
    logger('跳过威胁预防数据准备: 未提供相关运行上下文');
  }

  // 3.2 风险资产 TOP5：没有任何风险资产则该章节不展示
  {
    const r = reportData.riskOverview || {};
    r.topRiskAssetsSectionHide = !Array.isArray(r.topRiskAssets) || r.topRiskAssets.length === 0;
    // 2.2 节隐藏时，章节 2 末尾仍展示「综上...」精简段落（去掉「修复方案重点针对 xxx 等资产。」），
    // 由 HTML 里独立的 fallback 段落承载，显示条件与 2.2 节隐藏相反。
    r.topRiskAssetsSummaryFallbackHide = !r.topRiskAssetsSectionHide;
    logger(`3.2 风险资产 TOP5 章节隐藏标记: ${r.topRiskAssetsSectionHide} (fallback 显示: ${!r.topRiskAssetsSummaryFallbackHide})`);
  }

  // 3.1 关键风险卡片：无数据类别不展示（通过 data-hide 机制驱动）
  {
    const r = reportData.riskOverview || {};
    const k = reportData.key_risks || {};
    const igs = r.incidentGptStats || {};
    const es = r.exploitStats || {};
    // 防护有效性（#06）：无资产未安装EDR 且 无策略配置异常 时隐藏，与 #01-#05 口径一致
    const pe = reportData.protection_effectiveness || {};
    const withoutAesTotal = Number(((pe.without_aes_asset_stats || {}).total) || 0);
    const policyAbnormal = Number(((pe.policy_stats || {}).abnormal_count) || 0);
    r.keyRisk01Hide = (igs.total || 0) === 0;
    r.keyRisk02Hide = (es.total || 0) === 0;
    r.keyRisk03Hide = ((k.vuln || {}).high_count || 0) === 0;
    r.keyRisk04Hide = ((k.weak_pwd || {}).total || 0) === 0;
    r.keyRisk05Hide = ((k.exposure || {}).total || 0) === 0;
    r.keyRisk06Hide = withoutAesTotal === 0 && policyAbnormal === 0;
    // 全部关键风险子类都隐藏时，2.1 节导语「以下几类问题需要贵公司重点关注：」改为「暂无风险」
    r.keyRisksAllHidden = r.keyRisk01Hide && r.keyRisk02Hide && r.keyRisk03Hide
      && r.keyRisk04Hide && r.keyRisk05Hide && r.keyRisk06Hide;
    r.keyRisksNotAllHidden = !r.keyRisksAllHidden;
    logger(`关键风险卡片隐藏标记: #01=${r.keyRisk01Hide} #02=${r.keyRisk02Hide} #03=${r.keyRisk03Hide} #04=${r.keyRisk04Hide} #05=${r.keyRisk05Hide} #06=${r.keyRisk06Hide} 全部隐藏=${r.keyRisksAllHidden}`);
  }

  // 4.1.3 高危及以上安全事件：三类（C2外联/病毒木马/漏洞利用）全部为空则整章不展示
  {
    const examples = (reportData.riskDetails || {}).highRiskIncidentExamples || {};
    const c2 = Array.isArray(examples.c2Connections) ? examples.c2Connections.length : 0;
    const viruses = Array.isArray(examples.viruses) ? examples.viruses.length : 0;
    const vulnExploits = Array.isArray(examples.vulnExploits) ? examples.vulnExploits.length : 0;
    const allEmpty = c2 + viruses + vulnExploits === 0;
    reportData.riskDetails.highRiskEventsSectionHide = allEmpty;
    // 各子模块（C2外联/病毒木马/漏洞利用）无事件时不展示该子模块
    reportData.riskDetails.c2EventsSubsectionHide = c2 === 0;
    reportData.riskDetails.virusEventsSubsectionHide = viruses === 0;
    reportData.riskDetails.vulnExploitSubsectionHide = vulnExploits === 0;
    logger(`4.1.3 高危及以上安全事件章节隐藏标记: ${allEmpty} (C2=${c2}, 病毒=${viruses}, 漏洞利用=${vulnExploits}) 子模块隐藏: C2=${c2 === 0}, 病毒=${viruses === 0}, 漏洞利用=${vulnExploits === 0}`);
  }

  // 4.1.2 安全事件分布：事件表一个事件都没有则整章不展示
  {
    const noEvents = Number((reportData.riskDetails || {}).totalEvents || 0) === 0;
    reportData.riskDetails.eventDistributionSectionHide = noEvents;
    logger(`4.1.2 安全事件分布章节隐藏标记: ${noEvents} (totalEvents=${(reportData.riskDetails || {}).totalEvents || 0})`);
  }

  // 4.1.4 典型案例：攻击/防御时间线都为空则整章不展示（与 renderCaseStudySection 判空口径一致）
  {
    const cs = (reportData.riskDetails || {}).caseStudy || {};
    const attack = Array.isArray(cs.attackTimeline) ? cs.attackTimeline.length : 0;
    const defense = Array.isArray(cs.defenseTimeline) ? cs.defenseTimeline.length : 0;
    const defenseItems = Array.isArray(cs.defenseTimeline) ? cs.defenseTimeline : [];
    const noCase = attack + defense === 0;
    reportData.riskDetails.caseStudySectionHide = noCase;
    logger(`4.1.4 典型案例章节隐藏标记: ${noCase} (attack=${attack}, defense=${defense})`);
    if (defenseItems.length > 0) {
      logger(`4.1.4 防守时间线详情: ${JSON.stringify(defenseItems.map((item) => ({
        entries: Array.isArray(item.timeEntries) ? item.timeEntries.map((e) => ({
          time: e.timestamp && e.timestamp > 0 ? new Date(e.timestamp * 1000).toISOString() : '暂无时间',
          desc: e.desc
        })) : [],
        label: item.label
      })))}`);
    }
  }

  const reportDataJsonPath = options['output-json'] || path.join(outputDir, 'report-data.json');
  await writeJsonFile(reportDataJsonPath, reportData);
  logger(`数据已写入: ${reportDataJsonPath}`);

  const result = await timedPhase('渲染 HTML 报告 renderReportToFile', () => renderReportToFile({
    templatePath,
    outputDir,
    reportData
  }));
  logger(`HTML 已生成: ${result.html_path || result.filePath || ''}`);

  let wordExport = null;
  if (branch1Result) {
    const htmlPath = result.html_path || result.filePath || '';
    const baseName = path.basename(htmlPath, '.html');
    const wordDir = path.join(outputDir, 'report');
    await fs.mkdir(wordDir, { recursive: true });
    // 生成新 docx 前，先删除目录下已有的 docx 文件，避免残留旧版本
    const existingDocx = (await fs.readdir(wordDir))
      .filter((name) => name.toLowerCase().endsWith('.docx'));
    if (existingDocx.length) {
      await Promise.all(existingDocx.map((name) => fs.unlink(path.join(wordDir, name))));
      logger(`已清理旧的 docx 文件: ${existingDocx.length} 个`);
    }
    const wordPath = path.join(wordDir, `${baseName}.docx`);
    wordExport = await timedPhase('导出 Word 报告 exportBranch1Word', () => exportBranch1Word({
      htmlPath,
      wordPath
    }));
    logger(`Word 已生成: ${wordExport.wordPath}`);
  }

  const reportDir = path.join(outputDir, 'report');
  if (isExcelBeautificationEnabled(options)) {
    await timedPhase('美化归档风险清单 Excel', () => beautifyArchivedRiskLists(reportDir, logger));
  } else {
    logger('已跳过归档风险清单 Excel 美化 (--beautify-excel false)');
  }

  // 将安全体检报告文件夹打包为 zip，文件名严格中文命名（固定为「安全体检报告.zip」，见 SKILL.md 输出契约）
  const zipPath = await timedPhase('打包安全体检报告 ZIP', () => zipDirectory(reportDir, logger, '安全体检报告'));
  if (zipPath) {
    logger(`ZIP 已生成: ${zipPath}`);
  }
  const outboundZipPath = await publishZipToOutbound(zipPath, options['delivery-id'], logger);

  await fs.rm(runExportDir, { recursive: true, force: true });
  logger(`本次导出工作目录已清理: ${runExportDir}`);

  const totalMs = Date.now() - __main_t0;
  console.log(`[总耗时] 报告导出完成: ${totalMs} ms`);

  // 各阶段耗时始终收集并随结果输出到 timing_summary（排查瓶颈的后门数据）；
  // 默认不追加到给客户的文字摘要，是否展示给用户由 skill 层按特别说明决定。
  const timingSummary = buildTimingSummary(totalMs);

  outputResult({
    ...result,
    xdrExports: tableExports,
    word_path: wordExport ? wordExport.wordPath : null,
    zip_path: zipPath || null,
    outbound_zip_path: outboundZipPath,
    branch1Artifacts: branch1Result
      ? {
        ...branch1Result.artifacts,
        wordPath: wordExport ? wordExport.wordPath : null
      }
      : null,
    timing_summary: timingSummary
  }, emitJson, logger, `完成: ${result.html_path || result.filePath || ''}`);
}

/**
 * 综合 AF 设备数量与订阅参数，判断防火墙云情报网关状态并生成对应话术
 * @param {object} opts
 * @param {boolean} opts.afSubscribed  --af 参数（true/false）
 * @param {boolean} opts.sipSubscribed --sip 参数（true/false）
 * @param {number}  opts.afDeviceCount  接口查到的 AF 设备数
 * @param {number}  opts.sipDeviceCount 接口查到的 SIP 设备数
 * @returns {{ optimal: boolean, afStatus: string, sipStatus: string, afPhrase: string, sipPhrase: string }}
 */
function buildNetworkAdvice({ afSubscribed, sipSubscribed, afDeviceCount, sipDeviceCount }) {
  // 设备数为 0 时即使订阅参数为 true 也按无设备处理
  const afStatus = afDeviceCount === 0 ? 'no_device' : (afSubscribed ? 'on' : 'off');
  const sipStatus = sipDeviceCount === 0 ? 'no_device' : (sipSubscribed ? 'on' : 'off');

  const PHRASES = {
    af: {
      on: '您的防火墙目前已开通云情报网关',
      off: '开启防火墙云情报网关订阅，并更新到最新的情报库',
      no_device: '请你购买深信服防火墙设备，并开启情报网关订阅更新到最新的情报库'
    },
    sip: {
      on: '您的SIP目前已开启云端情报检测',
      off: '开启SIP的云端情报检测',
      no_device: '请你购买深信服SIP设备，并且开启云端情报检测'
    }
  };

  return {
    optimal: afStatus === 'on' && sipStatus === 'on',
    afStatus,
    sipStatus,
    afPhrase: PHRASES.af[afStatus],
    sipPhrase: PHRASES.sip[sipStatus]
  };
}

function printHelp() {
  console.log(`Usage:
  node health_report.js --customer "客户名" [--start YYYY-MM-DD --end YYYY-MM-DD] [options]

Options:
  --customer <name>              Customer name (用于自动查询 company_id)
  --mssw-cookie-path <path>      Required for generate and MSSW data flow
  --mssw-base-url <host>         MSSW origin (default http://mssw-inner.sangfor.com.cn:30001，来源于 config/api_config.json)
  --soar-base-url <host>         SOAR/mssp origin for EASM interfaces (default 线上 http://soar-inner.sangfor.com.cn:30001)
  --xdr-cookie-path <path>       Optional, XDR cookie file path
  --start <YYYY-MM-DD>           Optional report start date (最大范围 30 天)
  --end <YYYY-MM-DD>             Optional report end date (最大范围 30 天)
  --cookie-path <path>           SOAR cookie file path（线上 http://soar-inner.sangfor.com.cn:30001）
  --xdr-tables <names>           Optional MSSW export tables, default asset,incident
  --mock                         使用根目录本地清单模拟数据，跳过接口下载
  --download-dir <path>          Optional export directory override
  --output-json <path>           Optional report data JSON path, default output/report-data.json
  --json                         Print concise JSON summary to stdout (full data is written to report-data.json)
  --timeout-ms <ms>              Optional wait timeout for MSSW export download
  --poll-interval-ms <ms>        Optional MSSW event export polling interval
  --template <path>              HTML template path
  --output-dir <path>            Output directory
  --delivery-id <id>             Optional per-request WeCom outbound delivery ID
  --beautify-excel <true|false>  Beautify archived risk-list Excel files before ZIP (default true)
  --af <true|false>              是否开通防火墙云情报网关订阅（必填，由 skill 层反问后传入）
  --sip <true|false>             是否开通SIP云端情报检测（必填，由 skill 层反问后传入）
`);
}

async function exportConfiguredXdrTables(options) {
  if (!options.msswCookiePath) {
    logWith(options.logger, '未提供 mssw-cookie-path，跳过 MSSW 导表');
    return {};
  }

  const tables = parseXdrTables(options.xdrTables);
  logWith(options.logger, `准备导出表格: ${tables.join(', ')}`);
  const results = {};

  // asset/incident 两张表彼此独立，保守并发 2 并行导出以缩短整体耗时。
  // 各表写入互不相同的目标文件，无共享状态冲突。
  await mapLimit(tables.map((table) => () => exportOneConfiguredTable(table, options, results)), 2);

  return results;
}

// 导出单张配置表（asset / incident），结果写入共享 results 对象对应键。
async function exportOneConfiguredTable(table, options, results) {
  if (table === 'asset') {
    if (options.mock) {
      logWith(options.logger, '开始处理表格: asset (读取本地资产列表.xlsx)');
      const localAssetPath = path.join(__dirname, '资产列表.xlsx');
      const processedResult = await processRiskListTable('asset', localAssetPath, {
        outputDir: options.outputDir
      });
      results.asset = {
        filePath: processedResult.filePath,
        tmpFilePath: processedResult.filePath,
        filename: '资产列表.xlsx'
      };
    } else {
      logWith(options.logger, '开始处理表格: asset (MSSW 真实下载)');
      results.asset = await exportMsswAssetList({
        msswCookiePath: options.msswCookiePath,
        msswBaseUrl: options.msswBaseUrl,
        downloadDir: options.downloadDir,
        customerId: options.customerId,
        assetIds: options.assetIds || [],
        outputDir: options.outputDir,
        logger: options.logger
      });
    }
    return;
  }

  if (table === 'incident') {
    if (options.mock) {
      logWith(options.logger, '开始处理表格: incident (读取本地事件列表.xlsx)');
      const localIncidentPath = path.join(__dirname, '事件列表.xlsx');
      const processedResult = await processRiskListTable('incident', localIncidentPath, {
        outputDir: options.outputDir
      });
      results.incident = {
        filePath: processedResult.filePath,
        tmpFilePath: processedResult.filePath,
        filename: '事件列表.xlsx'
      };
    } else {
      logWith(options.logger, '开始处理表格: incident (MSSW 真实下载)');
      results.incident = await exportMsswIncidentList({
        msswCookiePath: options.msswCookiePath,
        msswBaseUrl: options.msswBaseUrl,
        downloadDir: options.downloadDir,
        start: options.start,
        end: options.end,
        customerId: options.customerId,
        timeoutMs: options.timeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        outputDir: options.outputDir,
        logger: options.logger
      });
    }
    return;
  }

  throw new Error(`Unsupported export table: ${table}`);
}

function createLogger(options = {}) {
  if (options.quiet === true || options.quiet === 'true') {
    return () => {};
  }

  return (message) => {
    console.error(message);
  };
}

function outputResult(result, emitJson, logger, summary) {
  if (emitJson) {
    // 后台长任务上下文收敛：只回传精简摘要，避免把整份 report-data 摊开
    // 回填到后台 agent 的 LLM 上下文（上下文过大是 LLM 请求超时的主要诱因之一）。
    // 完整数据已由脚本写入 --output-json 指定的 report-data.json，无需回传。
    const pick = {
      ok: true,
      html_path: result.html_path || result.filePath || null,
      word_path: result.word_path || null,
      zip_path: result.zip_path || null,
      outbound_zip_path: result.outbound_zip_path || null,
      timing_summary: result.timing_summary || null,
    };
    console.log(JSON.stringify(pick));
    return;
  }

  if (summary) {
    logger(summary);
  }
}

function logWith(logger, message) {
  if (typeof logger === 'function') {
    logger(message);
  }
}

function uniqueStrings(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }
  return result;
}

async function summarizeExportedIncidentStatus(tableExports, logger) {
  const incidentFilePath = tableExports && tableExports.incident ? tableExports.incident.filePath : '';
  if (!incidentFilePath) {
    return null;
  }

  logWith(logger, `开始统计事件表处置状态: ${incidentFilePath}`);
  const stats = await summarizeIncidentStatus(incidentFilePath);
  if (Number(tableExports.incident.totalEvents) > 0) {
    stats.totalEvents = Number(tableExports.incident.totalEvents);
    stats.closeRate = stats.totalEvents
      ? Number(((stats.closedEvents / stats.totalEvents) * 100).toFixed(2))
      : 0;
  }
  logWith(logger, `事件表统计完成: 事件数 ${stats.totalEvents} 起，严重 ${stats.severeEvents} 起，高危 ${stats.highEvents} 起，涉及到的资产数 ${stats.uniqueAssetCount} 个，已闭环 ${stats.closedEvents} 起，处置中 ${stats.processingEvents} 起，闭环率 ${stats.closeRate}%`);
  return stats;
}

async function summarizeExportedAssetStatus(tableExports, logger) {
  const assetFilePath = tableExports && tableExports.asset ? tableExports.asset.filePath : '';
  if (!assetFilePath) {
    return null;
  }

  logWith(logger, `开始统计资产表: ${assetFilePath}`);
  const stats = await summarizeAssetTable(assetFilePath);
  const getCount = (name) => {
    const item = Array.isArray(stats && stats.typeDistribution)
      ? stats.typeDistribution.find((entry) => entry && entry.name === name)
      : null;
    return item ? Number(item.value || 0) : 0;
  };
  logWith(
    logger,
    `资产表统计完成: 资产总数 ${stats.assetTotal} 个，服务器 ${getCount('服务器')} 个，终端 ${getCount('终端')} 个，暴露资产 ${Number(stats.internetExposureTotal || 0)} 个`
  );
  return stats;
}

function parseXdrTables(value) {
  const raw = value || 'asset,incident';
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function writeJsonFile(filePath, data) {
  const resolvedPath = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, JSON.stringify(data, null, 2), 'utf8');
}

async function createRunExportWorkspace(root, generatedAt, logger) {
  const exportRoot = require('./src/workdir').getTmpExportDir();
  await fs.mkdir(exportRoot, { recursive: true });

  const entries = await fs.readdir(exportRoot, { withFileTypes: true });
  const staleWorkspaces = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('run-'))
    .map((entry) => path.join(exportRoot, entry.name));
  await Promise.all(staleWorkspaces.map((workspace) => fs.rm(workspace, { recursive: true, force: true })));
  if (staleWorkspaces.length) {
    logger(`Cleaned interrupted export workspaces: ${staleWorkspaces.length}`);
  }

  const timestamp = generatedAt.toISOString().replace(/[:.]/g, '-');
  const workspace = path.join(exportRoot, `run-${timestamp}-${process.pid}`);
  await fs.mkdir(workspace, { recursive: true });
  return workspace;
}

// 各风险清单表归档前的统一后处理：
// - asset：删除第 1 空行，让表头上移到第 1 行
// - 各表（exposure 除外）：把表头样式统一为暴露面清单样式（微软雅黑10加粗 + 浅蓝底 + 居中 + thin边框）
// 处理结果写入临时文件，再 move 到归档目录；失败不阻断归档，源文件原样归档。
const UNIFY_RISK_HEADER_TABLE_TYPES = {
  incidentPath: 'incident',
  assetPath: 'asset',
  exposurePath: 'exposure',
  weakpwdPath: 'weakpwd',
  vulnPath: 'vuln',
  policyCheckPath: 'policy'
};

async function archiveRiskListFiles(options) {
  const riskListDir = path.join(options.outputDir || options.root, 'report', '风险清单');
  await fs.mkdir(riskListDir, { recursive: true });

  const mappings = [
    ['incidentPath', '安全事件清单.xlsx'],
    ['assetPath', '资产清单.xlsx'],
    ['exposurePath', '暴露面清单.xlsx'],
    ['weakpwdPath', '弱口令清单.xlsx'],
    ['vulnPath', '漏洞清单.xlsx'],
    ['policyCheckPath', '策略检查清单.xlsx']
  ];
  const archived = {};

  for (const [key, filename] of mappings) {
    const sourcePath = options[key];
    if (!sourcePath) {
      throw new Error(`归档风险清单失败: 缺少 ${key}`);
    }

    const tableType = UNIFY_RISK_HEADER_TABLE_TYPES[key];
    const readyPath = await prepareRiskListTable(tableType, sourcePath, riskListDir, options.logger);
    const targetPath = path.join(riskListDir, filename);
    archived[key] = await moveOrReplaceFile(readyPath, targetPath);
    logWith(options.logger, `风险清单已归档: ${archived[key]}`);
  }

  return archived;
}

// 归档前对单张表执行统一后处理（删除资产表首空行 + 统一表头样式）。
// 处理成功返回处理后的文件路径；失败返回源文件路径（不阻断归档）。
async function prepareRiskListTable(tableType, sourcePath, workDir, logger) {
  if (!tableType) {
    return sourcePath;
  }

  // 暴露面表不需要统一表头，但仍须先复制到归档工作目录，避免归档 move 删除输入文件。
  if (tableType === 'exposure') {
    const archiveCopyPath = path.join(workDir, `.archive-${path.basename(sourcePath)}`);
    await fs.copyFile(sourcePath, archiveCopyPath);
    return archiveCopyPath;
  }

  const scriptPath = path.join(__dirname, 'scripts', 'unify_risk_list_headers.py');
  const unifyOutPath = path.join(workDir, `.unify-${path.basename(sourcePath)}`);
  try {
    await execPythonWithArgs(scriptPath, [tableType, sourcePath, unifyOutPath]);
    logWith(logger, `风险清单表头已统一: ${tableType} -> ${unifyOutPath}`);
    return unifyOutPath;
  } catch (error) {
    logWith(logger, `风险清单表头统一失败（不影响归档，使用源文件）: ${tableType} ${error.message}`);
    return sourcePath;
  }
}

// 执行 Python 脚本并等待退出，失败抛错
function execPythonWithArgs(scriptPath, args) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    execFile(require('./src/python').pythonCommand(), [scriptPath, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function moveOrReplaceFile(sourcePath, targetPath) {
  const resolvedSource = path.resolve(sourcePath);
  const resolvedTarget = path.resolve(targetPath);
  if (samePath(resolvedSource, resolvedTarget)) {
    return resolvedTarget;
  }

  await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });
  await fs.rm(resolvedTarget, { force: true });

  try {
    await fs.rename(resolvedSource, resolvedTarget);
  } catch (error) {
    if (!isCrossDeviceError(error)) {
      throw error;
    }
    await fs.copyFile(resolvedSource, resolvedTarget);
    await fs.rm(resolvedSource, { force: true });
  }

  return resolvedTarget;
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isCrossDeviceError(error) {
  return Boolean(error) && (error.code === 'EXDEV' || error.code === 'EPERM');
}

function isExcelBeautificationEnabled(options) {
  const value = options['beautify-excel'];
  return value !== false && String(value || '').toLowerCase() !== 'false';
}

async function beautifyArchivedRiskLists(reportDir, logger) {
  const riskListDir = path.join(reportDir, '风险清单');
  const filenames = [
    '安全事件清单.xlsx',
    '资产清单.xlsx',
    '暴露面清单.xlsx',
    '弱口令清单.xlsx',
    '漏洞清单.xlsx',
    '策略检查清单.xlsx'
  ];
  const scriptPath = path.join(__dirname, 'excel-beautifier', 'scripts', 'cli.py');

  try {
    await fs.access(scriptPath);
  } catch (_) {
    logWith(logger, `Excel 美化工具不存在，跳过: ${scriptPath}`);
    return;
  }

  for (let index = 0; index < filenames.length; index += 1) {
    const filename = filenames[index];
    const sourcePath = path.join(riskListDir, filename);
    const temporaryPath = path.join(riskListDir, `.${filename}.beautifying-${process.pid}-${index}.xlsx`);
    try {
      await fs.access(sourcePath);
      await execPythonWithArgs(scriptPath, [
        'style',
        sourcePath,
        '--theme',
        'classic',
        '--output',
        temporaryPath
      ]);
      await moveOrReplaceFile(temporaryPath, sourcePath);
      logWith(logger, `风险清单 Excel 已美化: ${sourcePath}`);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      logWith(logger, `风险清单 Excel 美化失败，保留原文件: ${sourcePath}; ${error.message}`);
    }
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 跨平台打包目录为 zip（纯 Node 实现，无外部依赖）。
 *
 * 原实现调用 powershell Compress-Archive，仅 Windows 可用；muad 运行环境为 Linux，
 * 无 powershell 导致 spawn ENOENT。故改为用 node:zlib + 手写 ZIP 结构，
 * 在 Windows / Linux / mac 均可用。
 */
async function zipDirectory(sourceDir, logger, zipBaseName) {
  const resolvedSource = path.resolve(sourceDir);
  try {
    await fs.stat(resolvedSource);
  } catch (_) {
    logWith(logger, `ZIP 跳过: 目录不存在 ${resolvedSource}`);
    return null;
  }

  // ZIP 文件名严格采用中文报表基名（如 「【深信服】安全体检报告-<客户>-<时间>.zip」）；
  // 未提供时回退到目录 basename，保证产物名称始终符合中文命名要求。
  const parentDir = path.dirname(resolvedSource);
  const baseName = (zipBaseName && String(zipBaseName).trim())
    ? String(zipBaseName).trim()
    : path.basename(resolvedSource);
  const zipPath = path.join(parentDir, `${baseName}.zip`);

  // 删除已有的同名 zip
  await fs.rm(zipPath, { force: true });

  const zlib = require('zlib');
  const { deflateRawSync } = zlib;

  // CRC32 自实现（不依赖 Node 20+ 才提供的 zlib.crc32，保证 node>=18 兼容）
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...await walk(abs));
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
    return out;
  };

  const files = await walk(resolvedSource);

  const chunks = [];
  let offset = 0;
  const central = [];

  for (const abs of files) {
    // zip 内使用相对路径，统一正斜杠
    const rel = path.relative(resolvedSource, abs).split(path.sep).join('/');
    const data = await fs.readFile(abs);
    const crc = crc32(data) >>> 0;
    const compressed = deflateRawSync(data);
    const method = 8; // deflate
    const dosTime = 0;
    const dosDate = 0x21; // 1980-01-01

    // local file header
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);            // version needed
    lfh.writeUInt16LE(0x0800, 6);        // flags: UTF-8
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(Buffer.byteLength(rel), 26);
    lfh.writeUInt16LE(0, 28);            // extra len

    chunks.push(lfh, Buffer.from(rel, 'utf8'), compressed);

    central.push({
      rel,
      crc,
      compressedSize: compressed.length,
      uncompressedSize: data.length,
      localHeaderOffset: offset,
    });
    offset += 30 + Buffer.byteLength(rel) + compressed.length;
  }

  const centralOffset = offset;
  for (const rec of central) {
    const name = Buffer.from(rec.rel, 'utf8');
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);    // central dir signature
    cdh.writeUInt16LE(20, 4);            // version made by
    cdh.writeUInt16LE(20, 6);            // version needed
    cdh.writeUInt16LE(0x0800, 8);        // flags: UTF-8
    cdh.writeUInt16LE(8, 10);            // method
    cdh.writeUInt16LE(0, 12);            // dos time
    cdh.writeUInt16LE(0x21, 14);         // dos date
    cdh.writeUInt32LE(rec.crc, 16);
    cdh.writeUInt32LE(rec.compressedSize, 20);
    cdh.writeUInt32LE(rec.uncompressedSize, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt16LE(0, 30);            // extra len
    cdh.writeUInt16LE(0, 32);            // comment len
    cdh.writeUInt16LE(0, 34);            // disk number
    cdh.writeUInt16LE(0, 36);            // internal attrs
    cdh.writeUInt32LE(0, 38);            // external attrs
    cdh.writeUInt32LE(rec.localHeaderOffset, 42);
    chunks.push(cdh, name);
    offset += 46 + name.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);     // EOCD signature
  eocd.writeUInt16LE(0, 4);              // disk number
  eocd.writeUInt16LE(0, 6);              // disk with cd
  eocd.writeUInt16LE(central.length, 8); // entries on disk
  eocd.writeUInt16LE(central.length, 10);// total entries
  eocd.writeUInt32LE(offset - centralOffset, 12); // cd size (note: absolute offset difference)
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);             // comment len
  chunks.push(eocd);

  const buf = Buffer.concat(chunks);
  await fs.writeFile(zipPath, buf);
  logWith(logger, `ZIP 已打包: ${zipPath} (${files.length} 个文件)`);
  return zipPath;
}

async function publishZipToOutbound(zipPath, deliveryId, logger) {
  if (!zipPath || !deliveryId) return null;
  const safeDeliveryId = String(deliveryId).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(safeDeliveryId)) {
    throw new Error('Invalid --delivery-id: only letters, numbers, underscores, and hyphens are allowed.');
  }

  const targetDir = path.join(os.homedir(), '.openclaw', 'media', 'outbound', safeDeliveryId);
  const targetPath = path.join(targetDir, path.basename(zipPath));
  const temporaryPath = `${targetPath}.uploading`;
  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(zipPath, temporaryPath);
  await fs.rename(temporaryPath, targetPath);
  logWith(logger, `ZIP 已投递到企微 outbound: ${targetPath}`);
  return targetPath;
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const MAX_QUERY_DAY_SPAN = 30;

function computeDaySpan(startStr, endStr) {
  const startMatch = String(startStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const endMatch = String(endStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!startMatch || !endMatch) return null;
  const startDate = new Date(+startMatch[1], +startMatch[2] - 1, +startMatch[3]);
  const endDate = new Date(+endMatch[1], +endMatch[2] - 1, +endMatch[3]);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((endDate.getTime() - startDate.getTime()) / msPerDay) + 1;
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function subtractDays(dateStr, days) {
  const match = String(dateStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(+match[1], +match[2] - 1, +match[3]);
  date.setDate(date.getDate() - days);
  return formatDate(date);
}

async function resolveEffectiveTimeRange({ options, customerId, msswCookie, reportGeneratedAt, logger }) {
  const hasStart = options.start !== undefined && options.start !== null && String(options.start).trim() !== '';
  const hasEnd = options.end !== undefined && options.end !== null && String(options.end).trim() !== '';

  if (hasStart !== hasEnd) {
    throw new Error('时间参数必须同时传入 --start 和 --end，或两者都不传');
  }

  // 对用户传入的原始时间先做校验：格式、start≤end、end 不晚于今天
  // 必须放在服务范围 clamp 之前，否则未来日期会被静默截断而不是明确报错
  if (hasStart && hasEnd) {
    validateDateRange(String(options.start).trim(), String(options.end).trim());
  }

  // 每次都要查接口拿服务起止时间
  let serviceTimeRange = null;
  const canFetchEicvres = Boolean(options['mssw-cookie-path'] && customerId);

  if (canFetchEicvres) {
    try {
      const resolvedCookie = msswCookie || await readMsswCookieInfo(options['mssw-cookie-path']);
      serviceTimeRange = await fetchDefaultProjectTimeRange(
        resolvedCookie,
        options['mssw-base-url'],
        customerId,
        reportGeneratedAt
      );
      logger(`服务时间范围: ${serviceTimeRange.start} ~ ${serviceTimeRange.end}`);
    } catch (error) {
      throw new Error(`该客户无有效 MSSW 服务授权，无法生成报告（${error.message}）`);
    }
  }

  if (hasStart && hasEnd) {
    let effectiveStart = String(options.start).trim();
    let effectiveEnd = String(options.end).trim();

    if (serviceTimeRange) {
      const userStart = parseLocalDate(effectiveStart, false);
      const serviceStart = parseLocalDate(serviceTimeRange.start, false);
      const userEnd = parseLocalDate(effectiveEnd, true);
      const serviceEnd = parseLocalDate(serviceTimeRange.end, true);

      // 用户范围与服务范围完全没有交集
      if (userStart !== null && userEnd !== null && serviceStart !== null && serviceEnd !== null) {
        if (userEnd < serviceStart || userStart > serviceEnd) {
          throw new Error(
            `您指定的时间范围 ${String(options.start).trim()} ~ ${String(options.end).trim()} 与服务覆盖范围 ` +
            `${serviceTimeRange.start} ~ ${serviceTimeRange.end} 没有交集，请调整后重试`
          );
        }
      }

      // 起始时间早于服务开始时间 → 取服务开始时间
      if (userStart !== null && serviceStart !== null && userStart < serviceStart) {
        effectiveStart = serviceTimeRange.start;
        logger(`用户起始时间 ${options.start} 早于服务开始时间 ${serviceTimeRange.start}，已自动调整`);
      }

      // 结束时间晚于服务结束时间 → 取服务结束时间
      if (userEnd !== null && serviceEnd !== null && userEnd > serviceEnd) {
        effectiveEnd = serviceTimeRange.end;
        logger(`用户结束时间 ${options.end} 晚于服务结束时间 ${serviceTimeRange.end}，已自动调整`);
      }
    }

    const daySpan = computeDaySpan(effectiveStart, effectiveEnd);
    if (daySpan !== null && daySpan > MAX_QUERY_DAY_SPAN) {
      throw new Error(`查询时间范围不能超过 ${MAX_QUERY_DAY_SPAN} 天（当前 ${daySpan} 天），请缩小范围后重新输入`);
    }

    validateDateRange(effectiveStart, effectiveEnd);
    const clamped = effectiveStart !== String(options.start).trim() || effectiveEnd !== String(options.end).trim();
    logger(`最终时间范围: ${effectiveStart} ~ ${effectiveEnd}`);
    return {
      start: effectiveStart,
      end: effectiveEnd,
      source: clamped ? 'cli-clamped' : 'cli'
    };
  }

  // 用户未传时间，使用接口返回的服务时间范围
  if (!serviceTimeRange) {
    throw new Error('未传 --start/--end 时，需要提供 --mssw-cookie-path 和有效的 company_id 以自动推导默认时间范围');
  }

  // 最多只取最近 30 天：start 不能早于 end-29 天
  const daySpan = computeDaySpan(serviceTimeRange.start, serviceTimeRange.end);
  if (daySpan !== null && daySpan > MAX_QUERY_DAY_SPAN) {
    const cappedStart = subtractDays(serviceTimeRange.end, MAX_QUERY_DAY_SPAN - 1);
    if (cappedStart) {
      logger(`服务时间范围 ${serviceTimeRange.start} ~ ${serviceTimeRange.end} 超过 ${MAX_QUERY_DAY_SPAN} 天，自动截取最近 ${MAX_QUERY_DAY_SPAN} 天: ${cappedStart} ~ ${serviceTimeRange.end}`);
      serviceTimeRange.start = cappedStart;
    }
  }

  validateDateRange(serviceTimeRange.start, serviceTimeRange.end);
  logger(`最终时间范围: ${serviceTimeRange.start} ~ ${serviceTimeRange.end}`);
  return {
    ...serviceTimeRange,
    source: 'mssw-project-service'
  };
}

function validateDateRange(start, end) {
  const begin = parseLocalDate(start, false);
  const finish = parseLocalDate(end, true);

  if (!begin || !finish) {
    throw new Error('时间参数无效，请使用 YYYY-MM-DD');
  }
  if (begin > finish) {
    throw new Error('时间范围无效: --start 不能晚于 --end');
  }
  // --end 不能晚于今天（按天比较：end 当天 00:00 若晚于今天 00:00 则视为未来）
  const endDayStart = parseLocalDate(end, false);
  const todayStart = Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000);
  if (endDayStart > todayStart) {
    throw new Error('时间范围无效: --end 不能晚于今天');
  }
}

async function mergeJsonFile(filePath, patch) {
  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const merged = deepMerge(existing, patch);
  delete merged.report;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
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

async function shouldRunPreventionStage(options, tableExports) {
  return Boolean(
    options['cookie-path']
    || (options['mssw-cookie-path'] && await resolveIncidentFilePath(options, tableExports))
  );
}

async function resolveIncidentFilePath(options, tableExports) {
  const exportedPath = tableExports && tableExports.incident ? tableExports.incident.filePath : '';
  if (exportedPath) {
    return exportedPath;
  }

  return findLatestWorkbook(getTmpExportDir(), /incident|事件/i);
}

async function resolveAssetFilePath({ options, tableExports, logger }) {
  const exportedPath = tableExports && tableExports.asset ? tableExports.asset.filePath : '';
  if (exportedPath) {
    return exportedPath;
  }

  const discovered = await findLatestWorkbook(getTmpExportDir(), /asset|资产/i);
  if (discovered) {
    logger(`已从 tmp/exports 自动使用资产表: ${discovered}`);
    return discovered;
  }

  return '';
}

async function findLatestWorkbook(directory, pattern) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isFile() && /\.xlsx$/i.test(entry.name))
      .filter((entry) => pattern.test(entry.name))
      .map((entry) => path.join(directory, entry.name));

    if (!candidates.length) {
      return '';
    }

    const withStat = await Promise.all(candidates.map(async (filePath) => ({
      filePath,
      stat: await fs.stat(filePath)
    })));
    withStat.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    return withStat[0].filePath;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
