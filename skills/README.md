# Skill 开发与分层

本目录保存 Worker 镜像内置的 Skill 种子和开发模板。运行环境中的 Skill 由 Console 统一管理，并按 system、public、private 三层解析。

## 分层与优先级

| 范围 | 来源 | 生效方式 |
|------|------|----------|
| system | Worker 镜像内置 | 平台保护，用户不可覆盖或禁用 |
| public | 管理员上传的共享资产 | 状态变更后点击“应用 Skill”，同步到所有运行中 Pod |
| private | 用户详情中上传 | 安装到目标 Agent 工作区，只调和目标 Pod |

同名 Skill 默认不静默覆盖：system 始终优先；public 与 private 同名返回冲突，只有显式 `allow_override` 用户策略才允许 private 覆盖 public。

## 最小目录

```text
<skill-name>/
├── SKILL.md              # 必需：frontmatter + 指令
├── muad.skill.json       # 可选：managed 编排
├── scripts/              # 可选：Shell/Python/Node 脚本
└── references/           # 可选：参考资料
```

`SKILL.md` 是所有 Skill 的唯一必需文件。需要 Console 管理元数据或业务平台登录态的
public/private Skill 可额外提供 `muad.skill.json`，并在其中用 `platform` 或 `platforms`
按需声明 0 到多个业务平台依赖。

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

## 激活与执行

Skill 激活按用户消息轮次隔离：

1. Agent 优先读取 `<available_skills>` 中授权 Skill 的精确 `SKILL.md`。
2. 后续工具调用只受 Runtime Guard 的文件、浏览器和会话边界约束。
3. 用户发送“继续、重试、再次执行”等新消息时必须重新读取本轮需要的 Skill。

最小版本不再提供 `muad_use_skill` / `muad_run_skill` 托管执行工具；脚本类 Skill 是否可执行由 OpenClaw 原生能力和 Runtime Guard 策略决定。

## 可选 managed manifest

需要业务平台登录态的 Skill 可通过 `muad.skill.json` 声明平台依赖：

```json
{
  "name": "mssw-query",
  "platforms": ["mssw"],
  "runtime": "script",
  "version": "1.0.0",
  "capabilities": ["browser"]
}
```

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

## 长任务反馈

最小版本不再内置独立进度 CLI。长耗时任务先通过 OpenClaw 原生最终回复返回结果；需要阶段性反馈时，后续迭代由平台 adapter 或新的受控执行层补齐。

模板见 [`_templates/`](./_templates/)。

## 打包与上传

Console 支持 `.tar.gz` 和 `.zip`。压缩包可以有一层外部目录，但解包后必须且只能定位到一个有效 `SKILL.md` 所在目录。

上传会拒绝：

- 绝对路径、父级路径和 Windows drive path。
- symlink、hardlink 及解包目录逃逸。
- 多个 `SKILL.md` 根或缺少 `SKILL.md`。
- 超过大小限制、空包和非法名称。

Public Skill 依赖共享运行目录：Docker 使用 active-only bind mount；Kubernetes 使用 RWX PVC。Private Skill 由 Console 通过目标 Pod 内 installer 写入用户工作区，不直接写宿主 PVC。

## 业务 Skill 扩展

预防流、周期报告、策略检查等业务 Playbook 通过新增 public/private Skill 扩展，不改变控制面与 Runtime 架构。业务 Skill 绑定的平台来自 Console 中管理员手动创建的平台名称，仓库和前端不内置默认平台。

仓库内 `mss-soar/SKILL.md` 仍是结构骨架，正式使用前需补齐业务接口、鉴权和操作流程，或基于 `_templates/` 创建新包。
