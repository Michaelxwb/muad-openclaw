# Skill Templates

本目录提供业务 Skill 模板。选择模板时先确定执行形态：

| 形态 | 是否需要 `muad.skill.json` | 适用场景 |
|------|----------------------------|----------|
| managed metadata | 可选 | public/private Skill，声明 name/version/platforms/capabilities |
| traditional script | 否 | `SKILL.md` 指导 Agent 选择已扫描脚本 |
| traditional prompt | 否 | Skill 只指导 Agent 使用 browser 等原生工具 |

所有模板都必须包含合法 `SKILL.md`。需要业务平台登录态或 Console 管理元数据时，可包含 `muad.skill.json`，并用 `platform` 或 `platforms` 声明 0 到多个业务平台依赖。

## 开发规则

- Skill 激活按用户消息轮次隔离；Agent 每轮读取精确 `SKILL.md`。
- 受保护业务系统先通过 `session-manager get-state --skill-name <skill>` 获取当前用户登录态。
- 不在日志、错误或 manifest 中写入 Cookie、Token、密码、内部 URL、SQL 和堆栈。
- 最小版本不内置独立进度 CLI；最终结果继续走 OpenClaw 原生最终回复。
- 脚本使用 argv 参数，不拼接 shell 字符串；路径必须保持在 Skill 根目录内。

语言模板：

- [`business-skill-shell/`](business-skill-shell/)
- [`business-skill-python/`](business-skill-python/)
- [`business-skill-ts/`](business-skill-ts/)
完整约定见 [`../README.md`](../README.md)。
