'use strict';

const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const readline = require('readline');

function getBranch1Root() {
  return path.join(path.resolve(__dirname, '..'), '分支1');
}

function getDefaultDeviceJsonPath() {
  return path.join(path.resolve(__dirname, '..'), 'tmp', 'device.json');
}

async function runBranch1ReportStage(options = {}) {
  const branch1Root = getBranch1Root();
  const reportDir = path.join(branch1Root, 'report');
  const outputDir = path.resolve(options.outputDir || path.join(branch1Root, 'tmp'));
  await fs.mkdir(outputDir, { recursive: true });

  const reportOutputPath = path.join(outputDir, 'branch1-report.json');
  const policyJsonPath = options.policyJsonPath || path.join(path.resolve(__dirname, '..'), 'tmp', 'policy_check.json');
  const policyExcelPath = options.policyExcelPath || path.join(path.resolve(__dirname, '..'), '安全体检报告', '风险清单', '策略检查清单.xlsx');
  const args = [
    path.join(reportDir, 'run_all.py'),
    '--asset-path', path.resolve(options.assetPath || ''),
    '--event-path', path.resolve(options.eventPath || ''),
    '--weakpwd-path', path.resolve(options.weakpwdPath || ''),
    '--vuln-path', path.resolve(options.vulnPath || ''),
    '--exposure-path', path.resolve(options.exposurePath || ''),
    '--device-path', path.resolve(options.devicePath || getDefaultDeviceJsonPath()),
    '--output', reportOutputPath,
    '--policy-json-path', path.resolve(policyJsonPath),
    '--policy-excel-path', path.resolve(policyExcelPath),
  ];

  if (options.msswCookiePath) {
    args.push('--cookie-path', path.resolve(options.msswCookiePath));
  }
  if (options.msswBaseUrl) {
    args.push('--mssw-base-url', String(options.msswBaseUrl));
  }
  if (options.companyId) {
    args.push('--company-id', String(options.companyId));
  }
  if (options.start) {
    args.push('--start', String(options.start));
  }
  if (options.end) {
    args.push('--end', String(options.end));
  }
  if (options.mock) {
    args.push('--mock');
  }

  await execPython(args, '分支1报告计算失败', { cwd: undefined }, options.logger);
  const parsed = JSON.parse(await fs.readFile(reportOutputPath, 'utf8'));
  const checklistPaths = await findChecklistArtifacts(options);

  return {
    reportPatch: sanitizeBranch1ReportPatch(parsed.reportPatch),
    artifacts: {
      reportJsonPath: reportOutputPath,
      policyJsonPath: parsed.artifacts && parsed.artifacts.policyJsonPath ? parsed.artifacts.policyJsonPath : path.resolve(policyJsonPath),
      policyExcelPath: parsed.artifacts && parsed.artifacts.policyExcelPath ? parsed.artifacts.policyExcelPath : path.resolve(policyExcelPath),
      checklistPaths
    }
  };
}

async function exportBranch1Word(options = {}) {
  const branch1Root = getBranch1Root();
  const htmlPath = path.resolve(options.htmlPath || '');
  const wordPath = path.resolve(options.wordPath || replaceExtension(htmlPath, '.docx'));
  const args = [
    '-m', 'html_to_word.html_to_word_export',
    '--input', htmlPath,
    '--output', wordPath
  ];

  if (options.configPath) {
    args.push('--config', path.resolve(options.configPath));
  }

  await execPython(args, '分支1 Word 导出失败', { cwd: branch1Root });
  return {
    wordPath
  };
}

function sanitizeBranch1ReportPatch(patch) {
  return {
    scoring: patch && patch.scoring ? patch.scoring : {},
    protection_effectiveness: patch && patch.protection_effectiveness ? patch.protection_effectiveness : {}
  };
}

function mergeBranch1ReportPatch(reportData, reportPatch) {
  const patch = sanitizeBranch1ReportPatch(reportPatch);
  return {
    ...reportData,
    scoring: patch.scoring,
    protection_effectiveness: patch.protection_effectiveness
  };
}

async function findChecklistArtifacts(options = {}) {
  const candidates = [];
  const extractedDir = path.join(path.resolve(__dirname, '..'), 'tmp', 'prevention-export-work', 'extracted');
  const explicitPaths = Array.isArray(options.checklistPaths) ? options.checklistPaths : [];

  for (const explicitPath of explicitPaths) {
    if (explicitPath) candidates.push(path.resolve(explicitPath));
  }

  try {
    const entries = await fs.readdir(extractedDir, { withFileTypes: true });
    entries
      .filter((entry) => entry.isFile() && /清单/i.test(entry.name))
      .forEach((entry) => candidates.push(path.join(extractedDir, entry.name)));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  return [...new Set(candidates)];
}

function replaceExtension(filePath, extension) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${extension}`);
}

function execPython(args, label, options = {}, logger) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, {
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      PYTHONLEGACYWINDOWSSTDIO: '0'
    });
    const child = spawn('python', args, {
      cwd: options.cwd,
      env,
      windowsHide: true
    });
    let stdoutBuffer = '';
    let stderrBuffer = '';
    const logFn = typeof logger === 'function' ? logger : () => {};

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      stdoutBuffer += line + '\n';
      if (line) {
        logFn(`[branch1] ${line}`);
      }
    });

    const rlErr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    rlErr.on('line', (line) => {
      stderrBuffer += line + '\n';
      if (line) {
        logFn(`[branch1-stderr] ${line}`);
      }
    });

    child.on('error', (err) => {
      reject(new Error(`${label}: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`${label}: code=${code} signal=${signal} stderr=${stderrBuffer.slice(-500)}`));
        return;
      }
      resolve(stdoutBuffer.trim());
    });
  });
}

module.exports = {
  exportBranch1Word,
  getDefaultDeviceJsonPath,
  mergeBranch1ReportPatch,
  runBranch1ReportStage,
  sanitizeBranch1ReportPatch
};
