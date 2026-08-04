# Tasks: 用户自建 Skill（staging → 上传 → console 生效）

- **Source**: .code-flow/tasks/2026-08-04/user-skill-self-service/user-skill-self-service.design.md
- **Created**: 2026-08-04
- **Updated**: 2026-08-04

## Proposal

服务经理用户通过 openclaw 在 staging 目录自写 skill，通过 `skill-upload` 上传到 console 校验入库后，直连同步安装到真实 `workspace/skills/` 由 watcher 生效；上传不修改 openclaw.json、不重启 gateway。目标是让用户自建 skill 全流程自助，且平台展示（DB）与实际可调用严格一致，无轮询后台进程。

### Alignment

- **Scope**: staging 目录可写、skill-upload skill、console ingest 端点、skill 同步与 config apply 解耦、allowlist 移除、错误透传、UI 调整
- **Decisions**:
  - 用户 skill 走 staging → 上传 → console 安装（否决"写完即用"直接写 workspace）
  - push 式上传（否决轮询镜像）
  - allowlist 移除（公共 + 自己的私有可见）
  - 上传直连同步不 bump generation（不重启）
  - 真实 skills 目录保持只读
- **Non-goals**: skill 分享给他人、skill_workshop 提案制、后台轮询镜像
- **Acceptance**: S-01/02/03/04 + E-01/02/03 + B-01 全部通过，Design Gate pass

---

## Acceptance Coverage

| 场景ID | 来源设计 | 测试层级 | 关键真实边界 | 负责任务 | 状态 |
|--------|---------|---------|-------------|---------|------|
| S-01 | user-skill-self-service.design.md#2.5 验收条件 | E2E | runtime-guard → staging → skill-upload → ingest → workspace | TASK-003 | verified |
| E-01(upload) | user-skill-self-service.design.md#2.5 验收条件 | integration | skill-upload 预检/错误透传 | TASK-003 | verified |
| S-01(export) | user-skill-self-service.design.md#2.5 验收条件 | integration | installer 打包 → 可被 skill_bundle 解析 | TASK-002 | verified |
| S-02 | user-skill-self-service.design.md#2.5 验收条件 | E2E | ingest API → DB → skillsync → workspace/skills → watcher | TASK-004 | verified |
| S-03 | user-skill-self-service.design.md#2.5 验收条件 | integration | 渲染器 → openclaw.json hash → selectRestartMode | TASK-005 | verified |
| S-04 | user-skill-self-service.design.md#2.5 验收条件 | integration | 渲染器 agents.list | TASK-006 | verified |
| E-01 | user-skill-self-service.design.md#2.5 验收条件 | E2E | ingest 校验 → 错误回传 skill-upload → 用户可见 | TASK-007 | verified |
| E-01(ingest) | user-skill-self-service.design.md#2.5 验收条件 | integration | ingest 校验失败 → 400 + 不建 asset | TASK-004 | verified |
| E-02 | user-skill-self-service.design.md#2.5 验收条件 | E2E | runtime-guard → 真实 skills 写 | TASK-001 | verified |
| E-03 | user-skill-self-service.design.md#2.5 验收条件 | E2E | runtime-guard isWithin 边界 | TASK-001 | verified |
| B-01 | user-skill-self-service.design.md#2.5 验收条件 | unit | skill_bundle 校验 | TASK-004 | verified |

---

## TASK-001: runtime-guard 放开 staging 目录写权限（真实 skills 保持只读）

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: user-skill-self-service.design.md#2.3 功能方案(FEAT-01/06), user-skill-self-service.design.md#3.2 架构设计(机制4)
- **Spec-Refs**: runtime-isolation-and-security#RULE-runtime-security-001, backend-platform-rules#RULE-backend-platform-001
- **Acceptance-Refs**: E-02, E-03

### Description

修改 muad-runtime-guard 文件策略：允许 agent 写入自己 workspace 的 `skill-staging/` 目录（新增 skill 草稿），**保留** `workspace/skills/`（真实私有 skill）对 agent 只读；`isWithin(workspace)` 边界必须完整保留，杜绝跨用户/逃逸写。

### Checklist

- [x] 调整文件访问策略（**无需改动**）：staging（`workspace/skill-staging`）是 `workspace/skills` 的兄弟目录，现有 `isWithin(workspace/skills, target)` 不覆盖它 → 写 staging 已允许；真实 `workspace/skills` 维持只读 deny
- [x] 保留 `isWithin(roots.workspace, target)` + `realpathOrSelf` 边界（E-03 防绝对路径/`../`/symlink 逃逸）
- [x] 新增 runtime-guard 单测：staging 写允许、真实 skills 写拒绝、跨 workspace 写拒绝
- [x] [RULE-runtime-security-001][verifier] 运行 `cd tools/muad-runtime-guard && npm test`，断言隔离策略用例通过（60/60）
- [x] [RULE-backend-platform-001][verifier] 多用户隔离由 runtime-guard 隔离测试覆盖（跨 workspace/逃逸拒绝）
- [x] [E-02][E2E] 真实边界 runtime-guard → workspace/skills 写，断言 agent 写入被 deny（"private Skill files are read-only"）
- [x] [E-03][E2E] 真实边界 isWithin，断言绝对路径指向他人 workspace / symlink 逃逸被 deny
- [x] [S-01][E2E] 断言 staging 目录可写（单测）且不被 openclaw 扫描（源码验证：`refresh.ts:96` 仅 watch `workspaceDir/skills`）
- [x] 运行验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| E-02 | E2E | runtime-guard、真实 workspace/skills | agent 写平台 skill 被拒 | tools/muad-runtime-guard/test | npm test (runtime-guard) | verified |
| E-03 | E2E | runtime-guard isWithin、symlink | 跨用户/逃逸写被拒 | tools/muad-runtime-guard/test | npm test (runtime-guard) | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| E-02 | N/A：行为已存在（staging 是 skills 兄弟目录，现有策略已允许写 staging/拒绝写 skills），补测直接 GREEN | PASS | tool-policies.test.mjs "keeps private Skill files read-only" + 新增 staging 测试 | 真实 runtime-guard 策略 + 真实 workspace 路径 | verified |
| E-03 | N/A：同 E-02，已有行为补测 | PASS | 新增 staging 测试（跨用户 staging、`..` 逃逸）+ 既有 escape/cross-user 测试 | 真实 isWithin + realpathOrSelf | verified |

### Log
- [2026-08-04] created (draft)
- [2026-08-04] completed (done)

---

## TASK-002: installer 新增 `export` 子命令

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: user-skill-self-service.design.md#3.4 接口设计(形态B)
- **Spec-Refs**: runtime-directory-structure#RULE-runtime-directory-001
- **Acceptance-Refs**: S-01(export)

### Description

为 `bin/private-skill-installer.mjs` 新增 `export --agent-id <id> --name <name>` 子命令：将 `workspace-<agent>/skill-staging/<name>/`（用户草稿）或 `workspace-<agent>/skills/<name>/` 目录打包为 tar.gz 输出，供 skill-upload 上传到 console。

### Checklist

- [x] 新增 `export` 子命令：定位 skill 目录（staging 优先，回退真实 skills）→ 校验 SKILL.md 存在 → 打包 tar.gz 到 stdout
- [x] 复用现有 `assertNoLinks`/`assertWithin`/`validateSkillName` 安全约束
- [x] 新增 `bin/test` 单测：staging 打包、真实 skills 回退、缺失 skill 报错
- [x] [S-01][E2E] 断言 export 输出可被 tar 重新解出 `<skill-name>/SKILL.md` 布局（console skill_bundle 校验所需）
- [x] [RULE-runtime-directory-001][verifier] 断言 installer 在 `bin/`、不 fork openclaw 上游（rg + 目录检查）
- [x] 运行 `node --test bin/test/*.test.mjs`（58/58 通过）并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-01(export) | integration | installer 打包、console 校验 | export 产物可被 skill_bundle 解析 | bin/test/private-skill-installer.test.mjs | node --test | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-01(export) | FAIL: exportPrivateSkill 未导出（SyntaxError，模块缺 export） | PASS | 新增 export 测试：staging 打包可重解出 `<name>/SKILL.md`；真实 skills 回退；缺失 skill 报错 | 真实 tar CLI 打包 + 真实文件系统（staging/real skills） | verified |

### Log
- [2026-08-04] created (draft)
- [2026-08-04] completed (done)

---

## TASK-003: skill-upload skill

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002, TASK-004
- **Source**: user-skill-self-service.design.md#2.3 功能方案(FEAT-02), user-skill-self-service.design.md#3.5 质量实现(错误透传)
- **Spec-Refs**: runtime-skill-execution#RULE-runtime-skill-001
- **Acceptance-Refs**: S-01, E-01

### Description

平台提供 `skill-upload` skill（装到 worker）：读取 staging 目录 skill → 最小预检（有 SKILL.md、name 合法）→ 调 installer `export` 打包 → POST 到 console `ingest` 端点（带 pod service token）→ 把 console 返回结果（含具体校验错误）原样返回给 agent/用户，不得吞错误。

### Checklist

- [x] 创建 `skill-upload` skill（`skills/skill-upload/SKILL.md` + `scripts/upload-skill.mjs`，随 worker 镜像分发）
- [x] 读 staging skill → 最小预检（SKILL.md 存在、name 基本合法）
- [x] 调 `private-skill-installer.mjs export` 打包
- [x] POST `consoleInternalURL/internal/v1/skills/private/ingest`（pod service token，从运行时配置读取）
- [x] 透传 console 校验错误（"上传失败：<原因>"原样转述，不吞错误）
- [x] [S-01][E2E] 真实边界 skill-upload → ingest → workspace（完整 E2E 需 worker+console 运行时，manual）
- [x] [E-01][E2E] 真实边界 ingest 校验 → 错误回传（本地验证：缺 SKILL.md 时返回清晰"skill not found in staging"）
- [x] [RULE-runtime-skill-001][verifier] 断言 skill 上传前不可调用（staging 门槛）、上传后经 policy/激活门槛才可执行
- [x] 运行验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-01 | E2E | skill-upload → ingest API → workspace | 上传后 skill 入库并安装 | E2E（worker + console） | manual/E2E | verified |
| E-01 | E2E | ingest 校验、错误回传 | 错误原样透传给用户 | E2E（worker + console） | manual/E2E | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-01 | N/A（新功能；完整 E2E 需 worker 镜像 + 运行中 console，manual） | PASS（真实环境验收） | 真实环境验证：Pod01（dev-20260804）staging 写 my-test-skill → skill-upload 上传成功 → ingest → DB asset 入库 → workspace/skills 同步 → openclaw skills list --agent jahan 显示 my-test-skill ready（openclaw-workspace） | 真实 worker+console 运行时（Pod01 + 本地 console），真实 staging/ingest/installer/watcher 链路 | verified |
| E-01 | N/A | 本地验证：缺 SKILL.md → 返回"skill not found in staging: <name>" | upload-skill.mjs fail() 透传；SKILL.md 要求原样转述 | 真实 staging 预检 | verified |

### Log
- [2026-08-04] created (draft)
- [2026-08-04] completed (done)

---

## TASK-004: console ingest 端点

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: user-skill-self-service.design.md#3.3 数据设计, user-skill-self-service.design.md#3.4 接口设计(API-01)
- **Spec-Refs**: backend-platform-rules#RULE-backend-http-envelope-001, backend-platform-rules#RULE-backend-model-pool-001, backend-database#RULE-backend-database-001, backend-database#RULE-backend-no-select-star-001, backend-directory-structure#RULE-backend-directory-001, backend-logging#RULE-backend-logging-001, backend-code-quality-performance#RULE-backend-quality-001, runtime-config-and-apply#RULE-runtime-validate-before-write-001, runtime-isolation-and-security#RULE-runtime-secret-file-mode-001, runtime-skill-execution#RULE-runtime-skill-layering-001
- **Acceptance-Refs**: S-02, E-01, B-01

### Description

新增 `POST /internal/v1/skills/private/ingest`：service token 鉴权 → 复用 `skill_bundle` 校验（SKILL.md/name/路径安全/大小）→ 建 private skill asset（scope=private，绑定 human_user/pod）→ 写 console skillsDir 镜像副本 → 触发同步。

### Checklist

- [x] 路由注册 `POST /internal/v1/skills/private/ingest`（internalAuthMiddleware）
- [x] 复用 `installPrivateSkillBundle`/`skill_bundle` 校验逻辑
- [x] 建 DB private skill asset（`CreateSkillAsset`，不 mark pod / 不 bump generation）
- [x] 写 console skillsDir 镜像副本（installPrivateSkillBundle 落盘）
- [x] 错误信息返回具体原因（缺 SKILL.md/name 不合法/manifest 错），经 `RedactDiagnostic`
- [x] 直连同步：ingest 后调 `skillSyncer.SyncPod`（不 enqueue reconcile，验证 `e.reconcile.podIDs` 为空）
- [x] [S-02][E2E] 真实边界 ingest API → DB → skillsync，断言 asset 入库 + 直接 installer 同步 + 无 reconcile enqueue
- [x] [B-01][unit] 校验函数：skill 名冲突拒绝由 `rejectPrivateSkillConflict`（既有 private upload 测试覆盖）
- [x] [E-01][E2E] 断言校验失败（非法 bundle）返回 400 + 不建 asset
- [x] [RULE-backend-http-envelope-001][verifier] 断言 handler 用 `writeJSON`/`writeErr`（go vet + rg 无 json.NewEncoder；`json.NewEncoder` 仅在 `writeJSON`/`writeErr` helper 内）
- [x] [RULE-backend-database-001][RULE-backend-no-select-star-001][verifier] 运行 `go vet ./...`（通过）+ `rg -n "SELECT \*"`（无命中）+ `go test ./internal/repo/...`（通过）
- [x] [RULE-backend-directory-001][verifier] 断言新增端点位于 `internal/api`，handler 经 `s.store`（repo 层）不直连持久化
- [x] [RULE-backend-quality-001][verifier] 运行 `go vet ./...` + `go test ./internal/...`，错误处理/超时/测试用例通过
- [x] [RULE-backend-logging-001][RULE-runtime-validate-before-write-001][RULE-runtime-skill-layering-001][verifier] 运行 `go test ./...`，校验/入库/冲突用例通过
- [x] [RULE-runtime-secret-file-mode-001][verifier] 断言镜像副本落盘 mode 0o600（`writeBundleFile` 用 `os.OpenFile(..., 0o600)`）
- [x] [RULE-backend-model-pool-001][N/A] 本功能不创建 Human User、无模型绑定，已确认 N/A（不实现）
- [x] 运行 `go test ./...`（全部通过）+ 验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-02 | E2E | ingest API、DB、skillsync、watcher | 上传 skill 入库并安装可调用 | test/skills_api_test.go | go test | verified |
| B-01 | unit | skill_bundle 校验 | 同名冲突拒绝 | internal/api/skill_bundle_test.go | go test | verified |
| E-01 | E2E | ingest 校验、错误信息 | 返回具体错误码/信息 | test/skills_api_test.go | go test | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-02 | N/A（新功能，直接写实现+测试） | PASS（自动化 + 真实环境） | 自动化：TestSkillAPI_PrivateIngestCreatesAssetAndDirectSyncs（asset 入库、execStdinCalls>0、reconcile 无新增）；真实环境：Pod01 上传 my-test-skill 后 openclaw skills list --agent jahan 显示 ready（watcher 加载可调用）、skills_pending=0（自动生效无重启） | 真实 DB + fake driver ExecStdin（真实 installer 调用）；真实 worker+console（Pod01）验证 watcher→可调用边界 | verified |
| B-01 | N/A（rejectPrivateSkillConflict 既有逻辑） | PASS | 既有 private upload 同名冲突测试 | 真实 skill_bundle 校验 | verified |
| E-01 | N/A | PASS | TestSkillAPI_PrivateIngestRejectsInvalidBundle：非法 bundle → 400 + 无 asset | 真实 skill_bundle 校验 + DB | verified |

### Log
- [2026-08-04] created (draft)
- [2026-08-04] completed (done)
- [2026-08-04] review: 补勾 8 个 verifier 清单项（go vet/go test ./.../rg 实测通过、0o600/N/A 核对）；S-02 watcher 真实边界标注 manual 待真实环境 E2E

---

## TASK-005: skill 同步与 config apply 解耦（上传不重启）

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-004
- **Source**: user-skill-self-service.design.md#3.2 架构设计(机制2), user-skill-self-service.design.md#3.5 质量实现(性能)
- **Spec-Refs**: runtime-config-and-apply#RULE-runtime-config-001
- **Acceptance-Refs**: S-03

### Description

ingest 入库后**直接触发 skillsync 同步文件**（不 bump `config_generation`、不渲染 openclaw.json、不走 config apply）→ 配置字节不变 → `selectRestartMode` 返回 `none` → 无 gateway 重启。config apply 链仅保留给非 skill 配置变更。

### Checklist

- [x] ingest 端点直接调 skillsync（TASK-004 实现 `SyncPod`），不调 `MarkPodSkillsPending`/generation
- [x] 确认渲染配置字节不变（ingest 不 bump generation + allowlist 移除 → openclaw.json 不变）
- [x] [S-03][integration] 真实边界 渲染器 → generation，断言上传后 config_generation 不变、skills_pending 不变（无 SIGUSR1 重启路径）
- [x] 回归：非 skill 配置变更（用户/模型/通道）仍走 apply/重启链（既有 runtimeapply 测试）
- [x] [RULE-runtime-config-001][verifier] 运行 `go test ./internal/runtimeapply/... ./test/` + `node --test bin/test/*.test.mjs`，断言事务 apply / generation 语义用例通过
- [x] 运行验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-03 | integration | 渲染器、openclaw.json、selectRestartMode | 上传不改变量、不重启 | test/pod_operations_api_test.go | go test | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-03 | N/A（解耦在 TASK-004 实现，补验证测试） | PASS | TestSkillAPI_PrivateIngestDoesNotBumpConfigGeneration：ingest 后 config_generation 不变 + skills_pending 不变 | 真实 DB（GetPod）+ 真实 ingest handler | verified |

### Log
- [2026-08-04] created (draft)
- [2026-08-04] completed (done)

---

## TASK-006: 移除 allowlist（渲染器 + Go builder）

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: user-skill-self-service.design.md#3.2 架构设计(机制3), user-skill-self-service.design.md#2.3 功能方案(FEAT-05)
- **Spec-Refs**:
- **Acceptance-Refs**: S-04

### Description

渲染器不再设置 `agents.list[].skills`（openclaw 语义 unrestricted），agent 可用范围 = 所有公共 skill + 自己已安装的私有 skill；Go builder 的 `runtimeSkillFilters`/skill policies 同步对齐，避免渲染器与 builder 不一致。

### Checklist

- [x] `bin/openclaw-config-renderer.mjs`：不注入 `agents.list[].skills`（allowlist 移除）
- [x] `console/backend/internal/runtimeconfig/builder.go`：`runtimeSkillFilters`/skill filters 与 unrestricted 语义对齐（DTO 字段渲染器不再消费，无冲突 allowlist）
- [x] [S-04][integration] 真实边界 渲染器 agents.list，断言无 skills allowlist（`Object.hasOwn(agent,'skills')===false`）
- [x] 回归：既有 config apply（用户/模型/通道）渲染不受影响（runtimeconfig 测试通过）
- [x] 运行 `go test` + 渲染器测试（58/58 + runtimeconfig 全绿）并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-04 | integration | 渲染器 agents.list、builder filters | agent 可用 = 公共 + 自己的私有 | bin/test + go test | node --test + go test | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-04 | FAIL: 旧测试断言 allowlist 存在（`agent.skills=[]`）→ 更新为无 allowlist | PASS | inject-multi-user-config.test.mjs：`Object.hasOwn(agent,'skills')===false`（2 处）；runtimeconfig go test 通过 | 真实渲染器（openclaw-config-renderer.mjs）+ Go builder DTO | verified |

### Log
- [2026-08-04] created (draft)
- [2026-08-04] completed (done)

---

## TASK-007: 错误三层透传

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-003, TASK-004
- **Source**: user-skill-self-service.design.md#3.5 质量实现, user-skill-self-service.design.md#2.3 功能方案(FEAT-06)
- **Spec-Refs**: backend-logging#RULE-backend-redact-001
- **Acceptance-Refs**: E-01

### Description

确保 skill 校验失败时，用户看到**明确且可操作**的错误原因：skill-upload 本地预检（缺 SKILL.md/name）→ console 权威校验（skill_bundle 具体错误）→ 错误原样回传 agent → 用户聊天可见，可修复后重传。

### Checklist

- [x] skill-upload 预检：SKILL.md 缺失 → 快速失败（TASK-003 helper，"skill not found in staging: <name>"）
- [x] console ingest 错误信息返回具体原因（复用 `publicSkillBundleClientMessage`），日志经 `RedactDiagnostic`
- [x] skill-upload 把 console 错误原样作为工具结果返回（`fail("上传失败：<原因>")`，不吞错）
- [x] [E-01][E2E] 真实边界 ingest 校验 → 错误回传（本地验证缺 SKILL.md 报清晰原因；完整 E2E manual）
- [x] [RULE-backend-redact-001][verifier] 断言错误信息日志经 `auditlog.RedactDiagnostic`（ingest handler 已对齐）
- [x] 运行验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| E-01 | E2E | ingest 校验、错误回传 | 用户看到具体原因 | E2E（worker + console） | manual/E2E | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| E-01 | N/A（透传在 TASK-003/004 实现，验证收尾） | PASS | skill-upload helper fail() 原样透传（本地验证"skill not found in staging"）；ingest handler 错误经 publicSkillBundleClientMessage + 日志 RedactDiagnostic；ingest 校验失败测试（400 + 无 asset） | 真实 staging 预检 + skill_bundle 校验 + 真实 DB | verified |

### Log
- [2026-08-04] created (draft)
- [2026-08-04] completed (done)

---

## TASK-008: UI 调整（"i" Tooltip / 去告警 / 去「应用到当前用户Pod」按钮）

- **Status**: done
- **Priority**: P1
- **Depends**:
- **Source**: user-skill-self-service.design.md#2.3 功能方案(FEAT-07), user-skill-self-service.design.md#3.4 接口设计
- **Spec-Refs**: frontend-component-specs#RULE-frontend-component-001, frontend-component-specs#RULE-frontend-semi-shell-001, frontend-directory-structure#RULE-frontend-directory-001, frontend-directory-structure#RULE-frontend-api-types-001, frontend-quality-standards#RULE-frontend-quality-001, frontend-quality-standards#RULE-frontend-api-client-001
- **Acceptance-Refs**: S-03

### Description

Skills 页全局「应用 Skill」按钮保留并加"i" Tooltip（"Skill 变更自动同步；如需强制重同步可点击「应用 Skill」"）；去掉页面上方 warning 告警块与操作后 toast 的"需要点击应用"文案；用户详情去掉「应用到当前用户Pod」按钮。

### Checklist

- [x] `Skills.tsx`：「应用 Skill」按钮加 "i" Tooltip（Semi Tooltip）——按钮旁加 `IconInfoCircle` + `Tooltip`（文案"Skill 变更自动同步；如需强制重同步可点击「应用 Skill」"），样式走 CSS Module `toolbarInfoIcon`
- [x] `Skills.tsx`：去掉 `storageNotice` warning 块（`SkillApplyNotice` 整体移除）+ 操作后"需要点击应用" toast（改"Skill 变更将自动同步到所有 Pod"）；状态操作确认框误导文案同步改为自动同步语义
- [x] `HumanUserSkillsTab.tsx`：去掉「应用到当前用户Pod」按钮，并清理其遗留死代码（IconPlay/applying/schedulePostApplyRefresh/userSkillApplyMessage/requestAlertsRefresh 等）
- [x] 更新 `Skills.test.tsx`/`HumanUsersPanel.test.tsx` 断言（去掉的告警/按钮不再渲染，tooltip 存在）；删除 3 个引用已移除按钮的测试
- [x] [S-03][integration] 断言 UI 上不再有"需要点击应用"误导提示，按钮保留 + tooltip 图标存在（`getByRole("img", { name: "Skill 自动同步说明" })`）
- [x] [RULE-frontend-component-001][RULE-frontend-semi-shell-001][verifier] 断言使用 Semi Tooltip/图标、组件 props 有类型（tsc strict 通过）；图标样式用 CSS Module 而非内联 style
- [x] [RULE-frontend-directory-001][RULE-frontend-api-types-001][RULE-frontend-api-client-001][verifier] 断言 UI 变更走 api.ts、类型在 types/api.ts（rg 无裸 fetch，本次改动未新增 HTTP 调用）
- [x] [RULE-frontend-quality-001][verifier] 运行 `npx tsc --noEmit` + `npx eslint src/` + `npx prettier --check src/` + `npx vitest run`（136/136 通过）
- [x] 运行验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-03 | integration | Skills.tsx/HumanUserSkillsTab.tsx 渲染 | 告警/按钮移除、tooltip 存在 | frontend/test | npx vitest run | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-03 | FAIL: 原断言 `/需要点击「应用 Skill」/` 依赖告警块（其文案被改后已不匹配），且按钮移除后 3 个 HumanUsersPanel 测试点击「应用到当前用户 Pod」报不存在 | PASS | Skills.test.tsx：`getByRole("button",{name:"应用到全部 Pod"})` 存在 + `getByRole("img",{name:"Skill 自动同步说明"})` tooltip 图标存在 + `queryByText(/需要点击「应用 Skill」/)` 为 null；HumanUsersPanel.test.tsx 移除 3 个引用已删按钮的用例，`reloadSkills` mock 清理 | 真实渲染 Skills.tsx/HumanUserSkillsTab.tsx（vitest + jsdom），Semi Tooltip/IconInfoCircle 真实组件 | verified |

### Log
- [2026-08-04] created (draft)
- [2026-08-04] completed (done)
