'use strict';

/**
 * MSSW 资产分页导出（兜底方案）。
 *
 * 当默认导出接口 /apps/asset/view/asset/export 因数据量过大超时时，
 * 退而求其次通过 count + list 分页接口拉取全部资产，本地组装成 xlsx，
 * 然后交回 mssw_client.js 调用 process_risk_list_table.py 走原有合并流程。
 *
 * 本模块只负责调度 Python 脚本（scripts/mssw_asset_paged_export.py）并转发进度日志，
 * 不直接维护分页/HTTP 细节，便于后续维护。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const readline = require('readline');
const { encodePath } = require('./path_helper');

/**
 * 通过 Python 脚本走分页接口拉取资产并生成 xlsx。
 *
 * @param {Object} options
 * @param {{resolvedPath: string, cookieString: string}} options.cookieInfo readMsswCookieInfo 的返回值
 * @param {string} options.msswBaseUrl 形如 sitmssw.soar.sangfor.com（不带协议）
 * @param {string|number} options.companyId
 * @param {string} [options.outputDir] 默认 tmp/exports
 * @param {number} [options.pageSize] 默认 1000
 * @param {'current'|'wait_approve'|'both'} [options.searchType] 默认 both
 * @param {(msg: string) => void} [options.logger] 进度日志回调
 * @returns {Promise<{currentFilePath: string, waitApproveFilePath: string}>}
 */
async function pagedExportMsswAssetList(options) {
  const cookieInfo = options.cookieInfo;
  if (!cookieInfo || !cookieInfo.resolvedPath) {
    throw new Error('pagedExportMsswAssetList: cookieInfo.resolvedPath 缺失');
  }
  const msswBaseUrl = String(options.msswBaseUrl || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!msswBaseUrl) {
    throw new Error('pagedExportMsswAssetList: msswBaseUrl 缺失');
  }
  const companyId = String(options.companyId || '');
  if (!companyId) {
    throw new Error('pagedExportMsswAssetList: companyId 缺失');
  }

  const outputDir = options.outputDir || path.join(path.resolve(__dirname, '..'), 'tmp', 'exports');
  await fsp.mkdir(outputDir, { recursive: true });

  const scriptPath = path.join(__dirname, '..', 'scripts', 'mssw_asset_paged_export.py');
  const args = [
    scriptPath,
    '--cookie-path', encodePath(cookieInfo.resolvedPath),
    '--base-url', msswBaseUrl,
    '--company-id', companyId,
    '--output-dir', encodePath(outputDir),
    '--batch-size', String(options.pageSize || 1000),
    '--search-type', options.searchType || 'both'
  ];

  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  logger(`[paged-export] 启动分页导出: base=${msswBaseUrl} company=${companyId} searchType=${options.searchType || 'both'}`);

  const stdout = await runPython(args, logger);

  // Python 脚本最后会打印 '###JSON###' + JSON 结果
  const marker = '###JSON###';
  const idx = stdout.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error(`分页导出脚本未返回 JSON 标记: ${stdout.slice(-500)}`);
  }
  const jsonText = stdout.slice(idx + marker.length).trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`分页导出脚本 JSON 解析失败: ${jsonText.slice(0, 500)}`);
  }

  const result = {
    currentFilePath: parsed.currentFilePath || '',
    waitApproveFilePath: parsed.waitApproveFilePath || ''
  };
  // 校验文件存在
  if (result.currentFilePath && !fs.existsSync(result.currentFilePath)) {
    throw new Error(`分页导出返回的 currentFilePath 不存在: ${result.currentFilePath}`);
  }
  if (result.waitApproveFilePath && !fs.existsSync(result.waitApproveFilePath)) {
    logger(`[paged-export] waitApproveFilePath 不存在（可能为空），忽略: ${result.waitApproveFilePath}`);
    result.waitApproveFilePath = '';
  }
  return result;
}

/**
 * 跑 Python 脚本，stdout 按行实时转发到 logger，最终返回完整 stdout。
 *
 * 使用 spawn 而非 execFile，以便在长时间运行（2 小时+）过程中实时输出进度日志，
 * 而不是等进程退出后才一次性打印所有 stdout。
 */
function runPython(args, logger) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, {
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      PYTHONLEGACYWINDOWSSTDIO: '0'
    });
    // 分页导出可能涉及大数据量客户（20w+ 资产），需较长超时
    // 通过 spawn + setTimeout 实现，避免 execFile 在超时后无法获取已生成文件的边界问题
    const timeoutMs = 120 * 60 * 1000;
    let settled = false;
    let timeoutHandle = null;
    let childProc = null;
    let stdoutBuffer = '';
    let stderrBuffer = '';

    const tryRun = (cmd) => {
      childProc = spawn(cmd, args, { env, windowsHide: true });
      let cmdLabel = cmd;

      // 标准输出：实时按行转发到 logger
      const rl = readline.createInterface({ input: childProc.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        stdoutBuffer += line + '\n';
        if (line && !line.startsWith('###JSON###')) {
          logger(line);
        }
      });

      // 标准错误：实时按行转发到 logger（仅作日志，不阻断）
      const rlErr = readline.createInterface({ input: childProc.stderr, crlfDelay: Infinity });
      rlErr.on('line', (line) => {
        stderrBuffer += line + '\n';
        if (line) {
          logger(`[paged-export-stderr] ${line}`);
        }
      });

      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
      };

      const onExit = (code, signal) => {
        if (settled) return;
        cleanup();
        if (code !== 0 && code !== null) {
          // 如果是 python3 不存在，回退到 python
          if (cmd === 'python3' && (code === 127 || code === 1 || signal === 'ENOENT')) {
            logger(`[paged-export] python3 不可用 (code=${code})，尝试 python ...`);
            tryRun('python');
            return;
          }
          settled = true;
          reject(new Error(`分页导出脚本执行失败 (${cmdLabel}): code=${code} signal=${signal} stderr=${stderrBuffer.slice(-500)}`));
          return;
        }
        settled = true;
        resolve(stdoutBuffer);
      };

      childProc.on('error', (err) => {
        if (settled) return;
        // python3 不存在时 spawn 立即触发 ENOENT
        if (cmd === 'python3' && err && err.code === 'ENOENT') {
          logger(`[paged-export] python3 不存在 (ENOENT)，尝试 python ...`);
          tryRun('python');
          return;
        }
        cleanup();
        settled = true;
        reject(new Error(`分页导出脚本启动失败 (${cmdLabel}): ${err.message}`));
      });

      childProc.on('exit', onExit);
      childProc.on('close', (code, signal) => {
        // close 在 exit 之后触发，exit 已处理过就不再处理
        if (!settled && code === null && signal) {
          // 被 signal 杀掉
          onExit(code, signal);
        }
      });

      // 超时强制杀掉子进程
      timeoutHandle = setTimeout(() => {
        if (settled) return;
        logger(`[paged-export] 超时 ${timeoutMs / 1000}s，强制终止子进程`);
        try { childProc.kill('SIGTERM'); } catch (_) {}
        // 5 秒后若仍未退出，强杀
        setTimeout(() => {
          if (!settled) {
            try { childProc.kill('SIGKILL'); } catch (_) {}
          }
        }, 5000).unref();
      }, timeoutMs);
      timeoutHandle.unref();

      cmdLabel = cmd;
    };

    tryRun('python3');
  });
}

module.exports = {
  pagedExportMsswAssetList
};
