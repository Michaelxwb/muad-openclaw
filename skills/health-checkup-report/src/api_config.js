'use strict';

/**
 * 健康体检报告（health-checkup-report）API 集中配置加载（Node 侧）。
 *
 * 作用：读取 `config/api_config.json`，提供按平台（mssw / mssp）取 origin、
 * endpoint、Host 请求头的统一入口，避免域名散落在各业务文件中。
 *
 * - origin 支持环境变量覆盖（HEALTH_CHECKUP_MSSW_BASE_URL / HEALTH_CHECKUP_MSSP_BASE_URL）。
 * - 所有请求统一带 host_header 指定的 Host 头（nginx 靠 Host 路由，连接走 http:// + 端口）。
 */
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'api_config.json');

let cache = null;

function loadApiConfig(forceReload = false) {
  if (cache && !forceReload) {
    return cache;
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`API 配置文件不存在: ${CONFIG_PATH}`);
  }
  cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return cache;
}

/** 返回集中配置中的 host_header（统一请求 Host 头；无配置时为 inner.sangfor.com.cn）。 */
function getHostHeader() {
  const cfg = loadApiConfig();
  return String(cfg.host_header || 'inner.sangfor.com.cn');
}

/** 取某平台的 origin。优先平台级 env，其次配置文件 origin。 */
function getOrigin(platform) {
  const cfg = loadApiConfig();
  const section = cfg.platforms && cfg.platforms[platform];
  if (!section) {
    throw new Error(`api_config.json 缺少 platforms.${platform} 配置项`);
  }
  const envName = section.env;
  if (envName) {
    const envOrigin = process.env[envName];
    if (envOrigin) {
      return String(envOrigin).trim().replace(/\/+$/, '');
    }
  }
  const origin = section.origin;
  if (!origin) {
    throw new Error(`api_config.json 缺少 platforms.${platform}.origin 配置项`);
  }
  return String(origin).trim().replace(/\/+$/, '');
}

/** 取某平台的 endpoint 完整 URL（origin + path）。 */
function getEndpoint(platform, key) {
  const cfg = loadApiConfig();
  const section = cfg.platforms && cfg.platforms[platform];
  if (!section || !section.endpoints || !(key in section.endpoints)) {
    throw new Error(`api_config.json 缺少 platforms.${platform}.endpoints.${key} 配置项`);
  }
  return getOrigin(platform) + String(section.endpoints[key]);
}

/** 取某平台的 referer_path（默认 /index.html）。 */
function getRefererPath(platform) {
  const cfg = loadApiConfig();
  const section = cfg.platforms && cfg.platforms[platform];
  return section && section.referer_path ? String(section.referer_path) : '/index.html';
}

module.exports = {
  loadApiConfig,
  getHostHeader,
  getOrigin,
  getEndpoint,
  getRefererPath,
};
