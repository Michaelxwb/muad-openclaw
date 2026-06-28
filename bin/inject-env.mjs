// 运行期（entrypoint 调用）：把外部面环境变量契约注入 openclaw.json。
// 幂等：每次启动覆盖。管理员只提供这些 env，复杂配置已在镜像基线里。
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const state = process.env.OPENCLAW_STATE_DIR || `${homedir()}/.openclaw`;
const p = `${state}/openclaw.json`;
const d = JSON.parse(readFileSync(p, 'utf8'));
const E = process.env;
const v = (x) => (x ?? '').trim();

// 网关 token（per-user，provision 生成）
if (v(E.OPENCLAW_GATEWAY_TOKEN)) {
  d.gateway = d.gateway || {};
  d.gateway.auth = { mode: 'token', token: v(E.OPENCLAW_GATEWAY_TOKEN) };
}

// 消息通道：外部 CHANNEL（wecom 企业微信 / wechat 微信，缺省 wecom）映射到 openclaw 通道 id。
// openclaw 里企业微信通道 id 为 "wecom"（@wecom 插件），个人微信为 "openclaw-weixin"
// （@tencent-weixin/openclaw-weixin 插件）。凭证 env 沿用 WECOM_BOT_ID/WECOM_SECRET
// （wecom 用；wechat 免凭证，登录靠日志二维码）。仅启用所选通道，其余关闭避免互踢。
d.channels = d.channels || {};
const CHANNEL_MAP = { wecom: 'wecom', wechat: 'openclaw-weixin' };
const channel = v(E.CHANNEL) in CHANNEL_MAP ? v(E.CHANNEL) : 'wecom';
const ocChannel = CHANNEL_MAP[channel];
for (const id of Object.values(CHANNEL_MAP)) {
  const c = (d.channels[id] = d.channels[id] || {});
  c.enabled = id === ocChannel;
}
const ch = d.channels[ocChannel];
if (v(E.WECOM_BOT_ID)) ch.botId = v(E.WECOM_BOT_ID);
if (v(E.WECOM_SECRET)) ch.secret = v(E.WECOM_SECRET);

// LLM provider（OpenAI 兼容；默认 deepseek，基线已配 api/baseUrl）
const prov = v(E.LLM_PROVIDER) || 'deepseek';
d.models = d.models || {};
d.models.providers = d.models.providers || {};
const pc = (d.models.providers[prov] = d.models.providers[prov] || {});
if (v(E.LLM_API_KEY)) pc.apiKey = v(E.LLM_API_KEY);
if (v(E.LLM_BASE_URL)) pc.baseUrl = v(E.LLM_BASE_URL);
pc.api = pc.api || 'openai-completions';
const model = v(E.LLM_MODEL);
if (model) {
  pc.models = [{ id: model, name: model }];
  // 默认模型不在这里写：由 entrypoint 的 `openclaw models set` 写入 agents.defaults（正确 schema）
}

writeFileSync(p, JSON.stringify(d, null, 2));
console.log(`[inject-env] applied: channel=${channel}(${ocChannel}) provider=${prov} model=${model || '(default)'} bot=${v(E.WECOM_BOT_ID).slice(0, 10)}...`);
