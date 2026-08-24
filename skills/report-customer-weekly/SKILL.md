---
name: report-customer-weekly
description: 生成/导出客户周报（含测试客户周报，无论是否指定报告大小如 5M/25M）。MANDATORY to use when the user asks to generate/export/download a customer weekly report, 客户周报, 测试客户周报, 周报导出, 报告下载, 或任何周期性的客户数据汇总任务。
---

# 客户周报生成（长任务）

这是一个**后台长任务** skill。被触发后，任务会在独立会话中异步执行，结果完成后自动推送给用户。

## 执行方式

1. 先读取本目录的 `muad.skill.json`，确认任务目标。
2. 用 `bash` 工具执行脚本（不要用 `shell`），**只执行一次**，不要重复运行。**从用户请求里解析报告大小**（如「25M」→ `--size-mb 25`、「5M」→ `--size-mb 5`），用户未指定大小时用默认 30。周期缺省为当前 ISO 周，用户没给周期就不传 `--period`：

```bash
python3 scripts/run.py --customer "<客户名>" --size-mb <N> [--period "<周期，如 2026-W31>"]
```

3. 脚本会把报告写入运行环境注入的 `$SKILL_OUTPUT_DIR` 目录（脚本自动创建）。**不要把结果写到本 skill 目录**（`/opt/openclaw-skills` 是只读挂载，写入会失败）。
4. 执行结束后，用简洁中文总结脚本输出的 JSON 摘要，**不要**把脚本的原始 trace 或临时文件内容整段贴出。

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--customer` | ✅ | 客户名称，来自用户的请求 |
| `--period` | 否 | 统计周期，如 `2026-W31`；缺省为当前 ISO 周 |
| `--size-mb` | 否 | tar 报告包最小体积（MiB）。从用户请求提取（如 25M→25、5M→5）；未指定默认 30 |

## 输出

脚本会向 stdout 打印一个 JSON 摘要（如 `{"status":"ok","report":"<绝对路径>","format":"tar","sizeMb":30}`），并生成 **tar 报告包**。报告包是 `.tar` 归档，内含：

- `<客户>-<周期>.md`：周报摘要 + 打包清单
- `data/device-inspection.csv`：模拟明细数据
- `data/activity-log.jsonl`：模拟活动流水
- `logs/export.log`：导出日志（含体积填充）

任务会话最终回复时，按顺序做三件事：
1. 读 stdout JSON 里的 `report` 字段——它是 tar 报告包的**绝对路径**，原样保留，**不要改成相对路径、不要截断**。
2. 用 `MEDIA: <report 的绝对路径>` 把 `.tar` 报告包直接发给用户（tar 在 workspace 内，可直接作为媒体发送）。**不要解包、不要改包内文件、不要重新打包**。
3. 再用中文简要总结报告内容（状态 / 统计行数 / 报告 ID / 包大小 `sizeBytes`）。
