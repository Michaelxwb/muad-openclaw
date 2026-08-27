'use strict';
/**
 * 统一可写工作区（health-checkup-report）
 *
 * 技能根（/opt/openclaw-skills）是 NFS **只读**挂载，禁止在技能根内创建 tmp/ 等写目录。
 * 所有可写中间文件（device.json、导出 Excel、policy_check.json、允许前导出工作目录、
 * 分支1 报告 JSON、html_to_word 截图目录）必须落在可写目录：由 guard 注入的
 * SKILL_OUTPUT_DIR（本模块统一经 session.outputDir() 取得，回退到系统临时目录）。
 *
 * 只读的代码/模板/配置仍读技能根（__dirname/..），可写的产物全部走本模块。
 */

const path = require('node:path');
const fs = require('node:fs');

const { outputDir } = require('./session');

/** 可写工作区根：SKILL_OUTPUT_DIR/tmp。 */
function tmpRoot() {
  const d = path.join(outputDir(), 'tmp');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 导出 Excel 统一目录（原技能根 tmp/exports）。 */
function getTmpExportDir() {
  const d = path.join(tmpRoot(), 'exports');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 分支2/防护导出工作目录（原技能根 tmp/prevention-export-work）。 */
function preventionWorkDir() {
  const d = path.join(tmpRoot(), 'prevention-export-work');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 分支1 报告计算工作目录（原技能根 tmp/；branch1/tmp/）。 */
function branch1WorkDir() {
  const d = path.join(tmpRoot(), 'branch1');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** device.json 默认路径（原技能根 tmp/device.json）。 */
function deviceJsonPath() {
  return path.join(tmpRoot(), 'device.json');
}

/** policy_check.json 默认路径（原技能根 tmp/policy_check.json）。 */
function policyJsonPath() {
  return path.join(tmpRoot(), 'policy_check.json');
}

/** 策略检查清单 Excel 默认路径（对外交付目录为 report/风险清单/策略检查清单.xlsx）。 */
function policyExcelPath() {
  return path.join(tmpRoot(), 'policy_check.xlsx');
}

module.exports = {
  tmpRoot,
  getTmpExportDir,
  preventionWorkDir,
  branch1WorkDir,
  deviceJsonPath,
  policyJsonPath,
  policyExcelPath,
};
