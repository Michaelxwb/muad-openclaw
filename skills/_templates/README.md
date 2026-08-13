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
- 脚本使用 argv 参数，不拼接 shell 字符串。
- 读文件（`SKILL.md`、config、模板）路径保持在 Skill 根目录内；写文件（报告、临时结果）写 `SKILL_OUTPUT_DIR`（guard 注入的 per-agent 目录），别写 Skill 根目录（只读）或 `/tmp`（不隔离不持久）。

## 最小目录

```text
<skill-name>/
├── SKILL.md              # 必需：frontmatter + 指令
├── muad.skill.json       # 可选：managed 编排
├── scripts/              # 可选：Shell/Python/Node 脚本
└── references/           # 可选：参考资料
```

扫描器会把 Skill 分类为：

- `managed`：包含合法 `muad.skill.json`。
- `traditional-script`：无 manifest，但扫描到可执行脚本；仅 system 内置 Skill 可使用。
- `traditional-prompt`：无 manifest，由 Agent 按说明调用 OpenClaw 原生工具；仅 system 内置 Skill 可使用。

## SKILL.md frontmatter

```yaml
---
name: web-tools-guide
description: "MANDATORY before calling web_search, web_fetch, browser, or opencli. Trigger on: 搜索/抓取网页/打开网站。"
---
```

- `name` 使用小写字母、数字、`-` 或 `_`。
- `description` 应说明触发场景和能力，不要把密钥、内部 URL 或业务数据写入其中。
- 对必须先阅读本 Skill 才能调用的原生工具，可在 `description` 中明确触发场景。
- Runtime Guard 只开放当前用户允许的 Skill 根，只读读取 `SKILL.md` 是当前最小版本的激活边界。

## 可选 managed manifest

需要业务平台登录态的 Skill 可通过 `muad.skill.json` 声明平台依赖：

```json
{
  "name": "mssw-query",
  "platforms": ["mssw"],
  "runtime": "script",
  "version": "1.0.0",
  "capabilities": ["browser"],
  "longTask": false,
  "entrypoint": "scripts/run.mjs"
}
```

- `longTask: true` = 后台任务：installer 自动生成提交桩，运行时自动处理后台执行/递归防护/状态机。把普通 Skill 改成长任务只需加这一行，其余不用改。
- `entrypoint`（可选）= 显式声明主入口脚本；脚本放 `scripts/` 会被自动扫描，调用方式由 `SKILL.md` 描述，不依赖 `entrypoint`。

上传时 Console 会校验非空平台依赖均已存在。无平台依赖的 Skill 可直接作为通用 Skill 使用；声明平台依赖的 Skill 通过 `session-manager get-state --skill-name <skill>` 解析，一次返回该 Skill 声明的全部平台凭证；任一平台未配置时调用失败（不做部分降级）。

脚本类 Skill 采用**脚本自助**模式获取会话状态：`scripts/` 里的脚本直接调用
`session-manager get-state --skill-name <skill>`，无需 env 注入——agent 身份由 Runtime Guard
注入的 `MUAD_SESSION_KEY` 决定，脚本不自报身份。CLI 保证状态新鲜（缓存过期/缺失时自动登录并落盘），
返回按 Skill 裁剪的 `sessionStateFile`；脚本再读该文件当前 Skill 的 `<platform>` section 取
cookies 使用（文件只含当前 Skill 声明的平台）。cookie 不进入 CLI stdout、不进入模型上下文。
需要浏览器能力（`capabilities: ["browser"]`）的 Skill 仍走
`session_get_state` 模型工具，因为只有插件工具能调用 `browser.request`。

## 写 Skill 的关键提醒

### skill 名 ≠ platform 名，别让两者长得像

- `SKILL.md` 的 `name` 是 **skill 名**（横杠 `-`，如 `smoke-platform`、`policy-check-new`）。
- `muad.skill.json` 的 `platforms` 是 **平台名**（Console 里配置的自由字符串，如 `mssw`、`smoke_platform`）。
- 两者是不同概念，**不要长得像**（反例：`smoke-platform` vs `smoke_platform` 只差横杠/下划线）——模型会把平台名当 skill 名传给工具，Console 按 skill 名解析时找不到、报 `agent is not active`。
- SKILL.md 正文若提到平台，明确写「skill 名是 X，平台名是 Y」。

### 脚本自助：skill 名硬编码 + 失败 fail loud

- 脚本里 `session-manager get-state --skill-name <skill名>` 的 skill 名**硬编码**（不要从模型或参数动态取），保证解析稳定。
- 脚本失败必须写 **stderr** 并 **exit 非 0**（fail loud）；错误写 stdout 会导致 exec 失败日志转发不到，排查链路断掉。

### 引导模型跑脚本，而非直接调工具

- SKILL.md 顶部用「快速调用速查」直接列出脚本命令（如 `node scripts/run.mjs`），引导模型跑脚本。
- 不要让模型直接调 `session_get_state` 工具——该工具需要 `skillName` 参数，模型容易传成平台名。

## 语言模板

- [`business-skill-shell/`](business-skill-shell/)
- [`business-skill-python/`](business-skill-python/)
- [`business-skill-ts/`](business-skill-ts/)

完整约定见 [`../README.md`](../README.md)。
