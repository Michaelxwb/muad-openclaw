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

`SKILL.md` 是唯一必需文件。`muad.skill.json` 是确定性编排增强，不是 Skill 可见性或基础执行的前置条件。

扫描器会把 Skill 分类为：

- `managed`：包含合法 `muad.skill.json`。
- `traditional-script`：无 manifest，但扫描到可执行脚本。
- `traditional-prompt`：无 manifest，由 Agent 按说明调用 OpenClaw 原生工具。

## SKILL.md frontmatter

```yaml
---
name: web-tools-guide
description: "MANDATORY before calling web_search, web_fetch, browser, or opencli. Trigger on: 搜索/抓取网页/打开网站。"
---
```

- `name` 使用小写字母、数字、`-` 或 `_`。
- `description` 应说明触发场景和能力，不要把密钥、内部 URL 或业务数据写入其中。
- 对必须先阅读本 Skill 才能调用的原生工具，可使用 `MANDATORY before calling <tool list>.`。`muad-run-skill` 会从标准 description 解析工具列表，并在当前轮未激活时阻断调用、提示精确 `SKILL.md` 路径。
- 门禁只解析 frontmatter description，不从正文中的偶然工具名猜测依赖。

## 激活与执行

Skill 激活按用户消息轮次隔离：

1. Agent 优先读取 `<available_skills>` 中授权 Skill 的精确 `SKILL.md`。
2. 原生读取不可用时调用 `muad_use_skill(skill_name)`。
3. 后续工具调用归入当前 Skill，Agent/Runner 结束时写入终态。
4. 用户发送“继续、重试、再次执行”等新消息时必须重新激活，并产生新的 executionId。

传统脚本通过 `muad_run_skill` 执行扫描资产中允许的相对路径。禁止绝对路径、`..`、隐藏路径、目录、未扫描脚本、符号链接逃逸和 shell 字符串拼接。

## 可选 managed manifest

需要稳定步骤、参数和进度时增加 `muad.skill.json`：

```json
{
  "name": "example-long-task",
  "runtime": "script",
  "mode": "steps",
  "steps": [
    { "id": "auth", "title": "鉴权", "command": ["bash", "scripts/auth.sh"] },
    { "id": "query", "title": "查询", "command": ["python3", "scripts/query.py"] }
  ]
}
```

命令必须是 argv 数组，解释器仅允许 `bash`、`sh`、`python3` 或 `node`，脚本路径必须位于当前 Skill 根目录。

## 长任务进度

长耗时 managed/script Skill 使用语言无关的 `muad-progress` CLI 上报业务阶段。进度只描述 Agent 已知的上层步骤，不要求每个子脚本单独上报。

- 进度文本面向用户，保持简短。
- 不得包含 Cookie、Token、密码、内部 URL、SQL 或堆栈。
- 进度消息不能替代 OpenClaw 原生最终回复。
- 业务平台登录态通过 `session-manager` 获取，不在 Skill 中复制凭证解析逻辑。

模板见 [`_templates/`](./_templates/)；运行时细节见 [`../tools/muad-run-skill/README.md`](../tools/muad-run-skill/README.md)。

## 打包与上传

Console 支持 `.tar.gz` 和 `.zip`。压缩包可以有一层外部目录，但解包后必须且只能定位到一个有效 `SKILL.md` 所在目录。

上传会拒绝：

- 绝对路径、父级路径和 Windows drive path。
- symlink、hardlink 及解包目录逃逸。
- 多个 `SKILL.md` 根或缺少 `SKILL.md`。
- 超过大小限制、空包和非法名称。

Public Skill 依赖共享运行目录：Docker 使用 active-only bind mount；Kubernetes 使用 RWX PVC。Private Skill 由 Console 通过目标 Pod 内 installer 写入用户工作区，不直接写宿主 PVC。

## 业务 Skill 扩展

预防流、周期报告、策略检查等业务 Playbook 通过新增 public/private Skill 扩展，不改变控制面与 Runtime 架构。业务 Skill 绑定平台时，产品范围以 **MSSW / SDSP** 为主（见总设 CONST-PLAT-01）。

仓库内 `mss-soar/SKILL.md` 仍是结构骨架，正式使用前需补齐业务接口、鉴权和操作流程，或基于 `_templates/` 创建新包。
