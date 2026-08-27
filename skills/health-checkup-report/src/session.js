'use strict';
/**
 * 统一登录态模块（health-checkup-report）
 *
 * 作用：经 session-manager 一次性取 **mssw + mssp 两平台**的 session，
 * 私有写入 `SKILL_OUTPUT_DIR/session/{mssw,mssp}_cookies.txt`（0o600、随运行清理），
 * 供 Node 主链路（读 cookie 文件）与 Python 子进程（`--cookie-path` 读同一文件）串联使用。
 *
 * - mssw：客户数据（资产/事件/策略/设备/告警）
 * - mssp：easm 数据（暴露面/弱口令/漏洞/防护表）
 *
 * 凭据绝不写 stdout / 日志。
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const SKILL_NAME = 'health-checkup-report';

// 平台 slug 需与 session-manager 的 adapter 名一致（mssw / mssp）
const PLATFORM_MSSW = 'mssw';
const PLATFORM_MSSP = 'mssp';

// origin / host 头统一由 config/api_config.json 管理（线上默认，env 可覆盖）
const apiConfig = require('./api_config');
const MSSW_BASE_URL = apiConfig.getOrigin(PLATFORM_MSSW);
const MSSP_BASE_URL = apiConfig.getOrigin(PLATFORM_MSSP);
const HOST_HEADER = apiConfig.getHostHeader();

/** guard 注入的 SKILL_OUTPUT_DIR；缺失时仅开发调试 fallback 到系统临时目录（对齐 policy-check shared.output_dir）。 */
function outputDir() {
  const d = process.env.SKILL_OUTPUT_DIR;
  if (d) {
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  const tmp = path.join(os.tmpdir(), 'health-checkup-report');
  fs.mkdirSync(tmp, { recursive: true });
  return tmp;
}

function sessionDir() {
  return path.join(outputDir(), 'session');
}

function cookieFilePath(platform) {
  return path.join(sessionDir(), `${platform}_cookies.txt`);
}

/** 调 session-manager get-state 并读取 skill-scoped session 文件（内含各平台 cookies）。 */
function readSession() {
  const res = spawnSync('session-manager', ['get-state', '--skill-name', SKILL_NAME], {
    encoding: 'utf8',
    timeout: 60000,
  });
  if (res.error) {
    throw new Error(`调用 session-manager 失败: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`获取登录态失败: ${String(res.stderr || res.stdout || '').trim()}`);
  }
  let state;
  try {
    state = JSON.parse(res.stdout);
  } catch (e) {
    throw new Error(`session-manager 输出解析失败: ${e.message}`);
  }
  const sessionFile = state && state.sessionStateFile;
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    throw new Error('未获取到登录态文件，请先确认 mssw/mssp 平台已绑定并登录');
  }
  let session;
  try {
    session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  } catch (e) {
    throw new Error(`读取登录态文件失败: ${e.message}`);
  }
  return session;
}

/** 从 session.platforms.<slug>.cookies 拼 `name=value; name2=value2` cookie 串。 */
function cookieStringFor(platform, session) {
  const section = (session && session.platforms && session.platforms[platform]) || null;
  const cookies = section && section.cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return null;
  }
  const pairs = cookies
    .filter((c) => c && typeof c.name === 'string' && typeof c.value === 'string')
    .map((c) => `${c.name}=${c.value}`);
  return pairs.length ? pairs.join('; ') : null;
}

async function writePrivateCookieFile(platform, content) {
  await fsp.mkdir(sessionDir(), { recursive: true });
  const p = cookieFilePath(platform);
  await fsp.writeFile(p, content, { encoding: 'utf8', mode: 0o600 });
  return p;
}

/**
 * 取两平台登录态并写入私有 cookie 文件。
 * @returns {Promise<{msswCookiePath:string, msspCookiePath:?string, msswCookieString:string, msspCookieString:?string}>}
 * mssw 为必需；mssp（easm）缺失时返回 null 路径并告警（分支2 环节降级），不阻断主链路。
 */
async function resolveSessions(logger = () => {}) {
  const session = readSession();

  const msswCookieString = cookieStringFor(PLATFORM_MSSW, session);
  if (!msswCookieString) {
    throw new Error('登录态缺少 mssw 平台 cookie');
  }
  const msswCookiePath = await writePrivateCookieFile(PLATFORM_MSSW, msswCookieString);

  const msspCookieString = cookieStringFor(PLATFORM_MSSP, session);
  let msspCookiePath = null;
  if (msspCookieString) {
    msspCookiePath = await writePrivateCookieFile(PLATFORM_MSSP, msspCookieString);
  } else {
    logger('[session] 未获取到 mssp（easm）平台 cookie，弱口令/漏洞/暴露面环节将缺失');
  }

  return { msswCookiePath, msspCookiePath, msswCookieString, msspCookieString: msspCookieString || null };
}

module.exports = {
  SKILL_NAME,
  PLATFORM_MSSW,
  PLATFORM_MSSP,
  MSSW_BASE_URL,
  MSSP_BASE_URL,
  HOST_HEADER,
  resolveSessions,
  outputDir,
  sessionDir,
  cookieFilePath,
};
