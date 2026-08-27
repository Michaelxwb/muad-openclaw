'use strict';

const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const { encodePath } = require('./path_helper');

function getTmpExportDir() {
  return path.join(path.resolve(__dirname, '..'), 'tmp', 'exports');
}

async function calculateRiskAssetCount(options = {}) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'risk_asset_count.py');
  const tmpDir = getTmpExportDir();
  const eventPath = options.eventPath || await findLatestWorkbook(tmpDir, /incident|事件/i);
  const assetPath = options.assetPath || await findLatestWorkbook(tmpDir, /asset|资产/i);
  const args = [
    encodePath(eventPath || ''),
    encodePath(options.weakPasswordPath || path.join(tmpDir, '弱口令清单_mock.xlsx')),
    encodePath(options.vulnerabilityPath || path.join(tmpDir, '漏洞清单_mock.xlsx')),
    encodePath(options.exposurePath || path.join(tmpDir, '暴露面清单_mock.xlsx')),
    encodePath(assetPath || ''),
    JSON.stringify(Array.isArray(options.topRiskIncidentIds) ? options.topRiskIncidentIds : [])
  ];

  return new Promise((resolve, reject) => {
    execFile('python', [scriptPath, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`计算风险资产数失败: ${stderr || error.message}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (parseError) {
        reject(new Error(`解析风险资产数结果失败: ${parseError.message}`));
      }
    });
  });
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

module.exports = {
  calculateRiskAssetCount,
  getTmpExportDir
};
