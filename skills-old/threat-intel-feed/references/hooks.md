# 企微群 Webhook 配置

> 群机器人 Webhook URL，用于直接将报告推送到企微群。
> 配置方式：企微群 → 群设置 → 群机器人 → 添加机器人 → 复制 Webhook 地址

## 配置示例

```json
{
  "threat_intel_group": {
    "name": "威胁情报通报群",
    "webhook_url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=YOUR_KEY_HERE",
    "enabled": false
  }
}
```

## 使用方式

配置好 webhook_url 并将 enabled 设为 true 后，脚本在生成报告后会自动：

1. 通过 webhook 上传报告文件
2. 推送文件消息到对应群聊

需要安装企微 bot SDK：
```bash
npm install -g @wecom/aibot-node-sdk
```

## 发送流程

```python
# 1. 读取 webhook 配置
# 2. 上传文件获取 media_id
# 3. POST webhook 发送文件消息
```

> 注：如未配置 webhook，报告会通过 wecom 通道的 `MEDIA:` 指令直接发送到当前对话。
