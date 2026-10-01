# E2E 终验：待确认 review 清单

官方 verify-e2e 返回 decision=block、reason=manual_confirmation_required。下列 17 项 owner 均为 project-owner，需用户明确确认；Agent 不代确认。此前 code 阶段确认保留，review 阶段此次统一确认。

已有验证：19 项 functional passed；Go 全量测试/vet、Node 测试、E2E tagged compile/vet 通过。此证据支持审查，不替代真实集群 E2E。

| 规则 | 完整 checklist | owner |
|---|---|---|
| backend-code-quality-performance#RULE-backend-quality-001 | Confirm explicit errors, context timeouts, and go test/vet expectations. | project-owner |
| backend-database#RULE-backend-database-001 | Confirm parameterized queries, explicit columns, repo-only access, and reversible/idempotent schema changes. | project-owner |
| backend-directory-structure#RULE-backend-directory-001 | Confirm Go code lives under console/backend with cmd/internal separation and no cross-layer imports. | project-owner |
| backend-logging#RULE-backend-logging-001 | Confirm structured logs, RedactDiagnostic on stored/logged errors, no secrets, audit vs skill-execution separation. | project-owner |
| backend-logging#RULE-backend-redact-001 | Confirm error strings persisted to logs/audit/apply failures use auditlog.RedactDiagnostic first. | project-owner |
| backend-platform-rules#RULE-backend-model-pool-001 | Confirm CreateHumanUser binds unbound model_config_id and conflicts on already-bound models with no override fallback. | project-owner |
| backend-platform-rules#RULE-backend-platform-001 | Confirm multi-user isolation, model binding, writeJSON/writeErr, secret handling, and runtime apply semantics. | project-owner |
| runtime-config-and-apply#RULE-runtime-config-001 | Confirm validateRuntimeConfig, transactional apply stages, generation, and rollback/health behavior. | project-owner |
| runtime-config-and-apply#RULE-runtime-validate-before-write-001 | Confirm renderer/inject calls validateRuntimeConfig before atomic write and carries monotonic generation. | project-owner |
| runtime-directory-structure#RULE-runtime-directory-001 | Confirm runtime code stays in bin/tools/skills/k8s and does not fork OpenClaw upstream into this tree. | project-owner |
| runtime-isolation-and-security#RULE-runtime-secret-file-mode-001 | Confirm config/secret material uses 0o600 (token files 0400 at canonical path) and atomic writes. | project-owner |
| runtime-isolation-and-security#RULE-runtime-security-001 | Confirm secrets stay out of images, restrictive file modes, users stay isolated, and tokens are not logged. | project-owner |
| runtime-skill-execution#RULE-runtime-log-injection-001 | Confirm tool/plugin modules inject `log` (default no-op) instead of scattered console.*; plugin path uses api.logger.warn, CLI path uses console.warn. | project-owner |
| runtime-skill-execution#RULE-runtime-log-prefix-001 | Confirm log lines carry a stable module prefix ([session-manager]/[muad-runtime-guard]) and [<module>-<action>] sub-tags. | project-owner |
| runtime-skill-execution#RULE-runtime-skill-001 | Confirm skill layering, system protection, activation gates, progress events, and concurrency limits. | project-owner |
| runtime-skill-execution#RULE-runtime-skill-fail-loud-001 | Confirm skill scripts write failures to stderr and exit non-zero; stdout reserved for machine-readable result. | project-owner |
| runtime-skill-execution#RULE-runtime-skill-layering-001 | Confirm system-first resolution, system_protected, and no silent public/private overwrite without allow_override. | project-owner |

人工场景 manual_scenarios: 无。

尚缺专用环境：K8s/Docker 测试 Console 地址及登录配置、测试镜像标签、可访问的隔离 SQLite 文件、模型账号、测试 IM 账号；当前 MUAD_E2E_* 未配置。Docker daemon 与 orbstack 集群可访问，但现有 muad 命名空间的 Worker 不属于专用 E2E fixture。环境变量契约见 console/backend/test/runtime_file_e2e.md。
