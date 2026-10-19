# Skill 开发与分层

本目录保存 Skill 源码与开发模板，是手工上传/测试用的打包来源；Worker 镜像不再内置 Skill。运行环境中的 Skill 由 Console 统一管理，实际可用集合由 public 存储挂载与 private 工作区组成，并按 system、public、private 三层解析。

## 分层与优先级

| 范围 | 来源 | 生效方式 |
|------|------|----------|
| system | Console 预置（平台保护） | 平台保护，用户不可覆盖或禁用 |
| public | 管理员上传的共享资产 | 状态变更后点击“应用 Skill”，同步到所有运行中 Pod |
| private | 用户详情中上传 | 安装到目标 Agent 工作区，只调和目标 Pod |

同名 Skill 默认不静默覆盖：system 始终优先；public 与 private 同名返回冲突，只有显式 `allow_override` 用户策略才允许 private 覆盖 public。

## 激活与执行

Skill 激活按用户消息轮次隔离：

1. Agent 优先读取 `<available_skills>` 中授权 Skill 的精确 `SKILL.md`。
2. 后续工具调用只受 Runtime Guard 的文件、浏览器和会话边界约束。
3. 用户发送“继续、重试、再次执行”等新消息时必须重新读取本轮需要的 Skill。

最小版本不再提供 `muad_use_skill` / `muad_run_skill` 托管执行工具；脚本类 Skill 是否可执行由 OpenClaw 原生能力和 Runtime Guard 策略决定。

怎么写一个 Skill（目录结构、`SKILL.md` frontmatter、managed manifest、脚本自助、关键提醒）见 [`_templates/README.md`](./_templates/README.md)。

自建 Skill 统一使用 Python。业务平台请求先由 Skill 调用 `session-manager get-state` 获取登录态，再把返回的 `sessionStateFile` 交给 `muad_skill_http.platform_request`；SDK 统一构造 Cookie/CSRF/Host 与每请求 `Traceid`，并记录统计与上报。managed Skill 必须在 `muad.skill.json` 写非空 `author`（作者姓名/工号/用户名），上传时 Console 会校验。上线前可用内置 `self-skill-review` 做只读检查；上传链路不做语言硬拦截，最终由管理员审批。

## 本地开发环境

Skill 脚本依赖 `muad_skill_http`（公网 PyPI 包 `muad-skill-http`）。Pod 镜像通过 `requirements.txt` 按固定版本安装，本地统一用同样方式，在独立 venv 里安装：

```bash
python3 -m venv .venv
.venv/bin/pip install "muad-skill-http==0.2.0"   # 版本与仓库 requirements.txt 保持一致
```

IDE 的解释器指向该 venv 即可获得补全和断点调试。本地运行 `platform_request` 不需要安装 session-manager：用 `muad_skill_http.build_local_state("<平台名>", "Cookie: ...", base_url="https://...")` 从浏览器 Cookie 生成状态文件，写到固定路径 `~/.muad-local/session-state.json` 即可。多平台 Skill 用 `muad_skill_http.merge_local_states(...)` 把多个平台合并到同一个文件。该分支只在 `MUAD_SESSION_KEY` 不存在时生效（Pod 内 Guard 一定会注入该变量，因此仍走 session-manager）；真实平台请在 Pod 内执行。

## 长任务反馈

普通 Skill 与 `longTask:true` Skill 都可在自己选择的关键业务节点执行语言无关的 `muad-progress` CLI，主动发送 stage/done/error 文本。Skill 不持有收件人：Runtime Guard 从可信前台会话或后台 task 决定企微/Mattermost 目标；事件和诊断只在 execution 生命周期内保存，不写 Console 数据库。

进度调用是 best-effort，不自动 heartbeat、不做业务去重/限频，也不替代最终回复。完整结果仍只走 OpenClaw 原生 final reply。默认 stdout 静默；`--json` 仅供脚本/测试读取本地调用结果，不是用户消息。

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
