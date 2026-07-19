# 全面代码检查报告（2026-07-18）

> 检查范围：Go 后端（console/backend，85 文件 ~18k 行）、TS 前端（console/frontend，63 文件 ~9.8k 行）、Node 工具与脚本（tools/ + bin/，40 个 .mjs）、Python hooks（.code-flow/scripts/，22 个 .py）、全部基础设施与部署配置（Dockerfile / compose / k8s / entrypoint / provision 脚本）。
>
> 方法：4 路并行深度审查 + 全量测试与静态检查 + 对关键发现逐项人工复核（9/9 属实）。
>
> 基线状态：所有测试通过（Go 全绿 / 前端 120 / muad-run-skill 54 / muad-runtime-guard 42 / bin 28 / session-manager 20），`go vet`、`tsc --noEmit`、`eslint --max-warnings=0` 零告警，Python 全部可编译。
>
> **总体结论**：无 critical 级问题（无 SQL 注入、无 XSS sink、无入库密钥）。共 12 项高危、约 47 项中危、约 78 项低危，主要集中在认证加固缺失、回滚路径正确性、hook 安全边界、多租户隔离四个主题。
>
> 使用方式：每项前面是复选框，修复后勾选。标注 ✅已复核 的条目经过人工二次验证确认属实。

---

## 🔴 高危（12 项）

### 密钥卫生（最紧急）

- [ ] **H0. `users/poc/config` 中有一行游离的 DeepSeek API key（`sk-939b` 开头）**（本地文件、未入 git、权限 600）
  - `provision-user.sh:40` / `k8s/provision-user-k8s.sh:37` 用 `set -a; . "${DIR}/config"` 方式 source 该文件，游离行会被当作 shell 命令执行：脚本因 `set -e` 崩溃（exit 127），且密钥回显进 stderr/日志。
  - 处理：**立即轮换该 DeepSeek key 与同文件中的 WeCom secret**；删除游离行；脚本改为逐行解析 `KEY=VALUE` 而非 source（同时消除任意命令执行面）。

### Go 后端 ✅已复核

- [ ] **H1. 管理员登录无限流、无锁定、无请求体上限** — `console/backend/internal/api/auth.go:26-31`
  - 未认证端点直接 `json.NewDecoder(r.Body).Decode`，未走 `decodeJSONBody`，无 `http.MaxBytesReader`：超大 JSON 全量缓存进内存（未认证内存 DoS）。
  - 无尝试次数限制（绑定码路径有 `bindingAttemptLimiter`，登录没有），唯一管理员密码仅靠 bcrypt 成本抵御暴力破解。

- [ ] **H2. 回滚/恢复路径复用客户端（可能已取消的）请求 context**
  - `internal/api/pod_upgrade.go:47-59, 132-146` — 管理员升级中断开连接：`Create`/`waitForPodHealth` 中止，**且** `restorePodRuntime` 回滚也带着已取消的 context 执行失败，pod 留在 `error`/被删状态。
  - `internal/api/service_token.go:46-80, 108-119` — 同样问题：`drv.Stop` 之后断连，`rollbackToken` 失败，pod 停机且 token 状态不一致。
  - `internal/api/pods.go:288-296` — 删除流程标记 `deleting` 后 `drv.Remove(r.Context())` 被取消，DB 永久停在 `deleting`。
  - 处理：补偿/清理逻辑统一改用 `context.WithoutCancel(r.Context())`（或 `context.Background()` + 超时）。

- [ ] **H3. 绑定激活：校验用 trim 后的副本，落库用原始值 → 合法码可被打废** — `internal/api/internal_bindings.go:77-87`
  - `validBindingContext` 在值传递的局部副本上 trim `Channel`/`AccountID`/`ExternalIDType`，调用方（:56-61）却把未 trim 的原值传入 `repo.BindingActivation`。
  - `repo/binding_codes.go:291-314` `bindingScopeMatches` 是精确比较：`" wecom"` 过校验但 scope 匹配失败 → `persistBindingFailure`；5 次即可把合法待激活码永久 revoke（针对激活流程的 DoS）。

### 工具 / Hook 脚本 ✅已复核

- [ ] **H4. 被信号杀死的 skill 子进程被报告为成功** — `tools/muad-run-skill/src/runner.mjs:92`
  - `child.on("close", (code) => resolve({ code: code ?? 0 }))`：进程死于信号（OOM-kill、外部 `kill -9`）时 `code` 为 `null`，被强转为 0 → 运行结果 `ok: true`/"completed"（错误的成功语义，影响遥测与用户可见结果）。

- [ ] **H5. Stop hook 存在 shell 命令注入（经由编辑过的文件名）** — `.code-flow/scripts/cf_stop_hook.py:189-198`
  - `command.replace("{files}", " ".join(matched))` 后 `subprocess.run(command, shell=True)`；`matched` 来自会话编辑事件的 `tool_input.file_path`。文件名形如 `` x`$(cmd)`.py `` 或 `a;cmd.py` 即注入——Edit 能力经 Stop hook 升级为 shell 执行。
  - 处理：`shlex.quote` 每个路径，或改为 list 形式执行。

- [ ] **H6. 规范门禁在活动任务状态损坏时 fail-open** — `.code-flow/scripts/cf_pre_tool_hook.py:58-61`（+ `cf_spec_router.py:36-43, 56`）
  - `ContextError`/`SpecResolutionError` 是 `ValueError` 子类，落入只记日志的 `except (json.JSONDecodeError, OSError, ValueError)` 分支 → Edit/Write 被放行而非 deny。与项目契约"corrupt marker 必须 `SPEC_WORKFLOW_BLOCKED`"矛盾——恰好在状态损坏、最需要拦截时静默失效。router 内 `_task_file` 读取错误与 `project_task_session` 的 `ValueError` 同样在 `try` 之外抛出，同路径泄漏。

- [ ] **H7. zip 包未在解压前筛查 symlink（zip-slip）** — `bin/private-skill-installer.mjs:75-79`（对比 :64-73）
  - tar 路径解压前拒绝 link 条目（`type === "l" || "h"`），zip 路径的 `validateZipBundle` 仅经 `unzip -Z1` 检查文件名。zip 内 symlink 条目 + 穿过它的文件路径可使 `unzip` 写出 `extractRoot` 之外；`assertNoLinks`（:32）在解压后才执行，已太迟。

### 基础设施 ✅已复核

- [ ] **H8. docker.sock 挂进 `0.0.0.0:18080` 明文 HTTP 的控制台** — `console/docker-compose.yml:23, 28`
  - 管理密码/JWT 明文 HTTP 传输 + 控制台持有 docker.sock（等价宿主 root）：任何认证绕过或 RCE = 主机沦陷。已记为 RISK-03，但与全接口暴露叠加后风险放大。
  - 处理：至少改 `"127.0.0.1:18080:8080"` 或前置 TLS 反代；docker.sock 走 socket-proxy（如 tecnativa/docker-socket-proxy）限制端点；k8s 部署优先。

- [ ] **H9. 密钥经 sed 未转义替换进 YAML 后 `kubectl apply`** — `k8s/provision-user-k8s.sh:42-51`
  - `WECOM_SECRET`、`LLM_API_KEY`、`LLM_BASE_URL` 等值未转义 `|`/`&`/`\`/换行：合法值含 `&` 即破坏渲染（sed 反向引用）；恶意多行值可注入任意额外 K8s 资源并被 apply。
  - 处理：Secret 改用 `kubectl create secret generic --from-literal=...`，不经模板渲染。

- [ ] **H10. 无任何 NetworkPolicy；Docker 路径所有租户与控制台同网** — `k8s/` 全目录；`console/docker-compose.yml:37-43`；`entrypoint.sh:25`（gateway bind lan）
  - 运行不可信代码的 worker 拥有无限制 egress 与 pod 间可达：其他租户 gateway（18789，仅 token 防护）、console API、kube API、云 metadata（169.254.169.254）。与 NFR-SEC-03"不可信沙箱"承诺不符。
  - 处理：default-deny NetworkPolicy / 每租户独立网络。

### 前端 ✅已复核

- [ ] **H11. 删除 Private Skill 无错误处理（破坏性操作无反馈）** — `console/frontend/src/components/human-users/HumanUserSkillsTab.tsx:124-128`
  - `Modal.confirm` 的 `onOk` 内 `await api.deletePrivateSkill(...)` 无 try/catch：失败时 unhandled rejection、用户零反馈、列表不刷新。同文件 `setPolicy`（:110-116）与 `Skills.tsx:97-110` `applyAllSkills` 是正确写法。

---

## 🟡 中危（约 47 项）

### Go 后端（M1-M11）

- [ ] **M1.** `internal/config/config.go:222-224` — `jwtSecret` 为空时静默回退 = `masterKey`：一把钥匙横跨两个密码学域（HMAC 会话签名 + AES-GCM 密钥派生），任一面泄漏/轮换影响另一面。应像 `binding_code.go` 一样做域分离派生。（同 `config.example.yaml:10-11` 的默认示例）
- [ ] **M2.** `internal/crypto/crypto.go:28-42` — AES key 仅对 masterKey 做单次无盐 SHA-256：低熵人选字符串可被离线爆破。至少 HKDF，低熵输入用密码 KDF。
- [ ] **M3.** `internal/api/skill_bundle.go:206-216, 109-166` — 解压无解压后大小/条目数上限：5 MB gzip 炸弹可膨胀数 GB 写满 console 主机/共享 skills 卷；海量小文件可耗尽 inode。用 `io.LimitReader` + 条目数上限。
- [ ] **M4.** `internal/api/auth.go:18` + `internal/auth/auth.go:37-64` — 12h 无状态 session 无吊销：登出/改密后旧 token 仍有效至到期。控制面值得上 token 版本号或黑名单。
- [ ] **M5.** `internal/api/skills.go:227-269` — 公共 skill 删除先删磁盘再改 DB：`UpdateSkillAssetStatusAndMarkPods` 失败后文件已没、DB 行仍 `active`，无回滚。调换顺序或先暂存。
- [ ] **M6.** `internal/api/service_token.go:24-80` — token 轮换未走 `runPodExclusive`，Stop→Update→Start 可与 reconcile 协调器并发交错（双重重启、对半轮换状态做健康检查）。
- [ ] **M7.** `internal/api/llm.go:78-149` + `internal/llm/probe.go:18-53` — LLM 连通性测试用 `http.DefaultClient` 探测任意 `baseUrl`（SSRF：可达集群内部服务与云 metadata，状态码回显）。管理员认证后可用，仍建议拒绝私网段。
- [ ] **M8.** `tools/muad-progress/internal/progress/state.go:29-54, 77-89` — 节流状态文件无锁非原子（并发 CLI 丢更新/损坏后 :68-70 静默丢弃）；`entry.Count` 只增不减且跨执行持久 → 同 key 累计 100 事件（默认 `MUAD_PROGRESS_MAX_EVENTS`）后**永久**被节流。
- [ ] **M9.** `tools/muad-progress/internal/progress/cli.go:109-148` — `heartbeat` 的 `--interval-ms`/`--max-count` 解析后从未使用，只发一个事件，与帮助文本矛盾。
- [ ] **M10.** `internal/api/skill_bundle.go:308-321` — `muad.skill.json` 解析失败被静默忽略并降级为 `traditional-prompt`（managed skill 的 manifest 元数据全部丢弃）。应返回 400。
- [ ] **M11.** `cmd/console/main.go:138-145` — HTTP server 仅设 `ReadHeaderTimeout`，缺 Read/Write/Idle 超时（slowloris 慢滴请求体可长期占连接/goroutine）。

### 工具 / Hook 脚本（M12-M32）

- [ ] **M12.** Hook 超时矛盾 — `.claude/settings.local.json`（PostToolUse timeout: 5s）vs `cf_post_hook.py:96-110` done-gate 内 `command`/`test` 验证器各默认 30s 且无总预算：hook 常被中途杀死，反馈静默丢失，`save_context`（`cf_task_runtime.py:140`）可能写一半。Stop 侧 35s vs 30s 验证器 + 无上限 done-gate 同理。
- [ ] **M13.** `.code-flow/scripts/cf_checks.py:282-296` — 正则"超时"无法取消运行中的匹配：`future.cancel()` 对运行线程无效且 `with ThreadPoolExecutor` 退出会 join——一个灾难性回溯 pattern 卡住整个 hook，后续 check 全部排队"超时"。
- [ ] **M14.** `.code-flow/scripts/cf_inject_hook.py:7-26` — 死代码：引用 `cf_core.py` 已删除的 5 个函数（AST 验证），一旦被执行即 `ImportError`。`cf_session_hook.py`（写已删除的 `.inject-state`）同为遗留，应删除。
- [ ] **M15.** `.code-flow/scripts/cf_spec_context.py:1092` — `_decision_command` 恒返回第一个 binding 第一条 rule 的状态而非决策目标 rule；首 binding 无 rule 时 `IndexError` → `internal_error`。（盘上状态正确，仅 CLI 回复错。）
- [ ] **M16.** `tools/muad-runtime-guard/src/browser-lease.mjs:28-53` + `tools/runtime-concurrency/shared-lease-queue.mjs:64-79` — 浏览器槽位可永久泄漏：心跳每 2s 刷新槽文件直到 `release()`；若 `after_tool_call` 未触发或两侧 `browserCallKey` 计算不一致（`browser-hooks.mjs:32-38` 的 runId/sessionKey 单侧缺失），release 找不到目标，而 `sweepStale` 因心跳常新永远无法回收。另注意队列等待 30s 与 before-hook 35s 超时的紧耦合。
- [ ] **M17.** `tools/runtime-concurrency/shared-lease-queue.mjs:3` — 队列目录硬编码世界可写的 `/tmp/muad-runtime-queues/...`：他人先创建目录（0777、其属主）即可删/占槽文件，绕过并发限制或 DoS。单用户容器内无碍，共享主机不安全。
- [ ] **M18.** `tools/muad-run-skill/src/runner.mjs:87-88` — 子进程 stdout/stderr 无上限累积成字符串，话痨/恶意 skill 可耗尽 gateway 内存。
- [ ] **M19.** `tools/muad-run-skill/src/execution-context.mjs:34-46` — `buildSkillEnvironment` 把 gateway 全量 `process.env` 传给每个 skill 子进程：gateway 环境中的任何密钥泄漏给所有 skill 脚本。应改 allowlist。
- [ ] **M20.** `tools/muad-run-skill/src/manifest.mjs:79-81` — 递归扫描中对每个 `muad.skill.json` 裸 `JSON.parse`：公共 skills 根下任一坏 manifest 使**所有**递归查找抛 `skill_manifest_unavailable`（殃及无关 skill）。
- [ ] **M21.** `tools/muad-run-skill/src/tool-activation-gate.mjs:59-68, 86-99` — 按 agent 永久缓存包括失败结果：SKILL.md 瞬时读失败 → `tools: []` 被缓存整个生命周期 → 强制工具门禁静默关闭直到重启。
- [ ] **M22.** `tools/muad-run-skill/src/telemetry.mjs:183-194` — service token 首次读取成功后永久缓存（`tokenPromise` 不失效，401 也不清缓存）：K8s projected token 轮换后所有发送永久 401。
- [ ] **M23.** `bin/inject-channels.mjs:102` — `openclaw.json` 非原子写（同族脚本都用 temp+rename）：写一半崩溃或 gateway 并发热载读到截断配置。另 :151 循环变量遮蔽外层 `const p`。
- [ ] **M24.** `.code-flow/scripts/cf_spec_verify.py:163-192` — `command`/`test` 验证器直接执行 spec frontmatter 里的 argv（config 的 `cwd` 还可 `../` 逃出根）：能提交 spec 文件 = 能在所有跑 done-gate/stop hook 的机器上执行命令。属设计决策，但无 allowlist 或确认门。
- [ ] **M25.** `.code-flow/scripts/cf_core.py:40-41` — `estimate_tokens = len(text) // 4` 按 ASCII 校准；spec 以中文为主（1 字 ≈ 1+ token），低估 4-6 倍 → 基于它的所有注入预算（catalog_max、l1 预算、cf-stats 利用率）全线超支。
- [ ] **M26.** `.code-flow/scripts/cf_core.py:153-156, 93-95` — 用 `id()` 做缓存 key（`_ext_set_cache[id(code_exts)]` 等）：对象被 GC 后 id 可复用 → 另一对象命中脏数据。短命 hook 无碍，长驻进程错误。
- [ ] **M27.** `.code-flow/scripts/cf_core.py:15-37` — `load_config` 任何错误（缺 pyyaml、YAML 语法错）都返回 `{}`：一个配置手误静默关停整个 spec workflow（router 返回 "none"）。至少 stderr 告警区分"无配置"。
- [ ] **M28.** `bin/private-skill-installer.mjs:54-62` — 5 MiB 限制只作用于压缩包：解压炸弹可先在 `tempRoot` 膨胀数 GB（磁盘耗尽）再被验证。
- [ ] **M29.** `bin/runtime-config-schema.mjs:250-255` + `tools/muad-run-skill/src/skill-policy.mjs:70-79` — 校验不一致 + 静默丢授权：`assertRelativeSkillPath` 漏掉尾部 `"scripts/.."`（只查 `"/../"`），该条目过 schema 后 `normalizeScriptFiles` 返回 `null` → **整个 grant 被丢弃**（skill 对该 agent 静默不可用，无日志）。
- [ ] **M30.** `tools/muad-runtime-guard/src/tool-policies.mjs:103-110, 117-121` — 文件策略只做词法路径判断（无 realpath）：workspace 内指向外部的 symlink 可通过。业务 agent 自身建不了 symlink（shell 被拒），但经 `muad_run_skill` 跑的 skill 脚本可以，之后 agent `read` 即越界。
- [ ] **M31.** `.code-flow/scripts/cf_stop_hook.py:257` — done-gate 只捕 `(OSError, ValueError)`：其他异常（如坏 context 数据的 `KeyError`/`TypeError`）落到 :285 的外层通用 handler → 静默 return → 整个 stop 门禁 fail-open。
- [ ] **M32.** `tools/muad-run-skill/src/runner.mjs:66-77` — 250ms drain 定时器不等待上一次 drain：两次重叠的 `drainBestEffort` 从同一 `state.offset` 读 → 重复投递进度事件到会话，再竞态写新 offset。

### 基础设施（M33-M42）

- [ ] **M33.** `console/backend/config.yaml:7` — 弱管理密码 `k8stest` + 真实 masterKey 在盘；`k8s/DEMO.md:22-23` 将该文件原样载入集群 Secret。任何非本地使用前必须轮换 masterKey 并设强密码。
- [ ] **M34.** `k8s/console.yaml:79-98` — 控制台 pod 以 root 运行、无 securityContext、无 resources、无 livenessProbe（卡死不重启）、`image: :latest` 可变 tag。k8s 模式不用 docker.sock，本可非 root。
- [ ] **M35.** `console/Dockerfile:9-10` — 前端构建忽略 lockfile：只 COPY `package.json` 且 `npm install`（`package-lock.json` 存在却不用）。应 `COPY package.json package-lock.json ./` + `npm ci`（供应链 + 可复现性）。
- [ ] **M36.** `k8s/user.template.yaml:35` — 不可信 worker 沙箱硬化不全：缺 `allowPrivilegeEscalation: false`、`capabilities: {drop: [ALL]}`、`seccompProfile: RuntimeDefault`、`automountServiceAccountToken: false`（不可信 agent 现在拿得到 kube API token）。`compose.template.yml:21-23` 同理：只有 mem/cpu，缺 `pids_limit`（fork 炸弹）、`security_opt: [no-new-privileges:true]`、`cap_drop: [ALL]`。
- [ ] **M37.** 密钥以 env 注入不可信 worker — `compose.template.yml:9`（env_file）与 `k8s/user.template.yaml:44-45`（envFrom secretRef）：`WECOM_SECRET`/`LLM_API_KEY`/`OPENCLAW_GATEWAY_TOKEN` 进程环境被 agent 的所有子进程继承，`/proc/*/environ`、`docker inspect` 可读；`inject-env.mjs` 反正会写进 `openclaw.json`。优先文件挂载、启动读取后清除。
- [ ] **M38.** `k8s/reaper.sh:44-45` — annotation 值未验证直接进 bash 算术：`last_active` 形如 `x[$(malicious)]` 即在 reaper（持有 statefulset scale RBAC）内执行命令；TODO-A 计划让 worker（不可信）写该 annotation 后将实际可利用。非数字值还会因 `set -e` 崩掉脚本、静默跳过剩余用户。先 `[[ "$last_active" =~ ^[0-9]+$ ]]`。
- [ ] **M39.** `k8s/reaper-cronjob.yaml:40, 43` — `MUAD_NS: "default"` 而全栈部署在 `muad`；SA/Role/RoleBinding 未带 namespace——按现状 reaper 看错命名空间。`bitnami/kubectl:latest` 为已停更目录的可变 tag。job 容器无 resources/securityContext。
- [ ] **M40.** 资源类型漂移：console k8s driver 创建 **Deployment**（`k8s/console.yaml`、DEMO.md），而 `provision-user-k8s.sh` 创建 **StatefulSet**、`reaper.sh:38` 只扫 `statefulset -l app=muad-openclaw` → **console 创建的 worker 永远不被回收**，`--delete` 也删不掉它们。两条生命周期路径必有一条静默失效。
- [ ] **M41.** worker 容器全线无健康检查：根 `Dockerfile` 无 HEALTHCHECK、`compose.template.yml` 未定义、`k8s/user.template.yaml` 无 liveness/readiness（18789 可探测）。gateway 卡死后永远"running"，`restart: unless-stopped` 永不触发。
- [ ] **M42.** `provision-user.sh:40` / `provision-user-k8s.sh:37` — config 以 shell source 方式执行（任意命令执行面，H0 的根因）。改逐行解析 KEY=VALUE。

### 前端（M43-M47）

- [ ] **M43.** 轮询每 tick 置 `loading=true` → 表格 spinner 常闪：`pages/containers/usePodList.ts:19-21,43`（5s）、`components/human-users/HumanUsersPanel.tsx:48-51,72`（10s）、`pages/Users.tsx:121-124,145`（10s）。`pages/audit/useSkillExecutionRecords.ts:89-108` 已有正确的 `background` 标志模式，照抄即可。
- [ ] **M44.** 11 个表格 `columns={... as never}` 完全绕过列类型检查（render 签名、dataIndex 手误都能编译）：`PodTable.tsx:27`、`Users.tsx:292`、`Skills.tsx:441`、`HumanUserList.tsx:115`、`IdentityManager.tsx:32`、`BindingCodeManager.tsx:39`、`PlatformCredentialManager.tsx:27`、`HumanUserSkillsTab.tsx:56`、`PlatformSettings.tsx:58`、`SkillExecutionTable.tsx:17`、`OperationAuditTab.tsx:89`。应 `ColumnProps<T>[]`。
- [ ] **M45.** 相同校验错误重复提交无任何反馈：`FeedbackBanner`（`components/ConsolePage.tsx:67-85`）只在 error 字符串**变化**时发 Toast；`if (validation) return setError(validation)` 不先清空 → 第二次同错提交状态不变、无 Toast，点击像死了。涉及 `CreateHumanUserDialog.tsx:131-133`、`IdentityManager.tsx:174-175`、`BindingCodeManager.tsx:189`、`PlatformEditorDialog.tsx:72-74`、`CreatePodDialog.tsx:31-32`。
- [ ] **M46.** `pages/Users.tsx:177` — pod 查询硬编码 `pageSize: 100`：>100 pod 时用户表 pod 名解析静默缺失、创建用户对话框选不到 100 之后的 pod，无翻页无警告。
- [ ] **M47.** `src/api.ts:69-75` + `index.html` — token 存 `localStorage`（XSS 可窃取、非 HttpOnly），全站无 CSP，后端也无安全响应头。今日无 XSS sink，属纵深防御缺口（管理控制台值得补）。

---

## 🟢 低危（约 78 项，按域压缩记录）

### Go 后端

- [ ] `internal/api/auth.go:30-34` — 未知用户跳过 bcrypt 比较：响应时间可枚举用户名。miss 时对 dummy hash 比较。
- [ ] `internal/api/server.go:159-196` — 客户端可控 `X-Request-ID` 未消毒进 `log.Printf`（换行伪造日志行）且原样回写响应头。
- [ ] `internal/collector/collector.go:64-78` — `List`/`baseSnapshots` 失败静默 return 无日志（监控悄悄变陈旧；违反"禁止静默吞异常"）。
- [ ] `internal/api/skill_bundle.go:235-257` — `findSingleSkillDir` 多个 SKILL.md 时取最浅者，"must contain exactly one SKILL.md" 错误永不触发。
- [ ] `skill_bundle.go:99-107` — tar 失败后在残留脏目录上继续尝试 zip（O_EXCL 冲突产生误导错误），原始 tar 错误被丢弃。
- [ ] `skill_bundle.go:481-502` — 公共 skill 替换 `RemoveAll` → `Rename` 非原子：窗口期内运行中 pod 看不到 skill 目录；rename 失败则彻底删没。
- [ ] `internal/api/skills.go:182-212` — 公共上传先落盘后写 DB，DB 失败留孤儿目录；私有 skill 补偿（:330, :343）忽略自身错误。
- [ ] `internal/repo/pods.go:346-350`、`human_users.go:388-391`、`skills.go:687-719` — 搜索 `q` 中 `%`/`_` 未转义改变 LIKE 语义（非注入，已参数化）。
- [ ] `internal/driver/docker.go:151-173` — `--filter name=muad-oc-` 是子串过滤且 `TrimPrefix` 不验前缀：外部容器 `x-muad-oc-y` 产出伪 PodID（`StatsAll` :289 有 `HasPrefix` 防护，`List` 没有）。
- [ ] `internal/repo/repo.go:40` — SQLite DSN 用 Sprintf 拼接：路径含 `?`/`#` 破坏 DSN 解析。
- [ ] `internal/api/pods.go:320-329` — `(page-1)*pageSize` 大值溢出为负 OFFSET；`skill_executions.go:195-207` `pageSize` 带空白时校验用 trim 值、应用未 trim 解析值 → 返回默认 20。
- [ ] `internal/audit/audit.go:137-144` — `RedactDiagnostic` 按 512 字节截断可切碎多字节 UTF-8（中文错误信息常见）。
- [ ] `internal/driver/public_skills_sync.go:394-406` — deferred pod 删除用同一（可能已取消）ctx：`muad-skills-sync-*` pod 对象永久残留。
- [ ] `internal/runtimeapply/coordinator.go:93-102` — `locks` map 每 pod 一 channel 永不清理（含已删 pod；实际有界）。
- [ ] `internal/api/routes.go:87-89` — `handleNotImplemented` 死代码，从未注册。
- [ ] `internal/api/server.go:137-157`、`audit.go:51-59` — response recorder 未转发 `Flusher`/`Hijacker`（今日无害，加 SSE/websocket 即踩坑）。
- [ ] `internal/api/internal_bindings.go:89-93` — 限流 key 含 pod 自报的 `externalId`（被攻陷 pod 可轮换绕过）；猜错码不增 `failed_attempts`（仅 scope 不匹配才增，`repo/binding_codes.go:160-168`）。
- [ ] `internal/api/pod_channels.go:67-76` — 空输入 = 保留现值：没有 API 途径清除已配置的 `secret`/`botId`（只能删整个 channel）。
- [ ] `tools/muad-progress/internal/progress/delivery.go:36` — adapter 命令用 `strings.Fields` 切分，不支持引号：路径含空格无法配置。
- [ ] `tools/muad-progress/internal/skillcheck/check.go:125-129, 174-198` — 敏感文本命中总是报 SKILL.md 路径（即使问题行在别的文件）；`readSkillContent` 无大小上限全量拼接进内存。
- [ ] `internal/config/config.go:505-512` — `envIntOr` 静默忽略非法 `CONSOLE_COLLECT_INTERVAL`（其他 int env 走 `envIntOverride` 会报错）。

### 工具 / Hook 脚本

- [ ] `tools/muad-run-skill/src/index.mjs:233-235` + `hook-lifecycle.mjs` — 重复注册覆盖全局队列/遥测引用（仅健康端点读取，磁盘队列仍共享）。
- [ ] `hook-lifecycle.mjs:31, 265-275` — `warnedFallbackKeys` 随 gateway 生命周期无界增长。
- [ ] `hook-lifecycle.mjs:145-153, 408-411` — `captureAgentEventTool` 只存 `runId`，`capturedContextMatches` 恒通过：跨 agent 的 toolCallId 冲突可挂错 runId。
- [ ] `index.mjs:121` — `finally` 中 `if (release) await release()` 抛错会掩盖原始错误/结果。
- [ ] `traditional-runner.mjs:38-41` + `index.mjs:175` — 依赖 `...rest` 展开顺序覆盖 `args: { argv }` 才正常工作，调序即静默坏。
- [ ] `tool-params.mjs:33-36` — 接受单段 `script_path`（`foo.sh`）但 `safeRelativePath` 随后拒绝；`ParamsSchema` 与 `readToolParams` 对 array args 的约束不一致。
- [ ] `delivery.mjs:5-10` — `channel-outbound` 动态 import 失败被永久缓存为 rejected promise，出站投递不重启不恢复。
- [ ] `telemetry.mjs:88-93, 204-209` — `closed` 在 `flush()` 后才置位（晚到入队可静默丢）；`markWriteFailure` 把 drain 级错误也计入 `dropped`（计数高报）。
- [ ] `shared-lease-queue.mjs:190-193, 172-188` — `readOwner` 的 `JSON.parse` 错误逃出仅捕 ENOENT 的 catch：坏槽文件导致心跳报错刷屏、`release()` 可抛。
- [ ] `shared-lease-queue.mjs:110-121, 50-62, 131-142` — 无 FIFO（新来者先抢活动槽，等待者可饿到 `waitTimeoutMs`）；sweep 的 stat-then-unlink TOCTOU 可删掉刚心跳过的 lease。
- [ ] `tools/muad-runtime-guard/src/binding-context.mjs:121-128` vs `delivery.mjs:53` — `isDirectSession` 只比一个 `:` 段而 delivery 取 `parts.slice(4).join(":")`：sender id 含 `:` 者永远绑不上。
- [ ] `bind-command.mjs:15-19` — `onRejected` 只对 `BindingContextError` 触发：限流/无效码等客户端失败插件侧无日志。
- [ ] `binding-client.mjs:59-60` — `response.text()` 先全量缓冲再检查 64 KiB 上限（护不住内存）。
- [ ] `model-config-reply.mjs:50-66, 80-84` — 模型状态注册时快照一次（配置热载后陈旧）；`parseAgentIdFromSessionKey` 期待 `session:agent:...` 与他模块的 `agent:...` 不一致；解析不出 agent 时 fail-open。
- [ ] `tools/session-manager/openclaw-plugin.mjs:23-28, 32-37` — `baseURL` 可解析为 `""` 无校验，健康全局却报 `loaded: true`。
- [ ] `bin/seed-config.mjs:11-21`、`bin/inject-channels.mjs:76, 95` — `deepMerge`/直接赋值放行 `__proto__` key（原型污染；输入受信，故低危）。
- [ ] `bin/inject-channels.mjs:139, 151-170` — 按 `sessions.json` 的 `sessionFile` 删除任意绝对路径（受信文件，但无 containment 检查）。
- [ ] `bin/runtime-config-transaction.mjs:40-46`、`bin/runtime-image-self-check.mjs:71-84` — `spawnSync`/`execFileSync` 无超时：openclaw CLI 挂起则事务/自检永久挂起。
- [ ] `bin/inject-env.mjs:91-94`、`inject-multi-user-config.mjs:30-33` — `readFileSync(0)` 在静默管道下无限阻塞。
- [ ] `bin/openclaw-config-renderer.mjs:127-137, 84-92` — 业务 agent 空 `allow` 被隐式改成 `allow: ["read"]`（deny-list 语义悄悄翻成 allow-list）；`replaceManagedBlock` 在 END 先于 START 时留下坏块并追加第二块。
- [ ] `bin/private-skill-installer.mjs:139-158` — `rm target` → `rename staging` 非原子（崩溃丢 skill；固定 staging 名并发互踩）；`findSingleSkillDir` 多 SKILL.md 时静默取最浅（违背"single"契约）。
- [ ] `.code-flow/scripts/cf_user_prompt_hook.py:71` + `cf_spec_router.py:119-120` — `int(state.get("prompt_count"))` 对未校验值抛 `TypeError`（不在捕获元组内）→ 未处理 traceback。
- [ ] `.code-flow/scripts/cf_checks.py:61-71` / `cf_post_hook.py:171-197` — check state 非原子写 + 两轮独立读改写：并发 hook 丢更新。
- [ ] `.code-flow/scripts/cf_spec_session.py:87-93` — 末尾 `text[:max_chars]` 可把截断提示后的 Acceptance Contract 再切一刀。
- [ ] `.code-flow/scripts/cf_spec_migrate.py:24, 320-343` — `PACKAGE_ROOT = parents[4]` 仅源码布局正确（部署副本下 stage 读错路径）；plan 中绝对路径可逃出 staging 目录。
- [ ] `.code-flow/scripts/cf_spec_gate.py:148` — checklist 覆盖用子串匹配：`RULE-x-001` 会匹配进 `RULE-x-0010`。
- [ ] `.code-flow/scripts/cf_spec_context.py:181-200, 469-486` — `_atomic_text` fsync 文件不 fsync 目录（rename 持久性）；`doctor_active_task` 不加锁改 marker，与并发 `start` 竞态。
- [ ] `tools/muad-run-skill/src/progress-format.mjs` / `runner.mjs:110-129` — skill 自报进度 `text` 在出站会话路径无长度上限（遥测截 256，投递不截）。

### 基础设施

- [ ] `Dockerfile:59` — `openclaw setup ... || true` 掩盖所有 setup 失败（仅验证 openclaw.json 存在，半坏 setup 能过）。
- [ ] `Dockerfile:5,17,29`、`console/docker-compose.yml:15`、`k8s/console.yaml:83` — 基础镜像用可变 tag 未 pin digest。
- [ ] `Dockerfile:96-98` — `/opt/muad/*` 插件与 `/opt/openclaw-skills` chown 给运行用户：被攻陷的 agent 代码可改写自身插件/skill（未设 readOnlyRootFilesystem）。
- [ ] `entrypoint.sh:12-16` — 种子拷贝非原子：首启动中途死掉留下含 openclaw.json 的半成品目录，永久跳过重播种。临时目录 + rename 或最后写哨兵。
- [ ] `provision-user.sh:48-50` — `${IMAGE}`、`$(pwd)` 未转义进 `|` 分隔的 sed（管理员可控输入，故低危）。
- [ ] `k8s/user.template.yaml:27` — `serviceName: muad-oc-__USER__` 引用从未创建的 headless Service：StatefulSet pod DNS 不解析（docker 路径有容器名 DNS，k8s 路径无等价物）。
- [ ] `k8s/public-skills-local-rwx.yaml:29-31` — hostPath PV 标注仅测试，但无机制阻止误用于生产（hostPath + console 可写 RWX = 节点级写入面）。
- [ ] `console/backend/config.yaml:14` — `consoleInternalURL: http://host.internal:8080` 为 OrbStack 专属 DNS（标准 Docker 是 `host.docker.internal`），且 worker→console 内部 API 走明文 HTTP。
- [ ] `.code-flow/validation.yml:4,22,28` — hook 用裸 `npx tsc/eslint/prettier`（本地未装会从 registry 拉取执行；应 `npx --no-install`）；`**/*.go` 每次编辑触发全量 `go test ./...`（60s 超时）。
- [ ] `compose.template.yml:26` — 状态卷无大小上限：不可信 agent 可写满宿主盘（k8s 路径有 2Gi PVC 兜底）。

### 前端

- [ ] `src/main.tsx:14-23` — 全局 monkey-patch `console.error/warn`：任何参数字符串化含 "findDOMNode" 的日志被吞（包括无关 Error 的堆栈）。标注临时，范围过宽。
- [ ] `src/channels.ts:55-57` — 未知 channel id 回退 `CHANNELS[0]`（企业微信）：错误的标签/图标出现在 `ChannelTags.tsx`、`IdentityManager.tsx:104`、`BindingCodeManager.tsx:117`、`CreateHumanUserDialog.tsx:327`。应中性占位。
- [ ] `components/human-users/BindingCodeManager.tsx:142-151` — revoke（破坏性）点击即执行、无确认弹窗，与全站其他破坏性操作不一致。
- [ ] `components/BatchToolbar.tsx:27-44` — `Promise.allSettled` 外的 try/catch 是死代码；部分失败只报数量不报哪些 pod；`onBatchDelete(selectedIds)` 连失败 id 一起传（父组件目前只清选择，暂无害）。
- [ ] `pages/containers/createPodModel.ts:58-62` — 空 `memLimit`/`cpuLimit`/`restartPolicy` 发送 `""`、并发发 `0`，而 `imageTag` 正确用 `|| undefined`（后端当前把空当"继承"，语义脆弱）。
- [ ] `components/platforms/PlatformEditorDialog.tsx:65-69` — 重置 effect 依赖每次渲染都是新引用的 `props.available`（`PlatformSettings.tsx:32-34`）：父组件一旦加轮询即"输入中被重置"。
- [ ] `pages/pod-detail/PodActionDialogs.tsx:119-150` — 日志弹窗无 loading 且打开时不清空旧 `logs`（先显示上一个 pod 的日志）；同文件 :64-66 `UpgradeDialog` 空 tag 点确定静默无操作（批量版 `PodUpgradeDialog.tsx:44` 是禁用按钮，不一致）。
- [ ] `pages/Skills.tsx:69-73` — `refreshAfterUpload` 先 `setPage(1)` 再 `refresh()`（闭包捕获旧页）：先拉旧页再被 effect 拉第 1 页（瞬时错页 + 双请求；race guard 防住了数据损坏）。
- [ ] `components/platforms/PlatformSettings.tsx:118-119`、`pages/LLM.tsx:93-96` — 客户端分页在过滤集缩小时不收敛 `page`（删掉末页最后一行留下空页，范围文本如"显示第 11 条-第 10 条"）。
- [ ] `pages/LLM.tsx:279-287` — 行选择 key 跨全部模型而 `dataSource` 只是当前页切片：跨页选择是否被 Semi Table 保留未验证，需手测。
- [ ] `components/human-users/CreateHumanUserDialog.tsx:57-62, 78` — `externalId` 用 `=== ""` 校验（纯空白能过、发送未 trim）；`expiresInMinutes` 的范围判断不捕 `NaN`（InputNumber 清空时）。
- [ ] `components/ChannelForm.tsx:64-67` — 编辑模式 `secretConfigured` 让**所有**字段（含 botId）跳过必填校验：botId 可清空提交。
- [ ] `components/human-users/BasicUserForm.tsx:57-69` — 无校验：空 `displayName` 直达 API。
- [ ] `pages/Audit.tsx:15-19, 50-55` — `?tab=` 经 `replaceState` 写入后跳其他页面仍残留 URL（全站其余用 localStorage 而非 URL 路由）；popstate 监听基本无效（无人 push history）。
- [ ] `src/api.ts:116-121` — 2xx 但 `code !== 0` 时 `unwrapResponse` 丢弃服务端 message（回"服务端响应格式无效"；当前后端错误恒非 2xx，防御性问题）。另全站请求无超时/`AbortController`。
- [ ] 可访问性合集：`shared.tsx:39-46`、`ChannelForm.tsx:172-185` label 无 `htmlFor`；状态 `Select` 缺 aria-label（`HumanUserList.tsx:92-97`、`Users.tsx:265-270`、`ContainersToolbar.tsx:57-62`、`Skills.tsx:356-373`）；`RowActions.tsx:56-64` "更多▾" 无 `aria-label`/`aria-haspopup`；`SkillExecutionTable.tsx:151-158`、`PodTable.tsx:159` Tooltip-on-span 键盘不可达。
- [ ] `pages/audit/OperationAuditTab.tsx:120-141` — 仅"目标 ID"输入框支持回车提交，actor/action 缺 `onEnterPress`。
- [ ] `pages/llm/LLMCreateDialog.tsx:97-105` — API key 明文 textarea 输入（批量录入可接受，屏幕共享时可见）。

---

## ✅ 复核确认的正面结论

- 全部 SQL 参数化，无一处拼接；唯一约束与 pod 代际事务处理一致。
- tar 解压路径防护完整：拒绝绝对路径、`..`、symlink、hardlink（后端与 installer 的 tar 路径都验证过；installer 还带 `--no-same-owner --no-same-permissions`）。
- pod 内部认证：token fingerprint 索引 + `ConstantTimeEqual`；审计/日志脱敏正确；凭据经 env-file（非 argv）传给 docker。
- 前端：无 XSS sink（无 `dangerouslySetInnerHTML`/`innerHTML`/`eval`）、无内存泄漏（5 个 interval、3 个 listener 全部正确清理）、`useMountedRef` + 递增请求 ID 一致地防住陈旧响应竞态；无 `any`/`@ts-ignore`。
- `console/backend/config.yaml`（真实密钥）确认已 gitignore、未被 git 追踪，且 200 个历史版本中无泄漏（历史版本仅含占位符）；`users/poc/config` 同样未入 git。
- 项目规约合规：无裸 `exec.Command`、handler 无直接 `json.NewEncoder`（仅 helper 内部）、页面无裸 `fetch`。
- `binding_code_spec.json` 缺失系误报：`Dockerfile:85` 构建期拷贝，dev fallback 路径覆盖仓库布局。

---

## 建议处理顺序

1. **立即**：H0（轮换 `users/poc/config` 两个密钥 + 删游离行）；H8 第一步（`console/docker-compose.yml` 端口改绑 `127.0.0.1`）。
2. **短期（一周内）**：H1-H7 + H11（登录限流 + body cap、`WithoutCancel`、trim 统一、`code ?? 0`、Stop hook 注入、pre-tool fail-open、zip symlink 预筛、前端删除错误处理）+ M12（hook 超时矛盾——它在静默废掉整个质量闭环）。
3. **上线前**：H9/H10（sed→`--from-literal`、NetworkPolicy/租户隔离）、M33-M42（沙箱硬化、reaper 命名空间与资源类型漂移、健康检查）、M1/M2（密钥派生域分离）。
4. **随迭代消化**：其余中危按域批量处理（前端 M43-M45 是同一模式的三处套用，一次改完），低危列入日常清理。
