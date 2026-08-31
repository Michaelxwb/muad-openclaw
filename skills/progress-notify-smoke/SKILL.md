---
name: progress-notify-smoke
description: 仅在用户明确要求测试或验证 Skill 主动进度通知、muad-progress、企微/Mattermost 进度消息时使用。普通业务请求不要使用。
---

# 主动进度通知 Smoke

运行下面的普通前台 Skill 脚本一次，用于验证当前会话的 `muad-progress` stage/done 投递链：

```bash
node /opt/openclaw-skills/progress-notify-smoke/scripts/run.mjs
```

脚本会依次上报 `prepare` 和 `deliver` 两个节点，每个节点各有 stage/done 消息。不要自行传入 channel、peerId 或其他收件人信息；Runtime Guard 必须从当前可信会话决定目标。

**每次调用都必须实际执行上面的脚本一次**，依据本次 stdout/stderr 作答。严禁根据会话历史中的既有结果、记忆或推测作答——历史里的「通过」不代表本次通过；会话里已有 SKILL.md 内容时也必须重新执行脚本。

完整最终回复只根据脚本 stdout 返回一次。若脚本失败，原样说明 smoke 未通过，不要重试或改用 `openclaw message send` 绕过进度链。
