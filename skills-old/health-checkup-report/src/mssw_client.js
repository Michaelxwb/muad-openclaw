'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const https = require('https');
const http = require('http');
const path = require('path');

const { encodePath } = require('./path_helper');
const { pagedExportMsswAssetList } = require('./mssw_asset_paged_export');
const {
  removeIncidentRows,
  parseIncidentGptStats,
  extractIncidentDirectStats,
  extractIncidentAssetInfo,
  extractC2ConnectionExamples,
  extractVirusTrojanExamples,
  extractCaseStudyCandidates
} = require('./incident_excel_stats');

const DEFAULT_MSSW_BASE_URL = normalizeBaseUrl('mssw.sangfor.com.cn');
const DEFAULT_SOAR_BASE_URL = normalizeBaseUrl(process.env.SANGFOR_SOAR_BASE_URL || 'soar.sangfor.com.cn');
const ALERT_QUERY_ENDPOINT = '/ngsoc/INCIDENT/api/v1/table/query/alertTableQueryHandler?viewRegionId=ffffffffffffffffffffffff&onlySelfPlatform=false';
const ALERT_VIEW_INSTANCE_ID = '67aebe12c29c0b7b63b0c51e';
const ALERT_TABLE_SERVICE_INFO = {
  appName: 'incident',
  servletContextPath: '/',
  serviceType: 'table',
  handler: 'alertTableQueryHandler'
};
const DISPOSAL_TABS_ENDPOINT = '/ngsoc/INCIDENT/api/v1/incidents';
const DEVICE_LIST_ENDPOINT = '/api/apex/device/v1/devices/list?viewRegionId=ffffffffffffffffffffffff&onlySelfPlatform=false';
const THIRD_PARTY_DEVICE_STATS_ENDPOINT = '/api/apex/thirdparty/v1/app/instance/list?viewRegionId=ffffffffffffffffffffffff&onlySelfPlatform=false';
const MSSW_INCIDENT_EXPORT_ENDPOINT = '/gateway/mss-mdr/web/api/mssw/mss-mdr/v1/incidents/export/tasks';
const MSSW_CUSTOMER_STATISTIC_ENDPOINT = '/gateway/customer-mgr-service/order/v1/user/customer_statistic';
const MSSW_PROJECT_LIST_ENDPOINT = '/gateway/customer-mgr-service/order/v1/project/project_list/company_id';
const MSSW_ASSET_EXPORT_FIELDS_ENDPOINT = '/apps/asset/view/asset/export_fields?_method=GET';
const MSSW_ASSET_EXPORT_ENDPOINT = '/apps/asset/view/asset/export';
const MSSW_ASSET_DOWNLOAD_ENDPOINT = '/apps/asset/view/asset/download_file';
const MSSW_ASSET_COUNT_ENDPOINT = '/apps/asset/view/asset/asset_view/count?_method=GET';
const MSSW_INCIDENT_TABLE_ENDPOINT = '/gateway/mss-mdr/web/api/mssw/mss-mdr/v1/incident_table';
const MSSW_LOG_SEARCH_COUNT_ENDPOINT = '/gateway/log-search-center-service/datalake/v1/ckCount';
const SECURITY_CHECK_REPORT_STATS_ENDPOINT = '/gateway/log-search-center-service/datalake/v1/personalized_report/security_check_report_stats';
const ATTCK_COUNT_ENDPOINT = '/ngsoc/INCIDENT/api/v1/incidents/attckCount';
const INCIDENT_TABLE_QUERY_ENDPOINT = '/ngsoc/INCIDENT/api/v1/table/query/incidentTableQueryHandler';
const CASE_STUDY_SEVERITY_ORDER = ['严重', '高危', '中危', '低危'];
const CASE_STUDY_INCIDENT_SERVICE_INFO = {
  appName: 'incident',
  servletContextPath: '/',
  serviceType: 'table',
  handler: 'incidentTableQueryHandler'
};

// devType 到分类名称的映射
const DEVICE_TYPE_CATEGORIES = {
  aes: [12, 37, 100038, 50038, 100012],  // EDR, CWPP, SaaS-EDR-探针版, EDR-探针版, SAAS EDR
  sip: [9],
  af: [3],
  sta: [25]
};

function classifyDeviceType(devType) {
  for (const [category, types] of Object.entries(DEVICE_TYPE_CATEGORIES)) {
    if (types.includes(devType)) {
      return category;
    }
  }
  return 'other';
}

const INCIDENT_EXPORT_FIELDS = [
  ['mssIncidentServiceStatus', true, 150, 'value'],
  ['severity', true, 90, 'value'],
  ['name', true, 252, 'value'],
  ['uuId', true, 280, 'value'],
  ['hostIp', true, 144, 'value'],
  ['connectStatus', true, 100, 'value'],
  ['timeLimit', true, 150, 'value'],
  ['alertNumber', true, 100, 'value'],
  ['dataSources', true, 86, 'array'],
  ['dealStatus', true, 120, 'value'],
  ['gptResult', true, 150, 'value'],
  ['serviceEventId', true, 92, 'value'],
  ['incidentThreatClass', true, 150, 'value'],
  ['incidentThreatType', true, 150, 'value'],
  ['description', true, 320, 'value', 'disable', false],
  ['threatDefine', true, 180, 'array', 'disable', false],
  ['riskTag', true, 200, 'value', 'disable', false],
  ['responsible', true, 150, 'value', 'disable', false],
  ['newestUsername', true, 150, 'value', 'disable', false],
  ['checkOutUsername', true, 150, 'value', 'disable', false],
  ['startTime', true, 160, 'value', 'disable', false],
  ['endTime', true, 160, 'value', 'desc', false],
  ['logTraceInfo', true, 150, 'value', 'disable', false],
  ['devSourceNames', true, 200, 'array', 'disable', false],
  ['incidentSourceProxy', true, 200, 'value', 'disable', false],
  ['eventEngine', true, 150, 'array', 'disable', false],
  ['whiteStatus', true, 150, 'value', 'disable', false],
  ['eventRuleId', true, 92, 'value', 'disable', false],
  ['soarMatchEventTag', true, 150, 'value', 'disable', false],
  ['remarkInfo', true, 150, 'value', 'disable', false],
  ['platformHostBranchId', true, 150, 'value', 'disable', false],
  ['disposeTime', true, 140, 'value', 'disable', false],
  ['suppressTime', true, 140, 'value', 'disable', false],
  ['platformId', true, 150, 'value', 'disable', false],
  ['platformHostGroupIds', true, 150, 'array', 'disable', false],
  ['hostAssetAnalyzeResult', true, 150, 'value', 'disable', false],
  ['hostBranchId', false, 200, 'value', 'notSortable', false],
  ['hostIpAll', false, null, 'value', 'notSortable', false],
  ['uploadTime', false, null, 'value', 'disable', false],
  ['insertTime', false, null, 'value', 'disable', false],
  ['auditTime', false, null, 'value', 'disable', false],
  ['occurTime', false, null, 'value', 'disable', false],
  ['auditLogTraceInfo', false, null, 'value', 'notSortable', false],
  ['devUId', false, null, 'array', 'notSortable', false],
  ['devUIdProxy', false, null, 'array', 'notSortable', false],
  ['xthAttackIntent', false, null, 'value', 'notSortable', false],
  ['dealAction', false, null, 'value', 'notSortable', false],
  ['id', false, null, 'value', 'notSortable', false],
  ['alertIds', false, null, 'array', 'notSortable', false],
  ['hostGroupIds', false, null, 'array', 'notSortable', false],
  ['hostAssetId', false, null, 'value', 'disable', false],
  ['hostCountryName', false, null, 'value', 'notSortable', false],
  ['hostProvinceName', false, null, 'value', 'notSortable', false],
  ['xthType', false, null, 'value', 'notSortable', false],
  ['xthTag', false, null, 'value', 'notSortable', false],
  ['fromXth', false, null, 'value', 'notSortable', false],
  ['auditType', false, null, 'value', 'notSortable', false],
  ['pendingXth', false, null, 'value', 'notSortable', false],
  ['read', false, null, 'value', 'notSortable', false],
  ['xthConfirm', false, null, 'value', 'notSortable', false],
  ['hostClassifyId', false, null, 'value', 'notSortable', false],
  ['hostClassify1Id', false, null, 'value', 'notSortable', false],
  ['dataAuthorityBranchId', false, null, 'value', 'notSortable', false],
  ['huntingIps', false, null, 'array', 'notSortable', false],
  ['huntingDomains', false, null, 'array', 'notSortable', false],
  ['huntingMD5s', false, null, 'array', 'notSortable', false],
  ['isAutoDispose', false, null, 'value', 'notSortable', false],
  ['phishing', false, null, 'value', 'notSortable', false],
  ['xthExpert', false, null, 'value', 'notSortable', false],
  ['auditFrom', false, null, 'array', 'notSortable', false],
  ['regionId', false, null, 'value', 'notSortable', false],
  ['mssTagType', false, null, 'value', 'notSortable', false],
  ['attackState', false, null, 'value', 'notSortable', false],
  ['platformRole', false, null, 'value', 'notSortable', false],
  ['platformIsDelete', false, null, 'value', 'notSortable', false],
  ['pendingDisableFlag', false, null, 'value', 'notSortable', false],
  ['disposingDisableFlag', false, null, 'value', 'notSortable', false],
  ['disposedDisableFlag', false, null, 'value', 'notSortable', false],
  ['ignoreDisableFlag', false, null, 'value', 'notSortable', false],
  ['hungupDisableFlag', false, null, 'value', 'notSortable', false],
  ['addWhiteDisableFlag', false, null, 'value', 'notSortable', false],
  ['orderDisableFlag', false, null, 'value', 'notSortable', false]
];

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/^\./, '');
  if (!raw) return '';

  const withScheme = raw.includes('://') ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).hostname;
  } catch (error) {
    return raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  }
}

function normalizeAbsoluteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).toString().replace(/\/$/, '');
  } catch (error) {
    return '';
  }
}

function cookiePairsToString(pairs) {
  return pairs
    .filter((item) => item && item.name && item.value !== undefined)
    .map((item) => `${item.name}=${item.value}`)
    .join('; ');
}

function inferXdrBaseUrlFromCookiePairs(pairs) {
  if (!Array.isArray(pairs)) return '';

  const matched = pairs
    .map((item) => normalizeBaseUrl(item && item.domain ? item.domain : ''))
    .find((domain) => /^xdr[a-z0-9-]*\.sangfor\.com\.cn$/i.test(domain));

  return matched || '';
}

function inferXdrBaseUrlsFromText(text) {
  const matches = String(text || '').match(/\.?xdr[a-z0-9-]*\.sangfor\.com\.cn/ig) || [];
  return unique(matches.map((item) => normalizeBaseUrl(item)));
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function logInfo(logger, message) {
  if (typeof logger === 'function') {
    logger(message);
  }
}

function parseCookieString(cookieString) {
  const cookies = {};

  String(cookieString || '')
    .split(';')
    .forEach((cookie) => {
      const [name, ...valueParts] = cookie.trim().split('=');
      if (!name) return;
      cookies[name.trim()] = valueParts.join('=').trim();
    });

  return cookies;
}

function extractCsrfToken(cookieString) {
  const cookies = parseCookieString(cookieString);
  const tokenKeys = ['csrf_token', 'x-csrf-token', 'X-Csrftoken', 'csrftoken', '_csrf'];

  for (const key of tokenKeys) {
    if (cookies[key]) {
      return cookies[key];
    }
  }

  throw new Error('无法从 XDR Cookie 中找到 x-csrf-token');
}

function normalizeCookieContent(rawContent) {
  const content = String(rawContent || '').trim();
  if (!content) {
    throw new Error('XDR Cookie 文件内容为空');
  }

  if (content.startsWith('{') || content.startsWith('[')) {
    const parsed = JSON.parse(content);

    if (Array.isArray(parsed)) {
      return {
        cookieString: cookiePairsToString(parsed),
        csrfToken: null,
        xdrBaseUrl: inferXdrBaseUrlFromCookiePairs(parsed),
        alertQueryBaseUrl: ''
      };
    }

    const cookieString = parsed.cookie || parsed.cookieString || parsed.Cookie || parsed.cookiesText;
    const xdrBaseUrl = normalizeBaseUrl(parsed.xdrBaseUrl || parsed.baseUrl || parsed.domain);
    const alertQueryBaseUrl = normalizeAbsoluteUrl(
      parsed.alertQueryBaseUrl || parsed.alertBaseUrl || parsed.alert_table_base_url || parsed.alertQueryUrlBase
    );
    if (typeof cookieString === 'string' && cookieString.trim()) {
      return {
        cookieString: cookieString.trim(),
        csrfToken: parsed.csrfToken || parsed.xCsrftoken || parsed['x-csrf-token'] || null,
        xdrBaseUrl,
        alertQueryBaseUrl
      };
    }

    if (Array.isArray(parsed.cookies)) {
      return {
        cookieString: cookiePairsToString(parsed.cookies),
        csrfToken: parsed.csrfToken || parsed.xCsrftoken || parsed['x-csrf-token'] || null,
        xdrBaseUrl: xdrBaseUrl || inferXdrBaseUrlFromCookiePairs(parsed.cookies),
        alertQueryBaseUrl
      };
    }

    throw new Error('无法识别 XDR Cookie 的 JSON 格式');
  }

  return {
    cookieString: content,
    csrfToken: null,
    xdrBaseUrl: '',
    alertQueryBaseUrl: ''
  };
}

async function readXdrCookieInfo(cookiePath) {
  if (!cookiePath) {
    throw new Error('Real mode requires --xdr-cookie-path');
  }

  const resolvedPath = await resolveCookiePath(cookiePath);
  const rawContent = await fsp.readFile(resolvedPath, 'utf8');
  const normalized = normalizeCookieContent(rawContent);
  const cookieString = normalized.cookieString;

  return {
    resolvedPath,
    rawContent,
    cookieString,
    csrfToken: normalized.csrfToken || extractCsrfToken(cookieString),
    xdrBaseUrl: normalized.xdrBaseUrl || '',
    alertQueryBaseUrl: normalized.alertQueryBaseUrl || '',
    xdrBaseUrlCandidates: unique([
      normalized.xdrBaseUrl,
      ...inferXdrBaseUrlsFromText(rawContent)
    ]),
    cookies: parseCookieString(cookieString)
  };
}

async function resolveCookiePath(cookiePath) {
  const stat = await fsp.stat(cookiePath);
  if (stat.isFile()) {
    return cookiePath;
  }

  const candidates = await fsp.readdir(cookiePath, { withFileTypes: true });
  const files = candidates
    .filter((entry) => entry.isFile() && /\.(txt|json|cookie|cookies)$/i.test(entry.name))
    .map((entry) => path.join(cookiePath, entry.name));

  if (!files.length) {
    throw new Error(`XDR Cookie 目录中没有找到 txt/json/cookie 文件: ${cookiePath}`);
  }

  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

async function requestJson(url, { headers, body, timeout }) {
  const parsedUrl = new URL(url);
  const transport = parsedUrl.protocol === 'http:' ? http : https;
  const timeoutMs = Number(timeout) || 30000;

  return new Promise((resolve, reject) => {
    const req = transport.request(parsedUrl, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      rejectUnauthorized: false
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (error) {
          parsed = text;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`XDR 请求失败 ${res.statusCode}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed).slice(0, 500)}`));
          return;
        }

        resolve(parsed);
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`XDR 请求超时: ${url}`));
    });

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

async function requestBuffer(url, { headers }) {
  const parsedUrl = new URL(url);
  const transport = parsedUrl.protocol === 'http:' ? http : https;

  return new Promise((resolve, reject) => {
    const req = transport.request(parsedUrl, {
      method: 'GET',
      headers,
      rejectUnauthorized: false
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`XDR 下载失败 ${res.statusCode}: ${buffer.toString('utf8').slice(0, 500)}`));
          return;
        }
        resolve({
          buffer,
          headers: res.headers,
          statusCode: res.statusCode
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error(`XDR 下载请求超时: ${url}`));
    });
    req.end();
  });
}

function assertXdrApiSuccess(response, label) {
  if (!response || typeof response !== 'object') {
    throw new Error(`${label} 返回异常: ${JSON.stringify(response).slice(0, 500)}`);
  }

  const code = response.code;
  const message = String(response.message || response.msg || '').trim();

  if (code === 401 || message === 'session.expired') {
    throw new Error(`${label} 会话已过期，请重新登录后刷新 xdr_cookies.txt`);
  }
}

function buildExportFieldsRequestBody() {
  return {};
}

function buildAssetExportRequestBody(exportFields) {
  return {
    branch_id: 'all',
    search_type: 'current',
    is_all: false,
    ids: [],
    exclude_ids: [],
    export_fields: exportFields
  };
}

function buildAlertTableFields() {
  // Each entry: [field, show, selected, sort, columnWidth, fixed, dataType]
  var fields = [
    ['lastTime', true, true, 'desc', 130, null, 'value'],
    ['name', true, true, 'disable', 200, null, 'value'],
    ['operationLabels', true, true, 'disable', 330, null, 'array'],
    ['severity', true, true, 'disable', 85, null, 'value'],
    ['threatDefine', true, true, 'disable', 95, null, 'array'],
    ['similarRuleId', true, true, 'disable', 100, null, 'value'],
    ['whiteListIds', true, true, 'disable', 150, null, 'array'],
    ['srcIp', true, true, 'disable', 125, null, 'array'],
    ['dstIp', true, true, 'disable', 125, null, 'array'],
    ['hostIp', true, true, 'disable', 145, null, 'value'],
    ['attackResult', true, true, 'disable', 105, null, 'value'],
    ['accessDirection', true, true, 'disable', 110, null, 'value'],
    ['trafficForwardLocation', true, true, 'disable', 200, null, 'array'],
    ['newestUsername', true, false, 'disable', 150, null, 'value'],
    ['checkOutUsername', true, false, 'disable', 150, null, 'value'],
    ['responsible', true, false, 'disable', 80, null, 'value'],
    ['uuId', true, false, 'disable', 300, null, 'value'],
    ['riskTag', true, false, 'disable', 180, null, 'value'],
    ['similarId', true, false, 'disable', 100, null, 'value'],
    ['requestHead', true, false, 'disable', 150, null, 'value'],
    ['responseHead', true, false, 'disable', 150, null, 'value'],
    ['requestBody', true, false, 'disable', 150, null, 'value'],
    ['responseBody', true, false, 'disable', 150, null, 'value'],
    ['confidence', true, false, 'disable', 110, null, 'value'],
    ['stage', true, false, 'disable', 100, null, 'value'],
    ['natTransform', true, false, 'disable', 150, null, 'value'],
    ['srcPort', true, false, 'disable', 110, null, 'array'],
    ['dstPort', true, false, 'disable', 110, null, 'array'],
    ['platformHostBranchId', true, false, 'disable', 150, null, 'value'],
    ['platformHostGroupIds', true, false, 'disable', 150, null, 'array'],
    ['whiteStatus', true, false, 'disable', 100, null, 'value'],
    ['engineName', true, false, 'disable', 140, null, 'array'],
    ['virusName', true, false, 'disable', 140, null, 'array'],
    ['xForwardedFor', true, false, 'disable', 125, null, 'array'],
    ['threatClass', true, false, 'disable', 150, null, 'value'],
    ['threatTypeProxy', true, false, 'disable', 150, null, 'value'],
    ['threatSubTypeProxy', true, false, 'disable', 150, null, 'value'],
    ['respStatus', true, false, 'disable', 110, null, 'value'],
    ['attckTechnique', true, false, 'disable', 150, null, 'array'],
    ['attckSubTechnique', true, false, 'disable', 150, null, 'array'],
    ['fileMd5', true, false, 'disable', 180, null, 'array'],
    ['url', true, false, 'disable', 200, null, 'array'],
    ['domain', true, false, 'disable', 125, null, 'array'],
    ['cveId', true, false, 'disable', 180, null, 'value'],
    ['pName', true, false, 'disable', 180, null, 'array'],
    ['firstTime', true, false, 'disable', 136, null, 'value'],
    ['logTraceInfo', true, false, 'disable', 150, null, 'value'],
    ['incidentRelated', true, false, 'disable', 150, null, 'value'],
    ['devUId', true, false, 'disable', 150, null, 'array'],
    ['devUIdProxy', true, false, 'disable', 120, null, 'array'],
    ['devSourceNames', true, false, 'disable', 180, null, 'array'],
    ['dealStatus', true, false, 'disable', 126, null, 'value'],
    ['disposeTime', true, false, 'disable', 140, null, 'value'],
    ['dealAction', true, false, 'disable', 132, null, 'value'],
    ['mssStatus', true, false, 'disable', 150, null, 'value'],
    ['platformId', true, false, 'disable', 110, null, 'value'],
    ['gptResult', true, false, 'disable', 150, null, 'value'],
    ['gptStartAt', true, false, 'disable', 150, null, 'value'],
    ['gptEndAt', true, false, 'disable', 150, null, 'value'],
    ['gptAnalyzeTime', true, false, 'disable', 150, null, 'value'],
    ['gptSubResult', true, false, 'disable', 150, null, 'value'],
    ['incidentRootIds', true, false, 'disable', 150, null, 'array'],
    ['xUserName', true, false, 'disable', 150, null, 'value'],
    ['xUserGroup', true, false, 'disable', 150, null, 'value'],
    ['hostAssetAnalyzeResult', true, false, 'disable', 150, null, 'value'],
    ['platformIdAndGroupId', true, false, 'disable', 120, null, 'value'],
    ['gptRuleUid', true, false, 'disable', 150, null, 'value'],
    ['aiRuleIds', true, false, 'disable', 150, null, 'array'],
    // show: false fields
    ['proofType', false, false, 'notSortable', null, null, 'array'],
    ['hostBranchId', false, false, 'disable', null, null, 'value'],
    ['hostGroupIds', false, false, 'notSortable', null, null, 'array'],
    ['logType', false, false, 'notSortable', null, null, 'value'],
    ['vulnName', false, false, 'notSortable', null, null, 'array'],
    ['username', false, false, 'notSortable', null, null, 'array'],
    ['read', false, false, 'notSortable', null, null, 'value'],
    ['fusionAlert', false, false, 'notSortable', null, null, 'value'],
    ['uploadTime', false, false, 'disable', null, null, 'value'],
    ['insertTime', false, false, 'disable', null, null, 'value'],
    ['ndrSecdetectBreachMid', false, false, 'notSortable', null, null, 'value'],
    ['occurTime', false, false, 'disable', null, null, 'value'],
    ['hostClassifyId', false, false, 'notSortable', null, null, 'value'],
    ['hostClassify1Id', false, false, 'notSortable', null, null, 'value'],
    ['srcIpInfos', false, false, 'notSortable', null, null, 'array'],
    ['dstIpInfos', false, false, 'notSortable', null, null, 'array'],
    ['pendingDisableFlag', false, false, 'notSortable', null, null, 'value'],
    ['disposingDisableFlag', false, false, 'notSortable', null, null, 'value'],
    ['disposedDisableFlag', false, false, 'notSortable', null, null, 'value'],
    ['ignoreDisableFlag', false, false, 'notSortable', null, null, 'value'],
    ['misReportDisableFlag', false, false, 'notSortable', null, null, 'value'],
    ['customAlertGenerateIncidentDisableFlag', false, false, 'notSortable', null, null, 'value'],
    ['gptResultStrategyDisableFlag', false, false, 'notSortable', null, null, 'value'],
    ['banIpDisableFlag', false, false, 'notSortable', null, null, 'value'],
    ['addWhiteDisableFlag', false, false, 'notSortable', null, null, 'value'],
    ['statusChangeDisableFlag', false, false, 'notSortable', null, null, 'value'],
    ['orderDisableFlag', false, false, 'notSortable', null, null, 'value'],
    ['quarantineHostDisableFlag', false, false, 'notSortable', null, null, 'value'],
    ['disposeFileDisableFlag', false, false, 'notSortable', null, null, 'value'],
    ['trustFileDisableFlag', false, false, 'notSortable', null, null, 'value'],
    ['hostAssetId', false, false, 'notSortable', null, null, 'value'],
    ['hostCountryName', false, false, 'notSortable', null, null, 'value'],
    ['hostProvinceName', false, false, 'notSortable', null, null, 'value'],
    ['ioaRuleRelated', false, false, 'notSortable', null, null, 'value'],
    ['ruleIds', false, false, 'notSortable', null, null, 'array'],
    ['alertRuleId', false, false, 'notSortable', null, null, 'value'],
    ['huntingIps', false, false, 'notSortable', null, null, 'array'],
    ['huntingDomains', false, false, 'notSortable', null, null, 'array'],
    ['huntingMD5s', false, false, 'notSortable', null, null, 'array'],
    ['suspectedMisReport', false, false, 'notSortable', null, null, 'value'],
    ['devices', false, false, 'notSortable', null, null, 'array'],
    ['combineType', false, false, 'notSortable', null, null, 'value'],
    ['regionId', false, false, 'notSortable', null, null, 'value'],
    ['disposalRecord', false, false, 'notSortable', null, null, 'value'],
    ['gptRespAction', false, false, 'disable', null, null, 'value'],
    ['gptAction', false, false, 'notSortable', null, null, 'value'],
    ['gptEngineList', false, false, 'notSortable', null, null, 'array'],
    ['platformRole', false, false, 'notSortable', null, null, 'value'],
    ['platformIsDelete', false, false, 'notSortable', null, null, 'value'],
    ['srcAssetAnalyzeResultsStatus', false, false, 'notSortable', null, null, 'value'],
    ['srcAssetAnalyzeResults', false, false, 'notSortable', null, null, 'value'],
    ['hostAddress', false, false, 'notSortable', null, null, 'value'],
    ['smtpFrom', false, false, 'notSortable', null, null, 'value'],
    ['userAgent', false, false, 'notSortable', null, null, 'value'],
    ['reqCookie', false, false, 'notSortable', null, null, 'value'],
    ['dnsQueries', false, false, 'notSortable', null, null, 'value'],
    ['dnsAnswers', false, false, 'notSortable', null, null, 'value'],
    ['redisCommandCall', false, false, 'notSortable', null, null, 'value'],
    ['redisLogin', false, false, 'notSortable', null, null, 'value'],
    ['redisPassword', false, false, 'notSortable', null, null, 'value'],
    ['webmailUser', false, false, 'notSortable', null, null, 'value'],
    ['webmailFrom', false, false, 'notSortable', null, null, 'value'],
    ['webmailTo', false, false, 'notSortable', null, null, 'value'],
    ['mysqlCommand', false, false, 'notSortable', null, null, 'value'],
    ['webmailSubject', false, false, 'notSortable', null, null, 'value'],
    ['webmailAttachmentFilename', false, false, 'notSortable', null, null, 'value'],
    ['sqlServerRequest', false, false, 'notSortable', null, null, 'value'],
    ['smtpTo', false, false, 'notSortable', null, null, 'value'],
    ['smtpSubject', false, false, 'notSortable', null, null, 'value'],
    ['ftpUser', false, false, 'notSortable', null, null, 'value'],
    ['ftpCommand', false, false, 'notSortable', null, null, 'value'],
    ['ftpCwd', false, false, 'notSortable', null, null, 'value'],
    ['description', false, false, 'notSortable', null, null, 'value'],
    ['exploitCveId', false, false, 'notSortable', null, null, 'value'],
    ['sasUsername', false, false, 'notSortable', null, null, 'value'],
    ['snmpVersion', false, false, 'notSortable', null, null, 'value'],
    ['recommendation', false, false, 'notSortable', null, null, 'value'],
    ['aiRuleId', false, false, 'notSortable', null, null, 'value'],
    ['fileState', false, false, 'notSortable', null, null, 'value'],
    ['fileStatus', false, false, 'notSortable', null, null, 'value']
  ];

  return fields.map(function(f) {
    return {
      field: f[0],
      show: f[1],
      selected: f[2],
      sort: f[3],
      columnWidth: f[4],
      fixed: f[5],
      dataType: f[6]
    };
  });
}

function buildAlertCountRequestBody({ begin, end }) {
  return {
    extensionParams: null,
    spl: {
      mappedSpl: '',
      originalSpl: '',
      extensionParams: {
        frontRender: [],
        mappedInputSpl: '',
        originalInputSpl: ''
      }
    },
    serviceInfo: ALERT_TABLE_SERVICE_INFO,
    globalCondition: {
      branchIds: [],
      time: {
        timeField: 'firstTime',
        begin: { type: 'absolute', value: begin },
        end: { type: 'absolute', value: end }
      }
    },
    table: {
      enable: true,
      viewName: 'AlertView',
      aggregationStrategies: null,
      tableFields: buildAlertTableFields(),
      pageNum: 1,
      pageSize: 100,
      serviceInfo: ALERT_TABLE_SERVICE_INFO,
      subTable: null,
      rightClicked: false,
      selectAllPage: true,
      routers: [
        {
          icon: null,
          path: '/incident/event/detail',
          type: 'drillDown',
          params: null,
          actionParams: {
            quarantineHostDisableFlag: '$quarantineHostDisableFlag',
            disposedDisableFlag: '$disposedDisableFlag',
            ignoreDisableFlag: '$ignoreDisableFlag',
            trustFileDisableFlag: '$trustFileDisableFlag',
            disposeFileDisableFlag: '$disposeFileDisableFlag',
            soarDisableFlag: '$soarDisableFlag',
            orderDisableFlag: '$orderDisableFlag',
            disposingDisableFlag: '$disposingDisableFlag',
            banIpDisableFlag: '$banIpDisableFlag',
            gptResultStrategyDisableFlag: '$gptResultStrategyDisableFlag',
            pendingDisableFlag: '$pendingDisableFlag',
            toBeTransferDisableFlag: '$toBeTransferDisableFlag',
            id: '$uuId',
            customAlertGenerateIncidentDisableFlag: '$customAlertGenerateIncidentDisableFlag',
            misReportDisableFlag: '$misReportDisableFlag'
          },
          applicableCols: ['name']
        }
      ],
      rightActions: [
        {
          name: 'addFilter',
          type: 'filter',
          params: null,
          actionParams: null,
          applicableCols: ['responseHead', 'smtpTo', 'devSourceNames', 'sendFrom', 'occurTime', 'ignoreDisableFlag', 'platformIsDelete', 'recommendation', 'threatSubType', 'ftpCwd', 'similarId', 'srcPort', 'platformHostBranchId', 'accessDirection', 'huntingDomains', 'xUserGroup', 'humanCheck', 'redisLogin', 'tenant', 'fullTextSearch', 'quarantineHostDisableFlag', 'hostIp', 'respStatus', 'devices', 'ndrSecdetectBreachMid', 'mitreid', 'dealStatus', 'threatTypeProxy', 'aiRuleId', 'aiRuleIds', 'vulnName', 'soarDisableFlag', 'ftpCommand', 'newFullTextSearch', 'redisPassword', 'incidentRelated', 'gptAction', 'redisCommandCall', 'dealTime', 'threatType', 'orderDisableFlag', 'mssStatus', 'domain', 'disposingDisableFlag', 'reqCookie', 'whiteStatus', 'engineName', 'customAlertGenerateIncidentDisableFlag', 'gptRespAction', 'natTransform', 'dataAuthorityOwner', 'ioaRuleRelated', 'responseBody', 'webmailAttachmentFilename', 'statusChangeDisableFlag', 'featureInfo', 'dstIpStr', 'incidentRootIds', 'trustFileDisableFlag', 'regionIds', 'investigationResult', 'smtpFrom', 'ftpUser', 'ruleIds', 'dstPort', 'webmailSubject', 'whiteListIds', 'pName', 'requestBody', 'srcAssetAnalyzeResultsStatus', 'pendingDisableFlag', 'addWhiteDisableFlag', 'misReportDisableFlag', 'suspectedMisReport', 'hostClassify1Id', 'disposedDisableFlag', 'combineType', 'updateTime', 'userAgent', 'fileMd5', 'dstIpInfos', 'url', 'firstTime', 'platformHostGroupIds', 'devUId', 'riskTag', 'gptJudgementEngine', 'stage', 'dealAction', 'hostCountryName', 'exploitCveId', 'gptResultStrategyDisableFlag', 'huntingMD5s', 'hostAddress', 'dstIp', 'xForwardedFor', 'dnsQueries', 'alertRuleId', 'lastTime', 'similarRuleId', 'gptRuleUid', 'mysqlCommand', 'xUserName', 'requestHead', 'sasUsername', 'checker', 'disposeFileDisableFlag', 'webmailFrom', 'hostBranchId', 'attckTechnique', 'disposalRecord', 'srcIpInfos', 'fileState', 'devUIdProxy', 'banIpDisableFlag', 'srcAssetAnalyzeResults', 'sqlServerRequest', 'smtpSubject', 'fusionAlert', 'srcIp', 'attackResult', 'read', 'gptStartAt', 'virusName', 'correctGptResult', 'snmpVersion', 'threatClass', 'huntingIps', 'proofType', 'cveId', 'webmailUser', 'isCascade', 'trafficForwardLocation', 'hostAssetAnalyzeResult', 'gptSubResult', 'insertTime', 'hostProvinceName', 'gptAnalyzeTrace', 'webmailTo', 'name', 'dataAuthorityBranchId', 'gptResult', '_id', 'gptEngineList', 'logType', 'hostIpStr', 'platformIdAndGroupId', 'gptEndAt', 'humanNote', 'description', 'platformRole', 'srcIpStr', 'fileStatus', 'humanInvestigation', 'hostGroupIds', 'gptAnalyzeTime', 'hostAssetId', 'severity', 'owner', 'hostClassifyId', 'confidence', 'attckSubTechnique', 'platformId', 'label', 'uploadTime', 'uuId', 'logTraceInfo', 'disposeTime', 'regionId', 'threatSubTypeProxy', 'operationLabels', 'dnsAnswers', 'toBeTransferDisableFlag', 'threatDefine', 'dataAuthorityCooperators', 'username']
        },
        {
          name: 'removeFilter',
          type: 'filter',
          params: null,
          actionParams: null,
          applicableCols: ['responseHead', 'smtpTo', 'devSourceNames', 'sendFrom', 'occurTime', 'ignoreDisableFlag', 'platformIsDelete', 'recommendation', 'threatSubType', 'ftpCwd', 'similarId', 'srcPort', 'platformHostBranchId', 'accessDirection', 'huntingDomains', 'xUserGroup', 'humanCheck', 'redisLogin', 'tenant', 'fullTextSearch', 'quarantineHostDisableFlag', 'hostIp', 'respStatus', 'devices', 'ndrSecdetectBreachMid', 'mitreid', 'dealStatus', 'threatTypeProxy', 'aiRuleId', 'aiRuleIds', 'vulnName', 'soarDisableFlag', 'ftpCommand', 'newFullTextSearch', 'redisPassword', 'incidentRelated', 'gptAction', 'redisCommandCall', 'dealTime', 'threatType', 'orderDisableFlag', 'mssStatus', 'domain', 'disposingDisableFlag', 'reqCookie', 'whiteStatus', 'engineName', 'customAlertGenerateIncidentDisableFlag', 'gptRespAction', 'natTransform', 'dataAuthorityOwner', 'ioaRuleRelated', 'responseBody', 'webmailAttachmentFilename', 'statusChangeDisableFlag', 'featureInfo', 'dstIpStr', 'incidentRootIds', 'trustFileDisableFlag', 'regionIds', 'investigationResult', 'smtpFrom', 'ftpUser', 'ruleIds', 'dstPort', 'webmailSubject', 'whiteListIds', 'pName', 'requestBody', 'srcAssetAnalyzeResultsStatus', 'pendingDisableFlag', 'addWhiteDisableFlag', 'misReportDisableFlag', 'suspectedMisReport', 'hostClassify1Id', 'disposedDisableFlag', 'combineType', 'updateTime', 'userAgent', 'fileMd5', 'dstIpInfos', 'url', 'firstTime', 'platformHostGroupIds', 'devUId', 'riskTag', 'gptJudgementEngine', 'stage', 'dealAction', 'hostCountryName', 'exploitCveId', 'gptResultStrategyDisableFlag', 'huntingMD5s', 'hostAddress', 'dstIp', 'xForwardedFor', 'dnsQueries', 'alertRuleId', 'lastTime', 'similarRuleId', 'gptRuleUid', 'mysqlCommand', 'xUserName', 'requestHead', 'sasUsername', 'checker', 'disposeFileDisableFlag', 'webmailFrom', 'hostBranchId', 'attckTechnique', 'disposalRecord', 'srcIpInfos', 'fileState', 'devUIdProxy', 'banIpDisableFlag', 'srcAssetAnalyzeResults', 'sqlServerRequest', 'smtpSubject', 'fusionAlert', 'srcIp', 'attackResult', 'read', 'gptStartAt', 'virusName', 'correctGptResult', 'snmpVersion', 'threatClass', 'huntingIps', 'proofType', 'cveId', 'webmailUser', 'isCascade', 'trafficForwardLocation', 'hostAssetAnalyzeResult', 'gptSubResult', 'insertTime', 'hostProvinceName', 'gptAnalyzeTrace', 'webmailTo', 'name', 'dataAuthorityBranchId', 'gptResult', '_id', 'gptEngineList', 'logType', 'hostIpStr', 'platformIdAndGroupId', 'gptEndAt', 'humanNote', 'description', 'platformRole', 'srcIpStr', 'fileStatus', 'humanInvestigation', 'hostGroupIds', 'gptAnalyzeTime', 'hostAssetId', 'severity', 'owner', 'hostClassifyId', 'confidence', 'attckSubTechnique', 'platformId', 'label', 'uploadTime', 'uuId', 'logTraceInfo', 'disposeTime', 'regionId', 'threatSubTypeProxy', 'operationLabels', 'dnsAnswers', 'toBeTransferDisableFlag', 'threatDefine', 'dataAuthorityCooperators', 'username']
        },
        {
          name: 'copyCellText',
          type: 'copy',
          params: null,
          actionParams: null,
          applicableCols: null
        },
        {
          name: 'copyRecordData',
          type: 'copy',
          params: null,
          actionParams: null,
          applicableCols: null
        },
        {
          name: 'decodeTool',
          type: 'tool',
          params: null,
          actionParams: null,
          applicableCols: null
        },
        {
          name: 'hostIpAssetDetail',
          type: 'assetJump',
          params: null,
          actionParams: { assetId: '$hostAssetId', ip: '$hostIp', uuId: '$uuId' },
          applicableCols: ['hostIp']
        },
        {
          name: 'srcIpAssetDetail',
          type: 'assetJump',
          params: null,
          actionParams: { srcIpInfos: '$srcIpInfos', ip: '$.', uuId: '$uuId' },
          applicableCols: ['srcIp']
        },
        {
          name: 'dstIpAssetDetail',
          type: 'assetJump',
          params: null,
          actionParams: { ip: '$.', uuId: '$uuId', dstIpInfos: '$dstIpInfos' },
          applicableCols: ['dstIp']
        },
        {
          name: 'incidentBanIp',
          type: 'item',
          params: { disable: '$banIpDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentQuarantineHost',
          type: 'item',
          params: { disable: '$quarantineHostDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'alertGptResultStrategy',
          type: 'addAlertGptResultStrategy',
          params: { disable: '$gptResultStrategyDisableFlag' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentAddWhite',
          type: 'addWhite',
          params: { disable: '$addWhiteDisableFlag' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'alertStatusChange',
          type: 'statusChange',
          params: { disable: '$statusChangeDisableFlag' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'customAlertGenerateIncident',
          type: 'customAlertGenerateIncident',
          params: { disable: '$customAlertGenerateIncidentDisableFlag' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentDisposeFile',
          type: 'item',
          params: { disable: '$disposeFileDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentTrustFile',
          type: 'item',
          params: { disable: '$trustFileDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'jumpAllowList',
          type: 'jump',
          params: { hidden: true, disable: '$isCascade', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: ['whiteStatus']
        },
        {
          name: 'incidentIgnore',
          type: 'modifyDealStatus',
          params: { disable: '$ignoreDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentMisReport',
          type: 'modifyDealStatus',
          params: { disable: '$misReportDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentPending',
          type: 'modifyDealStatus',
          params: { disable: '$pendingDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentDisposing',
          type: 'modifyDealStatus',
          params: { disable: '$disposingDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentDisposed',
          type: 'modifyDealStatus',
          params: { disable: '$disposedDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentSuppressed',
          type: 'modifyDealStatus',
          params: { disable: '$disposedDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentToBeTransferred',
          type: 'transferred',
          params: { hidden: true, disable: '$toBeTransferDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'flowDisposalRecord',
          type: 'item',
          params: { disable: '$orderDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'soarDisposalRecord',
          type: 'item',
          params: { disable: '$soarDisableFlag', applicableLimit: '' },
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentUnRead',
          type: 'modifyReadStatus',
          params: null,
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        },
        {
          name: 'incidentRead',
          type: 'modifyReadStatus',
          params: null,
          actionParams: { uuId: '$uuId' },
          applicableCols: null
        }
      ],
      extensionParams: {}
    },
    tag: null,
    viewName: 'AlertView',
    model: 'expert',
    autoRefresh: false,
    viewInstanceId: ALERT_VIEW_INSTANCE_ID,
    enableHistory: true
  };
}

function buildCaseStudyAlertQueryRequestBody({ begin, end, alertIds, stageId, techniqueId }) {
  const tacticValue = `${stageId}.${techniqueId}`;
  const alertIdList = Array.isArray(alertIds) ? alertIds.map(id => `"${id}"`).join(' , ') : `"${alertIds}"`;
  return {
    extensionParams: null,
    spl: {
      mappedSpl: `filter uuId in { ${alertIdList} } | attckTactics = "${tacticValue}"`,
      originalSpl: `filter uuId in { ${alertIdList} } | attckTactics = "${tacticValue}"`,
      extensionParams: {
        frontRender: [],
        mappedInputSpl: `attckTactics = "${tacticValue}"`,
        originalInputSpl: `attckTactics = "${tacticValue}"`
      }
    },
    serviceInfo: ALERT_TABLE_SERVICE_INFO,
    globalCondition: {
      branchIds: [],
      time: {
        timeField: 'lastTime',
        begin: { type: 'absolute', value: begin },
        end: { type: 'absolute', value: end }
      }
    },
    table: {
      enable: true,
      viewName: 'AlertSubView',
      aggregationStrategies: [],
      tableFields: buildAlertTableFields(),
      pageNum: 1,
      pageSize: 10,
      serviceInfo: ALERT_TABLE_SERVICE_INFO,
      subTable: null,
      rightClicked: false,
      selectAllPage: false,
      routers: [],
      rightActions: [],
      extensionParams: {},
      tag: null
    },
    viewName: 'AlertSubView',
    model: 'simple',
    autoRefresh: true,
    viewInstanceId: ALERT_VIEW_INSTANCE_ID,
    enableHistory: false
  };
}

function buildIncidentCaseStudyQueryRequestBody({ begin, end, incidentId }) {
  return {
    extensionParams: null,
    spl: {
      mappedSpl: `filter uuId in { "${incidentId}" }`,
      originalSpl: `filter uuId in { "${incidentId}" }`,
      extensionParams: {
        frontRender: [],
        mappedInputSpl: '',
        originalInputSpl: ''
      }
    },
    serviceInfo: CASE_STUDY_INCIDENT_SERVICE_INFO,
    globalCondition: {
      branchIds: [],
      time: {
        timeField: 'endTime',
        begin: { type: 'absolute', value: begin },
        end: { type: 'absolute', value: end }
      }
    },
    table: {
      enable: true,
      viewName: 'IncidentView',
      aggregationStrategies: null,
      tableFields: [
        { field: 'uuId', show: true, selected: true, sort: 'disable', columnWidth: 280, fixed: null, dataType: 'value' },
        { field: 'logTraceInfo', show: true, selected: true, sort: 'disable', columnWidth: 150, fixed: null, dataType: 'value' },
        { field: 'endTime', show: true, selected: true, sort: 'desc', columnWidth: 160, fixed: null, dataType: 'value' }
      ],
      pageNum: 1,
      pageSize: 10,
      serviceInfo: CASE_STUDY_INCIDENT_SERVICE_INFO,
      subTable: null,
      rightClicked: false,
      selectAllPage: false,
      routers: [],
      rightActions: [],
      extensionParams: {},
      tag: null
    },
    viewName: 'IncidentView',
    model: 'simple',
    autoRefresh: false,
    viewInstanceId: 'case-study-incident-view',
    enableHistory: true
  };
}

function severityRank(value) {
  const index = CASE_STUDY_SEVERITY_ORDER.indexOf(String(value || '').trim());
  return index === -1 ? CASE_STUDY_SEVERITY_ORDER.length : index;
}

function buildEmptyCaseStudy(candidateCount = 0, matchedCount = 0) {
  return {
    selectedIncidentId: '',
    selectedSourceType: '',
    selectedSeverity: '',
    candidateCount: Number(candidateCount || 0),
    matchedCount: Number(matchedCount || 0),
    attackTimeline: [],
    defenseTimeline: []
  };
}

function parseAlertQueryBaseUrl(cookieInfo) {
  const explicit = normalizeAbsoluteUrl(cookieInfo && cookieInfo.alertQueryBaseUrl);
  if (explicit) {
    return explicit;
  }

  const candidates = Array.isArray(cookieInfo && cookieInfo.xdrBaseUrlCandidates)
    ? cookieInfo.xdrBaseUrlCandidates
    : [];
  const fallbackHost = candidates[0] || cookieInfo.xdrBaseUrl || '';
  if (!fallbackHost) {
    return '';
  }

  return normalizeAbsoluteUrl(`https://${fallbackHost}`);
}

function buildXdrAlertHeaders(cookieInfo, alertQueryBaseUrl) {
  const baseUrl = new URL(alertQueryBaseUrl);
  return {
    host: baseUrl.host,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    cookie: cookieInfo.cookieString,
    origin: baseUrl.origin,
    referer: `${baseUrl.origin}/`,
    'sec-ch-ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'x-requested-with': 'XMLHttpRequest',
    'x-csrf-token': cookieInfo.csrfToken
  };
}

function buildMsswTableQueryHeaders(cookieInfo, msswBaseUrl, companyId) {
  return buildMsswExportHeaders(cookieInfo, msswBaseUrl, companyId);
}

function extractCellValue(cell) {
  if (cell === null || cell === undefined) return '';
  if (typeof cell !== 'object') return cell;
  if (cell.renderValue !== undefined && cell.renderValue !== null) return cell.renderValue;
  if (cell.originalValue !== undefined && cell.originalValue !== null) return cell.originalValue;
  return '';
}

function extractArrayCellValues(cell) {
  if (!cell || typeof cell !== 'object') return [];
  const data = Array.isArray(cell.data) ? cell.data : [];
  return data
    .map((item) => {
      if (item && typeof item === 'object') {
        return item.renderValue !== undefined && item.renderValue !== null
          ? item.renderValue
          : item.originalValue;
      }
      return item;
    })
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function determineVoiceMode(hostIp, dstIpValues) {
  const normalizedHostIp = String(hostIp || '').trim();
  if (!normalizedHostIp) return '主动';
  return dstIpValues.includes(normalizedHostIp) ? '被动' : '主动';
}

function buildAttackNarrative(hostIp, stageName, techniqueName, voiceMode) {
  const prefix = String(hostIp || '').trim();
  const suffix = `${String(stageName || '').trim()}${String(techniqueName || '').trim()}`;
  if (!prefix) return suffix;
  if (voiceMode === '被动') return `${prefix}被${suffix}`;
  return `${prefix}${suffix}`;
}
// GPT 定性结论威胁家族名称列表
const THREAT_ACTOR_NAMES = [
  '勒索', '银狐', '黑猫', '金眼狗', '海莲花', '幼象', '响尾蛇',
  '魔罗桫', '摩诃草', '蔓灵花', '肚脑虫', 'CNC', '人面马', '桃色沙尘暴',
  'CharmingKitten', '污水', 'RocketKitten', 'APT42', '蓝色魔眼', '索伦之眼',
  '方程式', 'Longhorn', '伪猎者', '寄生兽', '图拉', '沙虫', '舒适熊', '奇幻熊',
  'KimSuky', '隐士', '拉萨路', '双尾蝎', '透明部落', '夜鹰', 'Machete', '草无根',
  'Careto', 'Chafer', 'Gorgon Group', 'Hacking Team', '黑格莎', 'Mabna Institute',
  '潜行者', 'SNOWGLOBE', 'SWEED', 'Tempting Cedar Spyware', 'TurkHackTeam',
  'Vendetta', '魔鼠', '暗象', '毒针', '黄金雕', '摩耶象', '拍拍熊', '三色堇',
  '双异鼠', '旺刺', '芜琼洞', '暗蚊', '金相狐', '金蝉', 'FaCai', 'DragonRank',
  '夜枭', '雪狼', 'cobaltstrike'
];

function matchThreatActor(gptSubResultValue) {
  if (!gptSubResultValue) return '';
  for (const name of THREAT_ACTOR_NAMES) {
    if (gptSubResultValue.includes(name)) {
      return name;
    }
  }
  return '';
}

async function fetchIncidentAttckCount(cookieInfo, msswBaseUrl, companyId, alertIds) {
  const headers = buildMsswTableQueryHeaders(cookieInfo, msswBaseUrl, companyId);
  const url = `https://${normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL)}${ATTCK_COUNT_ENDPOINT}`;
  const response = await requestJson(url, {
    headers,
    body: JSON.stringify(alertIds)
  });

  const code = response && response.code;
  if (code !== 0 && code !== '0' && code !== undefined && code !== null) {
    throw new Error(`ATT&CK 时间线查询失败 (${JSON.stringify(alertIds)}): ${response.message || response.msg || JSON.stringify(response).slice(0, 500)}`);
  }
  return response;
}

async function fetchIncidentAlertIds(cookieInfo, msswBaseUrl, companyId, incidentId) {
  const headers = buildMsswTableQueryHeaders(cookieInfo, msswBaseUrl, companyId);
  const url = `https://${normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL)}${DISPOSAL_TABS_ENDPOINT}/${incidentId}`;
  const response = await requestJson(url, { headers });

  const code = response && response.code;
  if (code !== 0 && code !== '0' && code !== undefined && code !== null) {
    throw new Error(`事件详情查询失败 (${incidentId}): ${response.message || response.msg || JSON.stringify(response).slice(0, 500)}`);
  }
  const data = response && response.data && typeof response.data === 'object' ? response.data : {};
  return Array.isArray(data.alertIds) ? data.alertIds : [];
}

async function queryCaseStudyAlertRow(msswCookieInfo, msswBaseUrl, companyId, range, alertIds, stageId, techniqueId) {
  const headers = buildMsswTableQueryHeaders(msswCookieInfo, msswBaseUrl, companyId);
  const url = `https://${normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL)}${ALERT_QUERY_ENDPOINT}`;
  const requestBody = buildCaseStudyAlertQueryRequestBody({
    begin: range.begin,
    end: range.end,
    alertIds,
    stageId,
    techniqueId
  });

  console.log('[DEBUG] 典型案例告警详情请求:', JSON.stringify({
    url,
    companyId: String(companyId || ''),
    alertIds,
    stageId,
    techniqueId,
    begin: range.begin,
    end: range.end,
    mappedSpl: requestBody.spl && requestBody.spl.mappedSpl,
    mappedInputSpl: requestBody.spl && requestBody.spl.extensionParams && requestBody.spl.extensionParams.mappedInputSpl,
    viewInstanceId: requestBody.viewInstanceId
  }, null, 2));

  const response = await requestJson(url, {
    headers,
    body: JSON.stringify(requestBody)
  });

  assertXdrApiSuccess(response, '典型案例攻击侧查询');
  const data = response && response.data && typeof response.data === 'object' ? response.data : {};
  const list = Array.isArray(data.data) ? data.data : [];
  const firstRow = list[0] || null;
  console.log('[DEBUG] 典型案例告警详情响应摘要:', JSON.stringify({
    code: response && response.code,
    strCode: response && response.strCode,
    message: response && response.message,
    topLevelKeys: response && typeof response === 'object' ? Object.keys(response) : [],
    dataKeys: Object.keys(data),
    total: data.total,
    pageNum: data.pageNum,
    pageSize: data.pageSize,
    listLength: list.length,
    firstRowKeys: firstRow && typeof firstRow === 'object' ? Object.keys(firstRow) : [],
    firstRow: firstRow ? {
      uuId: extractCellValue(firstRow.uuId),
      lastTime: extractCellValue(firstRow.lastTime),
      hostIp: extractCellValue(firstRow.hostIp),
      attckTechnique: firstRow.attckTechnique || null,
      attckSubTechnique: firstRow.attckSubTechnique || null
    } : null
  }, null, 2));
  return list[0] || null;
}

async function queryCaseStudyIncidentTimeline(cookieInfo, msswBaseUrl, companyId, range, incidentId) {
  const headers = buildMsswTableQueryHeaders(cookieInfo, msswBaseUrl, companyId);
  const url = `https://${normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL)}${INCIDENT_TABLE_QUERY_ENDPOINT}`;
  const response = await requestJson(url, {
    headers,
    body: JSON.stringify(buildIncidentCaseStudyQueryRequestBody({
      begin: range.begin,
      end: range.end,
      incidentId
    }))
  });

  assertXdrApiSuccess(response, '典型案例防守侧查询');
  const data = response && response.data && typeof response.data === 'object' ? response.data : {};
  const list = Array.isArray(data.data) ? data.data : [];
  const row = list[0] || null;
  const logTraceInfo = row && row.logTraceInfo && typeof row.logTraceInfo === 'object' ? row.logTraceInfo : null;
  const renderValue = logTraceInfo && Array.isArray(logTraceInfo.renderValue) ? logTraceInfo.renderValue : [];
  console.log('[DEBUG] 典型案例防守侧响应摘要:', JSON.stringify({
    total: data.total,
    listLength: list.length,
    rowKeys: row && typeof row === 'object' ? Object.keys(row) : [],
    hasLogTraceInfo: Boolean(row && row.logTraceInfo),
    logTraceInfoKeys: logTraceInfo ? Object.keys(logTraceInfo) : [],
    renderValueCount: renderValue.length,
    renderValuePreview: renderValue.slice(0, 5).map((item) => ({
      value: item && item.value,
      label: item && item.label,
      time: item && item.value ? new Date(item.value).toISOString() : null
    }))
  }, null, 2));
  return row;
}

function extractAttckTechniqueHits(response) {
  const data = response && response.data && typeof response.data === 'object' ? response.data : {};
  const tactics = Array.isArray(data.attckTacticVoList) ? data.attckTacticVoList : [];
  const hits = [];

  for (const tactic of tactics) {
    if (!tactic || tactic.isHit !== true) continue;
    const techniques = Array.isArray(tactic.attckTechniques) ? tactic.attckTechniques : [];
    if (!techniques.length) continue;

    for (const technique of techniques) {
      if (!technique || !technique.id) continue;
      hits.push({
        stageId: String(tactic.id || '').trim(),
        stageName: String(tactic.chineseName || '').trim(),
        techniqueId: String(technique.id || '').trim(),
        techniqueName: String(technique.chineseName || '').trim()
      });
    }
  }

  return hits;
}

// 防守时间线固定四个节点的标签和对应的时间字段组
const DEFENSE_TIMELINE_NODES = [
  {
    label: '【日志】接收到所有相关日志',
    timeLabels: ['数据湖标准化时间', '数据湖接收时间', '组件日志上报时间', '组件日志检测时间']
  },
  {
    label: '【告警】AI将上述日志提取出来生成关键告警',
    timeLabels: ['N侧引擎接收时间', '首次安全告警生成时间', 'XDR平台数据采集时间', 'XDR平台数据上报时间', '分布式数据云上安全代理转发时间', '安全告警解读时间']
  },
  {
    label: '【事件】AI进行关键告警分析生成事件',
    timeLabels: ['云端AI安服联动时间', 'NAE关联分析引擎接收时间', '首次安全事件生成时间', '安全事件接收时间', '安全事件入库时间']
  },
  {
    label: '【闭环】云端专家对威胁进行处置闭环',
    // 固定显示两个时间条目，取值均来自事件表的"完成时间"
    fixedTimeDescs: ['威胁遏制时间', '闭环时间']
  }
];

function buildDefenseTimelineFromIncidentRow(row, completionTime) {
  if (!row || typeof row !== 'object') {
    console.log('[DEBUG] 防守时间线构建: row 为空或非对象，返回固定四节点占位');
    return buildFixedDefenseNodes([], '');
  }
  const logTraceInfo = row.logTraceInfo && typeof row.logTraceInfo === 'object' ? row.logTraceInfo : {};
  const renderValue = Array.isArray(logTraceInfo.renderValue) ? logTraceInfo.renderValue : [];
  console.log('[DEBUG] 防守时间线构建: renderValue 原始数据:', JSON.stringify({
    renderValueCount: renderValue.length,
    renderValue: renderValue.map((item) => ({
      value: item && item.value,
      label: item && item.label,
      valueType: typeof (item && item.value),
      valueMs: item && item.value ? new Date(item.value * 1000).toISOString() : null
    }))
  }, null, 2));

  // 将 renderValue 转换为 label → maxTimestamp 的映射（同一label可能有多个值，取最晚）
  const labelTimeMap = new Map();
  for (const item of renderValue) {
    const ts = Number(item && item.value || 0);
    const label = String(item && item.label || '').trim();
    if (!Number.isFinite(ts) || ts <= 0 || !label) continue;
    const existing = labelTimeMap.get(label);
    if (existing === undefined || ts > existing) {
      labelTimeMap.set(label, ts);
    }
  }

  console.log('[DEBUG] 防守时间线构建: label→time 映射:', JSON.stringify(
    Array.from(labelTimeMap.entries()).map(([label, ts]) => ({
      label,
      timestamp: ts,
      time: new Date(ts * 1000).toISOString()
    }))
  , null, 2));

  return buildFixedDefenseNodes(labelTimeMap, completionTime);
}

/**
 * 从 label→time 映射中收集所有匹配的时间条目。
 * 对 timeLabels 中的每个标签尝试匹配（支持精确匹配和包含匹配），返回所有命中的条目。
 */
function collectTimeEntriesFromLabels(labelTimeMap, timeLabels) {
  const entries = [];
  const seenLabels = new Set(); // 避免同一 label 重复添加
  for (const targetLabel of timeLabels) {
    for (const [mapLabel, ts] of labelTimeMap) {
      // 精确匹配或互相包含
      if (mapLabel === targetLabel || mapLabel.includes(targetLabel) || targetLabel.includes(mapLabel)) {
        if (!seenLabels.has(mapLabel)) {
          seenLabels.add(mapLabel);
          entries.push({ timestamp: ts, desc: mapLabel });
        }
      }
    }
  }
  // 按时间升序排列
  entries.sort((a, b) => a.timestamp - b.timestamp);
  return entries;
}

function buildFixedDefenseNodes(labelTimeMap, completionTime) {
  const nodes = [];
  for (const nodeDef of DEFENSE_TIMELINE_NODES) {
    let timeEntries = [];
    if (nodeDef.timeLabels) {
      // 前三个节点：从接口返回中收集所有相关时间标签的条目
      timeEntries = collectTimeEntriesFromLabels(labelTimeMap, nodeDef.timeLabels);
    } else if (Array.isArray(nodeDef.fixedTimeDescs) && completionTime != null && completionTime > 0) {
      // 闭环节点：固定展示"威胁遏制时间 / 闭环时间"两个条目，时间均取事件表的完成时间
      timeEntries = nodeDef.fixedTimeDescs.map((desc) => ({
        timestamp: completionTime,
        desc
      }));
    }
    nodes.push({
      label: nodeDef.label,
      timeEntries: timeEntries
    });
  }

  console.log('[DEBUG] 防守时间线构建: 固定四节点结果:', JSON.stringify(
    nodes.map((item) => ({
      label: item.label,
      entriesCount: item.timeEntries.length,
      entries: item.timeEntries.map((e) => ({
        time: e.timestamp > 0 ? new Date(e.timestamp * 1000).toISOString() : '暂无时间',
        desc: e.desc
      }))
    }))
  , null, 2));

  return nodes;
}

async function fetchIncidentCaseStudy(options = {}) {
  const candidateCount = (
    (Array.isArray(options.c2Ids) ? options.c2Ids.length : 0) +
    (Array.isArray(options.virusIds) ? options.virusIds.length : 0) +
    (Array.isArray(options.exploitIds) ? options.exploitIds.length : 0)
  );

  if (!options.incidentFilePath) {
    return buildEmptyCaseStudy(candidateCount, 0);
  }

  const candidateResult = await extractCaseStudyCandidates(options.incidentFilePath, {
    c2Ids: options.c2Ids,
    virusIds: options.virusIds,
    exploitIds: options.exploitIds
  });
  const matchedCandidates = Array.isArray(candidateResult.matchedCandidates)
    ? candidateResult.matchedCandidates
    : [];
  const matchedCount = matchedCandidates.length;

  if (!matchedCount) {
    logInfo(options.logger, `[典型案例] 候选池为空: c2=${(options.c2Ids || []).length}, virus=${(options.virusIds || []).length}, exploit=${(options.exploitIds || []).length}`);
    return buildEmptyCaseStudy(candidateResult.candidateCount || candidateCount, 0);
  }

  const topSeverityRank = Math.min(...matchedCandidates.map((item) => severityRank(item.severity)));
  const topSeverityCandidates = matchedCandidates.filter((item) => severityRank(item.severity) === topSeverityRank);
  const selected = topSeverityCandidates[Math.floor(Math.random() * topSeverityCandidates.length)];
  if (!selected || !selected.incidentId) {
    logInfo(options.logger, '[典型案例] selected 无 incidentId，返回空 caseStudy');
    return buildEmptyCaseStudy(candidateResult.candidateCount || candidateCount, matchedCount);
  }

  const result = buildEmptyCaseStudy(candidateResult.candidateCount || candidateCount, matchedCount);
  result.selectedIncidentId = selected.incidentId;
  result.selectedSourceType = selected.sourceType || '';
  result.selectedSeverity = selected.severity || '';

  logInfo(options.logger, `[典型案例] 选中事件: id=${selected.incidentId}, sourceType=${selected.sourceType}, severity=${selected.severity}, matchedCount=${matchedCount}`);

  let alertIds = [];
  let techniqueHits = [];
  try {
    // 先查事件详情获取 alertIds，attckCount 接口需要传告警 ID 才有 isHit
    logInfo(options.logger, `[典型案例] 查询事件详情获取 alertIds: incidentId=${selected.incidentId}`);
    alertIds = await fetchIncidentAlertIds(
      options.msswCookieInfo,
      options.msswBaseUrl,
      options.companyId,
      selected.incidentId
    );
    logInfo(options.logger, `[典型案例] alertIds 数量: ${alertIds.length}`);

    if (!alertIds.length) {
      logInfo(options.logger, '[典型案例] alertIds 为空，跳过 ATT&CK 查询');
      return result;
    }

    logInfo(options.logger, `[典型案例] 开始查询 ATT&CK 时间线: alertIds=${alertIds.join(',')}`);
    const attckResponse = await fetchIncidentAttckCount(
      options.msswCookieInfo,
      options.msswBaseUrl,
      options.companyId,
      alertIds
    );
    const rawTactics = attckResponse?.data?.attckTacticVoList || [];
    const tacticsWithHit = rawTactics.filter(t => t?.isHit === true);
    logInfo(options.logger, `[典型案例] tactics=${rawTactics.length}, isHit=${tacticsWithHit.length}, hitList=${tacticsWithHit.map(t => `${t.id}(${t.chineseName})`).join(', ') || '(无)'}`);
    techniqueHits = extractAttckTechniqueHits(attckResponse);
    logInfo(options.logger, `[典型案例] 提取到技术命中数: ${techniqueHits.length}`);
  } catch (error) {
    logInfo(options.logger, `[典型案例] ATT&CK 查询失败: ${error.message}`);
    return result;
  }
  if (!techniqueHits.length) {
    logInfo(options.logger, '[典型案例] techniqueHits 为空，跳过攻击侧时间线查询');
    return result;
  }

  const attackTimeline = [];
  // 网页查询典型案例告警时不限制开始时间；不能使用报告生成时间范围，
  // 否则事件虽被 ATT&CK 命中，但其告警发生在报告起始时间之前时会查不到详情。
  const attackAlertQueryRange = {
    ...options.range,
    begin: 0
  };
  for (const hit of techniqueHits) {
    let alertRow = null;
    try {
      logInfo(options.logger, `[典型案例] 查询告警详情: stage=${hit.stageName}(${hit.stageId}), technique=${hit.techniqueName}(${hit.techniqueId}), alertIds=${alertIds.length}`);
      alertRow = await queryCaseStudyAlertRow(
        options.msswCookieInfo,
        options.msswBaseUrl,
        options.companyId,
        attackAlertQueryRange,
        alertIds,
        hit.stageId,
        hit.techniqueId
      );
    } catch (error) {
      logInfo(options.logger, `[典型案例] 告警详情查询失败(${hit.techniqueName}): ${error.message}`);
      continue;
    }
    if (!alertRow) {
      logInfo(options.logger, `[典型案例] 告警详情返回空(${hit.techniqueName})，跳过`);
      continue;
    }

    const hostIp = String(extractCellValue(alertRow.hostIp) || '').trim();
    const dstIpValues = extractArrayCellValues(alertRow.dstIp);
    const alertTimestamp = Number(extractCellValue(alertRow.lastTime) || 0);
    console.log('[DEBUG] 典型案例攻击侧记录已取到:', JSON.stringify({
      technique: `${hit.stageId}.${hit.techniqueId}`,
      alertIdCount: alertIds.length,
      alertRowKeys: Object.keys(alertRow),
      timestamp: alertTimestamp,
      timestampValid: Number.isFinite(alertTimestamp) && alertTimestamp > 0,
      hostIp,
      dstIpCount: dstIpValues.length
    }, null, 2));
    const voiceMode = determineVoiceMode(hostIp, dstIpValues);

    attackTimeline.push({
      timestamp: alertTimestamp,
      stageId: hit.stageId,
      stageName: hit.stageName,
      techniqueId: hit.techniqueId,
      techniqueName: hit.techniqueName,
      hostIp,
      voiceMode,
      narrative: buildAttackNarrative(hostIp, hit.stageName, hit.techniqueName, voiceMode)
    });
  }

  result.attackTimeline = attackTimeline
    .filter((item) => Number.isFinite(item.timestamp) && item.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
  logInfo(options.logger, `[典型案例] 攻击时间线: ${result.attackTimeline.length} 条`);

  try {
    logInfo(options.logger, `[典型案例] 查询防守侧时间线: incidentId=${selected.incidentId}`);
    const defenseIncidentQueryRange = {
      ...options.range,
      // 网页查询事件详情时不限制开始时间，避免旧事件被报告起始时间过滤掉。
      begin: 0
    };
    const incidentRow = await queryCaseStudyIncidentTimeline(
      options.msswCookieInfo,
      options.msswBaseUrl,
      options.companyId,
      defenseIncidentQueryRange,
      selected.incidentId
    );
    // 从事件表 Excel 读取"完成时间"
    let completionTime = null;
    try {
      completionTime = await readIncidentCompletionTime(options.incidentFilePath, selected.incidentId);
      logInfo(options.logger, `[典型案例] 完成时间: ${completionTime || '暂无时间'}`);
    } catch (completionErr) {
      logInfo(options.logger, `[典型案例] 读取完成时间失败: ${completionErr.message}`);
    }
    result.defenseTimeline = buildDefenseTimelineFromIncidentRow(incidentRow, completionTime);
    logInfo(options.logger, `[典型案例] 防守时间线: ${result.defenseTimeline.length} 条, incidentRow=${incidentRow ? '有' : '无'}`);
    if (result.defenseTimeline.length > 0) {
      logInfo(options.logger, `[典型案例] 防守时间线详情: ${JSON.stringify(result.defenseTimeline.map((item) => ({
        entries: Array.isArray(item.timeEntries) ? item.timeEntries.map((e) => ({
          time: e.timestamp && e.timestamp > 0 ? new Date(e.timestamp * 1000).toISOString() : '暂无时间',
          desc: e.desc
        })) : [],
        label: item.label
      })))}`);
    }
  } catch (error) {
    logInfo(options.logger, `[典型案例] 防守侧时间线查询失败: ${error.message}`);
    // Even on failure, return 5 fixed nodes (all with 暂无时间)
    result.defenseTimeline = buildFixedDefenseNodes(new Map(), null);
  }

  return result;
}

async function fetchMsswIncidentGptStats(cookieInfo, msswBaseUrl, companyId, startTimeMs, endTimeMs, logger, incidentFilePath) {
  const threatActorCounts = {};

  // 先以 GPT研判结论建立候选池，再按网络实体优先、文件实体其次的顺序分类。
  // extract_incident_direct_stats.py 已内置"黑"标签确认，无需二次查 API。
  logInfo(logger, `从事件表 Excel 统一识别 C2 / 病毒木马事件: ${incidentFilePath}`);
  const directStats = await extractIncidentDirectStats(incidentFilePath);
  const hostCompromiseIds = directStats.hostCompromiseIds;
  const virusTrojanIds = directStats.virusTrojanIds;

  // 读取 GPT 定性结论
  const excelData = await parseIncidentGptStats(incidentFilePath);
  const gptSubResultMap = excelData.gptSubResultMap;
  logInfo(logger, `Excel 统一分类完成: C2 外联 ${hostCompromiseIds.length} 个, 病毒木马 ${virusTrojanIds.length} 个`);

  const confirmedHostCompromiseIds = hostCompromiseIds;
  const confirmedVirusTrojanIds = virusTrojanIds;

  // Step 4: 对已确认的事件，从 gptSubResultMap 查询 GPT 定性结论并统计威胁家族
  const allIncidentIds = [...confirmedVirusTrojanIds, ...confirmedHostCompromiseIds];
  logInfo(logger, `开始统计已确认事件（病毒木马 ${confirmedVirusTrojanIds.length} + 主机失陷 ${confirmedHostCompromiseIds.length} = ${allIncidentIds.length}）的 GPT 定性结论...`);

  for (let i = 0; i < allIncidentIds.length; i += 1) {
    const incidentId = allIncidentIds[i];
    const subValue = gptSubResultMap[incidentId] || '';
    if (!subValue) {
      logInfo(logger, `事件 #${i + 1}/${allIncidentIds.length} ${incidentId}: 无 GPT 定性标签`);
      continue;
    }
    const matchedActor = matchThreatActor(subValue);
    if (matchedActor) {
      threatActorCounts[matchedActor] = (threatActorCounts[matchedActor] || 0) + 1;
      logInfo(logger, `事件 #${i + 1}/${allIncidentIds.length} ${incidentId}: GPT定性标签=${subValue}, 匹配=${matchedActor}`);
    } else {
      logInfo(logger, `事件 #${i + 1}/${allIncidentIds.length} ${incidentId}: GPT定性标签=${subValue}, 未匹配`);
    }
  }

  // Step 5: 排序取 top 2（合并病毒木马 + 主机失陷的统计结果）
  const sortedActors = Object.entries(threatActorCounts)
    .sort(([, countA], [, countB]) => countB - countA)
    .slice(0, 2)
    .map(([name, count]) => ({ name, count }));

  logInfo(logger, `威胁家族 Top2（合并统计）: ${JSON.stringify(sortedActors)}`);

  // Step 6: 按固定优先级顺序取 top2（勒索 > 银狐 > 黑猫 > ...，只要有就按序取）
  const matchedActorsSet = new Set(Object.keys(threatActorCounts));
  const threatTypeRanking = [];
  for (const name of THREAT_ACTOR_NAMES) {
    if (matchedActorsSet.has(name)) {
      threatTypeRanking.push(name);
      if (threatTypeRanking.length >= 2) break;
    }
  }
  logInfo(logger, `威胁类型 Top2（固定优先级）: ${JSON.stringify(threatTypeRanking)}`);

  const combinedTotal = confirmedHostCompromiseIds.length + confirmedVirusTrojanIds.length;

  return {
    total: combinedTotal,
    hostCompromise: {
      total: confirmedHostCompromiseIds.length,
      confirmedIncidentIds: confirmedHostCompromiseIds
    },
    virusTrojan: {
      total: confirmedVirusTrojanIds.length,
      confirmedIncidentIds: confirmedVirusTrojanIds
    },
    threatActorStats: sortedActors,
    threatTypeRanking
  };
}

async function fetchMsswAlertTableCount(cookieInfo, msswBaseUrl, companyId, options) {
  const headers = buildMsswExportHeaders(cookieInfo, msswBaseUrl, companyId);
  const msswHost = normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL);
  const url = 'https://' + msswHost + ALERT_QUERY_ENDPOINT;
  const timeRange = resolveIncidentTimeRange(options);
  const response = await requestJson(url, {
    headers,
    body: JSON.stringify(buildAlertCountRequestBody(timeRange))
  });

  assertXdrApiSuccess(response, 'MSSW 告警数量接口');

  const total = Number(response && response.data ? response.data.total : 0);
  if (!Number.isFinite(total)) {
    throw new Error('MSSW 告警数量接口返回缺少 total: ' + JSON.stringify(response).slice(0, 500));
  }
  return {
    total,
    response
  };
}

function buildContainedAlertCountRequestBody({ begin, end }) {
  return {
    extensionParams: null,
    spl: {
      mappedSpl: 'filter 处置动作  in { "已遏制\\(组件同步\\)", "已遏制\\(已封禁地址\\)" }',
      originalSpl: 'filter 处置动作  in { "已遏制\\(组件同步\\)", "已遏制\\(已封禁地址\\)" }',
      extensionParams: {
        frontRender: [{
          displayField: '处置动作',
          field: 'dealAction',
          value: ['已遏制(组件同步)', '已遏制(已封禁地址)'],
          headerType: 'alertDealAction',
          searchType: 'selector',
          valueText: '已遏制(组件同步), 已遏制(已封禁地址)',
          isValueNegate: false,
          type: 'string',
          filterSelect: 'renderValue'
        }],
        mappedInputSpl: '',
        originalInputSpl: ''
      }
    },
    serviceInfo: ALERT_TABLE_SERVICE_INFO,
    globalCondition: {
      branchIds: [],
      time: {
        timeField: 'lastTime',
        begin: { type: 'absolute', value: begin },
        end: { type: 'absolute', value: end }
      }
    },
    table: {
      enable: true,
      viewName: 'AlertView',
      aggregationStrategies: null,
      tableFields: buildAlertTableFields(),
      pageNum: 1,
      pageSize: 50,
      serviceInfo: ALERT_TABLE_SERVICE_INFO,
      subTable: null,
      rightClicked: false,
      selectAllPage: true,
      routers: [{
        icon: null,
        path: '/incident/event/detail',
        type: 'drillDown',
        params: null,
        actionParams: {
          quarantineHostDisableFlag: '$quarantineHostDisableFlag',
          disposedDisableFlag: '$disposedDisableFlag',
          ignoreDisableFlag: '$ignoreDisableFlag',
          trustFileDisableFlag: '$trustFileDisableFlag',
          disposeFileDisableFlag: '$disposeFileDisableFlag',
          soarDisableFlag: '$soarDisableFlag',
          orderDisableFlag: '$orderDisableFlag',
          disposingDisableFlag: '$disposingDisableFlag',
          banIpDisableFlag: '$banIpDisableFlag',
          gptResultStrategyDisableFlag: '$gptResultStrategyDisableFlag',
          pendingDisableFlag: '$pendingDisableFlag',
          toBeTransferDisableFlag: '$toBeTransferDisableFlag',
          id: '$uuId',
          customAlertGenerateIncidentDisableFlag: '$customAlertGenerateIncidentDisableFlag',
          misReportDisableFlag: '$misReportDisableFlag'
        },
        applicableCols: ['name']
      }],
      rightActions: buildAlertTableRightActions(),
      extensionParams: {}
    },
    tag: null,
    viewName: 'AlertView',
    model: 'simple',
    autoRefresh: false,
    viewInstanceId: ALERT_VIEW_INSTANCE_ID,
    enableHistory: true
  };
}

function buildAlertTableRightActions() {
  // 返回与 buildAlertCountRequestBody 中 rightActions 一致的数组
  var cols = ['responseHead', 'smtpTo', 'devSourceNames', 'sendFrom', 'occurTime', 'ignoreDisableFlag', 'platformIsDelete', 'recommendation', 'threatSubType', 'ftpCwd', 'similarId', 'srcPort', 'platformHostBranchId', 'accessDirection', 'huntingDomains', 'xUserGroup', 'humanCheck', 'redisLogin', 'tenant', 'fullTextSearch', 'quarantineHostDisableFlag', 'hostIp', 'respStatus', 'devices', 'ndrSecdetectBreachMid', 'mitreid', 'dealStatus', 'threatTypeProxy', 'aiRuleId', 'aiRuleIds', 'vulnName', 'soarDisableFlag', 'ftpCommand', 'newFullTextSearch', 'redisPassword', 'incidentRelated', 'gptAction', 'redisCommandCall', 'dealTime', 'threatType', 'orderDisableFlag', 'mssStatus', 'domain', 'disposingDisableFlag', 'reqCookie', 'whiteStatus', 'engineName', 'customAlertGenerateIncidentDisableFlag', 'gptRespAction', 'natTransform', 'dataAuthorityOwner', 'ioaRuleRelated', 'responseBody', 'webmailAttachmentFilename', 'statusChangeDisableFlag', 'featureInfo', 'dstIpStr', 'incidentRootIds', 'trustFileDisableFlag', 'regionIds', 'investigationResult', 'smtpFrom', 'ftpUser', 'ruleIds', 'dstPort', 'webmailSubject', 'whiteListIds', 'pName', 'requestBody', 'srcAssetAnalyzeResultsStatus', 'pendingDisableFlag', 'addWhiteDisableFlag', 'misReportDisableFlag', 'suspectedMisReport', 'hostClassify1Id', 'disposedDisableFlag', 'combineType', 'updateTime', 'userAgent', 'fileMd5', 'dstIpInfos', 'url', 'firstTime', 'platformHostGroupIds', 'devUId', 'riskTag', 'gptJudgementEngine', 'stage', 'dealAction', 'hostCountryName', 'exploitCveId', 'gptResultStrategyDisableFlag', 'huntingMD5s', 'hostAddress', 'dstIp', 'xForwardedFor', 'dnsQueries', 'alertRuleId', 'lastTime', 'similarRuleId', 'gptRuleUid', 'mysqlCommand', 'xUserName', 'requestHead', 'sasUsername', 'checker', 'disposeFileDisableFlag', 'webmailFrom', 'hostBranchId', 'attckTechnique', 'disposalRecord', 'srcIpInfos', 'fileState', 'devUIdProxy', 'banIpDisableFlag', 'srcAssetAnalyzeResults', 'sqlServerRequest', 'smtpSubject', 'fusionAlert', 'srcIp', 'attackResult', 'read', 'gptStartAt', 'virusName', 'correctGptResult', 'snmpVersion', 'threatClass', 'huntingIps', 'proofType', 'cveId', 'webmailUser', 'isCascade', 'trafficForwardLocation', 'hostAssetAnalyzeResult', 'gptSubResult', 'insertTime', 'hostProvinceName', 'gptAnalyzeTrace', 'webmailTo', 'name', 'dataAuthorityBranchId', 'gptResult', '_id', 'gptEngineList', 'logType', 'hostIpStr', 'platformIdAndGroupId', 'gptEndAt', 'humanNote', 'description', 'platformRole', 'srcIpStr', 'fileStatus', 'humanInvestigation', 'hostGroupIds', 'gptAnalyzeTime', 'hostAssetId', 'severity', 'owner', 'hostClassifyId', 'confidence', 'attckSubTechnique', 'platformId', 'label', 'uploadTime', 'uuId', 'logTraceInfo', 'disposeTime', 'regionId', 'threatSubTypeProxy', 'operationLabels', 'dnsAnswers', 'toBeTransferDisableFlag', 'threatDefine', 'dataAuthorityCooperators', 'username'];
  return [
    { name: 'addFilter', type: 'filter', params: null, actionParams: null, applicableCols: cols },
    { name: 'removeFilter', type: 'filter', params: null, actionParams: null, applicableCols: cols },
    { name: 'copyCellText', type: 'copy', params: null, actionParams: null, applicableCols: null },
    { name: 'copyRecordData', type: 'copy', params: null, actionParams: null, applicableCols: null },
    { name: 'decodeTool', type: 'tool', params: null, actionParams: null, applicableCols: null },
    { name: 'hostIpAssetDetail', type: 'assetJump', params: null, actionParams: { assetId: '$hostAssetId', ip: '$hostIp', uuId: '$uuId' }, applicableCols: ['hostIp'] },
    { name: 'srcIpAssetDetail', type: 'assetJump', params: null, actionParams: { srcIpInfos: '$srcIpInfos', ip: '$.', uuId: '$uuId' }, applicableCols: ['srcIp'] },
    { name: 'dstIpAssetDetail', type: 'assetJump', params: null, actionParams: { ip: '$.', uuId: '$uuId', dstIpInfos: '$dstIpInfos' }, applicableCols: ['dstIp'] },
    { name: 'incidentBanIp', type: 'item', params: { disable: '$banIpDisableFlag', applicableLimit: '' }, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'incidentQuarantineHost', type: 'item', params: { disable: '$quarantineHostDisableFlag', applicableLimit: '' }, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'alertGptResultStrategy', type: 'addAlertGptResultStrategy', params: { disable: '$gptResultStrategyDisableFlag' }, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'incidentAddWhite', type: 'addWhite', params: { disable: '$addWhiteDisableFlag' }, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'alertStatusChange', type: 'statusChange', params: { disable: '$statusChangeDisableFlag' }, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'customAlertGenerateIncident', type: 'customAlertGenerateIncident', params: { disable: '$customAlertGenerateIncidentDisableFlag' }, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'incidentDisposeFile', type: 'item', params: { disable: '$disposeFileDisableFlag', applicableLimit: '' }, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'incidentTrustFile', type: 'item', params: { disable: '$trustFileDisableFlag', applicableLimit: '' }, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'jumpAllowList', type: 'jump', params: { hidden: true, disable: '$isCascade', applicableLimit: '' }, actionParams: { uuId: '$uuId' }, applicableCols: ['whiteStatus'] },
    { name: 'incidentIgnore', type: 'modifyDealStatus', params: { disable: '$ignoreDisableFlag', applicableLimit: '' }, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'incidentMisReport', type: 'modifyDealStatus', params: { disable: '$misReportDisableFlag', applicableLimit: '' }, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'incidentPending', type: 'modifyDealStatus', params: { disable: '$pendingDisableFlag', applicableLimit: '' }, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'incidentDisposing', type: 'modifyDealStatus', params: { disable: '$disposingDisableFlag', applicableLimit: '' }, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'incidentDisposed', type: 'modifyDealStatus', params: { disable: '$disposedDisableFlag', applicableLimit: '' }, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'incidentSuppressed', type: 'modifyDealStatus', params: { disable: '$disposedDisableFlag', applicableLimit: '' }, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'incidentToBeTransferred', type: 'transferred', params: { hidden: true, disable: '$toBeTransferDisableFlag', applicableLimit: '' }, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'flowDisposalRecord', type: 'item', params: { disable: '$orderDisableFlag', applicableLimit: '' }, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'soarDisposalRecord', type: 'item', params: { disable: '$soarDisableFlag', applicableLimit: '' }, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'incidentUnRead', type: 'modifyReadStatus', params: null, actionParams: { uuId: '$uuId' }, applicableCols: null },
    { name: 'incidentRead', type: 'modifyReadStatus', params: null, actionParams: { uuId: '$uuId' }, applicableCols: null }
  ];
}

async function fetchContainedAlertCount(cookieInfo, msswBaseUrl, companyId, options) {
  const headers = buildMsswExportHeaders(cookieInfo, msswBaseUrl, companyId);
  const msswHost = normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL);
  const url = 'https://' + msswHost + ALERT_QUERY_ENDPOINT;
  const timeRange = resolveIncidentTimeRange(options);
  const response = await requestJson(url, {
    headers,
    body: JSON.stringify(buildContainedAlertCountRequestBody(timeRange))
  });

  assertXdrApiSuccess(response, '已遏制告警数量接口');

  const total = Number(response && response.data ? response.data.total : 0);
  if (!Number.isFinite(total)) {
    throw new Error('已遏制告警数量接口返回缺少 total: ' + JSON.stringify(response).slice(0, 500));
  }
  return total;
}

function mapProtectionTypeLabels(typeData) {
  const type = typeData && typeof typeData === 'object' ? typeData : {};
  const items = [
    ['online', '在线'],
    ['offline', '离线'],
    ['disabled', '已禁用'],
    ['demoted', '已降级'],
    ['unprotected', '未安装']
  ];

  return items
    .map(([key, label]) => ({
      name: label,
      value: Number(type[key] || 0)
    }))
    .filter((item) => Number.isFinite(item.value));
}

function mapExposureTypeLabels(typeData) {
  const type = typeData && typeof typeData === 'object' ? typeData : {};
  const items = [
    ['server', '服务器'],
    ['terminal', '终端'],
    ['other', '其它']
  ];

  return items
    .map(([key, label]) => ({
      name: label,
      value: Number(type[key] || 0)
    }))
    .filter((item) => Number.isFinite(item.value));
}

function mapAssetTypeLabels(typeData) {
  const type = typeData && typeof typeData === 'object' ? typeData : {};
  const items = [
    ['server', '服务器'],
    ['terminal', '终端'],
    ['other', '其它']
  ];

  return items
    .map(([key, label]) => ({
      name: label,
      value: Number(type[key] || 0)
    }))
    .filter((item) => Number.isFinite(item.value));
}

function normalizeCountTotal(response) {
  const total = response && response.total !== undefined
    ? response.total
    : response && response.data && response.data.total !== undefined
      ? response.data.total
      : 0;
  const value = Number(total || 0);
  return Number.isFinite(value) ? value : 0;
}

function normalizeAssetReadyToOutboundResponse(response) {
  return {
    ready_to_outbound: normalizeCountTotal(response)
  };
}

function parseLocalDate(value, endOfDay = false) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    return Number(value);
  }

  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`日期格式无效: ${value}，请使用 YYYY-MM-DD`);
  }

  const [, year, month, day] = match.map(Number);
  const date = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function resolveIncidentTimeRange(options = {}) {
  const begin = parseLocalDate(options.begin || options.start, false);
  const end = parseLocalDate(options.end, true);

  if (!begin || !end) {
    throw new Error('XDR 事件导出需要 --start YYYY-MM-DD 和 --end YYYY-MM-DD');
  }

  if (begin > end) {
    throw new Error('XDR 事件导出时间范围无效: --start 不能晚于 --end');
  }

  return { begin, end };
}

/**
 * Read "完成时间" for a given incident from the incident Excel table via Python helper.
 * Returns a unix timestamp (seconds) if found, or null.
 */
function readIncidentCompletionTime(excelPath, incidentId) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'read_incident_completion_time.py');
    execFile('python3', [scriptPath, encodePath(excelPath), incidentId], {
      encoding: 'utf8',
      timeout: 30000,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
    }, (error, stdout, stderr) => {
      if (error) {
        // Fallback: try python instead of python3
        execFile('python', [scriptPath, encodePath(excelPath), incidentId], {
          encoding: 'utf8',
          timeout: 30000,
          env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
        }, (err2, stdout2, stderr2) => {
          if (err2) {
            reject(new Error(`读取完成时间失败: ${stderr || error.message}`));
            return;
          }
          resolve(parseCompletionTimeResult(stdout2));
        });
        return;
      }
      resolve(parseCompletionTimeResult(stdout));
    });
  });
}

function parseCompletionTimeResult(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const timeStr = parsed.completionTime;
    if (!timeStr) return null;
    // Try to parse as datetime string and convert to unix timestamp (seconds)
    const dt = new Date(timeStr);
    if (isNaN(dt.getTime())) {
      return null;
    }
    return Math.floor(dt.getTime() / 1000);
  } catch (e) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseContentDispositionFilename(value) {
  const header = String(value || '');
  const encodedMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch) {
    return decodeURIComponent(encodedMatch[1].trim().replace(/^"|"$/g, ''));
  }

  const plainMatch = header.match(/filename="?([^";]+)"?/i);
  return plainMatch ? plainMatch[1].trim() : '';
}

function getTmpExportDir() {
  return path.join(path.resolve(__dirname, '..'), 'tmp', 'exports');
}

/**
 * 调用 Python 脚本后处理资产/事件表并保存到 tmp/exports。
 * @param {'asset'|'incident'} tableType
 * @param {string} inputPath 已下载并处理完成的 xlsx 文件路径
 * @returns {Promise<{filePath: string}>} 处理后的文件路径
 */
async function processRiskListTable(tableType, inputPath, options = {}) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'process_risk_list_table.py');
  const outputDir = path.resolve(options.outputDir || getTmpExportDir());
  await fsp.mkdir(outputDir, { recursive: true });

  // 资产表需要支持合并待审核数据
  const extraArgs = [];
  if (tableType === 'asset' && options.waitApproveFilePath) {
    extraArgs.push(encodePath(options.waitApproveFilePath));
  }

  return new Promise((resolve, reject) => {
    execFile('python3', [scriptPath, tableType, encodePath(inputPath), encodePath(outputDir), ...extraArgs], { encoding: 'utf8', timeout: 1800000, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) }, (error, stdout, stderr) => {
      if (error) {
        // Fallback: try python instead of python3
        execFile('python', [scriptPath, tableType, encodePath(inputPath), encodePath(outputDir), ...extraArgs], { encoding: 'utf8', timeout: 1800000, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) }, (err2, stdout2, stderr2) => {
          if (err2) {
            const python3Detail = stderr ? stderr.trim() : error.message;
            const pythonDetail = stderr2 ? stderr2.trim() : err2.message;
            reject(new Error(`处理风险清单表失败 (python3: ${python3Detail}, python: ${pythonDetail})`));
            return;
          }
          try {
            resolve(JSON.parse(stdout2));
          } catch (e) {
            reject(new Error(`解析处理结果失败: ${stdout2.slice(0, 500)}`));
          }
        });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`解析处理结果失败: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

async function fetchMsswAssetCore(cookieInfo, msswBaseUrl, companyId) {
  const headers = buildMsswExportHeaders(cookieInfo, msswBaseUrl, companyId);
  const url = `https://${normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL)}${MSSW_ASSET_COUNT_ENDPOINT}`;
  const response = await requestJson(url, {
    headers,
    body: JSON.stringify(buildAssetCountRequestBody({
      magnitude: { op: '=', val: 'core' }
    }))
  });
  const code = response && response.code;
  if (code !== 0 && code !== '0' && code !== undefined) {
    throw new Error(`MSSW 核心资产数量接口返回异常: ${response.msg || JSON.stringify(response).slice(0, 500)}`);
  }
  return response;
}

async function fetchMsswAssetReadyToOutbound(cookieInfo, msswBaseUrl, companyId) {
  const headers = buildMsswExportHeaders(cookieInfo, msswBaseUrl, companyId);
  const url = `https://${normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL)}${MSSW_ASSET_COUNT_ENDPOINT}`;
  const response = await requestJson(url, {
    headers,
    body: JSON.stringify(buildAssetCountRequestBody({
      ready_to_outbound: { op: '=', val: 'last7d' }
    }))
  });
  const code = response && response.code;
  if (code !== 0 && code !== '0' && code !== undefined) {
    throw new Error(`MSSW 7天内即将退库资产数量接口返回异常: ${response.msg || JSON.stringify(response).slice(0, 500)}`);
  }
  return response;
}

// 拉取资产总数（search_type=current 或 wait_approve），用于在导出前判断是否需要走分页兜底
async function fetchMsswAssetTotalCount(cookieInfo, msswBaseUrl, companyId, searchType = 'current') {
  const headers = buildMsswExportHeaders(cookieInfo, msswBaseUrl, companyId);
  const url = `https://${normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL)}${MSSW_ASSET_COUNT_ENDPOINT}`;
  const body = JSON.stringify({ branch_id: 'all', search_type: searchType, start: 0, limit: 20 });
  headers['content-length'] = String(Buffer.byteLength(body));
  const response = await requestJson(url, { headers, body, timeout: 30000 });
  if (!response || response.success !== true && response.code !== 0 && response.code !== '0') {
    throw new Error(`MSSW 资产总数接口返回异常: ${JSON.stringify(response).slice(0, 500)}`);
  }
  return Number(response.total || 0);
}

function buildMsswIncidentTableRequestBody({ offset, limit, startTimeMs, endTimeMs, customerId }) {
  return {
    limit,
    offset,
    filters: {
      status_note: [2],
      end_time: [startTimeMs, endTimeMs],
      customer_type: 'single_customer',
      company_ids: [String(customerId)]
    },
    sorts: [{ field: 'sla_deadline', order: 'asc' }]
  };
}

async function fetchMsswIncidentTablePage(cookieInfo, msswBaseUrl, companyId, options) {
  const headers = buildMsswExportHeaders(cookieInfo, msswBaseUrl, companyId);
  const url = `https://${normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL)}${MSSW_INCIDENT_TABLE_ENDPOINT}`;
  const response = await requestJson(url, {
    headers,
    body: JSON.stringify(buildMsswIncidentTableRequestBody(options))
  });

  const code = response && response.code;
  if (code !== 0 && code !== '0') {
    throw new Error(`MSSW 事件表查询失败: ${response.msg || JSON.stringify(response).slice(0, 500)}`);
  }

  return response;
}

async function fetchMsswFalsePositiveIncidentIds(cookieInfo, msswBaseUrl, companyId, startTimeMs, endTimeMs, logger) {
  const pageSize = 20;
  let offset = 0;
  let allIds = [];

  logInfo(logger, '开始拉取误报事件列表...');

  while (true) {
    const response = await fetchMsswIncidentTablePage(cookieInfo, msswBaseUrl, companyId, {
      offset,
      limit: pageSize,
      startTimeMs,
      endTimeMs,
      customerId: companyId
    });

    const data = response && response.data && typeof response.data === 'object' ? response.data : {};
    const list = Array.isArray(data.list) ? data.list : [];
    const total = Number(data.total || 0);

    for (const item of list) {
      if (item && item.incident_id) {
        allIds.push(item.incident_id);
      }
    }

    logInfo(logger, `误报事件拉取进度: ${allIds.length}/${total}`);

    if (list.length < pageSize) {
      break;
    }

    offset += pageSize;
  }

  logInfo(logger, `误报事件总数: ${allIds.length}`);
  return allIds;
}

function buildAssetCountRequestBody(filters = {}) {
  return {
    branch_id: 'all',
    search_type: 'current',
    platform_ids: [],
    start: 0,
    limit: 20,
    ...filters
  };
}

async function readMsswCookieInfo(cookiePath) {
  if (!cookiePath) {
    throw new Error('MSSW mode requires --mssw-cookie-path');
  }

  const resolvedPath = await resolveCookiePath(cookiePath);
  const rawContent = await fsp.readFile(resolvedPath, 'utf8');
  const cookieString = String(rawContent || '').trim();

  if (!cookieString) {
    throw new Error(`MSSW Cookie 文件内容为空: ${resolvedPath}`);
  }

  return {
    resolvedPath,
    cookieString,
    cookies: parseCookieString(cookieString)
  };
}

async function readSoarCookieInfo(cookiePath) {
  if (!cookiePath) {
    throw new Error('SOAR mode requires --cookie-path');
  }

  const resolvedPath = await resolveCookiePath(cookiePath);
  const rawContent = await fsp.readFile(resolvedPath, 'utf8');
  const normalized = normalizeCookieContent(rawContent);
  const cookieString = String(normalized.cookieString || '').trim();

  if (!cookieString) {
    throw new Error(`SOAR Cookie 文件内容为空: ${resolvedPath}`);
  }

  return {
    resolvedPath,
    rawContent,
    cookieString,
    csrfToken: normalized.csrfToken || extractCsrfToken(cookieString),
    soarBaseUrl: normalizeBaseUrl(normalized.baseUrl || normalized.soarBaseUrl || normalized.domain || DEFAULT_SOAR_BASE_URL),
    cookies: parseCookieString(cookieString)
  };
}

function buildMsswHeaders(cookieString, baseUrl, overrides = {}) {
  const msswBaseUrl = normalizeBaseUrl(baseUrl || DEFAULT_MSSW_BASE_URL);
  return {
    host: msswBaseUrl,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    cookie: cookieString,
    origin: `https://${msswBaseUrl}`,
    referer: `https://${msswBaseUrl}/index.html`,
    'sec-ch-ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'x-requested-with': 'XMLHttpRequest',
    ...overrides
  };
}

const MSSW_INCIDENT_EXPORT_FIELDS = [
  'incident_id', 'company_id', 'name', 'platform_id', 'host_ip',
  'device_type', 'current_handler', 'incident_belong', 'event_push_label',
  'gpt_result', 'gpt_sub_result', 'severity', 'deal_status',
  'incident_threat_class', 'incident_threat_type', 'attack_state',
  'end_time', 'created_time', 'company_name', 'src_ip', 'dst_ip',
  'ioc', 'dev_source_name', 'dev_id_list'
];

function buildMsswExportHeaders(cookieInfo, msswBaseUrl, companyId, overrides = {}) {
  const csrfToken = cookieInfo.cookies && cookieInfo.cookies['csrf_token'] || '';
  return buildMsswHeaders(cookieInfo.cookieString, msswBaseUrl, {
    'x-mssw-company-id': String(companyId || ''),
    'x-csrf-token': csrfToken,
    ...overrides
  });
}

function buildMsswAssetExportHeaders(cookieInfo, msswBaseUrl, companyId) {
  return buildMsswHeaders(cookieInfo.cookieString, msswBaseUrl, {
    traceid: generateUUID(),
    'x-mssw-company-id': String(companyId || '')
  });
}

function buildMsswIncidentExportRequestBody({ begin, end, companyId, fields }) {
  return {
    filters: {
      end_time: [begin, end],
      customer_type: 'single_customer',
      company_ids: [String(companyId)]
    },
    sorts: [{ field: 'sla_deadline', order: 'asc' }],
    export_mode: 'custom',
    format: 'xlsx',
    is_all: 0,
    my_customer: 0,
    event_id_list: [],
    fields: fields || MSSW_INCIDENT_EXPORT_FIELDS,
    export_ioc_intelligence: true
  };
}

function resolveMsswTimeRange(options = {}) {
  const begin = parseLocalDate(options.begin || options.start, false);
  const end = parseLocalDate(options.end, true);
  if (!begin || !end) {
    throw new Error('MSSW 事件导出需要 --start YYYY-MM-DD 和 --end YYYY-MM-DD');
  }
  if (begin > end) {
    throw new Error('MSSW 事件导出时间范围无效: --start 不能晚于 --end');
  }
  return { begin, end };
}

async function triggerMsswIncidentExport(cookieInfo, msswBaseUrl, options) {
  const { begin, end } = resolveMsswTimeRange(options);
  const companyId = options.customerId || options.companyId || '';
  const headers = buildMsswExportHeaders(cookieInfo, msswBaseUrl, companyId);
  const url = `https://${normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL)}${MSSW_INCIDENT_EXPORT_ENDPOINT}`;

  const response = await requestJson(url, {
    headers,
    body: JSON.stringify(buildMsswIncidentExportRequestBody({
      begin: begin * 1000,
      end: end * 1000,
      companyId
    }))
  });

  const code = response && response.code;
  if (code !== 0 && code !== '0') {
    throw new Error(`MSSW 事件导出创建任务失败: ${response.msg || JSON.stringify(response).slice(0, 500)}`);
  }

  return response;
}

async function pollMsswIncidentExportTask(cookieInfo, msswBaseUrl, taskId, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 120000);
  const intervalMs = Number(options.pollIntervalMs || 3000);
  const startedAt = Date.now();
  const logger = options.logger;
  const companyId = options.customerId || options.companyId || '';
  const headers = buildMsswExportHeaders(cookieInfo, msswBaseUrl, companyId);
  const url = `https://${normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL)}${MSSW_INCIDENT_EXPORT_ENDPOINT}/query`;
  let lastStatus = '';

  while (Date.now() - startedAt <= timeoutMs) {
    const response = await requestJson(url, {
      headers,
      body: JSON.stringify({ task_id: taskId })
    });

    const code = response && response.code;
    if (code !== 0 && code !== '0') {
      throw new Error(`MSSW 事件导出查询任务失败: ${response.msg || JSON.stringify(response).slice(0, 500)}`);
    }

    const data = response && response.data && typeof response.data === 'object' ? response.data : {};
    const status = String(data.status || '').toLowerCase();

    if (status !== lastStatus) {
      logInfo(logger, `事件导出任务状态: ${status}`);
      lastStatus = status;
    }

    if (status === 'completed') {
      return response;
    }

    if (status === 'failed' || status === 'error') {
      throw new Error(`MSSW 事件导出失败: ${data.error_msg || '未知错误'}`);
    }

    await sleep(intervalMs);
  }

  throw new Error(`MSSW 事件导出轮询超时: ${timeoutMs}ms`);
}

async function downloadMsswIncidentFile(cookieInfo, msswBaseUrl, taskId, downloadDir, filename, companyId) {
  const msswHost = normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL);
  const downloadUrl = `https://${msswHost}${MSSW_INCIDENT_EXPORT_ENDPOINT}/${taskId}/download`;

  const csrfToken = cookieInfo.cookies && cookieInfo.cookies['csrf_token'] || '';
  const headers = buildMsswHeaders(cookieInfo.cookieString, msswHost, {
    accept: '*/*',
    'x-mssw-company-id': String(companyId || ''),
    'x-csrf-token': csrfToken
  });
  delete headers['x-requested-with'];
  delete headers['content-type'];

  const downloaded = await requestBuffer(downloadUrl, { headers });
  const targetPath = path.join(downloadDir, filename);
  await fsp.mkdir(downloadDir, { recursive: true });
  await fsp.writeFile(targetPath, downloaded.buffer);

  return {
    ...downloaded,
    filePath: targetPath,
    filename,
    downloadUrl
  };
}

async function exportMsswIncidentList(options) {
  const logger = options.logger;
  logInfo(logger, `导出 MSSW 事件表: ${options.start} ~ ${options.end}`);
  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const msswBaseUrl = normalizeBaseUrl(options.msswBaseUrl || DEFAULT_MSSW_BASE_URL);
  const companyId = options.customerId || options.companyId || '';

  const exportResponse = await triggerMsswIncidentExport(cookieInfo, msswBaseUrl, options);
  const exportData = exportResponse && exportResponse.data && typeof exportResponse.data === 'object' ? exportResponse.data : {};
  const taskId = exportData.task_id;
  if (!taskId) {
    throw new Error(`MSSW 事件导出创建任务返回缺少 task_id: ${JSON.stringify(exportResponse).slice(0, 500)}`);
  }

  logInfo(logger, `事件导出任务: ${taskId}`);

  const queryResponse = await pollMsswIncidentExportTask(cookieInfo, msswBaseUrl, taskId, options);
  const queryData = queryResponse && queryResponse.data && typeof queryResponse.data === 'object' ? queryResponse.data : {};
  const fileUrl = queryData.download_url;
  const fileName = queryData.file_name || `incident-export-${taskId}.xlsx`;

  if (!fileUrl) {
    throw new Error(`MSSW 事件导出查询返回缺少下载路径: ${JSON.stringify(queryResponse).slice(0, 500)}`);
  }

  const downloadDir = options.downloadDir || path.dirname(cookieInfo.resolvedPath);
  const downloaded = await downloadMsswIncidentFile(cookieInfo, msswBaseUrl, taskId, downloadDir, fileName, companyId);
  logInfo(logger, `MSSW 事件表: ${downloaded.filePath}`);

  // 误报事件过滤：从事件表中移除已被标记为误报的事件
  try {
    const { begin, end } = resolveMsswTimeRange(options);
    const startTimeMs = begin * 1000;
    const endTimeMs = end * 1000;
    const falsePositiveIds = await fetchMsswFalsePositiveIncidentIds(cookieInfo, msswBaseUrl, companyId, startTimeMs, endTimeMs, logger);
    if (falsePositiveIds.length > 0) {
      const removeResult = await removeIncidentRows(downloaded.filePath, falsePositiveIds);
      logInfo(logger, `误报事件过滤完成: ${removeResult.message}`);
    } else {
      logInfo(logger, '没有误报事件需要过滤');
    }
  } catch (error) {
    logInfo(logger, `误报事件过滤失败（不影响主流程）: ${error.message}`);
  }

  // 后处理：保存到 tmp/exports
  let processedPath = '';
  try {
    const processedResult = await processRiskListTable('incident', downloaded.filePath, {
      outputDir: options.outputDir
    });
    processedPath = processedResult.filePath;
    logInfo(logger, `事件表已写入 tmp/exports: ${processedPath}`);
  } catch (error) {
    throw new Error(`事件表写入 tmp/exports 失败: ${error.message}`);
  }

  return {
    msswBaseUrl,
    downloadDir,
    filePath: processedPath,
    tmpFilePath: processedPath,
    filename: downloaded.filename,
    taskId,
    fileUrl,
    downloadUrl: downloaded.downloadUrl,
    exportResponse,
    queryResponse,
    downloadResponse: {
      statusCode: downloaded.statusCode,
      headers: downloaded.headers
    }
  };
}

function buildMsswAssetExportRequestBody(exportFields, ids = [], searchType = 'current') {
  return {
    branch_id: 'all',
    search_type: searchType,
    is_all: false,
    ids: Array.isArray(ids) ? ids : [],
    exclude_ids: [],
    export_fields: exportFields
  };
}

async function fetchMsswExportFields(cookieInfo, msswBaseUrl, companyId) {
  const msswHost = normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL);
  const headers = buildMsswAssetExportHeaders(cookieInfo, msswHost, companyId);
  const url = `https://${msswHost}${MSSW_ASSET_EXPORT_FIELDS_ENDPOINT}`;
  const body = JSON.stringify({});
  headers['content-length'] = String(Buffer.byteLength(body));
  const response = await requestJson(url, {
    headers,
    body
  });

  if (!response || response.success !== true || !response.data) {
    throw new Error(`MSSW 资产字段接口返回异常: ${JSON.stringify(response).slice(0, 500)}`);
  }

  return response;
}

async function triggerMsswAssetExport(cookieInfo, msswBaseUrl, companyId, exportFields, ids = [], searchType = 'current') {
  const msswHost = normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL);
  const headers = buildMsswAssetExportHeaders(cookieInfo, msswHost, companyId);
  const url = `https://${msswHost}${MSSW_ASSET_EXPORT_ENDPOINT}`;
  const body = JSON.stringify(buildMsswAssetExportRequestBody(exportFields, ids, searchType));
  headers['content-length'] = String(Buffer.byteLength(body));
  // 默认导出接口超时 10 分钟；超时后由 exportMsswAssetList 兜底走分页接口
  const response = await requestJson(url, {
    headers,
    body,
    timeout: 600000
  });

  const code = response && response.code;
  const apiSuccess = response && (response.success === true || response.success === 'true');
  if (code !== 0 && code !== '0' && !apiSuccess) {
    throw new Error(`MSSW 资产导出接口返回异常: ${JSON.stringify(response).slice(0, 500)}`);
  }

  return response;
}

async function downloadMsswAssetFile(cookieInfo, msswBaseUrl, companyId, filename, downloadDir) {
  const msswHost = normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL);
  const downloadUrl = `https://${msswHost}${MSSW_ASSET_DOWNLOAD_ENDPOINT}?file=${encodeURIComponent(filename)}`;

  const csrfToken = cookieInfo.cookies && cookieInfo.cookies['csrf_token'] || '';
  const headers = buildMsswHeaders(cookieInfo.cookieString, msswHost, {
    accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/octet-stream,*/*',
    'x-mssw-company-id': String(companyId || ''),
    'x-csrf-token': csrfToken
  });
  delete headers['content-type'];

  const downloaded = await requestBuffer(downloadUrl, { headers });
  const targetPath = path.join(downloadDir, filename);
  await fsp.mkdir(downloadDir, { recursive: true });
  await fsp.writeFile(targetPath, downloaded.buffer);
  return {
    ...downloaded,
    filePath: targetPath
  };
}

async function exportMsswAssetList(options) {
  const logger = options.logger;
  logInfo(logger, '导出 MSSW 资产表（资产台账 + 待审核资产）');
  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const msswBaseUrl = normalizeBaseUrl(options.msswBaseUrl || DEFAULT_MSSW_BASE_URL);
  const companyId = options.customerId || options.companyId || '';
  const assetIds = options.assetIds || [];
  // 资产数量阈值：超过此值直接走分页导出，避免默认导出超时浪费时间
  const PAGED_EXPORT_THRESHOLD = 10000;

  if (assetIds.length) {
    logInfo(logger, `使用 ${assetIds.length} 个指定资产 ID 导出`);
  } else {
    logInfo(logger, '未指定资产 ID，将尝试导出全部资产');
  }

  const exportFieldsResponse = await fetchMsswExportFields(cookieInfo, msswBaseUrl, companyId);
  const downloadDir = options.downloadDir || path.dirname(cookieInfo.resolvedPath);

  let currentFilePath = '';
  let waitApproveFilePath = '';
  let currentFilename = '';
  let currentExport = null;
  let downloadResponse = null;

  // 双维度触发分页导出：
  // 1) 资产台账数量 > PAGED_EXPORT_THRESHOLD（默认 10000）时直接走分页，避免默认导出超时浪费时间
  // 2) 默认导出超时（10 分钟）后兜底走分页
  // 临时屏蔽：把 DISABLE_PAGED_EXPORT 置为 true 可绕过分页导出路径，回归"默认导出超时即失败"的旧行为
  const DISABLE_PAGED_EXPORT = false;
  const usingPagedFallback = { value: false };
  let preCheckedTotal = null;

  if (!DISABLE_PAGED_EXPORT && !assetIds.length) {
    try {
      const currentTotal = await fetchMsswAssetTotalCount(cookieInfo, msswBaseUrl, companyId, 'current');
      const waitApproveTotal = await fetchMsswAssetTotalCount(cookieInfo, msswBaseUrl, companyId, 'wait_approve');
      preCheckedTotal = Math.max(currentTotal, waitApproveTotal);
      logInfo(logger, `资产总数（接口预查）: 资产台账 ${currentTotal}，待审核 ${waitApproveTotal}，取最大值 ${preCheckedTotal} 作为分页阈值判断依据`);
    } catch (error) {
      logInfo(logger, `资产总数预查失败（继续走默认导出 + 超时兜底）: ${error.message}`);
      preCheckedTotal = null;
    }
  }

  if (!DISABLE_PAGED_EXPORT && preCheckedTotal !== null && preCheckedTotal > PAGED_EXPORT_THRESHOLD) {
    logInfo(logger, `资产台账 ${preCheckedTotal} > ${PAGED_EXPORT_THRESHOLD}，直接走分页导出（避免默认导出超时浪费时间）`);
    usingPagedFallback.value = true;
    const pagedResult = await pagedExportMsswAssetList({
      cookieInfo,
      msswBaseUrl,
      companyId,
      outputDir: downloadDir,
      pageSize: 1000,
      searchType: 'both',
      logger
    });
    currentFilePath = pagedResult.currentFilePath;
    waitApproveFilePath = pagedResult.waitApproveFilePath || '';
    currentFilename = currentFilePath ? path.basename(currentFilePath) : '';
    downloadResponse = null;
    currentExport = null;
  } else {
    // 第 1 步：尝试默认导出接口（超时 10 分钟）；超时后走分页兜底
    try {
      logInfo(logger, '导出资产台账（search_type=current，默认导出接口）');
      currentExport = await triggerMsswAssetExport(cookieInfo, msswBaseUrl, companyId, exportFieldsResponse.data, assetIds, 'current');
      currentFilename = String(currentExport && currentExport.data ? currentExport.data : currentExport && currentExport.filename ? currentExport.filename : '');
      if (!currentFilename) {
        throw new Error(`MSSW 资产台账导出接口返回缺少文件名: ${JSON.stringify(currentExport).slice(0, 500)}`);
      }
      const currentDownloaded = await downloadMsswAssetFile(cookieInfo, msswBaseUrl, companyId, currentFilename, downloadDir);
      currentFilePath = currentDownloaded.filePath;
      downloadResponse = { statusCode: currentDownloaded.statusCode, headers: currentDownloaded.headers };
      logInfo(logger, `资产台账: ${currentFilePath}`);

      // 第 2 步：导出待审核资产（search_type=wait_approve）
      try {
        logInfo(logger, '导出待审核资产（search_type=wait_approve）');
        const waitApproveExport = await triggerMsswAssetExport(cookieInfo, msswBaseUrl, companyId, exportFieldsResponse.data, assetIds, 'wait_approve');
        const waitApproveFilename = String(waitApproveExport && waitApproveExport.data ? waitApproveExport.data : waitApproveExport && waitApproveExport.filename ? waitApproveExport.filename : '');
        if (waitApproveFilename) {
          const waitApproveDownloaded = await downloadMsswAssetFile(cookieInfo, msswBaseUrl, companyId, waitApproveFilename, downloadDir);
          waitApproveFilePath = waitApproveDownloaded.filePath;
          logInfo(logger, `待审核资产: ${waitApproveFilePath}`);
        } else {
          logInfo(logger, '待审核资产导出接口返回缺少文件名，仅使用资产台账数据');
        }
      } catch (error) {
        logInfo(logger, `待审核资产导出失败（不影响主流程）: ${error.message}`);
      }
    } catch (error) {
      const isTimeout = isTimeoutError(error);
      if (!isTimeout) {
        // 非超时错误：直接抛出
        throw error;
      }
      if (DISABLE_PAGED_EXPORT) {
        // 屏蔽分页导出：超时即失败，不再兜底
        logInfo(logger, `默认导出接口超时（${error.message}），分页导出已屏蔽，直接失败`);
        throw error;
      }
      logInfo(logger, `默认导出接口超时（${error.message}），切换分页接口兜底导出`);
      usingPagedFallback.value = true;
      const pagedResult = await pagedExportMsswAssetList({
        cookieInfo,
        msswBaseUrl,
        companyId,
        outputDir: downloadDir,
        pageSize: 1000,
        searchType: 'both',
        logger
      });
      currentFilePath = pagedResult.currentFilePath;
      waitApproveFilePath = pagedResult.waitApproveFilePath || '';
      currentFilename = currentFilePath ? path.basename(currentFilePath) : '';
      downloadResponse = null;
    }
  }

  // 第 3 步：后处理 — 合并两个 xlsx，新增"审核状态"列
  let processedPath = '';
  try {
    const processedResult = await processRiskListTable('asset', currentFilePath, {
      outputDir: options.outputDir,
      waitApproveFilePath
    });
    processedPath = processedResult.filePath;
    const tag = usingPagedFallback.value ? '（分页兜底）' : '';
    logInfo(logger, `资产表已写入 tmp/exports: ${processedPath}（已合并待审核数据，新增审核状态列，删除多余列）${tag}`);
  } catch (error) {
    throw new Error(`资产表写入 tmp/exports 失败: ${error.message}`);
  }

  return {
    msswBaseUrl,
    downloadDir,
    filePath: processedPath,
    tmpFilePath: processedPath,
    filename: currentFilename,
    exportFields: exportFieldsResponse.data,
    exportResponse: currentExport,
    downloadResponse
  };
}

function isTimeoutError(error) {
  if (!error || typeof error.message !== 'string') return false;
  const text = error.message.toLowerCase();
  return text.includes('timeout') || text.includes('超时') || text.includes('etimedout') || text.includes('esockettimedout');
}

async function fetchMsswCustomerListPage(cookieInfo, msswBaseUrl, { companyId, keyword, offset, limit }) {
  const headers = buildMsswExportHeaders(cookieInfo, msswBaseUrl, companyId);
  const url = `https://${normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL)}${MSSW_CUSTOMER_STATISTIC_ENDPOINT}?_method=GET`;
  const response = await requestJson(url, {
    headers,
    body: JSON.stringify({
      order: 'desc',
      keyword: keyword || '',
      customer_category: 1,
      company_id: String(companyId || ''),
      offset: offset || 0,
      limit: limit || 20
    })
  });

  const code = response && response.code;
  if (code !== 0 && code !== '0') {
    throw new Error(`MSSW 客户列表查询失败: ${response.msg || JSON.stringify(response).slice(0, 500)}`);
  }

  return response;
}

async function fetchMsswProjectListByCompanyId(cookieInfo, msswBaseUrl, companyId) {
  const resolvedCompanyId = String(companyId || '').trim();
  if (!resolvedCompanyId) {
    throw new Error('MSSW 项目列表查询需要 companyId');
  }

  const headers = buildMsswExportHeaders(cookieInfo, msswBaseUrl, resolvedCompanyId);
  const url = `https://${normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL)}${MSSW_PROJECT_LIST_ENDPOINT}`;
  const response = await requestJson(url, {
    headers,
    body: JSON.stringify({
      company_id: resolvedCompanyId
    })
  });

  const code = response && response.code;
  if (code !== 0 && code !== '0') {
    throw new Error(`MSSW 项目列表查询失败: ${response.msg || JSON.stringify(response).slice(0, 500)}`);
  }

  return response;
}

function formatDateFromTimestampMs(timestampMs) {
  const date = new Date(Number(timestampMs));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`无效时间戳: ${timestampMs}`);
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function resolveDefaultProjectTimeRangeFromResponse(response, reportGeneratedAt) {
  const generatedAt = reportGeneratedAt instanceof Date ? reportGeneratedAt : new Date(reportGeneratedAt || Date.now());
  if (Number.isNaN(generatedAt.getTime())) {
    throw new Error('报告生成时间无效');
  }

  const projects = Array.isArray(response && response.data) ? response.data : [];
  const services = projects.flatMap((project) => Array.isArray(project && project.service_info) ? project.service_info : []);
  if (!services.length) {
    throw new Error('MSSW 项目列表中没有 service_info，无法推导默认时间范围');
  }

  const serviceStartList = services
    .map((service) => Number(service && service.billing_start_time))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!serviceStartList.length) {
    throw new Error('MSSW 项目列表缺少有效的 billing_start_time，无法推导默认开始时间');
  }

  const nonNullServiceEnds = services
    .map((service) => Number(service && service.billing_end_time))
    .filter((value) => Number.isFinite(value) && value > 0);

  const minServiceStart = Math.min(...serviceStartList);
  const minServiceEnd = nonNullServiceEnds.length ? Math.min(...nonNullServiceEnds) : null;
  const endOfTodayMs = generatedAt.getTime();
  const effectiveEndMs = minServiceEnd === null ? endOfTodayMs : Math.min(endOfTodayMs, minServiceEnd);

  if (minServiceStart > effectiveEndMs) {
    throw new Error('MSSW 服务时间异常: 推导出的开始时间晚于结束时间');
  }

  return {
    start: formatDateFromTimestampMs(minServiceStart),
    end: formatDateFromTimestampMs(effectiveEndMs),
    meta: {
      serviceStartMs: minServiceStart,
      serviceEndMs: minServiceEnd,
      reportGeneratedAtMs: generatedAt.getTime(),
      effectiveEndMs
    }
  };
}

async function fetchDefaultProjectTimeRange(cookieInfo, msswBaseUrl, companyId, reportGeneratedAt) {
  const response = await fetchMsswProjectListByCompanyId(cookieInfo, msswBaseUrl, companyId);
  return resolveDefaultProjectTimeRangeFromResponse(response, reportGeneratedAt);
}

async function findMsswCustomerIdByName(cookieInfo, msswBaseUrl, customerName) {
  if (!customerName || !String(customerName).trim()) {
    throw new Error('findMsswCustomerIdByName 需要 customerName 参数');
  }

  const name = String(customerName).trim();
  const pageSize = 20;
  let offset = 0;
  let foundId = null;

  while (foundId === null) {
    const response = await fetchMsswCustomerListPage(cookieInfo, msswBaseUrl, {
      keyword: name,
      offset,
      limit: pageSize
    });

    const data = response && response.data && typeof response.data === 'object' ? response.data : {};
    const list = Array.isArray(data.list) ? data.list : [];
    const total = Number(data.total || 0);

    for (const item of list) {
      if (item && String(item.company_name || '').trim() === name) {
        foundId = String(item.company_id || '');
        break;
      }
    }

    if (foundId !== null) {
      break;
    }

    offset += pageSize;
    if (offset >= total || list.length < pageSize) {
      break;
    }
  }

  if (!foundId) {
    throw new Error(`未找到匹配的客户: ${name}，请检查 --customer 参数或手动指定 --customer-id`);
  }

  return foundId;
}

async function exportMsswDeviceList(options) {
  const logger = options.logger;
  logInfo(logger, '导出 MSSW 设备表');
  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const msswBaseUrl = normalizeBaseUrl(options.msswBaseUrl || DEFAULT_MSSW_BASE_URL);
  const companyId = options.customerId || options.companyId || '';
  const pageSize = 20;
  const firstResponse = await fetchMsswDeviceList(cookieInfo, msswBaseUrl, companyId, pageSize, 1, [1, 2, 3, 4]);
  const firstData = firstResponse && firstResponse.data && typeof firstResponse.data === 'object' ? firstResponse.data : {};
  const total = Number(firstData.total || 0);
  const firstPageDevices = Array.isArray(firstData.list) ? firstData.list : [];
  const devices = [...firstPageDevices];
  const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;

  for (let pageNum = 2; pageNum <= totalPages; pageNum += 1) {
    const pageResponse = await fetchMsswDeviceList(cookieInfo, msswBaseUrl, companyId, pageSize, pageNum, [1, 2, 3, 4]);
    const pageData = pageResponse && pageResponse.data && typeof pageResponse.data === 'object' ? pageResponse.data : {};
    const pageDevices = Array.isArray(pageData.list) ? pageData.list : [];
    devices.push(...pageDevices);
  }

  const response = {
    ...firstResponse,
    data: {
      ...firstData,
      list: devices
    }
  };
  const outputPath = path.join(path.resolve(__dirname, '..'), 'tmp', 'device.json');
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, JSON.stringify(response, null, 2), 'utf8');
  logInfo(logger, 'MSSW 设备表: ' + outputPath + ' (共 ' + devices.length + ' 条)');

  return {
    msswBaseUrl,
    filePath: outputPath,
    response
  };
}

async function fetchMsswAssetOverview(options = {}) {
  const logger = options.logger;

  logInfo(logger, '拉取 MSSW 资产台账统计');

  const cookieInfo = options.msswCookieInfo || await readMsswCookieInfo(options.msswCookiePath);
  const xdrBaseUrl = normalizeBaseUrl(options.msswBaseUrl || DEFAULT_MSSW_BASE_URL);
  const companyId = options.customerId || '';

  const start = options.start || (options.projectBackground && options.projectBackground.startDate) || options.begin;
  const end = options.end || (options.projectBackground && options.projectBackground.endDate);
  const timeOptions = {
    ...options,
    start,
    end
  };

  const assetReadyToOutboundResponse = await fetchMsswAssetReadyToOutbound(cookieInfo, xdrBaseUrl, companyId);

  const assetLedger = {
    ...normalizeAssetReadyToOutboundResponse(assetReadyToOutboundResponse),
    manage_asset: 0,
    typeDistribution: [],
    protectionDistribution: [],
    internetExposureDistribution: []
  };

  let incidentGptStats = {
    total: 0,
    hostCompromise: {
      total: 0,
      confirmedIncidentIds: []
    },
    virusTrojan: {
      total: 0,
      confirmedIncidentIds: []
    },
    threatActorStats: [],
    virusAttackAsset: '',
    virusAttackAssetEmpty: true,
    nonAesCoveredAssetsHideHint: true,
    nonAesCoveredAssetsAllInstalledHide: true,
    nonAesCoveredAssetsIps: '',
    unlabeledAssetsHideHint: true
  };
  let caseStudy = buildEmptyCaseStudy();

  try {
    const timeRange = resolveIncidentTimeRange(timeOptions);
    const startTimeMs = timeRange.begin * 1000;
    const endTimeMs = timeRange.end * 1000;
    incidentGptStats = await fetchMsswIncidentGptStats(cookieInfo, xdrBaseUrl, companyId, startTimeMs, endTimeMs, logger, options.incidentFilePath);
  } catch (error) {
    logInfo(logger, `获取事件表 GPT 研判结论统计失败: ${error.message}，将使用空结果`);
  }

  // 从事件表/资产表提取三类资产信息
  if (options.incidentFilePath) {
    try {
      const allIds = [
        ...(incidentGptStats.hostCompromise?.confirmedIncidentIds || []),
        ...(incidentGptStats.virusTrojan?.confirmedIncidentIds || [])
      ];
      const virusIds = incidentGptStats.virusTrojan?.confirmedIncidentIds || [];
      if (allIds.length > 0) {
        const assetInfo = await extractIncidentAssetInfo(
          options.incidentFilePath,
          options.assetFilePath || '',
          allIds,
          virusIds
        );
        incidentGptStats.virusAttackAsset = assetInfo.virusAttackAsset || '';
        incidentGptStats.virusAttackAssetEmpty = !incidentGptStats.virusAttackAsset;
        incidentGptStats.nonAesCoveredAssets = assetInfo.nonAesCoveredAssets || [];
        incidentGptStats.nonAesCoveredAssetsIps = incidentGptStats.nonAesCoveredAssets.filter(Boolean).join('、');
        incidentGptStats.nonAesCoveredAssetsHideHint = incidentGptStats.nonAesCoveredAssets.length === 0;
        incidentGptStats.nonAesCoveredAssetsAllInstalledHide = incidentGptStats.nonAesCoveredAssets.length > 0;
        incidentGptStats.unlabeledAssets = assetInfo.unlabeledAssets || [];
        incidentGptStats.unlabeledAssetsHideHint = incidentGptStats.unlabeledAssets.length === 0;
        logInfo(logger, `提取事件资产信息完成: 病毒攻击资产=${incidentGptStats.virusAttackAsset}, ` +
          `未被AES覆盖=${incidentGptStats.nonAesCoveredAssets.length}个, ` +
          `未标注资产=${incidentGptStats.unlabeledAssets.length}个`);
      }
    } catch (error) {
      logInfo(logger, `提取事件资产信息失败（不影响主流程）: ${error.message}`);
    }

    try {
      const c2Ids = incidentGptStats.hostCompromise?.confirmedIncidentIds || [];
      const c2Examples = await extractC2ConnectionExamples(options.incidentFilePath, c2Ids);
      incidentGptStats.c2ConnectionExamples = Array.isArray(c2Examples.c2Connections)
        ? c2Examples.c2Connections
        : [];
      logInfo(logger, `提取 C2 外联事件举例完成: ${incidentGptStats.c2ConnectionExamples.length} 条`);
    } catch (error) {
      logInfo(logger, `提取 C2 外联事件举例失败（不影响主流程）: ${error.message}`);
    }

    try {
      const virusIds = incidentGptStats.virusTrojan?.confirmedIncidentIds || [];
      const virusExamples = await extractVirusTrojanExamples(options.incidentFilePath, virusIds);
      incidentGptStats.virusTrojanExamples = Array.isArray(virusExamples.viruses)
        ? virusExamples.viruses
        : [];
      logInfo(logger, `提取病毒木马事件举例完成: ${incidentGptStats.virusTrojanExamples.length} 条`);
    } catch (error) {
      logInfo(logger, `提取病毒木马事件举例失败（不影响主流程）: ${error.message}`);
    }
  }

  try {
    if (options.incidentFilePath) {
      const timeRange = resolveIncidentTimeRange(timeOptions);
      caseStudy = await fetchIncidentCaseStudy({
        incidentFilePath: options.incidentFilePath,
        c2Ids: incidentGptStats.hostCompromise?.confirmedIncidentIds || [],
        virusIds: incidentGptStats.virusTrojan?.confirmedIncidentIds || [],
        exploitIds: Array.isArray(options.exploitIncidentIds) ? options.exploitIncidentIds : [],
        msswCookieInfo: cookieInfo,
        msswBaseUrl: xdrBaseUrl,
        companyId,
        range: timeRange,
        logger
      });
      logInfo(logger, `典型案例已提取: incident=${caseStudy.selectedIncidentId || '无'}, attack=${caseStudy.attackTimeline.length}, defense=${caseStudy.defenseTimeline.length}`);
    }
  } catch (error) {
    logInfo(logger, `提取典型案例失败（不影响主流程）: ${error.message}`);
  }

  let securityLogTotal = 0;
  let alertTotal = 0;
  let alertReductionRate = 0;
  try {
    [securityLogTotal, alertTotal] = await Promise.all([
      fetchMsswSecurityLogCount(cookieInfo, xdrBaseUrl, companyId, timeOptions).catch(() => 0),
      fetchMsswAlertTableCount(cookieInfo, xdrBaseUrl, companyId, timeOptions).then((r) => r.total).catch(() => 0)
    ]);
  } catch (error) {
    logInfo(logger, `获取安全日志量或有效告警统计失败: ${error.message}，将使用空结果`);
  }

  return {
    projectBackground: options.projectBackground || {},
    assetLedger,
    riskOverview: {
      incidentGptStats,
      securityLogTotal,
      alertTotal,
      alertReductionRate,
      closeRate: alertReductionRate
    },
    riskDetails: {
      securityLogTotal,
      alertTotal,
      alertReductionRate,
      closeRate: alertReductionRate,
      caseStudy,
      highRiskIncidentExamples: {
        viruses: Array.isArray(incidentGptStats.virusTrojanExamples)
          ? incidentGptStats.virusTrojanExamples
          : [],
        c2Connections: Array.isArray(incidentGptStats.c2ConnectionExamples)
          ? incidentGptStats.c2ConnectionExamples
          : []
      }
    }
  };
}

async function fetchMsswDeviceList(cookieInfo, msswBaseUrl, companyId, pageSize, pageNum = 1, devStatus) {
  const headers = buildMsswExportHeaders(cookieInfo, msswBaseUrl, companyId);
  const url = `https://${normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL)}${DEVICE_LIST_ENDPOINT}`;
  const response = await requestJson(url, {
    headers,
    body: JSON.stringify({
      keyword: '',
      type: 0,
      pageSize: pageSize || 1000,
      pageNum,
      devStatus: devStatus || [1, 2, 3, 4]
    })
  });
  // MSSW 设备列表接口成功时 code 可能是 "Success" 或 0
  const code = response && response.code;
  if (code !== 'Success' && code !== 0 && code !== '0' && code !== undefined) {
    throw new Error(`MSSW 设备列表接口返回异常: ${JSON.stringify(response).slice(0, 500)}`);
  }
  return response;
}

async function fetchMsswThirdPartyDeviceStats(cookieInfo, msswBaseUrl, companyId) {
  const headers = buildMsswExportHeaders(cookieInfo, msswBaseUrl, companyId);
  const url = `https://${normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL)}${THIRD_PARTY_DEVICE_STATS_ENDPOINT}`;
    const response = await requestJson(url, {
    headers,
    body: JSON.stringify({
      name: '',
      appIds: [],
      hostIp: '',
      statusList: [],
      abilityTypeList: [],
      enableList: [],
      appInstanceId: '',
      pageIndex: 1,
      pageSize: 20
    })
  });
  // MSSW 第三方设备统计接口成功时 code 可能是 "Success" 或 0
  const code = response && response.code;
  if (code !== 'Success' && code !== 0 && code !== '0' && code !== undefined) {
    throw new Error(`MSSW 第三方设备统计接口返回异常: ${JSON.stringify(response).slice(0, 500)}`);
  }
  return response;
}

async function collectMsswDeviceCategoryCounts(cookieInfo, msswBaseUrl, companyId, logger) {
  const log = typeof logger === 'function' ? logger : function() {};
  // 查询深信服设备列表 (MSSW)
  let firstPageResponse;
  try {
    firstPageResponse = await fetchMsswDeviceList(cookieInfo, msswBaseUrl, companyId, 1000, 1);
  } catch (error) {
    throw new Error(`获取 MSSW 设备列表失败: ${error.message}`);
  }

  const firstPageData = firstPageResponse && firstPageResponse.data && typeof firstPageResponse.data === 'object' ? firstPageResponse.data : {};
  const totalSangfor = Number(firstPageData.total || 0);
  const firstPageDevices = Array.isArray(firstPageData.list) ? firstPageData.list : [];

  const categoryCounts = { af: 0, aes: 0, sip: 0, sta: 0, other: 0 };
  const pageSize = 1000;
  const totalPages = totalSangfor > 0 ? Math.ceil(totalSangfor / pageSize) : 1;
  const devices = [...firstPageDevices];

  for (let pageNum = 2; pageNum <= totalPages; pageNum += 1) {
    const pageResponse = await fetchMsswDeviceList(cookieInfo, msswBaseUrl, companyId, pageSize, pageNum);
    const pageData = pageResponse && pageResponse.data && typeof pageResponse.data === 'object' ? pageResponse.data : {};
    const pageDevices = Array.isArray(pageData.list) ? pageData.list : [];
    devices.push(...pageDevices);
  }

  for (const device of devices) {
    const category = classifyDeviceType(Number(device.devType));
    if (categoryCounts[category] !== undefined) {
      categoryCounts[category] += 1;
    }
  }

  // 单独查询第三方设备（容错，查不到就记为 0）
  let totalThird = 0;
  try {
    const thirdPartyResponse = await fetchMsswThirdPartyDeviceStats(cookieInfo, msswBaseUrl, companyId);
    const thirdPartyData = thirdPartyResponse && thirdPartyResponse.data && typeof thirdPartyResponse.data === 'object' ? thirdPartyResponse.data : {};
    totalThird = Number(thirdPartyData.count || 0);
    log(`MSSW 第三方设备数量: ${totalThird}`);
  } catch (error) {
    log(`获取 MSSW 第三方设备数量失败: ${error.message}，将跳过第三方设备统计`);
  }

  return {
    devices: totalSangfor + totalThird,
    sangfor: totalSangfor,
    af: categoryCounts.af,
    aes: categoryCounts.aes,
    sip: categoryCounts.sip,
    sta: categoryCounts.sta,
    other_sf: categoryCounts.other,
    third: totalThird
  };
}

// ========== MSSW 安全日志量查询（数据湖 ckCount 接口）==========

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function formatTimestampToDateTime(seconds) {
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`无效时间戳: ${seconds}`);
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const sec = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${min}:${sec}`;
}

function buildMsswLogSearchCountRequestBody({ tableId, fromDate, toDate, companyId }) {
  return {
    fromDate,
    toDate,
    tableId: [tableId],
    searchString: '',
    constrains: [
      {
        fieldAlias: '客户',
        fieldName: 'customer',
        fieldOperater: '=',
        fieldValue: String(companyId)
      }
    ],
    quickSearch: {},
    datalakeClusterName: ''
  };
}

function buildMsswLogSearchCountHeaders(cookieInfo, msswBaseUrl) {
  const msswHost = normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL);
  const csrfToken = cookieInfo.cookies && cookieInfo.cookies['csrf_token'] || '';
  return {
    host: msswHost,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    cookie: cookieInfo.cookieString,
    origin: `https://${msswHost}`,
    referer: `https://${msswHost}/ui-analyze/index.html`,
    'sec-ch-ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    traceid: generateUUID(),
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'x-csrftoken': csrfToken,
    'x-requested-with': 'XMLHttpRequest'
  };
}

async function fetchMsswLogCountByTable(cookieInfo, msswBaseUrl, companyId, tableId, fromDate, toDate) {
  const url = 'https://' + normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL) + MSSW_LOG_SEARCH_COUNT_ENDPOINT;
  const headers = buildMsswLogSearchCountHeaders(cookieInfo, msswBaseUrl);
  const response = await requestJson(url, {
    headers,
    body: JSON.stringify(buildMsswLogSearchCountRequestBody({ tableId, fromDate, toDate, companyId })),
    timeout: 90000
  });

  const code = response && response.code;
  if (code !== 0 && code !== '0') {
    throw new Error(`MSSW 数据湖日志数量查询接口(tableId=${tableId})返回异常: ${JSON.stringify(response).slice(0, 500)}`);
  }

  const data = response && response.data && typeof response.data === 'object' ? response.data : {};
  const total = Number(data.total || 0);
  if (!Number.isFinite(total)) {
    throw new Error(`MSSW 数据湖日志数量接口(tableId=${tableId})返回 data.total 无效: ${JSON.stringify(response).slice(0, 500)}`);
  }
  return total;
}

/**
 * 调用 Python 脚本删除事件表中的"外网IP地址"、"域名"、"文件"三列。
 * @param {string} inputPath 事件表 xlsx 文件路径
 * @returns {Promise<{filePath: string}>} 处理后的文件路径
 */
async function removeIncidentSensitiveColumns(inputPath, outputDir) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'remove_incident_columns.py');
  const resolvedOutputDir = outputDir || getTmpExportDir();
  await fsp.mkdir(resolvedOutputDir, { recursive: true });

  return new Promise((resolve, reject) => {
    execFile('python3', [scriptPath, encodePath(inputPath), encodePath(resolvedOutputDir)], { encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) }, (error, stdout, stderr) => {
      if (error) {
        execFile('python', [scriptPath, encodePath(inputPath), encodePath(resolvedOutputDir)], { encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) }, (err2, stdout2, stderr2) => {
          if (err2) {
            const python3Detail = stderr ? stderr.trim() : error.message;
            const pythonDetail = stderr2 ? stderr2.trim() : err2.message;
            reject(new Error(`删除事件表敏感列失败 (python3: ${python3Detail}, python: ${pythonDetail})`));
            return;
          }
          try {
            resolve(JSON.parse(stdout2));
          } catch (e) {
            reject(new Error(`解析删除敏感列结果失败: ${stdout2.slice(0, 500)}`));
          }
        });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`解析删除敏感列结果失败: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

async function fetchMsswSecurityLogCount(cookieInfo, msswBaseUrl, companyId, options) {
  // 分两次查: tableId=62(网络安全日志) + tableId=26(终端安全日志)，求和
  const { begin, end } = resolveIncidentTimeRange(options);
  const fromDate = formatTimestampToDateTime(begin);
  const toDate = formatTimestampToDateTime(end);

  const [networkLogTotal, endpointLogTotal] = await Promise.all([
    fetchMsswLogCountByTable(cookieInfo, msswBaseUrl, companyId, 62, fromDate, toDate),
    fetchMsswLogCountByTable(cookieInfo, msswBaseUrl, companyId, 26, fromDate, toDate)
  ]);

  return networkLogTotal + endpointLogTotal;
}

/**
 * 计算近 30 天的有效时间范围（接口仅支持近 30 天数据）。
 * 取用户报告范围与「今天往前推 30 天」的交集。r
 * @param {string} start - YYYY-MM-DD
 * @param {string} end   - YYYY-MM-DD
 * @returns {{from_date:number, to_date:number, effectiveStart:string, effectiveEnd:string}}
 */
function resolveSecurityStatsTimeRange(start, end) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 近 30 天：今天往前推 29 天（含今天，共 30 天）
  const recentStart = new Date(today);
  recentStart.setDate(recentStart.getDate() - 29);
  const recentStartMs = recentStart.getTime();
  const recentEndMs = today.getTime() + 24 * 60 * 60 * 1000 - 1; // 含今天全天

  const userStartMs = parseLocalDate(start, false) * 1000;
  const userEndMs = parseLocalDate(end, true) * 1000;

  // 取交集：报告范围 ∩ 近30天
  const effectiveStartMs = Math.max(userStartMs, recentStartMs);
  const effectiveEndMs = Math.min(userEndMs, recentEndMs);

  if (effectiveStartMs > effectiveEndMs) {
    return null; // 无交集
  }

  return {
    from_date: Math.floor(effectiveStartMs / 1000),
    to_date: Math.floor(effectiveEndMs / 1000),
    effectiveStartMs,
    effectiveEndMs
  };
}

/**
 * 调用安全体检报告统计接口，获取攻击态势数据。
 * POST /gateway/log-search-center-service/datalake/v1/personalized_report/security_check_report_stats
 * @param {object} cookieInfo  - readMsswCookieInfo 返回的 cookie 信息
 * @param {string} msswBaseUrl - MSSW 基础域名（动态）
 * @param {string} customerId  - 客户 ID
 * @param {string} customerName - 客户名（写入 tenant_info.tenant_name）
 * @param {string} start - YYYY-MM-DD 报告起始时间
 * @param {string} end   - YYYY-MM-DD 报告结束时间
 * @returns {Promise<object|null>} 接口响应 data.list[0]，无交集/接口失败时返回 null
 */
async function fetchSecurityCheckReportStats(cookieInfo, msswBaseUrl, customerId, customerName, start, end) {
  const timeRange = resolveSecurityStatsTimeRange(start, end);
  if (!timeRange) {
    return null; // 报告范围不在近 30 天内
  }

  const url = 'https://' + normalizeBaseUrl(msswBaseUrl || DEFAULT_MSSW_BASE_URL) + SECURITY_CHECK_REPORT_STATS_ENDPOINT;
  const headers = buildMsswLogSearchCountHeaders(cookieInfo, msswBaseUrl);
  const body = JSON.stringify({
    condition: {
      from_date: timeRange.from_date,
      to_date: timeRange.to_date
    },
    top_n: 1,
    tenant_info: [
      {
        tenant_id: String(customerId || ''),
        tenant_name: String(customerName || '')
      }
    ]
  });

  const response = await requestJson(url, { headers, body });
  const code = response && response.code;
  if (code !== 0 && code !== '0') {
    throw new Error(`攻击态势接口查询失败: ${response.msg || JSON.stringify(response).slice(0, 500)}`);
  }

  const list = response && response.data && Array.isArray(response.data.list) ? response.data.list : [];
  return list.length ? list[0] : null;
}

/**
 * 格式化攻击态势的占比百分数。
 * 规则：
 *   - totalAttack <= 0 时返回 '0'（话术渲染为「0%」）
 *   - 能除尽（整数 / 一位小数 / 两位小数）则按实际位数返回，去掉末尾多余的 0
 *   - 除不尽则四舍五入保留最多两位小数
 * @param {number} nightAttack
 * @param {number} totalAttack
 * @returns {string} 百分数的数字部分（不含 %）
 */
function formatAttackRatio(nightAttack, totalAttack) {
  if (!totalAttack || totalAttack <= 0) {
    return '0';
  }
  const ratio = (Number(nightAttack || 0) / totalAttack) * 100;
  // 先按两位小数四舍五入，再去掉末尾多余的 0 和小数点
  return String(Math.round(ratio * 100) / 100);
}

/**
 * 计算攻击态势总览展示数据。
 * - daily_avg = total_attack_count / count_list.length（总次数/天数，四舍五入；dayCount=0 时兜底为 0）
 * - night_ratio = night_attack_count / total_attack_count（百分数：能除尽则按实际位数显示，除不尽四舍五入保留最多两位小数；
 *   去掉末尾多余的 0，整数结果不带小数点；totalAttack=0 时返回 '0'）
 * - trend_dates = report_date 仅取 MM-DD
 * - trend_values = attack_count
 * @param {object} stats - 接口返回的 list[0]
 * @returns {object} attackOverview 字段
 */
function calculateAttackOverview(stats) {
  if (!stats || typeof stats !== 'object') {
    return null;
  }

  const totalAttack = Number(stats.total_attack_count || 0);
  const nightAttack = Number(stats.night_attack_count || 0);
  const workdayAttack = Math.max(totalAttack - nightAttack, 0);
  const countList = Array.isArray(stats.count_list) ? stats.count_list : [];
  const dayCount = countList.length;
  const dailyAvg = dayCount > 0 ? Math.round(totalAttack / dayCount) : 0;
  const nightRatio = formatAttackRatio(nightAttack, totalAttack);

  const trendDates = countList.map((item) => {
    const reportDate = String(item && item.report_date || '');
    // YYYY-MM-DD → MM-DD
    return reportDate.length >= 10 ? reportDate.slice(5, 10) : reportDate;
  });
  const trendValues = countList.map((item) => Number(item && item.attack_count || 0));

  return {
    total_attack_count: totalAttack,
    night_attack_count: nightAttack,
    workday_attack_count: workdayAttack,
    daily_avg: dailyAvg,
    night_ratio: nightRatio,
    trend_dates: trendDates,
    trend_values: trendValues,
    error: stats.error || ''
  };
}

module.exports = {
  DEFAULT_MSSW_BASE_URL,
  DEFAULT_SOAR_BASE_URL,
  normalizeBaseUrl,
  normalizeCookieContent,
  readXdrCookieInfo,
  readMsswCookieInfo,
  readSoarCookieInfo,
  buildMsswHeaders,
  buildMsswExportHeaders,
  buildMsswIncidentExportRequestBody,
  resolveMsswTimeRange,
  triggerMsswIncidentExport,
  pollMsswIncidentExportTask,
  downloadMsswIncidentFile,
  exportMsswIncidentList,
  fetchMsswCustomerListPage,
  fetchMsswProjectListByCompanyId,
  resolveDefaultProjectTimeRangeFromResponse,
  fetchDefaultProjectTimeRange,
  findMsswCustomerIdByName,
  buildExportFieldsRequestBody,
  buildAssetExportRequestBody,
  buildAssetCountRequestBody,
  buildAlertCountRequestBody,
  mapProtectionTypeLabels,
  mapExposureTypeLabels,
  mapAssetTypeLabels,
  parseLocalDate,
  resolveIncidentTimeRange,
  normalizeAssetReadyToOutboundResponse,
  fetchMsswAssetOverview,
  fetchMsswAlertTableCount,
  fetchContainedAlertCount,
  fetchMsswSecurityLogCount,
  MSSW_LOG_SEARCH_COUNT_ENDPOINT,
  buildMsswLogSearchCountRequestBody,
  buildMsswLogSearchCountHeaders,
  fetchMsswLogCountByTable,
  SECURITY_CHECK_REPORT_STATS_ENDPOINT,
  fetchSecurityCheckReportStats,
  resolveSecurityStatsTimeRange,
  calculateAttackOverview,
  formatTimestampToDateTime,
  THREAT_ACTOR_NAMES,
  matchThreatActor,
  fetchMsswIncidentGptStats,
  DEVICE_TYPE_CATEGORIES,
  classifyDeviceType,
  buildMsswAssetExportRequestBody,
  fetchMsswExportFields,
  triggerMsswAssetExport,
  downloadMsswAssetFile,
  exportMsswAssetList,
  exportMsswDeviceList,
  fetchMsswDeviceList,
  fetchMsswThirdPartyDeviceStats,
  collectMsswDeviceCategoryCounts,
  MSSW_ASSET_COUNT_ENDPOINT,
  fetchMsswAssetCore,
  fetchMsswAssetReadyToOutbound,
  fetchMsswFalsePositiveIncidentIds,
  processRiskListTable,
  removeIncidentSensitiveColumns
};
