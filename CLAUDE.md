# Project Guidelines

## Team Identity
- Team: [team name]
- Project: muad-openclaw
- Language: Go, TypeScript

## Core Principles
- All changes must include tests
- Single responsibility per function (<= 50 lines)
- No loose typing or silent exception handling
- Handle errors explicitly
- **先对齐再改代码**：涉及表结构、跨模块重构、行为取舍或产品交互争议时，先给出结论/方案与用户确认，再动代码；当用户明确说“先对齐 / 先探讨 / 不要着急改代码 / 先给结论”时，不直接编辑代码、构建镜像或部署

## Forbidden Patterns
- Hard-coded secrets or credentials
- Unparameterized SQL / `SELECT *`
- Network calls inside tight loops
- Secrets baked into images or world-readable secret files

## Project Conventions

### Go Backend (console/backend)
- 外部命令（docker CLI）统一通过 helper 函数执行，`exec.CommandContext` + stderr 合并到 error；禁止裸 `exec.Command` 散落在业务代码中 `[internal/driver/docker.go]`
- HTTP handler 统一使用 `writeJSON` / `writeErr` 输出响应；禁止直接调用 `json.NewEncoder` `[internal/api/server.go]`
- 错误码体系：`4xxxx` 客户端错误 / `5xxxx` 服务端错误，子码按场景递增；业务冲突映射稳定文案（如 model already bound、generation conflict）
- 创建 Human User 必须绑定未占用 `model_config_id`，禁止隐式模型回退
- 写入日志/审计/apply 失败字段前对 error 做 `auditlog.RedactDiagnostic`
- 测试使用 fake/mock 实现接口（非真实 Docker/K8s），结合 `httptest` 测试 HTTP `[test/api_test.go]`

### TypeScript Frontend (console/frontend)
- 所有 API 调用经 `src/api.ts` 统一封装（`/api/v1`、auth header、`code===0` 解包、`ApiError`、401 → clear token + `UNAUTHORIZED_EVENT`）；`pages/**`/`components/**` 禁止裸 `fetch`
- 契约类型放 `src/types/api.ts`，由 `api.ts` re-export
- UI 以 Semi Design 为主；`ConfigProvider` 在 `main.tsx` 统一挂载
- TypeScript strict 模式开启（`strict`/`noUnusedLocals`/`noFallthroughCasesInSwitch`）`[tsconfig.json]`
- 表单提交：`busy` → `try/catch/finally` → `setErr`/`setMsg` 三态
- 轮询/自动刷新 hook 必须区分首载与后台刷新：后台刷新不设 `loading=true`，避免表格 spinner 持续闪烁

### Runtime (bin / tools / skills)
- 不 fork OpenClaw 上游；能力经控制面配置 + 外置插件
- runtime DTO 先 `validateRuntimeConfig` 再原子落盘（`0o600`）；apply 走 generation + stage + health/rollback
- Skill：system 优先且 protected；public/private 冲突默认不静默覆盖（需 allow_override）

<!-- code-flow:spec-loading schema=1 start -->
## Spec Workflow (schema 1)

- If `.code-flow/.active-task.json` exists, validate it and `spec-context.yml`, then use only the active TASK's `Spec-Refs`, Design refs, and Acceptance Contract. Never reselect Specs from Catalog.
- Without an active TASK, explicit file paths use deterministic `path_mapping` constraints; prompts without paths receive the Spec Catalog for exploration or creation of the next Context.
- PRD, Design, Plan, Start, Coding, and Done inherit one persisted Context. Required rules must be applied and verified before their stage gate passes.
- A corrupt marker, Context hash drift, or required scope expansion is `SPEC_WORKFLOW_BLOCKED`; run `cf-spec refresh/doctor` instead of falling back.
- Tier 0 `_map.md` files are navigation only. Rule constraints live in metadata-bearing Tier 1 Specs.

Do NOT ask the user which Specs to load—the Context-first router is authoritative.
<!-- code-flow:spec-loading schema=1 end -->

## 合规反馈协议（quality_loop）

1. 编辑代码后收到 **Spec 合规反馈 (auto-check)** 时，先按提示修正违规，再继续当前任务
2. 用户表示某条反馈是误报（"这是误报"/"忽略这个检查"）时，代为执行：
   `python3 .code-flow/scripts/cf_feedback.py ignore <check-id>`
   （check-id 见反馈中的 `规则: <spec>#<check-id>`；同一规则误报达阈值会自动停用）
3. 会话收尾被校验拦回（cf-stop 反馈未过项）时，修复后再结束；不要绕过
4. 新增/修改规范时优先用 ✅/❌ 代码对照示例表达（见 spec 模板 Examples 段）

## Task Documents (cf-task workflow)

- `.code-flow/specs/shared/` holds PRD/design templates（含前端 `design-frontend.md`）used by `/cf-task:prd` and `/cf-task:align`
- 一个需求的 prd / design / tasks 同放需求目录 `.code-flow/tasks/<日期>/<需求>/`；全栈需求可有 `<需求>.frontend.design.md` + `<需求>.backend.design.md`，`/cf-task:plan <需求目录>` 合并拆解，`/cf-task:archive` 按整个需求目录归档（旧扁平布局仍兼容）
- Workflow: `/cf-task:prd` → `.prd.md` → `/cf-task:align <.prd.md>` → `.design.md`(s) → `/cf-task:plan <需求目录>` → tasks
- Templates are read by the commands themselves; you do not need to pre-load them
