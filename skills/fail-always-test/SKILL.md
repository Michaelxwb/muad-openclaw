---
name: fail-always-test
description: 必然失败的测试长任务。MANDATORY to use when the user asks to 测试失败通知, 失败测试, 或验证长任务失败。用于验证长任务失败时是否向用户推送失败通知。
---

# 失败测试长任务

这是一个**后台长任务** skill，用于验证「长任务失败时主动推送失败通知」的能力。它**必然执行失败**。

## 执行方式

1. 先读取本目录的 `muad.skill.json`，确认任务目标。
2. 用 `bash` 工具执行脚本（不要用 `shell`），**只执行一次**，不要重复运行：

```bash
python3 scripts/run.py
```

3. 脚本会固定以非零退出码结束，模拟长任务执行失败。你无需做任何补救，如实等待任务失败即可。
