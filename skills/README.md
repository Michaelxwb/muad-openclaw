# Skill 开发与分层

本目录保存 Worker 镜像内置的 Skill 种子和开发模板。运行环境中的 Skill 由 Console 统一管理，并按 system、public、private 三层解析。

## 分层与优先级

| 范围 | 来源 | 生效方式 |
|------|------|----------|
| system | Worker 镜像内置 | 平台保护，用户不可覆盖或禁用 |
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
