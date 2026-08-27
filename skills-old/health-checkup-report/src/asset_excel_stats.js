'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { encodePath } = require('./path_helper');

async function summarizeAssetTable(excelPath, options = {}) {
  if (!excelPath) {
    return null;
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'asset_table_stats.py');
  const stdout = await execPython(scriptPath, encodePath(excelPath));
  const parsed = JSON.parse(stdout);
  const assetTotal = Number(parsed.assetTotal || 0);
  const protectionStats = parsed.protectionStats || { protected: 0, unprotected: 0 };

  const result = {
    assetTotal,
    currentAssetCount: Number(parsed.currentAssetCount || 0),
    manage_asset: Number(parsed.manage_asset || 0),
    core_asset: Number(parsed.core_asset || 0),
    core_managed_asset: Number(parsed.core_managed_asset || 0),
    waitApproveAssetCount: Number(parsed.waitApproveAssetCount || 0),
    ready_to_outbound: Number(parsed.ready_to_outbound || 0),
    typeDistribution: toNameValueList(parsed.typeDistribution, [
      ['服务器', 'server'],
      ['终端', 'terminal'],
      ['其它', 'other']
    ]),
    internetExposureTotal: Number(parsed.internetExposureTotal || 0),
    internetExposureDistribution: toNameValueList(parsed.internetExposureDistribution, [
      ['服务器', 'server'],
      ['终端', 'terminal'],
      ['其它', 'other']
    ]),
    // 资产防护：防护/未防护两类（基于"数据源"列判定）
    protectionDistribution: [
      { name: '防护', value: Number(protectionStats.protected || 0) },
      { name: '未防护', value: Number(protectionStats.unprotected || 0) }
    ],
    // 未防护 4 子类细分（生成过程统计用，饼图不消费）
    protectionStats: {
      protected: Number(protectionStats.protected || 0),
      unprotected: Number(protectionStats.unprotected || 0),
      unprotected_breakdown: protectionStats.unprotected_breakdown || {
        manual: 0,
        cloud_mirror: 0,
        manual_and_cloud_mirror: 0,
        empty: 0
      }
    },
    // 安全组件分布（基于 device.json 的 devType 聚合）
    componentDistribution: [],
    totalComponentCount: 0
  };

  // 第 4 点：从 device.json 计算组件分布
  const deviceJsonPath = options.deviceJsonPath || getDefaultDeviceJsonPath();
  if (deviceJsonPath && fs.existsSync(deviceJsonPath)) {
    try {
      const componentStats = await summarizeDeviceComponents(deviceJsonPath, options.thirdPartyCount);
      result.componentDistribution = componentStats.componentDistribution;
      result.totalComponentCount = componentStats.total;
    } catch (error) {
      // 不阻断主流程，组件分布留空
      console.warn(`[WARN] 安全组件分布统计失败: ${error.message}`);
    }
  }

  return result;
}

function getDefaultDeviceJsonPath() {
  return path.join(__dirname, '..', 'tmp', 'device.json');
}

async function summarizeDeviceComponents(deviceJsonPath, thirdPartyCount) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'device_component_stats.py');
  const args = [scriptPath, encodePath(deviceJsonPath)];
  if (Number.isFinite(thirdPartyCount) && thirdPartyCount > 0) {
    args.push('--third-party-count', String(Math.floor(thirdPartyCount)));
  }
  const stdout = await execPython(scriptPath, args.slice(1));
  const parsed = JSON.parse(stdout);
  return {
    total: Number(parsed.total || 0),
    componentDistribution: Array.isArray(parsed.componentDistribution)
      ? parsed.componentDistribution.map(item => ({
        name: String(item.name || ''),
        value: Number(item.value || 0)
      }))
      : []
  };
}

function toNameValueList(source, items) {
  const data = source && typeof source === 'object' ? source : {};
  return items.map(([name, key]) => ({
    name,
    value: Number(data[key] || 0)
  }));
}

function execPython(scriptPath, arg) {
  const args = Array.isArray(arg) ? arg : [arg];
  return new Promise((resolve, reject) => {
    execFile('python', [scriptPath, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`资产表统计失败: ${stderr || error.message}`));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

module.exports = {
  summarizeAssetTable,
  summarizeDeviceComponents
};
