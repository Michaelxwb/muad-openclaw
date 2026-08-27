'use strict';

const { execFile } = require('child_process');
const path = require('path');
const { encodePath } = require('./path_helper');

async function calculatePreventionData(options = {}) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'prevention_data.py');
  const args = [
    encodePath(options.assetPath || ''),
    encodePath(options.incidentPath || ''),
    encodePath(options.weakpwdPath || ''),
    encodePath(options.vulnPath || ''),
    encodePath(options.exposurePath || '')
  ];

  const stdout = await execPython(scriptPath, args, '威胁预防数据计算失败');
  const parsed = JSON.parse(stdout);

  return {
    summary: parsed.summary || {},
    key_risks: parsed.key_risks || {},
    risk_detail: parsed.risk_detail || {},
    internet: parsed.internet || {},
    intranet: parsed.intranet || {}
  };
}

function execPython(scriptPath, args, label) {
  return new Promise((resolve, reject) => {
    execFile('python', [scriptPath, ...args], {
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
  });
}

module.exports = {
  calculatePreventionData
};
