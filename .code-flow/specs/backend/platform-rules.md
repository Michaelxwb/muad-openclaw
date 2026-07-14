---
description: 涉及 API 设计/部署/配置/版本兼容时适用：平台规则
---

# Backend Platform Rules

## Examples

✅ 走统一封装 + 错误码常量

```python
return success(data)
raise BizError(ORDER_NOT_FOUND)   # 错误码定义在 errors/order.py
```

❌ handler 手拼响应结构 + 硬编码 message

```python
return {"code": 1, "message": "order not found", "data": None}
```

## Rules
- API 变更必须保持向后兼容；破坏性变更走新版本路径（`/v2/...`）并保留旧版本至少一个发布周期
- 配置项分环境管理（dev / staging / prod），敏感值走密钥管理服务，禁止入库
- 新增外部依赖必须更新部署文档与 `requirements` / `package.json` 锁文件
- 灰度 / 实验性功能必须由 feature flag 控制，默认关闭
- API 响应必须走统一封装：`success(data)` / `fail(code, message?)`，handler 禁止手写 `{code, message, data}` 字面量
- 错误码 → message 映射定义为常量，按业务模块拆分（`errors/order.py`、`errors/user.py`），错误码全局唯一，禁止重复

## Patterns
- API 响应统一结构：`{ code, message, data }`（`code=0` 表示成功），全项目一致
- 错误码命名空间：模块前缀 + 顺序号（如订单错误码 `10xxx`、用户 `20xxx`），便于定位归属
- 异常 → 错误码：自定义业务异常类携带 `code`，由中间件统一转 `fail(code)` 响应
- 配置加载优先级：环境变量 > 配置文件 > 默认值
- 健康检查端点（`/healthz`、`/readyz`）必须独立于业务认证
- 部署前跑 smoke test，覆盖核心路径
- **[项目] [internal/config/config.go]** env > yaml > defaults 三级优先级，`config.yaml` 不存在时静默使用 defaults（容器友好）；敏感值（密码/密钥）禁止写入 yaml，仅从 env 注入
- **[项目] [Dockerfile]** 凭证不进镜像（`NFR-SEC-02`），运行时经 env 注入；浏览器/插件/基线配置在构建期烤入，首启从种子卷播种
- **[项目] [CI: build-console.yml, build-image.yml]** tag push 触发 Docker build & push 到 GHCR，`console-v*` tag → 控制台镜像，`v*` tag → 工作镜像
- **[项目] [internal/api/server.go:80-90]** API 响应统一通过 `writeJSON` / `writeErr` 两个 helper 输出，禁止 handler 直接调用 `json.NewEncoder(w).Encode(...)`；所有 handler 必须走统一封装
- **[项目] [internal/api/*.go 所有 handler]** 错误码按 HTTP 状态码分段：`40001`（invalid body/param）、`40101`（unauthorized）、`40401`（not found）、`40901`（conflict/duplicate）、`50001`（internal error）；新增错误码沿用此体系，不重复使用已有编号
- **[项目] 消息通道为插件式架构** [Dockerfile, baseline-config.json, bin/inject-env.mjs]：openclaw 通道由**构建期安装的插件**提供——企微 `@wecom/wecom-openclaw-plugin`（通道 id `wecom`）、个人微信 `@tencent-weixin/openclaw-weixin`（通道 id `openclaw-weixin`）。baseline 声明通道、`inject-env.mjs` 按 `CHANNEL` env 仅启用所选通道（其余关闭防互踢）。外部 channel 值（`wecom`/`wechat`）→ openclaw 通道 id 的映射集中在 inject-env（`wechat`→`openclaw-weixin`）。openclaw 核心**无内置 wechat 通道**，未装插件就配 `channels.wechat` 会 `unknown channel id` 启动失败；新增通道必须先在 Dockerfile 装插件。
- **[项目] 通道凭证差异** [bin/inject-env.mjs]：企微用 `WECOM_BOT_ID/WECOM_SECRET`；个人微信**免凭证**，登录靠日志二维码（`openclaw channels login --channel openclaw-weixin` 输出 `liteapp.weixin.qq.com` 链接 + ASCII 二维码）。后端创建校验据此区分：仅 wecom 要求 botId/secret。
- **[项目] 容器内配置注入走 `ExecStdin` + stdin JSON，禁止走命令参数** [internal/driver/driver.go:91, internal/driver/docker.go:175-184, internal/driver/k8s.go:358-381, internal/api/containers.go:576-579]：RuntimeDriver 暴露 `ExecStdin(ctx, userID, stdin io.Reader, cmd ...string)` 接口，长 JSON / 凭据经 stdin pipe 传入——Docker driver 用 `docker exec -i` + `cmd.Stdin = stdin`；K8s driver 用 SPDY exec 把 `Stdin: true` 写入 `PodExecOptions` 并把 reader 挂到 `StreamOptions.Stdin`。handler 调 `s.drv.ExecStdin(r.Context(), userID, strings.NewReader(payloadJSON), "node", "/opt/muad/xxx.mjs")`，**payload 永远不进入 argv**——避免出现在 `ps` / shell history / 审计日志 / cgroup 监控。新增需要传大 payload 或敏感数据的容器内命令，统一走 ExecStdin 模式，不要再加 `Exec` 变体塞参数。
- **[项目] 多通道热更：Go 端 diff + ExecStdin 注入 `openclaw.json` 的 `channels` 段** [internal/api/containers.go:537-580, bin/inject-channels.mjs]：用户编辑通道配置（`PUT /containers/{userId}/channels`）后，handler 拿 `oldChannels / oldConfigs` 与请求做 diff → 合并 `mergeChannelConfig`（空 secret 字段 = 保留旧值）→ 加密新 secret → 用 `wecom→wecom` / `wechat→openclaw-weixin` 通道 id 映射构造 `oclConfig` → `json.Marshal` → `ExecStdin` 跑 `/opt/muad/inject-channels.mjs`（stdin 收 JSON → enable + 覆盖配置 → 删 input 中没有的 key → 写回）→ Exec 成功后才更新 DB。**Exec 失败时 DB 保持原样**（user 已通过的 `TestUpdateChannels_ExecFailureDoesNotMutateDB` 覆盖）。通道 id 映射在 Go 侧而非 mjs 侧——mjs 看到的是 openclaw 内部 id，Go 看到的是外部 `wecom`/`wechat`，职责清晰。热更 ~200ms 生效，gateway 自动重载，**不重启容器**。
- **[项目] 长耗时 script skill 进度走 `muad_run_skill` 执行边界** [tools/muad-run-skill/src/index.mjs, tools/muad-run-skill/src/delivery.mjs, tools/muad-progress]：业务脚本调用语言无关的 `muad-progress` CLI 上报阶段；OpenClaw 当前会话上下文只能由 `muad_run_skill` tool 持有，并由 runner 将进度通过当前会话投递为独立消息。不要让子进程 CLI 直接假设自己持有微信/企微会话上下文；旧 `progress-adapters/openclaw` 只能作为薄适配或 PoC，不作为 OpenClaw 主链路。
- **[项目] skill 进度消息不得替代 OpenClaw 原生最终回复** [tools/muad-run-skill/src/index.mjs, tools/muad-run-skill/src/delivery.mjs]：`muad-progress`/`muad_run_skill` 只负责阶段进度，最终结果继续走 OpenClaw native final reply 链路。禁止为了调整企微/微信排序，把最终回复改成 text-only outbound；只有在完整保真附件、图片、卡片等 payload 且有测试覆盖时，才能替换 final 投递路径。
- **[项目] session-manager 平台登录逻辑集中在 core/platform adapter** [.code-flow/tasks/2026-07-06/user-cookie-credential-import/user-cookie-credential-import.design.md]：OpenClaw/Hermes adapter 只做薄封装，不复制平台 token/cookie/storageState 逻辑；登录脚本由 `/opt/session-manager/platforms/<platform>` 统一管理，不属于业务 skill。新增平台只改 platform adapter 和配置，不新增 `service_registry` 式显式 token/cookie API 映射。
- **[项目] 多用户 LLM 配置只走模型池最终形态** [internal/repo/llm_models.go, internal/api/human_users.go, internal/runtimeconfig/models.go]：Human User 创建必须绑定一个存在且未被其他用户占用的 `llm_model_configs.model_config_id`；运行时 provider 只从用户绑定模型生成。禁止恢复 global LLM、Pod LLM override、Human User model override 等兼容 fallback。API/UI 只暴露 `api_key_fingerprint`，不得返回完整 API key。
- **[项目] Skill 生效边界由控制面 resolver + runtime policy 双层约束** [internal/repo/skill_resolver.go, tools/muad-run-skill/src/skill-policy.mjs]：Human User 可用 Skill 视图必须合并 system/public/private 资产、用户策略、平台启停、用户平台凭证、最近执行记录和 runtime pending 状态。system skill 永远优先且不可被 public/private 覆盖；private 与 public 同名默认返回 `conflict`，只有显式 `allow_override` 策略才允许 private 生效；`disable` 策略按用户维度禁用最终 Skill。
- **[项目] Public Skill 状态变更必须显式应用到所有 Pod** [internal/api/skills.go, internal/api/pod_operations.go, internal/driver/public_skills_sync.go]：上传、启用、禁用、删除 Public Skill 先更新控制面资产并标记相关 Pod，管理员点击“应用 Skill”后才同步 active-only Public Skill 目录并触发所有运行中 Pod 的 runtime config apply。Docker driver 维护 active-only 运行目录；K8s driver 优先使用 RWX PVC，PVC 不存在或未 Bound/非 RWX 时必须 fail fast，不允许假装成功。
- **[项目] Private Skill 写入目标 Pod 内用户 workspace** [internal/api/skills.go, bin/private-skill-installer.mjs]：Private Skill 安装/删除必须通过 `RuntimeDriver.ExecStdin` 调目标 Pod 内 `/opt/muad/private-skill-installer.mjs`，由 installer 写入 `/home/node/.openclaw/workspace-<agent>/skills/<skill>`。Console 只保存元数据和触发目标 Pod reconcile，不直接写 runtime PVC；安装后如果发生重名冲突或 DB 写入失败，必须调用 installer 清理 Pod 内已写入目录。
- **[项目] Skill bundle 格式和安全校验** [internal/api/skill_bundle.go, bin/private-skill-installer.mjs]：Public/Private Skill 上传均支持 `.tar.gz` 和 `.zip`；Skill 名称优先从 `muad.skill.json.name`、其次 `SKILL.md` frontmatter、最后目录名推导。解包只接受单个有效 `SKILL.md` 所在 Skill 目录，必须拒绝绝对路径、`..` 路径逃逸、Windows drive path、symlink/hardlink；可忽略 `__MACOSX` / `.DS_Store` 等 zip 噪声文件。
- **[项目] 上游 OpenClaw/插件能力通过 adapter/wrapper 扩展** [tools/muad-run-skill, bin/inject-env.mjs, bin/inject-channels.mjs]：遇到 OpenClaw 或第三方插件限制时，优先通过 adapter、wrapper、配置注入或运行时编排解决；不要 fork 或直接修改上游插件代码。只有用户明确要求维护 fork，且有升级、回滚和测试方案时，才允许改上游代码。

## Anti-Patterns
- 禁止在生产环境开启 `DEBUG` / 详细堆栈输出
- 禁止把 secret 写进代码库或 dev 配置文件
- 禁止破坏性 API 变更不通知调用方直接发布
- 禁止 feature flag 长期遗留，上线稳定后必须清理
- 禁止在 handler 里直接拼响应结构或硬编码错误 message，必须引用 `errors/` 常量并走 `success / fail` 封装
- 禁止绕过 `muad_run_skill` 让长耗时 skill 的子进程自行向微信/企微发进度；子进程没有可靠的会话上下文
- 禁止恢复全局模型、Pod 模型覆盖或用户模型覆盖作为多用户 LLM fallback；用户运行时模型只能来自已绑定的模型池配置
- 禁止为修业务链路直接修改上游 OpenClaw 或第三方插件代码；先通过本项目 adapter/wrapper/注入层隔离
- 禁止让 Public Skill 的启用/禁用/删除只改 DB 而不提供“应用 Skill”同步入口；运行时目录必须只暴露 active 的 Console-managed Public Skill
- 禁止由 Console 直接写 Human User 的 runtime workspace/PVC 安装 private skill；必须通过目标 Pod 内 installer 和 `ExecStdin` 完成
