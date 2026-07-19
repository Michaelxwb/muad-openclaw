# Skill Templates

本目录提供业务 Skill 模板。选择模板时先确定执行形态：

| 形态 | 是否需要 `muad.skill.json` | 适用场景 |
|------|----------------------------|----------|
| managed steps | 是 | 平台需要稳定步骤、自动进度和逐步失败定位 |
| managed entrypoint | 是 | 已有上层脚本编排多个子脚本，并主动上报阶段 |
| traditional script | 否 | `SKILL.md` 指导 Agent 选择已扫描脚本 |
| traditional prompt | 否 | Skill 只指导 Agent 使用 browser 等原生工具 |

所有模板都必须包含合法 `SKILL.md`。`muad.skill.json` 只用于 managed 编排，不能成为普通 Skill 接入的强制要求。

## 开发规则

- Skill 激活按用户消息轮次隔离；Agent 每轮读取精确 `SKILL.md`，或调用 `muad_use_skill`。
- 原生工具型 Skill 可在 frontmatter description 中声明 `MANDATORY before calling <tools>.`，由运行时门禁保证先激活后调用。
- 长任务使用 `muad-progress` 上报 accepted/auth/query/analysis/done/error 等上层业务阶段。
- 上层脚本可以调用多个子脚本，进度不需要深入每个内部命令。
- 受保护业务系统先通过 `session-manager` 获取当前用户登录态。
- 不在进度、日志、错误或 manifest 中写入 Cookie、Token、密码、内部 URL、SQL 和堆栈。
- `muad-progress` 仅发送阶段进度，最终结果继续走 OpenClaw 原生最终回复。
- 脚本使用 argv 参数，不拼接 shell 字符串；路径必须保持在 Skill 根目录内。

语言模板：

- [`business-skill-shell/`](business-skill-shell/)
- [`business-skill-python/`](business-skill-python/)
- [`business-skill-ts/`](business-skill-ts/)
- [`example-long-task/`](example-long-task/)

完整约定见 [`../README.md`](../README.md) 和 [`../../tools/muad-run-skill/README.md`](../../tools/muad-run-skill/README.md)。
