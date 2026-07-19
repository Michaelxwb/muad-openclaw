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
- 当用户明确说“先对齐 / 先探讨 / 不要着急改代码 / 先给结论”时，先输出方案、风险和建议，不直接编辑代码、构建镜像或部署

## Forbidden Patterns
- Hard-coded secrets or credentials
- Unparameterized SQL
- Network calls inside tight loops

## Project Conventions

### Go Backend (console/backend)
- 外部命令（docker CLI）统一通过 helper 函数执行，`exec.CommandContext` + stderr 合并到 error；禁止裸 `exec.Command` 散落在业务代码中 `[internal/driver/docker.go:176-183]`
- HTTP handler 统一使用 `writeJSON` / `writeErr` 输出响应；禁止直接调用 `json.NewEncoder` `[internal/api/server.go:80-90]`
- 错误码体系：`4xxxx` 客户端错误 / `5xxxx` 服务端错误，子码按场景递增 `[internal/api/*.go]`
- 测试使用 fake/mock 实现接口（非真实 Docker/K8s），结合 `httptest` 测试 HTTP `[test/api_test.go]`

### TypeScript Frontend (console/frontend)
- 所有 API 调用经 `src/api.ts` 统一封装（BASE path、auth header、401 处理）；页面组件禁止裸 `fetch` `[src/api.ts]`
- TypeScript strict 模式开启（`strict`/`noUnusedLocals`/`noFallthroughCasesInSwitch`）`[tsconfig.json]`
- 表单提交：`busy` → `try/catch/finally` → `setErr`/`setMsg` 三态 `[Login.tsx, Containers.tsx]`

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
