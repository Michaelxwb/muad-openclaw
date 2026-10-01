# Tasks: Runtime 配置精简与文件输入

- **Source**: runtime-config-file-input.design.md（v1.1）
- **Created**: 2026-09-30
- **Updated**: 2026-10-01
- **Status**: done（21 个实现/测试修复任务已通过 Done Gate；20 个 functional 验收通过；S-02 E2E 已通过，10 个真实集群场景及 review 规则待终验）

## Proposal

保留 RuntimeConfigV1 及按 Agent 授权结构，只移除非传统脚本类型的无用路径，K8s 和 Docker 启动统一改为文件输入，解决大 DTO 阻止入口执行的问题。热更新仍走 stdin 事务，并保留原镜像/env/file 的通用回滚；用户可删除时保留状态，再以相同 Pod ID、新镜像接管旧卷和用户。

本计划不引入 Skill 引用重构、数据库迁移、旧镜像日常创建或新前端交互。既有旧 workload 过渡维护与失败回滚保留；新建使用配套新镜像。

## 人工确认归档（2026-10-01）

- 用户明确指示：“我手动验证了基本可用，那就直接归档任务”。按此指示直接归档，不继续执行原计划的完整自动化终验。
- 用户此前明确：“docker不用测，10个用户也不用测”。这两项不再补测，已有实测证据保留。
- 人工验证结论限于“基本可用”，不推断用户已经逐项验证私有 Skill、Console 中途退出、Secret 延迟、并发或重复升级，也不推断已经确认全部 17 项 review 规范。
- 21 个子任务维持 Done Gate 后的 done；已 verified 的验收证据保持，10 个原始 E2E 场景继续保留 e2e_deferred。归档表示用户确认收尾，不表示完整自动化终验通过。
- 本次用户明确指示优先于 cf-task-archive 默认要求所有任务 verified 的归档前置条件；未伪造 gate 或人工规范确认记录。实际本地测试见 runtime-config-file-input.live-e2e.md。

## 执行约定

- TASK-001～014 的 unit/integration 在功能编码前记录 RED，完成后记录 GREEN 和断言位置。每个任务只在其工作范围内修改；全局规范从同一 Context 继承，Spec-Refs 表示唯一验收责任。
- E2E 不降级为 mock 测试；编码期编写/登记测试及命令，全部功能测试通过后统一交 cf-task-verify-e2e 执行。缺集群、Docker、配套镜像或隔离测试凭证时明确记录环境依赖，不视为已验证。
- 所有命令是计划命令，新增 Test 名在编码中落实并以最终实际命令回填。Go 命令 cwd 为 console/backend，Node 命令 cwd 为仓库根；含“；”的两条命令分别执行。
- 真实外部 Bot/平台账号人工抽查是可选发布检查，不替代任何自动化验收；本计划无需以 manual 场景替代 E2E。
- 每个任务限定 1–3 个实现/测试文件；若实际需扩展先刷新设计/Context，禁止静默扩大。

## Acceptance Coverage

| 场景ID | 来源设计 | 测试层级 | 关键真实边界与断言 | 负责任务 | 状态 | 命令 | 工作目录 | 超时 |
|---|---|---|---|---|---|
| S-17 | runtime-config-file-input.design.md#2.5.2 acceptance | integration | Real Node startup and transaction files plus Coordinator/Applier: new DTO and credentials converge after retained high generation; same-instance stale startup still protected | TASK-014 | verified | python3 -c 'import subprocess; subprocess.run(["node","--test","bin/test/inject-env.test.mjs"],check=True); subprocess.run(["go","test","./internal/runtimeapply","-run","TestAdoptedGeneration","-count=1"],cwd="console/backend",check=True)' | . | 120 |
| S-16 | runtime-config-file-input.design.md#2.5.2 acceptance | integration | Real Docker command builders and local files; external CLI fake: paired image/input recovery, original volume and token, explicit failure | TASK-011 | verified | go test ./internal/driver -run TestRuntimeFileTask011 -count=1 | console/backend | 120 |
| S-15 | runtime-config-file-input.design.md#2.5.2 acceptance | integration | Real K8s manifest and recovery resource builders with fake API: env/file snapshot, source and image restore, token/PVC preserved | TASK-010 | verified | go test ./internal/driver -run TestRuntimeFileTask010 -count=1 | console/backend | 120 |
| S-14 | runtime-config-file-input.design.md#2.5.2 acceptance | integration | Real Coordinator retry and production applier factory: startup-source failure never completes apply; retry uses current generation | TASK-009 | verified | go test ./internal/runtimeapply -run TestStartupSourceReconcile -count=1 | console/backend | 120 |
| S-13 | runtime-config-file-input.design.md#2.5.2 acceptance | integration | Real Applier orchestration: startup publication follows validation and health; restart publication and failure restore are ordered | TASK-008 | verified | go test ./internal/runtimeapply -run TestRuntimeStartupSource -count=1 | console/backend | 120 |
| S-12 | runtime-config-file-input.design.md#2.5.2 验收场景 | integration | 本地真实文件和目录：0700/0600、owner、原子 rename、无效输入及 I/O 失败保留 last-good | TASK-006 | verified | go test ./internal/driver -run TestRuntimeFileTask006 -count=1 | console/backend | 120 |
| S-11 | runtime-config-file-input.design.md#2.5.2 验收场景 | unit | 强类型启动 payload、真实 Go Schema 和 JSON 编解码：file env 无 DTO，错误显式返回，env/file 恢复材料 round-trip | TASK-004 | verified | go test ./internal/driver -run TestRuntimeFileTask004 -count=1 | console/backend | 120 |
| S-01 | runtime-config-file-input.design.md#2.5.2 验收场景 | unit | Go grants 构建器：三种 EntryType 输出符合字段约束，复制不别名原 slice；Skill 名称/来源/目录/版本/longTask 保持 | TASK-001 | verified | go test ./internal/runtimeconfig -run TestRuntimeSkillScriptFiles -count=1 | console/backend | 120 |
| S-02 | runtime-config-file-input.design.md#2.5.2 验收场景 | E2E | Go DTO 生成 → Node Schema → 真实 renderer：精简前后最终配置和指导文件字节一致；无需集群 | TASK-001 | verified | go test -tags=e2e ./test -run TestRuntimeGrantRenderEquivalence -count=1 | console/backend | 120 |
| E-01 | runtime-config-file-input.design.md#2.5.2 验收场景 | integration | 真实 Node 读取：声明 file 但不存在/无权限/空文件/损坏 JSON/Schema 无效 → stderr 可定位错误、非零退出、原 openclaw.json 不被覆盖；不静默回退 env | TASK-002 | verified | node --test bin/test/runtime-config-schema.test.mjs | . | 60 |
| S-05 | runtime-config-file-input.design.md#2.5.2 验收场景 | integration | 真实 Node 文件/管道：启动 file 优先 env；无 file 时旧 env 优先 stdin；transaction 的 stdin DTO 不受启动 file/env 干扰；已知 file 时不阻塞读取 stdin | TASK-003 | verified | node --test bin/test/inject-env.test.mjs bin/test/runtime-config-transaction.test.mjs | . | 60 |
| B-02 | runtime-config-file-input.design.md#2.5.2 验收场景 | integration | fake client：旧 env key 已不存在、部分迁移失败、Runtime Secret 已存在时可幂等继续；只清理已成功迁移资源，不误删服务令牌或保留状态 | TASK-005 | verified | go test ./internal/driver -run TestRuntimeFileTask005 -count=1 | console/backend | 120 |
| S-07 | runtime-config-file-input.design.md#2.5.2 验收场景 | integration | K8s manifest 与本地真实文件权限：生成权限设置正确；原子替换不留半截 JSON；fake client/command runner 覆盖驱动写入与错误路径 | TASK-007 | verified | go test ./internal/driver -run TestRuntimeFileTask007 -count=1 | console/backend | 120 |
| E-04 | runtime-config-file-input.design.md#2.5.2 验收场景 | integration | fake K8s 写入错误/真实本地磁盘权限错误：失败向上返回，秘密不泄漏；候选写入失败不替换 last-good | TASK-007 | verified | go test ./internal/driver -run TestRuntimeFileTask007 -count=1 | console/backend | 120 |
| E-03 | runtime-config-file-input.design.md#2.5.2 验收场景 | integration | httptest + fake Driver/Store：替换失败、回滚失败、取消/超时明确返回既有失败码并落终态，错误字段脱敏，不伪报 Running | TASK-012 | verified | go test ./internal/api ./test -run TestRuntimeFileUpgrade -count=1 | console/backend | 120 |
| E-06 | runtime-config-file-input.design.md#2.5.2 验收场景 | integration | httptest＋真实 repo＋fake driver：接管未明确授权返回保留状态冲突；创建/状态写入失败不能删除保留卷或工作空间；用户恢复冲突明确报错；新建生成新服务凭证、旧凭证失效 | TASK-013 | verified | go test ./test -run TestRuntimeFileAdoption -count=1 | console/backend | 120 |
| S-03 | runtime-config-file-input.design.md#2.5.2 验收场景 | E2E | 真实 K8s Secret → Deployment → 非 root Worker 启动：文件可读、env 不含完整 DTO，启动 generation 正确 | TASK-015 | e2e_deferred | go test -tags=e2e,integration ./test -run TestRuntimeFileK8sStartup -count=1 -timeout=45m | console/backend | 3600 |
| S-06 | runtime-config-file-input.design.md#2.5.2 验收场景 | E2E | Console 升级 API → 存储 → 真实 K8s → Worker：旧 env Pod 切换新镜像和文件模式，PVC UID、工作空间与会话哨兵保持，凭证不意外轮换，generation/应用状态/健康收敛 | TASK-015 | e2e_deferred | go test -tags=e2e,integration ./test -run TestRuntimeFileK8sUpgrade -count=1 -timeout=45m | console/backend | 3600 |
| S-08 | runtime-config-file-input.design.md#2.5.2 验收场景 | E2E | 新 Console → 真实 K8s/Docker → 配套新 Worker：新建和升级均使用文件；普通流程没有旧镜像/env 分支；新版 loader 的历史 env 读取由 S-05 独立验证 | TASK-015 | e2e_deferred | go test -tags=e2e,integration ./test -run TestRuntimeFileCreateUpgradeContract -count=1 -timeout=45m | console/backend | 3600 |
| S-09 | runtime-config-file-input.design.md#2.5.2 验收场景 | E2E | 真实 runtime guard 与隔离工作区：两个用户同名私有 Skill 不串扰；system 优先；传统脚本可执行、审计归属正确、长任务行为不变、模型绑定保持 | TASK-015 | e2e_deferred | go test -tags=e2e,integration ./test -run TestRuntimeFileSkillIsolation -count=1 -timeout=45m | console/backend | 3600 |
| E-02 | runtime-config-file-input.design.md#2.5.2 验收场景 | E2E | 升级 API → 真实 K8s/Docker/Worker：已迁移 Pod 的新镜像 health 失败后恢复先前文件模式镜像及输入资源；首次旧 Pod 迁移失败恢复升级前镜像与 env 输入；保留状态；回滚 generation 单调前移；健康成功才报告恢复 | TASK-015 | e2e_deferred | go test -tags=e2e,integration ./test -run TestRuntimeFileUpgradeRollback -count=1 -timeout=45m | console/backend | 3600 |
| E-05 | runtime-config-file-input.design.md#2.5.2 验收场景 | E2E | 真实 Worker 与事务管道：Secret 传播延迟/Console 重启/迁移重复执行/配置更新和升级竞争时，启动与 apply generation 不倒退；失败不发布未经健康验证的启动配置 | TASK-015 | e2e_deferred | go test -tags=e2e,integration ./test -run TestRuntimeFileStartupSourceRecovery -count=1 -timeout=45m | console/backend | 3600 |
| B-01 | runtime-config-file-input.design.md#2.5.2 验收场景 | E2E | 真实容器启动：有效合成 DTO 的 UTF-8 bytes >128 KiB、低于平台资源限制；file 模式正常执行入口并健康。固定 10 用户且保留传统脚本，不能只用 managed 冗余路径构造后被精简掉 | TASK-015 | e2e_deferred | go test -tags=e2e,integration ./test -run TestRuntimeFileLargeDTO -count=1 -timeout=45m | console/backend | 3600 |
| S-04 | runtime-config-file-input.design.md#2.5.2 验收场景 | E2E | 真实 Docker 目录 bind → Worker：文件模式启动正常，重启可读，原子更新后读取新文件 | TASK-016 | e2e_deferred | go test -tags=e2e,integration ./test -run TestRuntimeFileDockerStartup_S04 -count=1 -timeout=45m | console/backend | 3600 |
| S-10 | runtime-config-file-input.design.md#2.5.2 验收场景 | E2E | 真实 Console 删除/创建 API → SQLite → K8s/Docker 卷 → 新 Worker：deleteState=false 后卷与用户数据保留；相同 podId、新镜像、adoptState=true、restoreUsers=true 创建，卷 UID/标识、Agent ID、会话/记忆/私有 Skill 哨兵保持；新 DTO 走文件并健康，用户身份/模型绑定恢复 | TASK-016 | e2e_deferred | go test -tags=e2e,integration ./test -run TestRuntimeFileRetainedWorkspace_S10 -count=1 -timeout=45m | console/backend | 3600 |
| B-03 | runtime-config-file-input.design.md#2.5.2 验收场景 | E2E | 保留卷 openclaw.json generation 高于新 Pod 记录初始 generation：同名重建后最终应用新 Pod 的通道/模型/文件 DTO 和新 gateway 凭证，不能永久停留旧配置或 token_mismatch；代次收敛与后续容器重启正常 | TASK-016 | e2e_deferred | go test -tags=e2e,integration ./test -run TestRuntimeFileAdoptedGeneration_B03 -count=1 -timeout=45m | console/backend | 3600 |
| S-18 | runtime-config-file-input.design.md#4.3 回滚与热更新 | integration | 真实 HTTP handler、SQLite 与互斥队列；排队前的旧快照不能覆盖最新设置，普通更新与镜像升级同锁 | TASK-017 | verified | go test ./test -run TestRuntimeFileConcurrency -count=1 | console/backend | 120 |
| S-19 | runtime-config-file-input.design.md#4.3 回滚与热更新 | integration | 真实 Secret/manifest、本地私有文件、HTTP/SQLite；仅外部 K8s/CLI fake；缺失 workload 从可靠恢复材料重建原 env/file，凭证/卷保留，材料缺失或损坏明确失败 | TASK-018 | verified | go test ./internal/driver ./test -run TestRuntimeFileRecovery -count=1 | console/backend | 120 |
| S-20 | runtime-config-file-input.design.md#3.5 规范约束 | integration | 原 driver 全量测试断言保持：仅拆分新增或扩大的函数，挂载/manifest/输入恢复行为不变 | TASK-019 | verified | go test ./internal/driver -count=1 | console/backend | 120 |
| S-21 | runtime-config-file-input.design.md#3.5 规范约束 | integration | 原 Docker 恢复测试断言保留，最后一处 fixture 拆分 | TASK-020 | verified | go test ./internal/driver -run TestRuntimeFileTask011 -count=1 | console/backend | 120 |
| S-22 | runtime-config-file-input.design.md#2.5.2 验收场景 | integration | 真实 HTTP handler/SQLite 的 Human User GET/PATCH：E2E helper 正确读取 humanUser 包装，prompt 修改实际递增配置代次并更新用户 | TASK-021 | verified | go test -tags=e2e,integration ./test -run TestRuntimeFileUserDetailContract -count=1 | console/backend | 120 |

## 规则与风险追溯

| 设计规则/风险 | 覆盖场景 | 最终验收责任 |
|---|---|---|
| RULE-01 | S-01、S-02、S-09 | 按 Acceptance Coverage 的逐场景唯一负责人 |
| RULE-02 | B-01、S-03、S-04 | 按 Acceptance Coverage 的逐场景唯一负责人 |
| RULE-03 | S-05、E-01 | 按 Acceptance Coverage 的逐场景唯一负责人 |
| RULE-04 | S-06、E-02、E-03 | 按 Acceptance Coverage 的逐场景唯一负责人 |
| RULE-05 | S-07、E-04 | 按 Acceptance Coverage 的逐场景唯一负责人 |
| RULE-06 | E-02、E-03、E-05 | 按 Acceptance Coverage 的逐场景唯一负责人 |
| RULE-07 | S-10、E-06、B-03 | 按 Acceptance Coverage 的逐场景唯一负责人 |
| RISK-01 | S-08、E-02 | 按 Acceptance Coverage 的逐场景唯一负责人 |
| RISK-02 | S-03、B-01、B-02 | 按 Acceptance Coverage 的逐场景唯一负责人 |
| RISK-03 | S-04、S-07、E-05 | 按 Acceptance Coverage 的逐场景唯一负责人 |
| RISK-04 | S-06、E-02、E-03、E-05 | 按 Acceptance Coverage 的逐场景唯一负责人 |
| RISK-05 | S-01、S-02、S-09 | 按 Acceptance Coverage 的逐场景唯一负责人 |
| RISK-06 | S-03、S-04、S-06、B-01 | 按 Acceptance Coverage 的逐场景唯一负责人 |
| RISK-07 | S-10、E-06、B-03 | 按 Acceptance Coverage 的逐场景唯一负责人 |

## Spec Responsibility

| required Rule | 唯一责任 TASK | verifier_ref |
|---|---|---|
| backend-code-quality-performance#RULE-backend-quality-001 | TASK-009 | backend-code-quality-performance#RULE-backend-quality-001 |
| backend-code-quality-performance#RULE-backend-write-err-001 | TASK-012 | backend-code-quality-performance#RULE-backend-write-err-001 |
| backend-directory-structure#RULE-backend-directory-001 | TASK-004 | backend-directory-structure#RULE-backend-directory-001 |
| backend-logging#RULE-backend-logging-001 | TASK-012 | backend-logging#RULE-backend-logging-001 |
| backend-logging#RULE-backend-redact-001 | TASK-012 | backend-logging#RULE-backend-redact-001 |
| backend-platform-rules#RULE-backend-platform-001 | TASK-012 | backend-platform-rules#RULE-backend-platform-001 |
| backend-platform-rules#RULE-backend-http-envelope-001 | TASK-012 | backend-platform-rules#RULE-backend-http-envelope-001 |
| backend-platform-rules#RULE-backend-model-pool-001 | TASK-013 | backend-platform-rules#RULE-backend-model-pool-001 |
| runtime-config-and-apply#RULE-runtime-config-001 | TASK-008 | runtime-config-and-apply#RULE-runtime-config-001 |
| runtime-config-and-apply#RULE-runtime-validate-before-write-001 | TASK-002 | runtime-config-and-apply#RULE-runtime-validate-before-write-001 |
| runtime-isolation-and-security#RULE-runtime-security-001 | TASK-015 | runtime-isolation-and-security#RULE-runtime-security-001 |
| runtime-isolation-and-security#RULE-runtime-secret-file-mode-001 | TASK-006 | runtime-isolation-and-security#RULE-runtime-secret-file-mode-001 |

| backend-database#RULE-backend-database-001 | TASK-001 | backend-database#RULE-backend-database-001 |
| backend-database#RULE-backend-no-select-star-001 | TASK-001 | backend-database#RULE-backend-no-select-star-001 |

| runtime-directory-structure#RULE-runtime-directory-001 | TASK-002 | runtime-directory-structure#RULE-runtime-directory-001 |
| runtime-skill-execution#RULE-runtime-skill-001 | TASK-002 | runtime-skill-execution#RULE-runtime-skill-001 |
| runtime-skill-execution#RULE-runtime-skill-layering-001 | TASK-002 | runtime-skill-execution#RULE-runtime-skill-layering-001 |
| runtime-skill-execution#RULE-runtime-log-injection-001 | TASK-002 | runtime-skill-execution#RULE-runtime-log-injection-001 |
| runtime-skill-execution#RULE-runtime-log-prefix-001 | TASK-002 | runtime-skill-execution#RULE-runtime-log-prefix-001 |
| runtime-skill-execution#RULE-runtime-skill-fail-loud-001 | TASK-002 | runtime-skill-execution#RULE-runtime-skill-fail-loud-001 |

---

## TASK-001: 精简 Skill Grant 并验证渲染等价

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: runtime-config-file-input.design.md#2.3 功能方案, runtime-config-file-input.design.md#3.1 方案选型
- **Spec-Refs**: backend-database#RULE-backend-database-001, backend-database#RULE-backend-no-select-star-001
- **Acceptance-Refs**: S-01, S-02, F-TASK-001
- **Files**: internal/runtimeconfig/builder.go；internal/runtimeconfig/builder_test.go；test/runtime_grant_e2e_test.go
- **Estimate**: 15–60 分钟；真实 E2E 执行另计

### Description

先写三种 EntryType、slice 不别名、授权字段不变的 unit 失败测试并记录 RED；实现非脚本空数组。 登记 Go DTO→Node Schema/renderer/指导文件的 E2E 等价测试；执行留给 verify-e2e。

### Checklist
- [x] 先写三种 EntryType、slice 不别名、授权字段不变的 unit 失败测试并记录 RED；实现非脚本空数组。
- [x] 登记 Go DTO→Node Schema/renderer/指导文件的 E2E 等价测试；执行留给 verify-e2e。
- [x] [F-TASK-001][unit] 先增加失败断言并执行 `go test ./internal/runtimeconfig -run TestRuntimeSkillScriptFiles -count=1`，记录 RED；真实边界：Go Skill Grant 构建器；实现后记录 GREEN：managed/prompt 为 []，脚本清单复制不别名且授权字段保持。
- [x] [S-01][unit] 先写失败用例并记录 RED，再实现并记录 GREEN：Go grants 构建器：三种 EntryType 输出符合字段约束，复制不别名原 slice；Skill 名称/来源/目录/版本/longTask 保持；命令 `go test ./internal/runtimeconfig -run TestRuntimeSkillScriptFiles -count=1`。
- [x] [S-02][E2E] 编写并登记独立 E2E 命令，不在编码期执行；统一留给 verify-e2e：Go DTO 生成 → Node Schema → 真实 renderer：精简前后最终配置和指导文件字节一致；无需集群；命令 `go test -tags=e2e ./test -run TestRuntimeGrantRenderEquivalence -count=1`。

- [x] RULE-backend-database-001：本任务只精简 DTO，不修改 SQL、数据库结构或 repo 访问；人工规范验收待负责人确认。
- [x] RULE-backend-no-select-star-001：不新增查询；自动 regex verifier 检查。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| F-TASK-001 | unit | Go Skill Grant 构建器 | managed/prompt 为 []，脚本清单复制不别名且授权字段保持 | internal/runtimeconfig/builder_test.go / TestRuntimeSkillScriptFiles_S01 | go test ./internal/runtimeconfig -run TestRuntimeSkillScriptFiles -count=1 | verified |
| S-01 | unit | Go grants 构建器：三种 EntryType 输出符合字段约束，复制不别名原 slice；Skill 名称/来源/目录/版本/longTask 保持 | Go grants 构建器：三种 EntryType 输出符合字段约束，复制不别名原 slice；Skill 名称/来源/目录/版本/longTask 保持 | internal/runtimeconfig/builder_test.go / TestRuntimeSkillScriptFiles_S01 | go test ./internal/runtimeconfig -run TestRuntimeSkillScriptFiles -count=1 | verified |
| S-02 | E2E | Go DTO 生成 → Node Schema → 真实 renderer：精简前后最终配置和指导文件字节一致；无需集群 | Go DTO 生成 → Node Schema → 真实 renderer：精简前后最终配置和指导文件字节一致；无需集群 | test/runtime_grant_e2e_test.go / TestRuntimeGrantRenderEquivalence_S02 | go test -tags=e2e ./test -run TestRuntimeGrantRenderEquivalence -count=1 | verified |

### Acceptance Evidence

- S-01 / F-TASK-001 RED：`cd console/backend && go test ./internal/runtimeconfig -run TestRuntimeSkillScriptFiles -count=1`，exit=1；managed/traditional-prompt 仍包含 scripts/report.py。断言：TestRuntimeSkillScriptFiles_S01，直接调用真实 grants 构建器。
- S-02：登记 TestRuntimeGrantRenderEquivalence_S02；真实 Go Builder → Node Schema → renderer/guidance，编码阶段不执行。
- S-01: verified — automated command passed; run_id=08871316f9c74864b4d53a596055053a (confirmed_by: runner)
- S-02: e2e_deferred — automated command e2e_deferred; run_id=08871316f9c74864b4d53a596055053a (confirmed_by: runner)

- F-TASK-001 GREEN：同 RED 命令 exit=0；三种 entryType 与元数据/别名/JSON 数组断言全部通过。
- S-02 断言位置：test/runtime_grant_e2e_test.go / TestRuntimeGrantRenderEquivalence_S02；Node schema 校验两份 Go DTO，逐字节比较最终配置和每个 Agent 的指导文件，e2e_deferred。
- S-01: verified — automated command passed; run_id=6bc86fb96c4443cfb37fb9e93dde6f70 (confirmed_by: runner)
- S-02: e2e_deferred — automated command e2e_deferred; run_id=6bc86fb96c4443cfb37fb9e93dde6f70 (confirmed_by: runner)

- 自动校验：`python3 .code-flow/scripts/cf_validation.py --root "$PWD" --json` decision=pass，Go test/vet 通过；E2E 只登记并编译，未执行。
- Done Gate：decision=block，manual_confirmation_missing；当前 diff 的人工 Spec 验收待 project-owner 确认，不代填确认，不标 done。

> BLOCKED: 当前配置精简 diff 的自动验收与 Go test/vet 已通过；Done Gate 和 stop hook 返回 manual_confirmation_missing，等待 project-owner 人工规范确认。不得代填确认或标记 done；确认后 resume 并重新 finish。
- S-01: verified — automated command passed; run_id=36fe4b795cb542cf94e1924c3d173e1c (confirmed_by: runner)
- S-02: e2e_deferred — automated command e2e_deferred; run_id=36fe4b795cb542cf94e1924c3d173e1c (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)
- S-02: e2e_deferred — automated command e2e_deferred; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=1220b4ffc42b4d77915b1910c340b729 (confirmed_by: runner)

### Log

- [2026-09-30] 用户确认拆解写入，创建 draft；尚未激活。

---
- [2026-09-30] started
- [2026-09-30] resumed (in-progress)
- [2026-09-30] blocked (当前配置精简 diff 的自动验收与 Go test/vet 已通过；Done Gate 和 stop hook 返回 manual_confirmation_missing，等待 project-owner 人工规范确认。不得代填确认或标记 done；确认后 resume 并重新 finish。)
- [2026-09-30] completed (done)
## TASK-002: 统一 Worker 文件输入读取与失败处理

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: runtime-config-file-input.design.md#3.4 输入与内部接口契约
- **Spec-Refs**: runtime-config-and-apply#RULE-runtime-validate-before-write-001, runtime-directory-structure#RULE-runtime-directory-001, runtime-skill-execution#RULE-runtime-skill-001, runtime-skill-execution#RULE-runtime-skill-layering-001, runtime-skill-execution#RULE-runtime-log-injection-001, runtime-skill-execution#RULE-runtime-log-prefix-001, runtime-skill-execution#RULE-runtime-skill-fail-loud-001
- **Acceptance-Refs**: E-01, F-TASK-002
- **Files**: bin/runtime-config-schema.mjs；bin/inject-multi-user-config.mjs；bin/test/runtime-config-schema.test.mjs
- **Estimate**: 15–60 分钟；真实 E2E 执行另计

### Description

先写文件缺失/无权限/空内容/无效 JSON/Schema 的 integration 失败测试，记录 RED。 新增绝对路径输入；声明文件失败不回退 env；统一校验，file 已确定不阻塞读取 stdin。

### Checklist
- [x] 先写文件缺失/无权限/空内容/无效 JSON/Schema 的 integration 失败测试，记录 RED。
- [x] 新增绝对路径输入；声明文件失败不回退 env；统一校验，file 已确定不阻塞读取 stdin。
- [x] [F-TASK-002][integration] 先增加失败断言并执行 `node --test bin/test/runtime-config-schema.test.mjs`，记录 RED；真实边界：Node 输入读取、真实本地文件与共享 Schema；实现后记录 GREEN：无效文件不回退 env，校验前不覆盖 openclaw.json。
- [x] [E-01][integration] 先写失败用例并记录 RED，再实现并记录 GREEN：真实 Node 读取：声明 file 但不存在/无权限/空文件/损坏 JSON/Schema 无效 → stderr 可定位错误、非零退出、原 openclaw.json 不被覆盖；不静默回退 env；命令 `node --test bin/test/runtime-config-schema.test.mjs`。
- [x] RULE-runtime-validate-before-write-001 verifier：runtime-config-and-apply#RULE-runtime-validate-before-write-001；输入为本任务及依赖任务 diff、Acceptance Evidence 和已登记场景；真实 Node共享 Schema、文件读取和原子输出，断言 无效输入不覆盖目标；有效输入先校验；generation语义不变；命令 `node --test bin/test/runtime-config-schema.test.mjs bin/test/inject-multi-user-config.test.mjs bin/test/inject-env.test.mjs`。规范的 manual verifier 按 code gate 要求提交明确审核证据，不伪造 owner 确认。

- [x] RULE-runtime-directory-001：共享读取/Schema 位于 bin；保持原 Skill 分层、权限、并发和日志入口；无效文件经现有 CLI stderr＋非零退出，原 DTO/指导文件不写入日志。manual verifier 需负责人确认当前文件输入 diff。
- [x] RULE-runtime-skill-001：共享读取/Schema 位于 bin；保持原 Skill 分层、权限、并发和日志入口；无效文件经现有 CLI stderr＋非零退出，原 DTO/指导文件不写入日志。manual verifier 需负责人确认当前文件输入 diff。
- [x] RULE-runtime-skill-layering-001：共享读取/Schema 位于 bin；保持原 Skill 分层、权限、并发和日志入口；无效文件经现有 CLI stderr＋非零退出，原 DTO/指导文件不写入日志。manual verifier 需负责人确认当前文件输入 diff。
- [x] RULE-runtime-log-injection-001：共享读取/Schema 位于 bin；保持原 Skill 分层、权限、并发和日志入口；无效文件经现有 CLI stderr＋非零退出，原 DTO/指导文件不写入日志。manual verifier 需负责人确认当前文件输入 diff。
- [x] RULE-runtime-log-prefix-001：共享读取/Schema 位于 bin；保持原 Skill 分层、权限、并发和日志入口；无效文件经现有 CLI stderr＋非零退出，原 DTO/指导文件不写入日志。manual verifier 需负责人确认当前文件输入 diff。
- [x] RULE-runtime-skill-fail-loud-001：共享读取/Schema 位于 bin；保持原 Skill 分层、权限、并发和日志入口；无效文件经现有 CLI stderr＋非零退出，原 DTO/指导文件不写入日志。manual verifier 需负责人确认当前文件输入 diff。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| F-TASK-002 | integration | Node 输入读取、真实本地文件与共享 Schema | 无效文件不回退 env，校验前不覆盖 openclaw.json | bin/test/runtime-config-schema.test.mjs / E-01 file input takes priority and rejects relative paths | node --test bin/test/runtime-config-schema.test.mjs | verified |
| E-01 | integration | 真实 Node 读取：声明 file 但不存在/无权限/空文件/损坏 JSON/Schema 无效 → stderr 可定位错误、非零退出、原 openclaw.json 不被覆盖；不静默回退 env | 真实 Node 读取：声明 file 但不存在/无权限/空文件/损坏 JSON/Schema 无效 → stderr 可定位错误、非零退出、原 openclaw.json 不被覆盖；不静默回退 env | bin/test/runtime-config-schema.test.mjs / E-01 invalid files fail CLI without fallback or overwriting existing config | node --test bin/test/runtime-config-schema.test.mjs | verified |
| runtime-config-and-apply#RULE-runtime-validate-before-write-001 | integration | 真实 Node共享 Schema、文件读取和原子输出 | 无效输入不覆盖目标；有效输入先校验；generation语义不变 | 本任务与依赖的测试/代码审查证据 | node --test bin/test/runtime-config-schema.test.mjs bin/test/inject-multi-user-config.test.mjs bin/test/inject-env.test.mjs | verified |

### Acceptance Evidence

- E-01 / F-TASK-002 RED：`node --test bin/test/runtime-config-schema.test.mjs` exit=1，7 个失败；file 未被选择，无效文件的 CLI 静默选择 env 并 exit=0。真实文件/CLI；相对路径、缺失、权限、空文件、JSON/Schema 失败断言见 E-01 测试。
- E-01: verified — automated command passed; run_id=9e4dd28f854c495fad8a64505c038244 (confirmed_by: runner)

- F-TASK-002 GREEN：`node --test bin/test/runtime-config-schema.test.mjs bin/test/inject-multi-user-config.test.mjs bin/test/inject-env.test.mjs` exit=0，39 个测试通过。E-01 测试读取真实临时文件并运行 CLI，断言非零退出、不回退 env、不覆盖哨兵、不输出无效 JSON 中的秘密。
- E-01: verified — automated command passed; run_id=c8f0ea4de15e410ba173c247e211db7b (confirmed_by: runner)

> BLOCKED: 文件输入及 E-01 真实文件/CLI 验收已经实现并通过；新增 runtime-directory-structure/runtime-skill-execution 的六项 manual verifier 返回 manual_confirmation_missing，需负责人确认 TASK-002 当前 diff。TASK-001 的确认不冒充新增规范的确认。
- E-01: verified — automated command passed; run_id=b1b2e6ea2244402e88631d41e93e5f2c (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-09-30] 用户确认拆解写入，创建 draft；尚未激活。

---
- [2026-09-30] started
- [2026-09-30] resumed (in-progress)
- [2026-09-30] blocked (文件输入及 E-01 真实文件/CLI 验收已经实现并通过；新增 runtime-directory-structure/runtime-skill-execution 的六项 manual verifier 返回 manual_confirmation_missing，需负责人确认 TASK-002 当前 diff。TASK-001 的确认不冒充新增规范的确认。)
- [2026-09-30] completed (done)
## TASK-003: 接入启动入口并隔离事务 stdin

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002
- **Source**: runtime-config-file-input.design.md#3.4 输入与内部接口契约, runtime-config-file-input.design.md#4.3 回滚与热更新
- **Spec-Refs**:
- **Acceptance-Refs**: S-05, F-TASK-003
- **Files**: bin/inject-env.mjs；bin/test/inject-env.test.mjs；bin/test/runtime-config-transaction.test.mjs
- **Estimate**: 15–60 分钟；真实 E2E 执行另计

### Description

先写真实文件/管道测试：启动 file→env→stdin 与 transaction 显式 stdin 分离，记录 RED。 旧 env/stdin 读取兼容保留；transaction prepare/commit 永不误读启动配置。

### Checklist
- [x] 先写真实文件/管道测试：启动 file→env→stdin 与 transaction 显式 stdin 分离，记录 RED。
- [x] 旧 env/stdin 读取兼容保留；transaction prepare/commit 永不误读启动配置。
- [x] [F-TASK-003][integration] 先增加失败断言并执行 `node --test bin/test/inject-env.test.mjs bin/test/runtime-config-transaction.test.mjs`，记录 RED；真实边界：Node 入口、文件和 stdin 管道；实现后记录 GREEN：file→env→stdin 启动优先级；transaction 始终使用本次 stdin。
- [x] [S-05][integration] 先写失败用例并记录 RED，再实现并记录 GREEN：真实 Node 文件/管道：启动 file 优先 env；无 file 时旧 env 优先 stdin；transaction 的 stdin DTO 不受启动 file/env 干扰；已知 file 时不阻塞读取 stdin；命令 `node --test bin/test/inject-env.test.mjs bin/test/runtime-config-transaction.test.mjs`。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| F-TASK-003 | integration | Node 入口、文件和 stdin 管道 | file→env→stdin 启动优先级；transaction 始终使用本次 stdin | bin/test/inject-env.test.mjs, bin/test/runtime-config-transaction.test.mjs / S-05 startup preserves file then env then stdin priority | node --test bin/test/inject-env.test.mjs bin/test/runtime-config-transaction.test.mjs | verified |
| S-05 | integration | 真实 Node 文件/管道：启动 file 优先 env；无 file 时旧 env 优先 stdin；transaction 的 stdin DTO 不受启动 file/env 干扰；已知 file 时不阻塞读取 stdin | 真实 Node 文件/管道：启动 file 优先 env；无 file 时旧 env 优先 stdin；transaction 的 stdin DTO 不受启动 file/env 干扰；已知 file 时不阻塞读取 stdin | bin/test/inject-env.test.mjs, bin/test/runtime-config-transaction.test.mjs / S-05 startup selects file without waiting for an open stdin pipe; S-05 transaction prepare and commit consume stdin despite startup file and env | node --test bin/test/inject-env.test.mjs bin/test/runtime-config-transaction.test.mjs | verified |

### Acceptance Evidence

- S-05 / F-TASK-003 RED：`node --test bin/test/inject-env.test.mjs bin/test/runtime-config-transaction.test.mjs` exit=1；声明 file 但 stdin pipe 未结束时启动错误 EAGAIN。真实 Node 子进程及打开的 stdin 管道。事务 stdin 隔离为既有行为补测，无需伪造 RED。
- S-05: verified — automated command passed; run_id=cc6a629c1bba4b2fb90d32021285270b (confirmed_by: runner)

- F-TASK-003 GREEN：同 RED 命令 exit=0，22 项通过；file 启动不消费尚未结束的 stdin，三种输入优先级及 prepare/commit 的 stdin 独立性均由真实 CLI 验证。
- S-05: verified — automated command passed; run_id=14175126b59347949c45ed39fc3332e5 (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-09-30] 用户确认拆解写入，创建 draft；尚未激活。

---
- [2026-09-30] started
- [2026-09-30] completed (done)
## TASK-004: 定义驱动文件传输与恢复契约

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: runtime-config-file-input.design.md#3.2 架构与职责, runtime-config-file-input.design.md#3.4 输入与内部接口契约
- **Spec-Refs**: backend-directory-structure#RULE-backend-directory-001
- **Acceptance-Refs**: S-11, F-TASK-004
- **Files**: internal/driver/driver.go；internal/driver/runtime.go；internal/driver/runtime_test.go
- **Estimate**: 15–60 分钟；真实 E2E 执行另计

### Description

先写启动 payload 序列化失败、file env 不含 DTO、恢复元数据 round-trip 的 functional RED。 明确普通 file 创建、原 env/file workload 恢复和启动源同步接口；强类型并显式处理 Marshal 错误。

### Checklist
- [x] 先写启动 payload 序列化失败、file env 不含 DTO、恢复元数据 round-trip 的 functional RED。
- [x] 明确普通 file 创建、原 env/file workload 恢复和启动源同步接口；强类型并显式处理 Marshal 错误。
- [x] [F-TASK-004][unit] 先增加失败断言并执行 `go test ./internal/driver -run TestRuntimeFileTask004 -count=1`，记录 RED；真实边界：强类型 PodSpec/启动 payload 序列化；实现后记录 GREEN：错误向上返回，file env 无 DTO，恢复材料无歧义。
- [x] RULE-backend-directory-001 verifier：backend-directory-structure#RULE-backend-directory-001；输入为本任务及依赖任务 diff、Acceptance Evidence 和已登记场景；真实包依赖和启动传输 helper，断言 driver/runtimeconfig/runtimeapply/api 分层，handler 无直接 K8s/Docker/SQL 实现；命令 `go vet ./internal/driver ./internal/runtimeconfig ./internal/runtimeapply ./internal/api`。规范的 manual verifier 按 code gate 要求提交明确审核证据，不伪造 owner 确认。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-11 | unit | 强类型启动 payload、真实 Go Schema 和 JSON 编解码 | file env 无 DTO，错误显式返回，env/file 恢复材料 round-trip | internal/driver/runtime_test.go / TestRuntimeFileTask004_S11 | go test ./internal/driver -run TestRuntimeFileTask004 -count=1 | verified |
| F-TASK-004 | unit | 强类型 PodSpec/启动 payload 序列化 | 错误向上返回，file env 无 DTO，恢复材料无歧义 | internal/driver/runtime_test.go / TestRuntimeFileTask004_S11 | go test ./internal/driver -run TestRuntimeFileTask004 -count=1 | verified |
| backend-directory-structure#RULE-backend-directory-001 | unit | 真实包依赖和启动传输 helper | driver/runtimeconfig/runtimeapply/api 分层，handler 无直接 K8s/Docker/SQL 实现 | 本任务与依赖的测试/代码审查证据 | go vet ./internal/driver ./internal/runtimeconfig ./internal/runtimeapply ./internal/api | verified |

### Acceptance Evidence

- S-11 / F-TASK-004 RED：`cd console/backend && go test ./internal/driver -run TestRuntimeFileTask004 -count=1` exit=1，新启动 payload 和恢复契约未定义；测试引用真实 Go Schema 与 JSON codec。

- F-TASK-004 GREEN：同 RED 命令 exit=0；真实 JSON codec round-trip、无 DTO file env、无效通道 JSON/无效 generation 返回 error 全部通过。新增 RuntimeStartupDriver 的 snapshot/sync/restore 独立扩展接口，尚未改变现有驱动创建行为。
- S-11: verified — automated command passed; run_id=bf543d8d9cbc49f4b7e7fc7506717bcc (confirmed_by: runner)
- S-11: verified — automated command passed; run_id=d7ebd0243fd94bbbbf4ed9eda133430d (confirmed_by: runner)
- S-11: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-09-30] 用户确认拆解写入，创建 draft；尚未激活。

---
- [2026-09-30] started
- [2026-09-30] completed (done)
## TASK-005: 接入 K8s Secret、挂载和迁移生命周期

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-004
- **Source**: runtime-config-file-input.design.md#3.3 存储设计, runtime-config-file-input.design.md#4.2 既有环境配置迁移
- **Spec-Refs**:
- **Acceptance-Refs**: B-02, F-TASK-005
- **Files**: internal/driver/k8s.go；internal/driver/k8s_manifest.go；internal/driver/k8s_internal_test.go
- **Estimate**: 15–60 分钟；真实 E2E 执行另计

### Description

先写 fake client 的 Secret/mount/env 切换和部分迁移幂等失败测试，记录 RED。 独立 runtime Secret，0440＋FSGroup=1000、目录只读挂载，不使用 subPath；file workload 不注入完整 DTO。 创建/更新/删除遵守状态保留策略；旧 workload 未切换前保留旧 env，成功后清理冗余 key。

### Checklist
- [x] 先写 fake client 的 Secret/mount/env 切换和部分迁移幂等失败测试，记录 RED。
- [x] 独立 runtime Secret，0440＋FSGroup=1000、目录只读挂载，不使用 subPath；file workload 不注入完整 DTO。
- [x] 创建/更新/删除遵守状态保留策略；旧 workload 未切换前保留旧 env，成功后清理冗余 key。
- [x] [F-TASK-005][integration] 先增加失败断言并执行 `go test ./internal/driver -run TestRuntimeFileTask005 -count=1`，记录 RED；真实边界：真实 manifest builder；K8s 外部 API 可用 fake client；实现后记录 GREEN：挂载/权限设置正确，部分迁移可幂等重试，清理不删状态。
- [x] [B-02][integration] 先写失败用例并记录 RED，再实现并记录 GREEN：fake client：旧 env key 已不存在、部分迁移失败、Runtime Secret 已存在时可幂等继续；只清理已成功迁移资源，不误删服务令牌或保留状态；命令 `go test ./internal/driver -run TestRuntimeFileTask005 -count=1`。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| F-TASK-005 | integration | 真实 manifest builder；K8s 外部 API 可用 fake client | 挂载/权限设置正确，部分迁移可幂等重试，清理不删状态 | internal/driver/k8s_internal_test.go / TestRuntimeFileTask005_B02ResourcesAndIsolation | go test ./internal/driver -run TestRuntimeFileTask005 -count=1 | verified |
| B-02 | integration | fake client：旧 env key 已不存在、部分迁移失败、Runtime Secret 已存在时可幂等继续；只清理已成功迁移资源，不误删服务令牌或保留状态 | fake client：旧 env key 已不存在、部分迁移失败、Runtime Secret 已存在时可幂等继续；只清理已成功迁移资源，不误删服务令牌或保留状态 | internal/driver/k8s_internal_test.go / TestRuntimeFileTask005_B02PartialMigrationRetry | go test ./internal/driver -run TestRuntimeFileTask005 -count=1 | verified |

### Acceptance Evidence

- B-02 / F-TASK-005 RED：`cd console/backend && go test ./internal/driver -run TestRuntimeFileTask005 -count=1` exit=1，SyncStartupConfig 接口尚未实现；fake client 和真实 manifest 构建器。测试覆盖 Secret/mount 权限、A/B 隔离、部分 rollout 失败后旧 env 保留、重试/清理幂等和保留 PVC。

- F-TASK-005 GREEN：同 RED 命令 exit=0；真实 manifest＋fake client 检查 0440 / FSGroup1000 / 目录只读无 subPath、file workload 无 envFrom、Pod A/B Secret 隔离、部分失败旧 key 保留与健康同步后的重复清理、Remove 保留 PVC。`go test ./internal/driver -count=1` 通过。旧 env 启动模式的专用维护/恢复实现归 TASK-010。
- B-02: verified — automated command passed; run_id=c2905982340f4cc1ad80736b34a6700f (confirmed_by: runner)
- B-02: verified — automated command passed; run_id=2015344f78da42478ec7b368a413137a (confirmed_by: runner)
- B-02: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-09-30] 用户确认拆解写入，创建 draft；尚未激活。

---
- [2026-09-30] started
- [2026-09-30] completed (done)
## TASK-006: 实现 Docker 持久配置目录与原子写入

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-004
- **Source**: runtime-config-file-input.design.md#3.3 存储设计, runtime-config-file-input.design.md#3.5 质量实现与合规落点
- **Spec-Refs**: runtime-isolation-and-security#RULE-runtime-secret-file-mode-001
- **Acceptance-Refs**: S-12, F-TASK-006
- **Files**: internal/driver/runtime_file.go（新）；internal/driver/runtime_file_test.go（新）
- **Estimate**: 15–60 分钟；真实 E2E 执行另计

### Description

先写真实本地目录/文件权限、写入错误、原子替换和 last-good 保留测试，记录 RED。 0700 目录、0600 文件，UID/GID 对齐 runtime；临时文件同目录 rename，不写秘密到日志。

### Checklist
- [x] 先写真实本地目录/文件权限、写入错误、原子替换和 last-good 保留测试，记录 RED。
- [x] 0700 目录、0600 文件，UID/GID 对齐 runtime；临时文件同目录 rename，不写秘密到日志。
- [x] [F-TASK-006][integration] 先增加失败断言并执行 `go test ./internal/driver -run TestRuntimeFileTask006 -count=1`，记录 RED；真实边界：真实本地目录、文件模式、原子 rename；实现后记录 GREEN：目录0700/文件0600；失败不替换 last-good、不泄露秘密。
- [x] RULE-runtime-secret-file-mode-001 verifier：runtime-isolation-and-security#RULE-runtime-secret-file-mode-001；输入为本任务及依赖任务 diff、Acceptance Evidence 和已登记场景；真实本地文件权限/原子rename；K8s投影非root由 S-03补足，断言 写配置0600、目录0700；投影0440+FSGroup；service-token原契约保持；命令 `go test ./internal/driver -run 'TestRuntimeFileTask006|TestRuntimeFileTask005' -count=1`。规范的 manual verifier 按 code gate 要求提交明确审核证据，不伪造 owner 确认。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-12 | integration | 本地真实文件和目录 | 0700/0600、owner、原子 rename、失败保留 last-good | internal/driver/runtime_file_test.go / TestRuntimeFileTask006_S12 | go test ./internal/driver -run TestRuntimeFileTask006 -count=1 | verified |
| F-TASK-006 | integration | 真实本地目录、文件模式、原子 rename | 目录0700/文件0600；失败不替换 last-good、不泄露秘密 | internal/driver/runtime_file_test.go / TestRuntimeFileTask006_S12AtomicPermissions; TestRuntimeFileTask006_S12FailuresKeepLastGood | go test ./internal/driver -run TestRuntimeFileTask006 -count=1 | verified |
| runtime-isolation-and-security#RULE-runtime-secret-file-mode-001 | integration | 真实本地文件权限/原子rename；K8s投影非root由 S-03补足 | 写配置0600、目录0700；投影0440+FSGroup；service-token原契约保持 | 本任务与依赖的测试/代码审查证据 | go test ./internal/driver -run 'TestRuntimeFileTask006&#124;TestRuntimeFileTask005' -count=1 | verified |

### Acceptance Evidence

- S-12 / F-TASK-006 RED：`cd console/backend && go test ./internal/driver -run TestRuntimeFileTask006 -count=1` exit=1，writeRuntimeFile 尚未实现。测试使用真实本地文件，覆盖权限、旧 inode/新路径、备份、无效 generation、备份目标为目录造成 I/O 失败及临时文件清理。

- F-TASK-006 GREEN：同 RED 命令 exit=0；补跑 TASK-005/006 联合验收通过。断言实际 stat mode/UID/GID、原 inode 完整和新路径新内容、0600 previous、非法 DTO 拒绝、真实 backup rename I/O 错误不替换 last-good，临时秘密文件被清理。
- S-12: verified — automated command passed; run_id=258b7138b2654fecbef3af5dbf923a43 (confirmed_by: runner)
- S-12: verified — automated command passed; run_id=31bcc366f1a640ccb3278a4b636b3855 (confirmed_by: runner)
- S-12: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-09-30] 用户确认拆解写入，创建 draft；尚未激活。

---
- [2026-09-30] started
- [2026-09-30] completed (done)
## TASK-007: 接入 Docker 启动挂载及驱动异常验收

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-005, TASK-006
- **Source**: runtime-config-file-input.design.md#3.3 存储设计, runtime-config-file-input.design.md#3.4 输入与内部接口契约
- **Spec-Refs**:
- **Acceptance-Refs**: S-07, E-04, F-TASK-007
- **Files**: internal/driver/docker.go；internal/driver/docker_internal_test.go；internal/driver/docker_test.go
- **Estimate**: 15–60 分钟；真实 E2E 执行另计

### Description

先写 fake command runner 的 Create/ReplaceRuntime/UpdateSpec/Remove 失败与保留卷测试，记录 RED。 挂载持久目录而非单文件 inode；普通创建不注入 DTO env，外部命令走既有 context helper。 S-07/E-04 由本任务汇总 K8s TASK-005 与本地文件 TASK-006 的真实权限和错误证据。

### Checklist
- [x] 先写 fake command runner 的 Create/ReplaceRuntime/UpdateSpec/Remove 失败与保留卷测试，记录 RED。
- [x] 挂载持久目录而非单文件 inode；普通创建不注入 DTO env，外部命令走既有 context helper。
- [x] S-07/E-04 由本任务汇总 K8s TASK-005 与本地文件 TASK-006 的真实权限和错误证据。
- [x] [F-TASK-007][integration] 先增加失败断言并执行 `go test ./internal/driver -run TestRuntimeFileTask007 -count=1`，记录 RED；真实边界：真实 Docker 参数构建与本地文件；外部 CLI 可用 fake runner；实现后记录 GREEN：只读挂目录，重启能读原子更新结果，失败保留旧资源。
- [x] [S-07][integration] 先写失败用例并记录 RED，再实现并记录 GREEN：K8s manifest 与本地真实文件权限：生成权限设置正确；原子替换不留半截 JSON；fake client/command runner 覆盖驱动写入与错误路径；命令 `go test ./internal/driver -run TestRuntimeFileTask007 -count=1`。
- [x] [E-04][integration] 先写失败用例并记录 RED，再实现并记录 GREEN：fake K8s 写入错误/真实本地磁盘权限错误：失败向上返回，秘密不泄漏；候选写入失败不替换 last-good；命令 `go test ./internal/driver -run TestRuntimeFileTask007 -count=1`。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| F-TASK-007 | integration | 真实 Docker 参数构建与本地文件；外部 CLI 可用 fake runner | 只读挂目录，重启能读原子更新结果，失败保留旧资源 | internal/driver/docker_internal_test.go, internal/driver/docker_test.go / TestRuntimeFileTask007_S07DockerDirectoryMount | go test ./internal/driver -run TestRuntimeFileTask007 -count=1 | verified |
| S-07 | integration | K8s manifest 与本地真实文件权限：生成权限设置正确；原子替换不留半截 JSON；fake client/command runner 覆盖驱动写入与错误路径 | K8s manifest 与本地真实文件权限：生成权限设置正确；原子替换不留半截 JSON；fake client/command runner 覆盖驱动写入与错误路径 | internal/driver/docker_internal_test.go, internal/driver/docker_test.go / TestRuntimeFileTask007_S07DockerDirectoryMount | go test ./internal/driver -run TestRuntimeFileTask007 -count=1 | verified |
| E-04 | integration | fake K8s 写入错误/真实本地磁盘权限错误：失败向上返回，秘密不泄漏；候选写入失败不替换 last-good | fake K8s 写入错误/真实本地磁盘权限错误：失败向上返回，秘密不泄漏；候选写入失败不替换 last-good | internal/driver/docker_internal_test.go, internal/driver/docker_test.go / TestRuntimeFileTask007_E04FailedDockerReplacementRestoresSource; TestRuntimeFileTask007_E04PermissionFailure; TestRuntimeFileTask007_E04K8sSecretFailure | go test ./internal/driver -run TestRuntimeFileTask007 -count=1 | verified |

### Acceptance Evidence

- S-07 / F-TASK-007 RED: `cd console/backend && go test ./internal/driver -run TestRuntimeFileTask007 -count=1`, exit=1; Docker SyncStartupConfig undefined. Tests capture actual env file and Docker bind args and read actual local files.

- F-TASK-007 GREEN: `go test ./internal/driver -run TestRuntimeFileTask007 -count=1`, exit=0. Docker env/mount/local file checks and failed replacement restore passed; E-04 actual permission error executed as UID501 (not skipped), fake K8s Secret failure preserves original. Regression `go test ./internal/driver -count=1` passed. S-07 also collects Task005 manifest and Task006 filesystem assertions.
- S-07: verified — automated command passed; run_id=a7f26f4ff3fd4f24a7b1af43a50db65e (confirmed_by: runner)
- E-04: verified — automated command passed; run_id=a7f26f4ff3fd4f24a7b1af43a50db65e (confirmed_by: runner)
- S-07: verified — automated command passed; run_id=882374c0c5294a7f8a9f8b3b2e87d38d (confirmed_by: runner)
- E-04: verified — automated command passed; run_id=882374c0c5294a7f8a9f8b3b2e87d38d (confirmed_by: runner)
- S-07: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)
- E-04: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-09-30] 用户确认拆解写入，创建 draft；尚未激活。

---
- [2026-09-30] started
- [2026-09-30] completed (done)
## TASK-008: 补齐 apply 启动源同步与失败恢复时序

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-003, TASK-005, TASK-007
- **Source**: runtime-config-file-input.design.md#4.3 回滚与热更新, runtime-config-file-input.design.md#5. 风险与确认决定
- **Spec-Refs**: runtime-config-and-apply#RULE-runtime-config-001
- **Acceptance-Refs**: S-13, F-TASK-008
- **Files**: internal/runtimeapply/apply.go；internal/runtimeapply/apply_test.go；internal/driver/driver.go
- **Estimate**: 15–60 分钟；真实 E2E 执行另计

### Description

先写 prepare/validate/commit/restart/health 的 source sync 调用顺序和恢复失败测试，记录 RED。 普通 hot apply health 后同步启动源；需 Pod 重启时校验后准备源再重启；保存可恢复 last-good。 stdin 事务保持，sync 失败不能假报应用成功，取消/超时显式恢复。

### Checklist
- [x] 先写 prepare/validate/commit/restart/health 的 source sync 调用顺序和恢复失败测试，记录 RED。
- [x] 普通 hot apply health 后同步启动源；需 Pod 重启时校验后准备源再重启；保存可恢复 last-good。
- [x] stdin 事务保持，sync 失败不能假报应用成功，取消/超时显式恢复。
- [x] [F-TASK-008][integration] 先增加失败断言并执行 `go test ./internal/runtimeapply -run TestRuntimeStartupSource -count=1`，记录 RED；真实边界：真实 Applier 状态编排；外部 Driver 使用 fake；实现后记录 GREEN：validate 前不发候选；同步/重启/health 顺序及失败恢复明确。
- [x] RULE-runtime-config-001 verifier：runtime-config-and-apply#RULE-runtime-config-001；输入为本任务及依赖任务 diff、Acceptance Evidence 和已登记场景；真实 Applier stage与Node transaction输入；Driver外部调用可fake，断言 prepare/validate/commit/restart/health 与恢复顺序；E-05/E-02 验证运行效果；命令 `go test ./internal/runtimeapply -run TestRuntimeStartupSource -count=1`。规范的 manual verifier 按 code gate 要求提交明确审核证据，不伪造 owner 确认。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-13 | integration | Real Applier and fake external Driver | validated source publication; sync/restart/health order; explicit recovery | internal/runtimeapply/apply_test.go / TestRuntimeStartupSource_S13 | go test ./internal/runtimeapply -run TestRuntimeStartupSource -count=1 | verified |
| F-TASK-008 | integration | 真实 Applier 状态编排；外部 Driver 使用 fake | validate 前不发候选；同步/重启/health 顺序及失败恢复明确 | internal/runtimeapply/apply_test.go / TestRuntimeStartupSource_S13PublishOrder; TestRuntimeStartupSource_S13SyncFailureRecovery | go test ./internal/runtimeapply -run TestRuntimeStartupSource -count=1 | verified |
| runtime-config-and-apply#RULE-runtime-config-001 | integration | 真实 Applier stage与Node transaction输入；Driver外部调用可fake | prepare/validate/commit/restart/health 与恢复顺序；E-05/E-02 验证运行效果 | 本任务与依赖的测试/代码审查证据 | go test ./internal/runtimeapply -run TestRuntimeStartupSource -count=1 | verified |

### Acceptance Evidence

- S-13 / F-TASK-008 RED: `cd console/backend && go test ./internal/runtimeapply -run TestRuntimeStartupSource -count=1`, exit=1; startup source option absent. Real Applier with fake external driver, actual Go DTO fixture. Assertions verify validate/snapshot/commit/publication/health/recovery order.
- S-13: verified — automated command passed; run_id=2a5a66e6961d4f4294b1f20e8aa31a8f (confirmed_by: runner)

- F-TASK-008 GREEN: targeted startup-source tests and runtimeapply regression passed. Assertions include none/gateway health-before-publication, Pod source-before-restart, validation abort with no source publication, publication/restore failure propagation and cancellation recovery using independent bounded context.
- S-13: verified — automated command passed; run_id=4586db0194ec4193b4f0bb324bcdbaf4 (confirmed_by: runner)
- S-13: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-09-30] 用户确认拆解写入，创建 draft；尚未激活。

---
- [2026-09-30] started
- [2026-09-30] completed (done)
## TASK-009: 协调器收敛及调用点装配

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-008
- **Source**: runtime-config-file-input.design.md#3.2 架构与职责, runtime-config-file-input.design.md#4.3 回滚与热更新
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-quality-001
- **Acceptance-Refs**: S-14, F-TASK-009
- **Files**: internal/runtimeapply/coordinator.go；internal/runtimeapply/coordinator_test.go；cmd/console/main.go
- **Estimate**: 15–60 分钟；真实 E2E 执行另计

### Description

先写源同步失败/重试/Console 恢复时的 fake executor functional RED。 启动源同步与应用状态完成顺序明确；复用 Pod 级独占锁，幂等重试，不增加无界 IO/循环网络调用。

### Checklist
- [x] 先写源同步失败/重试/Console 恢复时的 fake executor functional RED。
- [x] 启动源同步与应用状态完成顺序明确；复用 Pod 级独占锁，幂等重试，不增加无界 IO/循环网络调用。
- [x] [F-TASK-009][integration] 先增加失败断言并执行 `go test ./internal/runtimeapply -run TestStartupSourceReconcile -count=1`，记录 RED；真实边界：真实 Coordinator/互斥/重试编排；外部执行器可 fake；实现后记录 GREEN：启动源同步失败不记成功；恢复/重试幂等，deadline 传递。
- [x] RULE-backend-quality-001 verifier：backend-code-quality-performance#RULE-backend-quality-001；输入为本任务及依赖任务 diff、Acceptance Evidence 和已登记场景；Coordinator/Applier 错误和 context deadline 真实传递；外部操作可 fake，断言 明确错误、取消/超时、幂等恢复；所有 touched packages 的 go test/go vet；命令 `go test ./internal/runtimeconfig ./internal/driver ./internal/runtimeapply ./internal/api ./test；go vet ./internal/runtimeconfig ./internal/driver ./internal/runtimeapply ./internal/api ./test`。规范的 manual verifier 按 code gate 要求提交明确审核证据，不伪造 owner 确认。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-14 | integration | Real Coordinator and factory; external driver fake | source failure never marks success; recovery retry uses latest generation | internal/runtimeapply/coordinator_test.go / TestStartupSourceReconcile_S14 | go test ./internal/runtimeapply -run TestStartupSourceReconcile -count=1 | verified |
| F-TASK-009 | integration | 真实 Coordinator/互斥/重试编排；外部执行器可 fake | 启动源同步失败不记成功；恢复/重试幂等，deadline 传递 | internal/runtimeapply/coordinator_test.go / TestStartupSourceReconcile_S14FactoryRequiresAndUsesSource; TestStartupSourceReconcile_S14FailureThenLatestGeneration | go test ./internal/runtimeapply -run TestStartupSourceReconcile -count=1 | verified |
| backend-code-quality-performance#RULE-backend-quality-001 | integration | Coordinator/Applier 错误和 context deadline 真实传递；外部操作可 fake | 明确错误、取消/超时、幂等恢复；所有 touched packages 的 go test/go vet | 本任务与依赖的测试/代码审查证据 | go test ./internal/runtimeconfig ./internal/driver ./internal/runtimeapply ./internal/api ./test；go vet ./internal/runtimeconfig ./internal/driver ./internal/runtimeapply ./internal/api ./test | verified |

### Acceptance Evidence

- S-14 / F-TASK-009 RED: `cd console/backend && go test ./internal/runtimeapply -run TestStartupSourceReconcile -count=1`, exit=1; production startup-source-aware factory undefined. Coordinator retry is existing behavior supplemented with source failure assertions (no fake RED).
- S-14: verified — automated command passed; run_id=f3830032e0014efb88432ea189e1949b (confirmed_by: runner)

- Additional RED: cancelled RunExclusive test failed because select could acquire a free lock after cancellation. Added context checks before and after acquisition; targeted tests GREEN.
- F-TASK-009 GREEN: source-aware factory + source failure/retry/current generation assertions pass; affected package go test and go vet pass. Factory requires startup storage explicitly; real driver implementations follow in TASK-010/011.
- S-14: verified — automated command passed; run_id=3af57d68abe64880817f0c9f5708e22a (confirmed_by: runner)
- S-14: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-09-30] 用户确认拆解写入，创建 draft；尚未激活。

---
- [2026-09-30] started
- [2026-09-30] completed (done)
## TASK-010: 实现 K8s 原镜像与输入方式恢复

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-005
- **Source**: runtime-config-file-input.design.md#4.2 既有环境配置迁移, runtime-config-file-input.design.md#4.3 回滚与热更新
- **Spec-Refs**:
- **Acceptance-Refs**: S-15, F-TASK-010
- **Files**: internal/driver/k8s_restore.go（新）；internal/driver/k8s_restore_test.go（新）；internal/driver/k8s.go
- **Estimate**: 15–60 分钟；真实 E2E 执行另计

### Description

先写原 env/file 资源快照、恢复、token 保留与失败测试，记录 RED。 恢复原镜像时同步恢复配套输入；大 env 不可承载时明确失败；普通 Create 保持新镜像/file。

### Checklist
- [x] 先写原 env/file 资源快照、恢复、token 保留与失败测试，记录 RED。
- [x] 恢复原镜像时同步恢复配套输入；大 env 不可承载时明确失败；普通 Create 保持新镜像/file。
- [x] [F-TASK-010][integration] 先增加失败断言并执行 `go test ./internal/driver -run TestRuntimeFileTask010 -count=1`，记录 RED；真实边界：真实 K8s 恢复元数据和资源构建；外部 API 可 fake；实现后记录 GREEN：镜像与 env/file 输入成对恢复、保留 token/状态。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-15 | integration | Real K8s recovery builders, external API fake | image and env/file input restore together; token and state retained | internal/driver/k8s_restore_test.go / TestRuntimeFileTask010_S15 | go test ./internal/driver -run TestRuntimeFileTask010 -count=1 | verified |
| F-TASK-010 | integration | 真实 K8s 恢复元数据和资源构建；外部 API 可 fake | 镜像与 env/file 输入成对恢复、保留 token/状态 | internal/driver/k8s_restore_test.go / TestRuntimeFileTask010_S15 | go test ./internal/driver -run TestRuntimeFileTask010 -count=1 | verified |

### Acceptance Evidence

| Scenario | RED | GREEN | Assertions / boundary | Status |
|---|---|---|---|---|
| S-15 / F-TASK-010 | `go test ./internal/driver -run TestRuntimeFileTask010 -count=1` exit 1: SnapshotStartupConfig, RestoreRuntime and SyncRuntimeConfig undefined | PASS: same command exit 0; driver and runtimeapply regression passed | k8s_restore_test.go: real driver resource builders; fake external Kubernetes API; original input/image/token/state and oversized recovery assertions | verified |
- S-15: verified — automated command passed; run_id=4b54b6a195da42d8b4e7dfd246237630 (confirmed_by: runner)
- S-15: verified — automated command passed; run_id=27bb773d4d4d4582a6e40a583cff1ce4 (confirmed_by: runner)
- S-15: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-09-30] 用户确认拆解写入，创建 draft；尚未激活。

---
- [2026-09-30] started
- [2026-09-30] completed (done)
## TASK-011: 实现 Docker 原镜像与输入方式恢复

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-007
- **Source**: runtime-config-file-input.design.md#4.3 回滚与热更新
- **Spec-Refs**:
- **Acceptance-Refs**: S-16, F-TASK-011
- **Files**: internal/driver/docker_restore.go（新）；internal/driver/docker_restore_test.go（新）；internal/driver/docker.go
- **Estimate**: 15–60 分钟；真实 E2E 执行另计

### Description

先写 command runner 恢复 env/file、保留原卷、恢复失败与临时资源清理测试，记录 RED。 恢复材料持续到 health 完成；失败状态显式报告；不把通用旧镜像恢复变成日常旧镜像创建选项。

### Checklist
- [x] 先写 command runner 恢复 env/file、保留原卷、恢复失败与临时资源清理测试，记录 RED。
- [x] 恢复材料持续到 health 完成；失败状态显式报告；不把通用旧镜像恢复变成日常旧镜像创建选项。
- [x] [F-TASK-011][integration] 先增加失败断言并执行 `go test ./internal/driver -run TestRuntimeFileTask011 -count=1`，记录 RED；真实边界：真实 Docker 恢复参数及文件；外部 CLI 可 fake；实现后记录 GREEN：原镜像及配套输入恢复，失败明确，旧卷不删。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-16 | integration | Real Docker command builders and local files; external CLI fake | paired image/input recovery, original volume/token, explicit failure | internal/driver/docker_restore_test.go / TestRuntimeFileTask011_S16 | go test ./internal/driver -run TestRuntimeFileTask011 -count=1 | verified |
| F-TASK-011 | integration | 真实 Docker 恢复参数及文件；外部 CLI 可 fake | 原镜像及配套输入恢复，失败明确，旧卷不删 | internal/driver/docker_restore_test.go / TestRuntimeFileTask011_S16 | go test ./internal/driver -run TestRuntimeFileTask011 -count=1 | verified |

### Acceptance Evidence

- S-16 / F-TASK-011 RED: `cd console/backend && go test ./internal/driver -run TestRuntimeFileTask011 -count=1`, exit 1: Docker recovery and startup-source methods are missing. Assertions: docker_restore_test.go real files, env-file and image/mount/retained volume; external CLI fake.
- S-16: verified — automated command passed; run_id=384ce35a20244727aaffce7e5c8bf1e5 (confirmed_by: runner)

- GREEN: same functional command exit 0; full driver/runtimeapply tests and go vet passed. Recovery uses explicit original env/file mode, current rollback generation, preserved gateway environment and named volume; rename failure cleans temporary container. Legacy Docker source maintenance leaves immutable container env unchanged as approved design section 4.3.
- S-16: verified — automated command passed; run_id=7eb102087f194577b7e351f0e0ca68e4 (confirmed_by: runner)
- S-16: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-09-30] 用户确认拆解写入，创建 draft；尚未激活。

---
- [2026-09-30] started
- [2026-09-30] completed (done)
## TASK-012: 升级 API 接入通用回滚与稳定错误输出

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-009, TASK-010, TASK-011
- **Source**: runtime-config-file-input.design.md#4.1 发布路径, runtime-config-file-input.design.md#4.3 回滚与热更新, runtime-config-file-input.design.md#3.5 质量实现与合规落点
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-write-err-001, backend-logging#RULE-backend-logging-001, backend-logging#RULE-backend-redact-001, backend-platform-rules#RULE-backend-platform-001, backend-platform-rules#RULE-backend-http-envelope-001
- **Acceptance-Refs**: E-03, F-TASK-012
- **Files**: internal/api/pod_upgrade.go；internal/api/pod_upgrade_test.go；test/pod_upgrade_api_test.go（新，若已有对应套件则复用）
- **Estimate**: 15–60 分钟；真实 E2E 执行另计

### Description

先写 httptest＋fake Driver/Store 的替换失败、health 失败、回滚失败、超时测试，记录 RED。 保留既有升级请求/响应和 errcode，回滚原镜像＋原输入，generation 单调前移，健康通过才报告恢复。 错误入 apply/audit/log 前脱敏；结构化诊断不含 DTO/密钥，操作审计不混 Skill telemetry。

### Checklist
- [x] 先写 httptest＋fake Driver/Store 的替换失败、health 失败、回滚失败、超时测试，记录 RED。
- [x] 保留既有升级请求/响应和 errcode，回滚原镜像＋原输入，generation 单调前移，健康通过才报告恢复。
- [x] 错误入 apply/audit/log 前脱敏；结构化诊断不含 DTO/密钥，操作审计不混 Skill telemetry。
- [x] [F-TASK-012][integration] 先增加失败断言并执行 `go test ./internal/api ./test -run 'TestRuntimeFileUpgrade|TestPodUpgrade' -count=1`，记录 RED；真实边界：httptest、真实 handler；Driver/Store 按 E-03 可 fake；实现后记录 GREEN：稳定错误码、健康失败不报恢复、错误脱敏。
- [x] [E-03][integration] 先写失败用例并记录 RED，再实现并记录 GREEN：httptest + fake Driver/Store：替换失败、回滚失败、取消/超时明确返回既有失败码并落终态，错误字段脱敏，不伪报 Running；命令 `go test ./internal/api ./test -run 'TestRuntimeFileUpgrade|TestPodUpgrade' -count=1`。
- [x] RULE-backend-write-err-001 verifier：backend-code-quality-performance#RULE-backend-write-err-001；输入为本任务及依赖任务 diff、Acceptance Evidence 和已登记场景；httptest handler 的真实错误输出，断言 仅使用 errcode 常量，经 writeErr/writeRuntimeFailure/writeRepoError；命令 `go test ./internal/api ./test -run 'TestRuntimeFileUpgrade|TestErrorCatalog' -count=1`。规范的 manual verifier 按 code gate 要求提交明确审核证据，不伪造 owner 确认。
- [x] RULE-backend-logging-001 verifier：backend-logging#RULE-backend-logging-001；输入为本任务及依赖任务 diff、Acceptance Evidence 和已登记场景；真实 handler/audit 诊断生成；按 E-03 允许 fake Driver/Store，断言 有 pod/generation/stage，秘密不输出，操作审计与 Skill telemetry 分离；命令 `go test ./internal/api ./test -run 'TestRuntimeFileUpgrade|TestPodUpgradeRedaction' -count=1`。规范的 manual verifier 按 code gate 要求提交明确审核证据，不伪造 owner 确认。
- [x] RULE-backend-redact-001 verifier：backend-logging#RULE-backend-redact-001；输入为本任务及依赖任务 diff、Acceptance Evidence 和已登记场景；真实错误链及 RedactDiagnostic，断言 注入 token/API key 的失败诊断进入日志/审计/apply 前脱敏；命令 `go test ./internal/api ./test -run 'TestRuntimeFileUpgrade|TestPodUpgradeRedaction' -count=1`。规范的 manual verifier 按 code gate 要求提交明确审核证据，不伪造 owner 确认。
- [x] RULE-backend-platform-001 verifier：backend-platform-rules#RULE-backend-platform-001；输入为本任务及依赖任务 diff、Acceptance Evidence 和已登记场景；真实升级 handler/generation编排；真实外部服务由 E-02/S-09 验证，断言 保持隔离和模型绑定；health/rollback 才完成；秘密运行时注入；命令 `go test ./internal/api ./test -run 'TestRuntimeFileUpgrade|TestPodUpgrade' -count=1`。规范的 manual verifier 按 code gate 要求提交明确审核证据，不伪造 owner 确认。
- [x] RULE-backend-http-envelope-001 verifier：backend-platform-rules#RULE-backend-http-envelope-001；输入为本任务及依赖任务 diff、Acceptance Evidence 和已登记场景；httptest 响应 envelope，断言 writeJSON/writeErr 及现有稳定 code/message，不能裸 json.NewEncoder；命令 `go test ./internal/api ./test -run 'TestRuntimeFileUpgrade|TestErrorCatalog' -count=1`。规范的 manual verifier 按 code gate 要求提交明确审核证据，不伪造 owner 确认。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| F-TASK-012 | integration | httptest、真实 handler；Driver/Store 按 E-03 可 fake | 稳定错误码、健康失败不报恢复、错误脱敏 | internal/api/pod_upgrade_test.go, test/pod_upgrade_api_test.go / TestRuntimeFileUpgrade_E03 | go test ./internal/api ./test -run 'TestRuntimeFileUpgrade&#124;TestPodUpgrade' -count=1 | verified |
| E-03 | integration | httptest + fake Driver/Store：替换失败、回滚失败、取消/超时明确返回既有失败码并落终态，错误字段脱敏，不伪报 Running | httptest + fake Driver/Store：替换失败、回滚失败、取消/超时明确返回既有失败码并落终态，错误字段脱敏，不伪报 Running | internal/api/pod_upgrade_test.go, test/pod_upgrade_api_test.go / TestRuntimeFileUpgrade_E03 | go test ./internal/api ./test -run 'TestRuntimeFileUpgrade&#124;TestPodUpgrade' -count=1 | verified |
| backend-code-quality-performance#RULE-backend-write-err-001 | integration | httptest handler 的真实错误输出 | 仅使用 errcode 常量，经 writeErr/writeRuntimeFailure/writeRepoError | 本任务与依赖的测试/代码审查证据 | go test ./internal/api ./test -run 'TestRuntimeFileUpgrade&#124;TestErrorCatalog' -count=1 | verified |
| backend-logging#RULE-backend-logging-001 | integration | 真实 handler/audit 诊断生成；按 E-03 允许 fake Driver/Store | 有 pod/generation/stage，秘密不输出，操作审计与 Skill telemetry 分离 | 本任务与依赖的测试/代码审查证据 | go test ./internal/api ./test -run 'TestRuntimeFileUpgrade&#124;TestPodUpgradeRedaction' -count=1 | verified |
| backend-logging#RULE-backend-redact-001 | integration | 真实错误链及 RedactDiagnostic | 注入 token/API key 的失败诊断进入日志/审计/apply 前脱敏 | 本任务与依赖的测试/代码审查证据 | go test ./internal/api ./test -run 'TestRuntimeFileUpgrade&#124;TestPodUpgradeRedaction' -count=1 | verified |
| backend-platform-rules#RULE-backend-platform-001 | integration | 真实升级 handler/generation编排；真实外部服务由 E-02/S-09 验证 | 保持隔离和模型绑定；health/rollback 才完成；秘密运行时注入 | 本任务与依赖的测试/代码审查证据 | go test ./internal/api ./test -run 'TestRuntimeFileUpgrade&#124;TestPodUpgrade' -count=1 | verified |
| backend-platform-rules#RULE-backend-http-envelope-001 | integration | httptest 响应 envelope | writeJSON/writeErr 及现有稳定 code/message，不能裸 json.NewEncoder | 本任务与依赖的测试/代码审查证据 | go test ./internal/api ./test -run 'TestRuntimeFileUpgrade&#124;TestErrorCatalog' -count=1 | verified |

### Acceptance Evidence

- E-03 / F-TASK-012 RED: `cd console/backend && go test ./internal/api ./test -run 'TestRuntimeFileUpgrade|TestPodUpgrade' -count=1`, exit 1. New httptest cases fail because original env/file recovery is never invoked, source publication failure is ignored, and restore failure is falsely reported as rolled back. Real handler and SQLite Store, fake external Driver; assertions in test/pod_upgrade_api_test.go.
- E-03: verified — automated command passed; run_id=fd37e51bfd034389916d7e91281ba19f (confirmed_by: runner)
- E-03: verified — automated command passed; run_id=de648a5646cf49f49b5b71d76437b9a8 (confirmed_by: runner)

- GREEN: functional runner command `go test ./internal/api ./test -run TestRuntimeFileUpgrade -count=1` passed with collected E-03 tests; broader upgrade/PATCH tests passed. An initial encoded-pipe runner filter selected zero tests and was discarded; replaced with executable single prefix and rerun. Original input snapshot is taken before mutation; recovery has independent bounded context, generation advances, health required; apply terminal writes propagate errors and redact diagnostics.
- E-03: verified — automated command passed; run_id=ca43efba5ccc4ef4abd03e254c0faa88 (confirmed_by: runner)
- E-03: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-09-30] 用户确认拆解写入，创建 draft；尚未激活。

---
- [2026-09-30] started
- [2026-09-30] completed (done)
## TASK-013: 保护手动删除重建的接管失败清理

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-005, TASK-007
- **Source**: runtime-config-file-input.design.md#4.4 手动删除与同名重建升级
- **Spec-Refs**: backend-platform-rules#RULE-backend-model-pool-001
- **Acceptance-Refs**: E-06, F-TASK-013
- **Files**: internal/api/pods.go；test/pods_api_test.go；test/pod_keep_users_test.go
- **Estimate**: 15–60 分钟；真实 E2E 执行另计

### Description

先写真实 repo＋httptest 的恢复用户冲突、未授权接管、创建失败/状态写入失败测试，记录 RED。 deleteState=false、adoptState=true、restoreUsers=true 沿用；接管失败 Remove 清理必须保留旧卷与用户资产。 Agent/身份/私有 Skill/模型绑定保持，新 Pod 凭证重新生成，不复用旧 service token。

### Checklist
- [x] 先写真实 repo＋httptest 的恢复用户冲突、未授权接管、创建失败/状态写入失败测试，记录 RED。
- [x] deleteState=false、adoptState=true、restoreUsers=true 沿用；接管失败 Remove 清理必须保留旧卷与用户资产。
- [x] Agent/身份/私有 Skill/模型绑定保持，新 Pod 凭证重新生成，不复用旧 service token。
- [x] [F-TASK-013][integration] 先增加失败断言并执行 `go test ./test -run 'TestRuntimeFileAdoption|TestDeletePodKeepsUsers|TestRestorePodUsers' -count=1`，记录 RED；真实边界：httptest、真实 SQLite repo/用户关联；外部 Driver 可 fake；实现后记录 GREEN：未授权接管/用户冲突明确；失败不删卷；模型绑定保留、新凭证。
- [x] [E-06][integration] 先写失败用例并记录 RED，再实现并记录 GREEN：httptest＋真实 repo＋fake driver：接管未明确授权返回保留状态冲突；创建/状态写入失败不能删除保留卷或工作空间；用户恢复冲突明确报错；新建生成新服务凭证、旧凭证失效；命令 `go test ./test -run 'TestRuntimeFileAdoption|TestDeletePodKeepsUsers|TestRestorePodUsers' -count=1`。
- [x] RULE-backend-model-pool-001 verifier：backend-platform-rules#RULE-backend-model-pool-001；输入为本任务及依赖任务 diff、Acceptance Evidence 和已登记场景；真实 SQLite repo 与 httptest 用户恢复，断言 保留 model_config_id；占用冲突与必选绑定保持，不隐式共享或回退；命令 `go test ./test -run 'TestRuntimeFileAdoption|TestHumanUser|TestModelBinding' -count=1`。规范的 manual verifier 按 code gate 要求提交明确审核证据，不伪造 owner 确认。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| F-TASK-013 | integration | httptest、真实 SQLite repo/用户关联；外部 Driver 可 fake | 未授权接管/用户冲突明确；失败不删卷；模型绑定保留、新凭证 | test/pods_api_test.go, test/pod_keep_users_test.go / TestRuntimeFileAdoption_E06 | go test ./test -run 'TestRuntimeFileAdoption&#124;TestDeletePodKeepsUsers&#124;TestRestorePodUsers' -count=1 | verified |
| E-06 | integration | httptest＋真实 repo＋fake driver：接管未明确授权返回保留状态冲突；创建/状态写入失败不能删除保留卷或工作空间；用户恢复冲突明确报错；新建生成新服务凭证、旧凭证失效 | httptest＋真实 repo＋fake driver：接管未明确授权返回保留状态冲突；创建/状态写入失败不能删除保留卷或工作空间；用户恢复冲突明确报错；新建生成新服务凭证、旧凭证失效 | test/pods_api_test.go, test/pod_keep_users_test.go / TestRuntimeFileAdoption_E06 | go test ./test -run 'TestRuntimeFileAdoption&#124;TestDeletePodKeepsUsers&#124;TestRestorePodUsers' -count=1 | verified |
| backend-platform-rules#RULE-backend-model-pool-001 | integration | 真实 SQLite repo 与 httptest 用户恢复 | 保留 model_config_id；占用冲突与必选绑定保持，不隐式共享或回退 | 本任务与依赖的测试/代码审查证据 | go test ./test -run 'TestRuntimeFileAdoption&#124;TestHumanUser&#124;TestModelBinding' -count=1 | verified |

### Acceptance Evidence

- E-06 / F-TASK-013 RED: `cd console/backend && go test ./test -run 'TestRuntimeFileAdoption|TestDeletePodKeepsUsers|TestRestorePodUsers' -count=1`, exit 1: real SQLite trigger rejects Running state; failed adoption calls Remove with keepState=false. Real HTTP, repo and restored user/model associations; fake external driver. Assertions test/pods_api_test.go TestRuntimeFileAdoption_E06StateWriteFailureKeepsVolume and FreshCredentialsAndUsers.
- E-06: verified — automated command passed; run_id=a82744ae0ad94b48be9264a61623c7cf (confirmed_by: runner)

- GREEN: E-06 runner passed; adoption/delete/restore/AttachUsers and retained-state regression passed. Real SQLite trigger proves state-write failure retains volume and retry succeeds; fresh service fingerprint and old credential invalidation verified; model/agent associations preserved.
- E-06: verified — automated command passed; run_id=c7c2d7f2f8f84820a8c99b9d3eb72f5f (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-09-30] 用户确认拆解写入，创建 draft；尚未激活。

---
- [2026-09-30] started
- [2026-09-30] completed (done)
## TASK-014: 旧 workspace 接管的代次与凭证收敛

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-003, TASK-009, TASK-013
- **Source**: runtime-config-file-input.design.md#4.4 手动删除与同名重建升级
- **Spec-Refs**:
- **Acceptance-Refs**: S-17, F-TASK-014
- **Files**: bin/inject-env.mjs；bin/test/inject-env.test.mjs；internal/runtimeapply/coordinator_test.go
- **Estimate**: 15–60 分钟；真实 E2E 执行另计

### Description

先写旧磁盘 generation 高于新 Pod 及旧 gateway token 的 functional RED；避免与同实例 stale-runtime 保护混淆。 沿用当前启动契约修复与协调器 apply，在接管后最终使用新 DTO/新凭证；同实例仍禁止代次倒退。

### Checklist
- [x] 先写旧磁盘 generation 高于新 Pod 及旧 gateway token 的 functional RED；避免与同实例 stale-runtime 保护混淆。
- [x] 沿用当前启动契约修复与协调器 apply，在接管后最终使用新 DTO/新凭证；同实例仍禁止代次倒退。
- [x] [F-TASK-014][integration] 先增加失败断言并执行 `node --test bin/test/inject-env.test.mjs；go test ./internal/runtimeapply -run TestAdoptedGeneration -count=1`，记录 RED；真实边界：真实 Node 启动与配置文件；真实 Coordinator 编排；实现后记录 GREEN：同名重建最终新配置/新凭证收敛；同实例 stale 保护仍有效。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-17 | integration | Real Node startup/transaction and Coordinator/Applier; external exec fake | retained high generation converges to new DTO/token; stale startup preserved | bin/test/inject-env.test.mjs / S-17; internal/runtimeapply/coordinator_test.go / TestAdoptedGeneration_S17 | python3 -c 'import subprocess; subprocess.run(["node","--test","bin/test/inject-env.test.mjs"],check=True); subprocess.run(["go","test","./internal/runtimeapply","-run","TestAdoptedGeneration","-count=1"],cwd="console/backend",check=True)' | verified |
| F-TASK-014 | integration | 真实 Node 启动与配置文件；真实 Coordinator 编排 | 同名重建最终新配置/新凭证收敛；同实例 stale 保护仍有效 | bin/test/inject-env.test.mjs, internal/runtimeapply/coordinator_test.go / planned | node --test bin/test/inject-env.test.mjs；go test ./internal/runtimeapply -run TestAdoptedGeneration -count=1 | verified |

### Acceptance Evidence

- S-17 / F-TASK-014: supplemental regression of existing behavior; no fabricated RED. Inspection showed startup preserves high disk generation and refreshes credentials, while explicit stdin transaction intentionally applies the current Console generation; TASK-008 source publication before Pod restart closes startup-source convergence. No production change needed.
- GREEN: `node --test bin/test/inject-env.test.mjs` exit 0, 10 collected tests; S-17 real Node startup/prepare/commit/file restart reduces retained generation 42 to new instance 1, uses new channel/token, then still rejects stale startup 1 after same instance 2.
- GREEN: `cd console/backend && go test ./internal/runtimeapply -run TestAdoptedGeneration -count=1` exit 0; real Coordinator + Applier with validated Go DTO and fake external exec/health; source is published before restart and DB applied generation converges from new record 7 despite old worker 42.
- S-17: verified — automated command passed; run_id=074bb301f6654e54a66609f5635417ef (confirmed_by: runner)
- S-17: verified — automated command passed; run_id=5cf5559b8a044e1ea00d8e8a51e64ed5 (confirmed_by: runner)
- S-17: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-09-30] 用户确认拆解写入，创建 draft；尚未激活。

---
- [2026-09-30] started
- [2026-09-30] completed (done)
## TASK-015: 登记真实 K8s 启动、升级和回滚 E2E

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001, TASK-012, TASK-014
- **Source**: runtime-config-file-input.design.md#2.5.2 验收场景, runtime-config-file-input.design.md#4.1 发布路径, runtime-config-file-input.design.md#4.3 回滚与热更新
- **Spec-Refs**: runtime-isolation-and-security#RULE-runtime-security-001
- **Acceptance-Refs**: S-03, S-06, S-08, S-09, E-02, E-05, B-01
- **Files**: test/runtime_file_e2e.md（环境说明）；test/runtime_file_e2e_support_test.go（新）；test/runtime_file_k8s_e2e_test.go（新）；test/runtime_file_skill_e2e_test.go（新）
- **Estimate**: 15–60 分钟；真实 E2E 执行另计

### Description

建立 opt-in E2E harness：真实 Console/API、SQLite、K8s、非 root Worker、guard/renderer，不以 fake 替代。 登记有效 >128 KiB DTO、旧 env→file、新 file→file、故障回滚、传播延迟/并发/Console 恢复测试命令。 验证用户 Skill 隔离、system 优先、脚本/审计/longTask、模型绑定；S-08/E-02/E-05/B-01 汇总 Docker TASK-016 证据。 只编写并登记 E2E，不在编码期执行；功能测试全过后交 verify-e2e。

### Checklist
- [x] 建立 opt-in E2E harness：真实 Console/API、SQLite、K8s、非 root Worker、guard/renderer，不以 fake 替代。
- [x] 登记有效 >128 KiB DTO、旧 env→file、新 file→file、故障回滚、传播延迟/并发/Console 恢复测试命令。
- [x] 验证用户 Skill 隔离、system 优先、脚本/审计/longTask、模型绑定；S-08/E-02/E-05/B-01 汇总 Docker TASK-016 证据。
- [x] 只编写并登记 E2E，不在编码期执行；功能测试全过后交 verify-e2e。
- [x] [S-03][E2E] 编写并登记独立 E2E 命令，不在编码期执行；统一留给 verify-e2e：真实 K8s Secret → Deployment → 非 root Worker 启动：文件可读、env 不含完整 DTO，启动 generation 正确；命令 `go test -tags=e2e,integration ./test -run TestRuntimeFileK8sStartup -count=1`。
- [x] [S-06][E2E] 编写并登记独立 E2E 命令，不在编码期执行；统一留给 verify-e2e：Console 升级 API → 存储 → 真实 K8s → Worker：旧 env Pod 切换新镜像和文件模式，PVC UID、工作空间与会话哨兵保持，凭证不意外轮换，generation/应用状态/健康收敛；命令 `go test -tags=e2e,integration ./test -run TestRuntimeFileK8sUpgrade -count=1`。
- [x] [S-08][E2E] 编写并登记独立 E2E 命令，不在编码期执行；统一留给 verify-e2e：新 Console → 真实 K8s/Docker → 配套新 Worker：新建和升级均使用文件；普通流程没有旧镜像/env 分支；新版 loader 的历史 env 读取由 S-05 独立验证；命令 `go test -tags=e2e,integration ./test -run TestRuntimeFileCreateUpgradeContract -count=1`。
- [x] [S-09][E2E] 编写并登记独立 E2E 命令，不在编码期执行；统一留给 verify-e2e：真实 runtime guard 与隔离工作区：两个用户同名私有 Skill 不串扰；system 优先；传统脚本可执行、审计归属正确、长任务行为不变、模型绑定保持；命令 `go test -tags=e2e,integration ./test -run TestRuntimeFileSkillIsolation -count=1`。
- [x] [E-02][E2E] 编写并登记独立 E2E 命令，不在编码期执行；统一留给 verify-e2e：升级 API → 真实 K8s/Docker/Worker：已迁移 Pod 的新镜像 health 失败后恢复先前文件模式镜像及输入资源；首次旧 Pod 迁移失败恢复升级前镜像与 env 输入；保留状态；回滚 generation 单调前移；健康成功才报告恢复；命令 `go test -tags=e2e,integration ./test -run TestRuntimeFileUpgradeRollback -count=1`。
- [x] [E-05][E2E] 编写并登记独立 E2E 命令，不在编码期执行；统一留给 verify-e2e：真实 Worker 与事务管道：Secret 传播延迟/Console 重启/迁移重复执行/配置更新和升级竞争时，启动与 apply generation 不倒退；失败不发布未经健康验证的启动配置；命令 `go test -tags=e2e,integration ./test -run TestRuntimeFileStartupSourceRecovery -count=1`。
- [x] [B-01][E2E] 编写并登记独立 E2E 命令，不在编码期执行；统一留给 verify-e2e：真实容器启动：有效合成 DTO 的 UTF-8 bytes >128 KiB、低于平台资源限制；file 模式正常执行入口并健康。固定 10 用户且保留传统脚本，不能只用 managed 冗余路径构造后被精简掉；命令 `go test -tags=e2e,integration ./test -run TestRuntimeFileLargeDTO -count=1`。
- [x] RULE-runtime-security-001 verifier：runtime-isolation-and-security#RULE-runtime-security-001；输入为本任务及依赖任务 diff、Acceptance Evidence 和已登记场景；真实镜像/容器/用户目录/guard，禁止mock，断言 密钥只运行时注入，workspace/profile/session隔离，token不输出；命令 `go test -tags=e2e,integration ./test -run 'TestRuntimeFileK8sStartup|TestRuntimeFileSkillIsolation' -count=1`（执行留给 verify-e2e）。规范的 manual verifier 按 code gate 要求提交明确审核证据，不伪造 owner 确认。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-03 | E2E | 真实 K8s Secret → Deployment → 非 root Worker 启动：文件可读、env 不含完整 DTO，启动 generation 正确 | 真实 K8s Secret → Deployment → 非 root Worker 启动：文件可读、env 不含完整 DTO，启动 generation 正确 | test/runtime_file_e2e_support_test.go（新）；test/runtime_file_k8s_e2e_test.go（新）；test/runtime_file_skill_e2e_test.go（新） / S-03 | go test -tags=e2e,integration ./test -run TestRuntimeFileK8sStartup -count=1 | e2e_deferred |
| S-06 | E2E | Console 升级 API → 存储 → 真实 K8s → Worker：旧 env Pod 切换新镜像和文件模式，PVC UID、工作空间与会话哨兵保持，凭证不意外轮换，generation/应用状态/健康收敛 | Console 升级 API → 存储 → 真实 K8s → Worker：旧 env Pod 切换新镜像和文件模式，PVC UID、工作空间与会话哨兵保持，凭证不意外轮换，generation/应用状态/健康收敛 | test/runtime_file_e2e_support_test.go（新）；test/runtime_file_k8s_e2e_test.go（新）；test/runtime_file_skill_e2e_test.go（新） / S-06 | go test -tags=e2e,integration ./test -run TestRuntimeFileK8sUpgrade -count=1 | e2e_deferred |
| S-08 | E2E | 新 Console → 真实 K8s/Docker → 配套新 Worker：新建和升级均使用文件；普通流程没有旧镜像/env 分支；新版 loader 的历史 env 读取由 S-05 独立验证 | 新 Console → 真实 K8s/Docker → 配套新 Worker：新建和升级均使用文件；普通流程没有旧镜像/env 分支；新版 loader 的历史 env 读取由 S-05 独立验证 | test/runtime_file_e2e_support_test.go（新）；test/runtime_file_k8s_e2e_test.go（新）；test/runtime_file_skill_e2e_test.go（新） / S-08 | go test -tags=e2e,integration ./test -run TestRuntimeFileCreateUpgradeContract -count=1 | e2e_deferred |
| S-09 | E2E | 真实 runtime guard 与隔离工作区：两个用户同名私有 Skill 不串扰；system 优先；传统脚本可执行、审计归属正确、长任务行为不变、模型绑定保持 | 真实 runtime guard 与隔离工作区：两个用户同名私有 Skill 不串扰；system 优先；传统脚本可执行、审计归属正确、长任务行为不变、模型绑定保持 | test/runtime_file_e2e_support_test.go（新）；test/runtime_file_k8s_e2e_test.go（新）；test/runtime_file_skill_e2e_test.go（新） / S-09 | go test -tags=e2e,integration ./test -run TestRuntimeFileSkillIsolation -count=1 | e2e_deferred |
| E-02 | E2E | 升级 API → 真实 K8s/Docker/Worker：已迁移 Pod 的新镜像 health 失败后恢复先前文件模式镜像及输入资源；首次旧 Pod 迁移失败恢复升级前镜像与 env 输入；保留状态；回滚 generation 单调前移；健康成功才报告恢复 | 升级 API → 真实 K8s/Docker/Worker：已迁移 Pod 的新镜像 health 失败后恢复先前文件模式镜像及输入资源；首次旧 Pod 迁移失败恢复升级前镜像与 env 输入；保留状态；回滚 generation 单调前移；健康成功才报告恢复 | test/runtime_file_e2e_support_test.go（新）；test/runtime_file_k8s_e2e_test.go（新）；test/runtime_file_skill_e2e_test.go（新） / E-02 | go test -tags=e2e,integration ./test -run TestRuntimeFileUpgradeRollback -count=1 | e2e_deferred |
| E-05 | E2E | 真实 Worker 与事务管道：Secret 传播延迟/Console 重启/迁移重复执行/配置更新和升级竞争时，启动与 apply generation 不倒退；失败不发布未经健康验证的启动配置 | 真实 Worker 与事务管道：Secret 传播延迟/Console 重启/迁移重复执行/配置更新和升级竞争时，启动与 apply generation 不倒退；失败不发布未经健康验证的启动配置 | test/runtime_file_e2e_support_test.go（新）；test/runtime_file_k8s_e2e_test.go（新）；test/runtime_file_skill_e2e_test.go（新） / E-05 | go test -tags=e2e,integration ./test -run TestRuntimeFileStartupSourceRecovery -count=1 | e2e_deferred |
| B-01 | E2E | 真实容器启动：有效合成 DTO 的 UTF-8 bytes >128 KiB、低于平台资源限制；file 模式正常执行入口并健康。固定 10 用户且保留传统脚本，不能只用 managed 冗余路径构造后被精简掉 | 真实容器启动：有效合成 DTO 的 UTF-8 bytes >128 KiB、低于平台资源限制；file 模式正常执行入口并健康。固定 10 用户且保留传统脚本，不能只用 managed 冗余路径构造后被精简掉 | test/runtime_file_e2e_support_test.go（新）；test/runtime_file_k8s_e2e_test.go（新）；test/runtime_file_skill_e2e_test.go（新） / B-01 | go test -tags=e2e,integration ./test -run TestRuntimeFileLargeDTO -count=1 | e2e_deferred |
| runtime-isolation-and-security#RULE-runtime-security-001 | E2E | 真实镜像/容器/用户目录/guard，禁止mock | 密钥只运行时注入，workspace/profile/session隔离，token不输出 | 本任务与依赖的测试/代码审查证据 | go test -tags=e2e,integration ./test -run 'TestRuntimeFileK8sStartup&#124;TestRuntimeFileSkillIsolation' -count=1 | e2e_deferred |

### Acceptance Evidence

- S-03/S-06/S-08/S-09/E-02/E-05/B-01: `e2e_deferred`; executable scenario commands registered in Acceptance Coverage and manifest. No E2E RED/GREEN executed in coding phase.
- Real boundaries: dedicated candidate Console HTTP/API + its real SQLite repo + actual Kubernetes/Docker drivers + non-root Worker/guard. Shared scenarios explicitly cover both drivers. Legacy fixture is seeded only through real repo/recovery, not an ordinary old-image Create option. Valid large fixture has ten bound users and retained traditional script paths; actual UTF-8 size checked against >128 KiB and Secret capacity.
- Assertions: runtime_file_k8s_e2e_test.go startup/migration/image-input rollback/generation/state/source/crash/concurrency; runtime_file_skill_e2e_test.go real tool/script execution, user isolation, protected system conflict, telemetry ownership and long-task completion. runtime_file_e2e_support_test.go real resource builders, envelopes, Secret, UID/mount, database fixtures; environment setup in test/runtime_file_e2e.md.
- Compile-only `cd console/backend && go test -tags=e2e,integration ./test -run '^$'` passed; tagged go vet passed. This collects zero executed E2E tests intentionally and is not execution evidence.
- S-03: e2e_deferred — automated command e2e_deferred; run_id=ee97a884c5294fd58da619b26f02665a (confirmed_by: runner)
- S-06: e2e_deferred — automated command e2e_deferred; run_id=ee97a884c5294fd58da619b26f02665a (confirmed_by: runner)
- S-08: e2e_deferred — automated command e2e_deferred; run_id=ee97a884c5294fd58da619b26f02665a (confirmed_by: runner)
- S-09: e2e_deferred — automated command e2e_deferred; run_id=ee97a884c5294fd58da619b26f02665a (confirmed_by: runner)
- E-02: e2e_deferred — automated command e2e_deferred; run_id=ee97a884c5294fd58da619b26f02665a (confirmed_by: runner)
- E-05: e2e_deferred — automated command e2e_deferred; run_id=ee97a884c5294fd58da619b26f02665a (confirmed_by: runner)
- B-01: e2e_deferred — automated command e2e_deferred; run_id=ee97a884c5294fd58da619b26f02665a (confirmed_by: runner)
- S-03: e2e_deferred — automated command e2e_deferred; run_id=7fd340750ed344cfb8703b95cad1e98c (confirmed_by: runner)
- S-06: e2e_deferred — automated command e2e_deferred; run_id=7fd340750ed344cfb8703b95cad1e98c (confirmed_by: runner)
- S-08: e2e_deferred — automated command e2e_deferred; run_id=7fd340750ed344cfb8703b95cad1e98c (confirmed_by: runner)
- S-09: e2e_deferred — automated command e2e_deferred; run_id=7fd340750ed344cfb8703b95cad1e98c (confirmed_by: runner)
- E-02: e2e_deferred — automated command e2e_deferred; run_id=7fd340750ed344cfb8703b95cad1e98c (confirmed_by: runner)
- E-05: e2e_deferred — automated command e2e_deferred; run_id=7fd340750ed344cfb8703b95cad1e98c (confirmed_by: runner)
- B-01: e2e_deferred — automated command e2e_deferred; run_id=7fd340750ed344cfb8703b95cad1e98c (confirmed_by: runner)
- S-03: e2e_deferred — automated command e2e_deferred; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)
- S-06: e2e_deferred — automated command e2e_deferred; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)
- S-08: e2e_deferred — automated command e2e_deferred; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)
- S-09: e2e_deferred — automated command e2e_deferred; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)
- E-02: e2e_deferred — automated command e2e_deferred; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)
- E-05: e2e_deferred — automated command e2e_deferred; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)
- B-01: e2e_deferred — automated command e2e_deferred; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-09-30] 用户确认拆解写入，创建 draft；尚未激活。

---
- [2026-09-30] started
- [2026-09-30] completed (done)
## TASK-016: 登记 Docker 及双驱动手动接管 E2E

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001, TASK-012, TASK-014, TASK-015
- **Source**: runtime-config-file-input.design.md#2.5.2 验收场景, runtime-config-file-input.design.md#4.4 手动删除与同名重建升级
- **Spec-Refs**:
- **Acceptance-Refs**: S-04, S-10, B-03
- **Files**: test/runtime_file_docker_e2e_test.go（新）；test/runtime_file_adoption_e2e_test.go（新）；internal/driver/docker_integration_test.go
- **Estimate**: 15–60 分钟；真实 E2E 执行另计

### Description

登记真实 Docker 非 root 文件挂载、原子更新/重启、>128 KiB、env/file 回滚 E2E；向 TASK-015 提供共享场景证据。 真实双驱动 API 删除保留状态→同名新建接管：原卷标识、工作区/会话/私有 Skill/Agent/模型保持，新凭证、新配置和高旧代次收敛。 只编写并登记 E2E，不在编码期执行；功能测试全过后交 verify-e2e。

### Checklist
- [x] 登记真实 Docker 非 root 文件挂载、原子更新/重启、>128 KiB、env/file 回滚 E2E；向 TASK-015 提供共享场景证据。
- [x] 真实双驱动 API 删除保留状态→同名新建接管：原卷标识、工作区/会话/私有 Skill/Agent/模型保持，新凭证、新配置和高旧代次收敛。
- [x] 只编写并登记 E2E，不在编码期执行；功能测试全过后交 verify-e2e。
- [x] [S-04][E2E] 编写并登记独立 E2E 命令，不在编码期执行；统一留给 verify-e2e：真实 Docker 目录 bind → Worker：文件模式启动正常，重启可读，原子更新后读取新文件；命令 `go test -tags=e2e,integration ./test -run TestRuntimeFileDockerStartup -count=1`。
- [x] [S-10][E2E] 编写并登记独立 E2E 命令，不在编码期执行；统一留给 verify-e2e：真实 Console 删除/创建 API → SQLite → K8s/Docker 卷 → 新 Worker：deleteState=false 后卷与用户数据保留；相同 podId、新镜像、adoptState=true、restoreUsers=true 创建，卷 UID/标识、Agent ID、会话/记忆/私有 Skill 哨兵保持；新 DTO 走文件并健康，用户身份/模型绑定恢复；命令 `go test -tags=e2e,integration ./test -run TestRuntimeFileRetainedWorkspace -count=1`。
- [x] [B-03][E2E] 编写并登记独立 E2E 命令，不在编码期执行；统一留给 verify-e2e：保留卷 openclaw.json generation 高于新 Pod 记录初始 generation：同名重建后最终应用新 Pod 的通道/模型/文件 DTO 和新 gateway 凭证，不能永久停留旧配置或 token_mismatch；代次收敛与后续容器重启正常；命令 `go test -tags=e2e,integration ./test -run TestRuntimeFileAdoptedGeneration -count=1`。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-04 | E2E | 真实 Docker 目录 bind → Worker：文件模式启动正常，重启可读，原子更新后读取新文件 | 真实 Docker 目录 bind → Worker：文件模式启动正常，重启可读，原子更新后读取新文件 | test/runtime_file_docker_e2e_test.go（新）；test/runtime_file_adoption_e2e_test.go（新）；test/runtime_file_docker_e2e_test.go / TestRuntimeFileDockerStartup_S04 | go test -tags=e2e,integration ./test -run TestRuntimeFileDockerStartup -count=1 | deferred（verify-e2e） | e2e_deferred |
| S-10 | E2E | 真实 Console 删除/创建 API → SQLite → K8s/Docker 卷 → 新 Worker：deleteState=false 后卷与用户数据保留；相同 podId、新镜像、adoptState=true、restoreUsers=true 创建，卷 UID/标识、Agent ID、会话/记忆/私有 Skill 哨兵保持；新 DTO 走文件并健康，用户身份/模型绑定恢复 | 真实 Console 删除/创建 API → SQLite → K8s/Docker 卷 → 新 Worker：deleteState=false 后卷与用户数据保留；相同 podId、新镜像、adoptState=true、restoreUsers=true 创建，卷 UID/标识、Agent ID、会话/记忆/私有 Skill 哨兵保持；新 DTO 走文件并健康，用户身份/模型绑定恢复 | test/runtime_file_docker_e2e_test.go（新）；test/runtime_file_adoption_e2e_test.go（新）；test/runtime_file_adoption_e2e_test.go / TestRuntimeFileRetainedWorkspace_S10 | go test -tags=e2e,integration ./test -run TestRuntimeFileRetainedWorkspace -count=1 | deferred（verify-e2e） | e2e_deferred |
| B-03 | E2E | 保留卷 openclaw.json generation 高于新 Pod 记录初始 generation：同名重建后最终应用新 Pod 的通道/模型/文件 DTO 和新 gateway 凭证，不能永久停留旧配置或 token_mismatch；代次收敛与后续容器重启正常 | 保留卷 openclaw.json generation 高于新 Pod 记录初始 generation：同名重建后最终应用新 Pod 的通道/模型/文件 DTO 和新 gateway 凭证，不能永久停留旧配置或 token_mismatch；代次收敛与后续容器重启正常 | test/runtime_file_docker_e2e_test.go（新）；test/runtime_file_adoption_e2e_test.go（新）；test/runtime_file_adoption_e2e_test.go / TestRuntimeFileAdoptedGeneration_B03 | go test -tags=e2e,integration ./test -run TestRuntimeFileAdoptedGeneration -count=1 | deferred（verify-e2e） | e2e_deferred |

### Acceptance Evidence

S-04/S-10/B-03: e2e_deferred。新增实际 Docker/K8s、Console API/SQLite、保留状态卷和真实 Worker/agent 用例；只编译，不运行 E2E。S-04 断言真实只读目录 bind、旧 fd 不变/新路径更新及物理重启；S-10/B-03 断言卷标识/记忆/会话/私有 Skill、Agent/模型保留，旧服务凭证失效、新 gateway 凭证、旧 1000 generation 配置经协调器被替换，真实 agent Skill 执行与重启收敛。go test -tags=e2e,integration ./test -run '^$' 与 tagged go vet 通过。共享 S-08/E-02/E-05/B-01 双驱动用例由 TASK-015 登记。无实际 E2E 结果，交 verify-e2e。

- 工作区流程更新由用户 2026-10-01「继续」纳入当前检查范围，作为现有基线登记；其内容保持。
- S-04: e2e_deferred — automated command e2e_deferred; run_id=4c1a0b7d6a0246dfad7fc0e4536a8704 (confirmed_by: runner)
- S-10: e2e_deferred — automated command e2e_deferred; run_id=4c1a0b7d6a0246dfad7fc0e4536a8704 (confirmed_by: runner)
- B-03: e2e_deferred — automated command e2e_deferred; run_id=4c1a0b7d6a0246dfad7fc0e4536a8704 (confirmed_by: runner)
- S-04: e2e_deferred — automated command e2e_deferred; run_id=b84f74bf6125435da2624b8254685f25 (confirmed_by: runner)
- S-10: e2e_deferred — automated command e2e_deferred; run_id=b84f74bf6125435da2624b8254685f25 (confirmed_by: runner)
- B-03: e2e_deferred — automated command e2e_deferred; run_id=b84f74bf6125435da2624b8254685f25 (confirmed_by: runner)
- S-04: e2e_deferred — automated command e2e_deferred; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)
- S-10: e2e_deferred — automated command e2e_deferred; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)
- B-03: e2e_deferred — automated command e2e_deferred; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-09-30] 用户确认拆解写入，创建 draft；尚未激活。
- [2026-10-01] started
- [2026-10-01] completed (done)

## TASK-017: 修复并发升级保留最新 Pod 设置

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-016
- **Source**: runtime-config-file-input.design.md#4.3 回滚与热更新
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-quality-001, backend-logging#RULE-backend-redact-001, runtime-config-and-apply#RULE-runtime-config-001, runtime-isolation-and-security#RULE-runtime-secret-file-mode-001
- **Acceptance-Refs**: S-18
- **Files**: internal/api/pod_upgrade.go；internal/api/pods.go；test/runtime_file_concurrency_test.go（新）

### Description

终态检查发现原设计 §4.3 的实现缺口，显式追加修复任务；不重开已完成任务，不变更 DTO/数据库/产品交互。TASK-018 因恢复链跨 API/两种驱动及持久源，显式登记范围超过原先 1–3 文件约定；共享 E2E harness 同步实体重启验证，不降低原 E2E 边界。

### Checklist
- [x] 编写功能验收并记录真实 RED。
- [x] 修复原设计约束并验证 GREEN，E2E 仍 deferred。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-18 | integration | 真实 HTTP handler、SQLite 与互斥队列；排队前的旧快照不能覆盖最新设置，普通更新与镜像升级同锁 | 真实 HTTP handler、SQLite 与互斥队列；排队前的旧快照不能覆盖最新设置，普通更新与镜像升级同锁 | internal/api/pod_upgrade.go；internal/api/pods.go；test/runtime_file_concurrency_test.go（新） / TestRuntimeFileConcurrency | go test ./test -run TestRuntimeFileConcurrency -count=1 | verified |

### Acceptance Evidence

RED: go test ./test -run TestRuntimeFileConcurrency -count=1，exit 1：两个场景分别复现旧快照覆盖最新 displayName、普通 patch 未使用同锁。真实 HTTP/SQLite，队列模拟锁等待前的另一次成功 mutation。
- S-18: verified — automated command passed; run_id=e479166197944648b034190f48491fca (confirmed_by: runner)
- S-18: verified — automated command passed; run_id=974487eac90749ca818b804be5479d06 (confirmed_by: runner)
- S-18: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-10-01] 最终检查发现已确认设计的边界缺口，显式追加修复任务。
- [2026-10-01] started

GREEN: 同一 TestRuntimeFileConcurrency 命令 exit 0；internal/api 与 test 全量回归通过。代码在锁内重新读取最新记录，仅合并实际变更 metadata；image PATCH 后续 metadata 合并保持在原锁内。
- [2026-10-01] completed (done)
## TASK-018: 补齐缺失 workload 的原输入恢复

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-017
- **Source**: runtime-config-file-input.design.md#4.3 回滚与热更新
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-quality-001, backend-logging#RULE-backend-redact-001, runtime-config-and-apply#RULE-runtime-config-001, runtime-isolation-and-security#RULE-runtime-secret-file-mode-001
- **Acceptance-Refs**: S-19
- **Files**: internal/api/pod_operations.go；internal/driver/k8s_restore.go；internal/driver/docker_restore.go；internal/driver/docker_recovery.go（新）；internal/driver/runtime.go；internal/driver/docker.go；internal/driver/runtime_recovery_test.go（新）；internal/driver/docker_internal_test.go；internal/driver/docker_restore_test.go；test/runtime_file_recovery_test.go（新）；test/runtime_file_*e2e_test.go

### Description

终态检查发现原设计 §4.3 的实现缺口，显式追加修复任务；不重开已完成任务，不变更 DTO/数据库/产品交互。TASK-018 因恢复链跨 API/两种驱动及持久源，显式登记范围超过原先 1–3 文件约定；共享 E2E harness 同步实体重启验证，不降低原 E2E 边界。

### Checklist
- [x] 编写功能验收并记录真实 RED。
- [x] 修复原设计约束并验证 GREEN，E2E 仍 deferred。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-19 | integration | 真实 Secret/manifest、本地私有文件、HTTP/SQLite；仅外部 K8s/CLI fake；缺失 workload 从可靠恢复材料重建原 env/file，凭证/卷保留，材料缺失或损坏明确失败 | 真实 Secret/manifest、本地私有文件、HTTP/SQLite；仅外部 K8s/CLI fake；缺失 workload 从可靠恢复材料重建原 env/file，凭证/卷保留，材料缺失或损坏明确失败 | internal/api/pod_operations.go；internal/driver/k8s_restore.go；internal/driver/docker_restore.go；internal/driver/docker_recovery.go（新）；internal/driver/runtime.go；internal/driver/docker.go；internal/driver/runtime_recovery_test.go（新）；internal/driver/docker_internal_test.go；internal/driver/docker_restore_test.go；test/runtime_file_recovery_test.go（新）；test/runtime_file_*e2e_test.go / TestRuntimeFileRecovery | go test ./internal/driver ./test -run TestRuntimeFileRecovery -count=1 | verified |

### Acceptance Evidence

RED: go test ./internal/driver ./test -run TestRuntimeFileRecovery -count=1，exit 1：K8s 缺失 Deployment 时不读取保留 Secret、Docker 缺失 container 时丢失原启动源；修正测试路由后 go test ./test -run TestRuntimeFileRecovery -count=1 再次 exit 1，真实 restart 通过普通 Create 切为 file、restore 失败仍报成功。初次错误路由的 404 不计入有效 RED。
- S-19: verified — automated command passed; run_id=b94580cd8bca42d49f59877d721a880d (confirmed_by: runner)
- S-19: verified — automated command passed; run_id=bf88ca6aac854022bb9b63d1da4e20e6 (confirmed_by: runner)
- S-19: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-10-01] 最终检查发现已确认设计的边界缺口，显式追加修复任务。
- [2026-10-01] started

GREEN: go test ./internal/driver ./test -run TestRuntimeFileRecovery -count=1 exit 0；完整 driver/runtimeapply/test 回归、go vet ./...、E2E tagged compile/vet 通过，cf_validation decision=pass。Docker 初次 file Create 也保存可靠材料；恢复包含原镜像、输入与新恢复代次，跨 Pod/损坏/宽松权限拒绝。E2E 重启现在等待物理 UID/StartedAt 变化，避免探测到旧进程即误报成功；并发 E2E 的错误在主测试协程断言。
- [2026-10-01] completed (done)

## TASK-019: 收尾函数结构检查

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-018
- **Source**: runtime-config-file-input.design.md#3.5 规范约束
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-quality-001
- **Acceptance-Refs**: S-20
- **Files**: internal/driver/k8s.go；internal/driver/docker_internal_test.go；internal/driver/docker_restore_test.go

### Description

按 AGENTS 单职责/函数 ≤50 行要求拆分本需求新增或扩大的函数。原有未增大的长函数保持，避免无关重构。

### Checklist
- [x] 拆分新增长函数，保持原断言与行为。
- [x] 原 driver 全量测试与 vet 通过。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-20 | integration | 原 driver 全量真实文件及 manifest 测试；仅外部 K8s/CLI fake | 所有挂载/权限/输入恢复断言保持 | internal/driver/*_test.go / 原全量 driver 测试 | go test ./internal/driver -count=1 | verified |

### Acceptance Evidence

纯函数拆分，行为已通过功能测试，不存在缺陷 RED；不得伪造失败。拆分后执行原验收 GREEN。
- S-20: verified — automated command passed; run_id=be7cbf9e275247388ba3d4c362ae5283 (confirmed_by: runner)
- S-20: verified — automated command passed; run_id=15b47fbf07e0482287e883d6c629d140 (confirmed_by: runner)
- S-20: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-10-01] 新增或扩大的三处函数超过 50 行，显式追加结构修复。
- [2026-10-01] started

GREEN: go test ./internal/driver -count=1 与 go vet ./internal/driver exit 0。仅拆分 deployment 的卷/安全上下文构建及两处测试 fixture；原测试断言不删减。新增长函数检查均 ≤50 行。
- [2026-10-01] completed (done)

## TASK-020: 完成 Docker 恢复 fixture 拆分

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-019
- **Source**: runtime-config-file-input.design.md#3.5 规范约束
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-quality-001
- **Acceptance-Refs**: S-21
- **Files**: internal/driver/docker_restore_test.go

### Description

TASK-019 后函数检查发现 assertDockerRecovery 仍为 53 行；显式追加完成剩余拆分，不改已完成任务状态。

### Checklist
- [x] 剩余 fixture 拆分并保留所有恢复断言，回归通过。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-21 | integration | 原 Docker 命令参数及本地文件测试 | 原 env/file、image/volume/token 断言保留 | internal/driver/docker_restore_test.go / TestRuntimeFileTask011 | go test ./internal/driver -run TestRuntimeFileTask011 -count=1 | verified |

### Acceptance Evidence

纯 fixture 拆分无行为变化，不能伪造 RED；拆分后原验收 GREEN。
- S-21: verified — automated command passed; run_id=b02a141ef9764fefbefe8f10465f79cb (confirmed_by: runner)
- S-21: verified — automated command passed; run_id=6d86f53e15fa4e35a4cca404637c4e83 (confirmed_by: runner)
- S-21: verified — automated command passed; run_id=c2094703596b486cad0fb92f525506f0 (confirmed_by: runner)

### Log

- [2026-10-01] 剩余测试 fixture 结构修复。
- [2026-10-01] started

GREEN: go test ./internal/driver -run TestRuntimeFileTask011 -count=1 exit 0；原四组输入/镜像/卷/令牌断言完整，函数检查 ≤50 行。
- [2026-10-01] completed (done)

## 实现阶段收尾（2026-10-01）

- TASK-001～020 均通过官方 finish，当前无 active TASK；不将 done 等同于 E2E verified。
- 全场景 acceptance runner: decision=pass；19 functional passed，11 E2E e2e_deferred。
- 最终 go test ./...、go vet ./...、E2E tagged compile/vet、git diff --check 均通过；项目 cf_validation decision=pass。
- Node 入口/schema/transaction 测试通过；未执行真实 E2E，未构建/部署镜像，未提交代码。
- 17 项 review 层规范及真实 E2E 统一交 cf-task-verify-e2e；环境依赖见 console/backend/test/runtime_file_e2e.md。流程文件的既有更新保留，非本需求编写。
- 最终功能边界：Pod 启动文件隔离；普通新 Worker file-only；旧镜像/原输入回滚；保留状态同名接管；并发 metadata 与升级同锁；缺失 workload 使用可靠原输入恢复材料，缺材料明确失败。

## E2E 执行记录（2026-10-01）

- 用户明确要求执行 E2E。
- 官方 verify-e2e 入口 exit 3：decision=block、reason=manual_confirmation_required；完整 17 项 review checklist 和 owner 已写入 runtime-config-file-input.review.md，并一次性向用户请求确认。未代确认或提升任务为 verified。
- 独立执行无需集群的 S-02：cf_acceptance_runner --owner TASK-001 --only-e2e --write-evidence，decision=pass；真实 Go DTO→Node Schema→renderer 配置及指导文件等价，exit 0，manifest S-02 verified。
- 其余 10 个场景暂未执行：当前没有 MUAD_E2E_* 专用 Console、镜像、数据库、模型/测试 IM 配置。Docker server 29.4.0 与 orbstack Kubernetes 可访问，但现有 muad 工作负载未作为测试 fixture 使用。等待测试配置位置与 review 确认，不把缺环境视为测试通过。

## TASK-021: 修正实测发现的 E2E 用户接口契约

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-020
- **Source**: runtime-config-file-input.design.md#2.5.2 验收场景
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-quality-001, backend-platform-rules#RULE-backend-platform-001
- **Acceptance-Refs**: S-22
- **Files**: test/runtime_file_e2e_support_test.go；test/runtime_file_adoption_e2e_test.go；test/runtime_file_docker_e2e_test.go；test/runtime_file_skill_e2e_test.go；test/runtime_file_user_contract_test.go（新）

### Description

用户授权 muad/pod01、pod02 本地实测时，GET 用户详情返回 data.humanUser，原 E2E helper 错读平铺 data；Docker 更新还错误使用 userPrompt 而非 prompt。显式追加测试修复任务，五文件范围是共享 helper 与其四处调用所需，不改产品 API/存储/行为。

### Checklist
- [x] 增加真实 HTTP/SQLite 用户详情及 prompt 更新契约测试并记录 RED。
- [x] 修正 E2E helper、调用及字段，GREEN 与编译通过。

### Acceptance Contract

| 场景ID/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-22 | integration | 真实 HTTP handler/SQLite；仅外部 driver fake | helper 解包 humanUser；prompt 更新生效，generation 递增，model/agent 保持 | test/runtime_file_user_contract_test.go / TestRuntimeFileUserDetailContract_S22 | go test -tags=e2e,integration ./test -run TestRuntimeFileUserDetailContract -count=1 | verified |

### Acceptance Evidence

RED: go test -tags=e2e,integration ./test -run TestRuntimeFileUserDetailContract -count=1 exit 1，缺正确 Human User 解包/请求类型 helper。实测脚本原 GET 断言失败 KeyError: podId；检查确认真实响应是 data.humanUser。修正读法后，pod02 同名接管、新凭证、原用户/Agent/模型/PVC、旧 generation 5→新 generation 2 及物理重启实际通过。原自动化用例仍 deferred，不冒充全部终验。
- S-22: verified — automated command passed; run_id=ded0b5e1c5ff4e09819fc6148ea0d030 (confirmed_by: runner)
- S-22: verified — automated command passed; run_id=cf3c99131d4b483da605d73c5adc420b (confirmed_by: runner)

### Log

- [2026-10-01] 本地实测发现辅助代码接口契约错误，显式追加修复，不重开 done。
- [2026-10-01] started

GREEN: go test -tags=e2e,integration ./test -run TestRuntimeFileUserDetailContract -count=1 exit 0；tagged go vet 与 compile 通过。真实 HTTP/SQLite 验证 GET/PATCH 包装、prompt 值与 generation 改变、model/agent 不变。只修 E2E helper；产品代码未改。
- [2026-10-01] completed (done)

## 用户授权现有 Pod 实测收尾（2026-10-01）

详见 runtime-config-file-input.live-e2e.md：旧 env→file、真实失败回滚至旧 env 镜像、保留 PVC 后同名接管（旧 generation 5→新 generation 2）、两 Pod 物理重启及启动源隔离均实测通过。独立真实 Docker 141 KiB 合成 DTO 文件启动、0600/UID1000、readonly 目录、原子更新旧 fd/新路径、重启也通过。pod01/pod02 最终 Ready 1/1、每 Pod 原 1 用户、原 PVC 保持；临时哨兵和 Docker 测试卷/容器已清理。

追加 TASK-021 修复实测暴露的 E2E HTTP 契约误读（data.humanUser、prompt），功能契约/compile/vet 及 Done Gate 通过。没有新增产品实现改动。需求级正式终验仍需完成原自动化矩阵及 review 确认，原 deferred 状态保留；不能把上述局部实测算作全部 E2E verified。
