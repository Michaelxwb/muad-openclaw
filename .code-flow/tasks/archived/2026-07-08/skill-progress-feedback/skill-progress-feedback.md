# Tasks: Skill 长耗时进度反馈规范与 muad-progress CLI

- **Source**: `.code-flow/tasks/2026-07-08/skill-progress-feedback/skill-progress-feedback.design.md`
- **Created**: 2026-07-09
- **Updated**: 2026-07-09

## Proposal

本任务集实现语言无关的 `muad-progress` 进度上报能力，让 TS、Python、Shell、Go 等不同语言编写的业务 skill 都能以统一方式向用户反馈长耗时任务进度。2026-07-09 微信/企微实测确认旧 OpenClaw adapter 未持有会话上下文，不能稳定投递独立进度；后续方案调整为 `muad-run-skill` OpenClaw runner/tool 持有执行上下文，`muad-progress` 只负责把脚本进度事件交回 runner。

---

## TASK-001: 搭建 muad-progress Go CLI 工程骨架

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: `skill-progress-feedback.design.md#3.1 方案选型`, `skill-progress-feedback.design.md#3.2 架构设计`, `skill-progress-feedback.design.md#4.1 部署架构`

### Description

在 `tools/muad-progress/` 下创建 Go CLI 主体目录，建立 `cmd/muad-progress`、`internal/`、`testdata/` 和 README。CLI 主体应独立于 `console/`，后续产出 `/usr/local/bin/muad-progress`。

### Checklist

- [x] 创建 `tools/muad-progress/` 目录结构。
- [x] 初始化 Go module 或复用仓库 Go 工作区策略，确保不耦合 `console/backend` 包。
- [x] 实现最小 `muad-progress --help` / version 输出。
- [x] 添加基础 CLI 单元测试或命令执行测试。
- [x] 在 README 中说明目录职责、构建方式和不放入 Console 的原因。

### Log

- [2026-07-09] created (draft)
- [2026-07-09] started (in-progress)
- [2026-07-09] completed (done)

---

## TASK-002: 实现进度事件模型与参数校验

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: `skill-progress-feedback.design.md#2.3 功能方案`, `skill-progress-feedback.design.md#3.3 数据设计`, `skill-progress-feedback.design.md#3.4 接口设计`

### Description

实现 `progress` / `done` / `error` 事件模型，支持 `skill`、`stage`、`text`、`id`、`visibility`、`privacy`、`ts` 等字段校验。参数非法时返回约定退出码并输出可诊断错误。

### Checklist

- [x] 定义事件结构体和事件类型枚举。
- [x] 实现 `stage`、`done`、`error` 子命令的参数解析。
- [x] 校验必填字段、stage 合法性、text 非空和长度边界。
- [x] 实现 `--json` 输出格式。
- [x] 添加正常、缺参、非法参数、超长 text 的测试。

### Log

- [2026-07-09] created (draft)
- [2026-07-09] started (in-progress)
- [2026-07-09] completed (done)

---

## TASK-003: 实现敏感信息过滤与本地诊断日志

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002
- **Source**: `skill-progress-feedback.design.md#2.5 验收条件`, `skill-progress-feedback.design.md#3.5 质量实现方案`

### Description

为用户可见进度增加敏感信息保护，避免 Cookie、token、password、内部 URL、SQL、stack trace 等内容出现在进度消息中。adapter 不可用或事件被拒绝时，写入当前用户 State PVC 下的本地诊断日志。

### Checklist

- [x] 实现敏感字段与模式检测。
- [x] 对敏感命中事件返回退出码 `3`，并输出脱敏错误。
- [x] 实现可选本地 JSONL 诊断日志 `/home/node/.muad/progress-events.jsonl`。
- [x] 确保诊断日志也不写入敏感原文。
- [x] 添加敏感信息拒绝、日志脱敏和日志写入失败不阻塞的测试。

### Log

- [2026-07-09] created (draft)
- [2026-07-09] started (in-progress)
- [2026-07-09] completed (done)

---

## TASK-004: 实现节流、去重与心跳兜底

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002
- **Source**: `skill-progress-feedback.design.md#2.5 验收条件`, `skill-progress-feedback.design.md#3.5 质量实现方案`

### Description

实现长耗时任务的进度体验保护，支持同阶段去重、最小发送间隔、最大消息条数，以及 `heartbeat` 子命令的低频兜底提示，避免企微/微信刷屏。

### Checklist

- [x] 定义本地去重 key：session / skill / id / stage。
- [x] 实现同阶段重复上报合并或丢弃。
- [x] 实现最小发送间隔和最大条数配置。
- [x] 实现 `muad-progress heartbeat` 子命令。
- [x] 添加重复上报、高频上报、heartbeat 终止条件测试。

### Log

- [2026-07-09] created (draft)
- [2026-07-09] started (in-progress)
- [2026-07-09] completed (done)

---

## TASK-005: 实现 OpenClaw Progress Adapter

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002, TASK-003, TASK-004
- **Source**: `skill-progress-feedback.design.md#3.2 架构设计`, `skill-progress-feedback.design.md#3.4 接口设计`, `skill-progress-feedback.design.md#5 风险与依赖`

### Description

在 `tools/progress-adapters/openclaw/` 实现 TypeScript 薄 adapter，将 `muad-progress` 事件转换为 OpenClaw 现有 `onUpdate` / `emitToolProgress` / `tool.progress` 通道，不包含业务逻辑。

### Checklist

- [x] 创建 OpenClaw adapter 目录与 README。
- [x] 定义 adapter 输入事件 JSON schema。
- [x] 调用 OpenClaw 现有进度通道发送 channel 可见 progress。
- [x] 实现 adapter 不可用时的快速失败/降级约定。
- [x] 添加事件转换、错误降级和不暴露敏感字段的测试。

### Log

- [2026-07-09] created (draft)
- [2026-07-09] started (in-progress)
- [2026-07-09] completed (done)

---

## TASK-006: 实现 Hermes Progress Adapter

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002, TASK-003, TASK-004
- **Source**: `skill-progress-feedback.design.md#3.2 架构设计`, `skill-progress-feedback.design.md#3.4 接口设计`, `skill-progress-feedback.design.md#5 风险与依赖`

### Description

在 `tools/progress-adapters/hermes/` 实现 Python 薄 adapter，通过 Hermes plugin/tool 机制承接 `muad-progress` 事件。skill 调用方式保持与 OpenClaw 一致。

### Checklist

- [x] 创建 Hermes adapter 目录与 README。
- [x] 定义 Hermes plugin/tool 注册入口。
- [x] 将 CLI 事件转换为 Hermes 可展示的进度或低频普通消息。
- [x] 实现 Hermes 进度能力不足时的降级策略。
- [x] 添加 plugin 注册、事件转换和降级路径测试。

### Log

- [2026-07-09] created (draft)
- [2026-07-09] started (in-progress)
- [2026-07-09] completed (done)

---

## TASK-007: 编写 TS / Python / Shell 业务 Skill 模板

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001, TASK-002
- **Source**: `skill-progress-feedback.design.md#2.3 功能方案`, `skill-progress-feedback.design.md#3.2 架构设计`

### Description

在 `skills/_templates/` 提供多语言业务 skill 模板，默认包含 accepted、auth、query、analysis、done、error 等阶段示例，并演示如何与 session-manager 配合。

### Checklist

- [x] 创建 `business-skill-ts` 模板。
- [x] 创建 `business-skill-python` 模板。
- [x] 创建 `business-skill-shell` 模板。
- [x] 模板默认调用 `muad-progress`，不依赖专属 SDK。
- [x] 模板 README 说明阶段命名、文案规范和安全边界。
- [x] 添加模板 smoke test 或示例执行校验。

### Log

- [2026-07-09] created (draft)
- [2026-07-09] started (in-progress)
- [2026-07-09] completed (done)

---

## TASK-008: 实现 Skill 规范静态检查

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-007
- **Source**: `skill-progress-feedback.design.md#2.3 功能方案`, `skill-progress-feedback.design.md#2.5 验收条件`, `skill-progress-feedback.design.md#3.5 质量实现方案`

### Description

提供 CI 可调用的静态检查，扫描长耗时或业务系统 skill 是否接入 `muad-progress`、是否绕过 session-manager、是否存在明显敏感进度文案。

### Checklist

- [x] 定义 skill 检查脚本入口和配置。
- [x] 扫描 `SKILL.md` 与 `scripts/` 中是否调用 `muad-progress`。
- [x] 对标记为业务系统访问的 skill 检查 session-manager 使用约定。
- [x] 扫描 Cookie/token/password 等敏感文案。
- [x] 支持 warning / fail 两种模式，便于灰度。
- [x] 添加通过、失败、warning 模式测试样例。

### Log

- [2026-07-09] created (draft)
- [2026-07-09] started (in-progress)
- [2026-07-09] completed (done)

---

## TASK-009: 完善部署、构建与回滚文档

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-001, TASK-005, TASK-006, TASK-007
- **Source**: `skill-progress-feedback.design.md#4 部署与运维`, `skill-progress-feedback.design.md#5 风险与依赖`

### Description

补充 worker 镜像内置 `muad-progress`、adapter 和 skill 模板的发布路径、构建命令、K8s 挂载说明、灰度与回滚步骤。

### Checklist

- [x] 文档化 Go CLI 多平台构建命令。
- [x] 文档化 worker 镜像中的 `/usr/local/bin/muad-progress` 发布位置。
- [x] 文档化 `/opt/muad/progress-adapters/` 与 public skills PVC 的关系。
- [x] 补充 PoC、灰度、全量和回滚流程。
- [x] 补充 OpenClaw/Hermes 两种 Agent 的部署检查清单。

### Log

- [2026-07-09] created (draft)
- [2026-07-09] started (in-progress)
- [2026-07-09] completed (done)

---

## TASK-010: 集成验收与示例业务 Skill 验证

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-005, TASK-006, TASK-007
- **Source**: `skill-progress-feedback.design.md#2.5 验收条件`, `skill-progress-feedback.design.md#6 需求追溯矩阵`

### Description

用一个示例业务 skill 验证完整链路：CLI 上报阶段、adapter 投递进度、同阶段去重、敏感信息拒绝、adapter 不可用降级、OpenClaw/Hermes 调用方式一致。

### Checklist

- [x] 编写示例长耗时 skill 或基于模板生成示例。
- [x] 覆盖 S-01：OpenClaw worker 中进度可见。
- [x] 覆盖 S-02/B-03：Python skill 不依赖 Python SDK 即可上报。
- [x] 覆盖 S-03/S-05/B-02：兜底、去重和节流生效。
- [x] 覆盖 E-02/E-03/E-04：敏感拒绝、adapter 不可用、业务超时。
- [x] 输出验收记录或测试报告。

### Log

- [2026-07-09] created (draft)
- [2026-07-09] started (in-progress)
- [2026-07-09] completed (done)

---

## TASK-011: 用 muad-run-skill 替换 OpenClaw no-op adapter 路径

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001, TASK-002, TASK-007, TASK-008
- **Source**: `skill-progress-feedback.design.md#3.2 架构设计`, `skill-progress-feedback.design.md#2.5 验收条件`

### Description

新增 `tools/muad-run-skill/` OpenClaw 插件，注册通用 `muad_run_skill` tool。runner 读取 `muad.skill.json`，支持 `steps` 和 `entrypoint` 两种模式；`steps` 由 runner 自动上报阶段，`entrypoint` 通过 `MUAD_PROGRESS_EVENTS_FILE` 接收脚本内 `muad-progress` 事件，再通过 OpenClaw tool `onUpdate` 发出进度。旧 `progress-adapters/openclaw` 不再作为 OpenClaw 主链路。

### Checklist

- [x] 创建 `tools/muad-run-skill/` 插件目录、manifest 和 README。
- [x] 实现 `muad.skill.json` 读取与校验。
- [x] 实现 `steps` 模式自动阶段进度。
- [x] 实现 `entrypoint` 模式通过 `MUAD_PROGRESS_EVENTS_FILE` 接收脚本事件。
- [x] 注册 `muad_run_skill` OpenClaw tool，并通过 `onUpdate` 输出进度。
- [x] 扩展 `muad-progress` 支持 runner 事件文件通道。
- [x] 扩展 `muad-skill-check` 校验 runner manifest。
- [x] 更新 `example-long-task` 为 runner manifest + `muad_run_skill` 调用方式。
- [x] 更新 Dockerfile / baseline / inject-env，使 worker 镜像加载 `muad-run-skill` 插件。
- [x] 构建新镜像并在 66667 Pod 端到端验证微信/企微可见进度。

### Log

- [2026-07-09] created (in-progress)
- [2026-07-09] completed (done)
