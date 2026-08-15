---
name: report-customer-weekly
description: 生成客户周报。MANDATORY to use when the user asks to generate/export a weekly customer report, 客户周报, 周报导出, 或任何周期性的客户数据汇总任务。
---

# 客户周报生成（长任务）

这是一个**后台长任务** skill。被触发后，任务会在独立会话中异步执行，结果完成后自动推送给用户。

## 执行方式

1. 先读取本目录的 `muad.skill.json`，确认任务目标。
2. 用 `bash` 工具执行脚本（不要用 `shell`），**只执行一次**，不要重复运行：

```bash
python3 scripts/run.py --customer "<客户名>" --period "<周期，如 2026-W31>"
```

3. 脚本会把报告写入运行环境注入的 `$SKILL_OUTPUT_DIR` 目录（脚本自动创建）。**不要把结果写到本 skill 目录**（`/opt/openclaw-skills` 是只读挂载，写入会失败）。
4. 执行结束后，用简洁中文总结脚本输出的 JSON 摘要，**不要**把脚本的原始 trace 或临时文件内容整段贴出。

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--customer` | ✅ | 客户名称，来自用户的请求 |
| `--period` | ✅ | 统计周期，如 `2026-W31` |

## 输出

脚本会向 stdout 打印一个 JSON 摘要（如 `{"status":"ok","report":"<绝对路径>","rows":N}`），并生成报告文件。

任务会话最终回复时，按顺序做三件事：
1. 读 stdout JSON 里的 `report` 字段——它是报告文件的**绝对路径**，原样保留，**不要改成相对路径、不要截断**。
2. 用 `MEDIA: <report 的绝对路径>` 把报告文件直接发给用户（报告在 workspace 内，可直接作为媒体发送）。
3. 再用中文简要总结报告内容（状态 / 行数 / 报告 ID）。
