// 构建期：把 baseline-config.json 深合并进 openclaw.json，并信任 WeCom 插件。
// 用 node（镜像必有），不依赖 python3。
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const state = process.env.OPENCLAW_STATE_DIR || `${homedir()}/.openclaw`;
const cfgPath = `${state}/openclaw.json`;
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const base = JSON.parse(readFileSync('/opt/muad/baseline-config.json', 'utf8'));

function deepMerge(dst, src) {
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith('_')) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      dst[k] = deepMerge(dst[k] && typeof dst[k] === 'object' ? dst[k] : {}, v);
    } else {
      dst[k] = v;
    }
  }
  return dst;
}

deepMerge(cfg, base);
// 不设 plugins.allow：一旦设了就变成允许列表，会把 bundled 的 browser / wechat 插件排除（→ 功能 disabled）。
// 留空 = 自动加载 bundled（browser、wechat 内置通道等）+ wecom 插件（仅一条无害告警）。

writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log('[seed-config] baseline merged');
