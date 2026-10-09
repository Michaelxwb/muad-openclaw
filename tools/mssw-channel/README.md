# MSSW Channel

原生 Worker 通道插件。通过 Console 配置启用，Gateway HTTP 接收，原生 SDK 调度，持久回调交付。

完整协议、身份边界和两个仓库的分工见 [接入说明](../../docs/mssw-channel.md)。

```sh
node --test tools/mssw-channel/*.test.mjs
```

真实业务授权来自平台后端；通道 token 仅证明调用服务，不能替代客户权限。默认只支持直接文本会话。
