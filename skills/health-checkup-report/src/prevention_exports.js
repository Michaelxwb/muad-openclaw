'use strict';

const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

const { mapLimit } = require('./parallel');

function getTmpExportDir() {
  const { getTmpExportDir: workRunExportDir } = require('./workdir');
  return workRunExportDir();
}

async function collectPreventionTableExports(options = {}) {
  const outputDir = path.resolve(options.outputDir || getTmpExportDir());
  const tempDir = path.resolve(options.tempDir || require('./workdir').preventionWorkDir());

  await fs.mkdir(outputDir, { recursive: true });
  // The exporters retain downloaded archives and source workbooks here. They are
  // only needed during the current report generation, so discard an earlier run.
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });

  // 三张表彼此独立，保守并发 3 并行导出（每表使用独立子临时目录，避免并发写同一目录冲突）。
  const configs = [
    { key: 'weakpwd', type: 'weakpwd', explicit: options.weakpwdPath },
    { key: 'vuln', type: 'vuln', explicit: options.vulnPath },
    { key: 'exposure', type: 'exposure', explicit: options.exposurePath },
  ];
  const list = configs.map((c) => async () => {
    const subTempDir = path.join(tempDir, c.type);
    await fs.mkdir(subTempDir, { recursive: true });
    return resolveTablePath(c.type, c.explicit, options, outputDir, subTempDir);
  });
  const entries = await mapLimit(list, 3);
  return {
    weakpwd: entries[0],
    vuln: entries[1],
    exposure: entries[2],
  };
}

async function resolveTablePath(tableType, explicitPath, options, outputDir, tempDir) {
  if (explicitPath) {
    const filePath = await copyToOutputDir(explicitPath, outputDir);
    return {
      filePath,
      source: 'local'
    };
  }

  const soarCookiePath = options.soarCookiePath || '';
  if (!soarCookiePath) {
    throw new Error(`${displayName(tableType)} 导出失败: 缺少 SOAR Cookie，请传 --cookie-path`);
  }
  if (tableType !== 'exposure' && !options.msswCookiePath) {
    throw new Error(`${displayName(tableType)} 导出失败: 缺少 MSSW Cookie，请传 --mssw-cookie-path`);
  }

  const outputFile = path.join(outputDir, buildOutputFilename(tableType, options.customer, options.start, options.end));
  const scriptPath = path.join(__dirname, '..', 'scripts', 'export_prevention_table.py');
  const args = [
    scriptPath,
    tableType,
    '--customer', options.customer || '',
    '--start', options.start || '',
    '--end', options.end || '',
    '--output-file', outputFile,
    '--temp-dir', tempDir,
    '--easm-cookie-path', soarCookiePath
  ];

  if (tableType !== 'exposure') {
    args.push('--mssw-cookie-path', options.msswCookiePath);
  }

  if (options.msswBaseUrl) {
    args.push('--mssw-base-url', options.msswBaseUrl);
  }

  if (options.soarBaseUrl) {
    args.push('--soar-base-url', options.soarBaseUrl);
  }

  const stdout = await execPython(args, `${displayName(tableType)} 导出失败`, options.logger);
  const lastLine = stdout.split(/\r?\n/).filter(Boolean).pop() || '{}';
  const parsed = JSON.parse(lastLine);

  if (!parsed.filePath) {
    throw new Error(`${displayName(tableType)} 导出失败: 返回缺少 filePath`);
  }

  return {
    filePath: path.resolve(parsed.filePath),
    source: 'export'
  };
}

async function copyToOutputDir(sourcePath, outputDir) {
  const resolvedSource = path.resolve(sourcePath);
  const targetPath = path.join(outputDir, path.basename(resolvedSource));
  if (resolvedSource !== targetPath) {
    await fs.copyFile(resolvedSource, targetPath);
  }
  return targetPath;
}

function buildOutputFilename(tableType, customer, start, end) {
  const baseName = `${tableType}_${customer || 'customer'}_${start || 'start'}_${end || 'end'}.xlsx`;
  return baseName.replace(/[\\/:*?"<>|]/g, '_');
}

function displayName(tableType) {
  if (tableType === 'weakpwd') return '弱口令表';
  if (tableType === 'vuln') return '漏洞表';
  return '暴露面表';
}

function execPython(args, label, logger) {
  return new Promise((resolve, reject) => {
    const child = execFile(require('./python').pythonCommand(), args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 20,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${label}: ${stderr || error.message}`));
        return;
      }

      resolve(stdout.trim());
    });

    if (child.stderr && typeof logger === 'function') {
      child.stderr.on('data', (chunk) => {
        String(chunk).split(/\r?\n/).forEach((line) => {
          if (line.trim()) logger(line.trim());
        });
      });
    }
  });
}

module.exports = {
  collectPreventionTableExports,
  getTmpExportDir
};
