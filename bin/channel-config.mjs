// Mattermost 通道配置归一化：冷启动（startup-context）与热更新（inject-channels）
// 共用同一份实现，保证两条路径产出完全一致的 mattermost 配置。
//
// 强制固定：dmPolicy=open / groupPolicy=disabled / allowFrom=["*"] / streaming=off。
// - streaming=off：关闭 live-preview 流式（否则默认 partial 走 delete+recreate 预览
//   post，失败时中间预览消息被删除显示"已删除"）；与企微一致直接投递最终结果。
// - allowPrivateNetwork 由调用方判定（冷启动只读原始字符串；热更新还要读回已落盘的
//   network 以保留私网开关），作为参数传入，避免两条路径语义被误合并。

export function normalizeMattermostChannelConfig(config, allowPrivateNetwork) {
  delete config.allowPrivateNetwork;
  delete config.botId;
  delete config.secret;
  config.dmPolicy = "open";
  config.groupPolicy = "disabled";
  config.allowFrom = ["*"];
  config.streaming = "off";
  if (allowPrivateNetwork) {
    config.network = { dangerouslyAllowPrivateNetwork: true };
  } else {
    delete config.network;
  }
  return config;
}
