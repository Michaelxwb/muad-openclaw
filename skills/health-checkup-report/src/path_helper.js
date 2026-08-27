'use strict';

/**
 * 路径编解码工具，解决 Windows 命令行中文字符乱码问题。
 * 配合 scripts/_path_helper.py 使用，在传递包含中文的路径时进行 base64 编码。
 */

function encodePath(p) {
  if (typeof p !== 'string') return p;
  return 'B64:' + Buffer.from(p, 'utf8').toString('base64');
}

module.exports = { encodePath };
