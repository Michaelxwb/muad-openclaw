'use strict';

/**
 * 统一 Python 解释器：固定使用 `python3`。
 *
 * 运行环境（muad/Linux）统一提供 `python3`，不保证有 `python`。
 * 如需非常规覆盖，可用环境变量 HEALTH_CHECKUP_PYTHON 显式指定解释器命令。
 */

function pythonCommand() {
  const override = process.env.HEALTH_CHECKUP_PYTHON;
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  return 'python3';
}

module.exports = { pythonCommand };
