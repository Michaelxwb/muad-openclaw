# muad 管理控制台

`muad-console` 是多用户 OpenClaw 平台的控制面。后端为 Go 单二进制，生产构建内嵌 React + Semi Design 前端；通过统一 `RuntimeDriver` 管理 Docker 或 Kubernetes 中的 Worker Pod。

相关设计：

- [多用户单 Pod](../docs/multi-user-single-pod.md)
- [100 用户 Kubernetes 架构](../docs/k8s-architecture-100users.md)
- [Skill 执行审计](../.code-flow/tasks/archived/2026-07-14/skill-execution-audit/)

## 功能

- **Pod 生命周期**：创建、启停、重启、删除、镜像升级、日志、资源、通道和配置 generation 调和。
- **Human User**：每个 Pod 最多 10 个用户；用户拥有独立 Agent、工作区、浏览器 Profile、模型配置和 IM 身份。
- **身份绑定**：支持已知 External ID 预绑定，以及 main Agent 中使用一次性绑定码自动绑定新 IM。
- **模型池**：批量导入 OpenAI 兼容模型配置并测试连通性；创建用户时绑定一个未占用模型。
- **Skill 管理**：Public/Private 上传、启禁用、删除、用户策略、冲突解析和最终生效视图。
- **平台凭证**：维护业务平台及每用户 API Key，数据库只保存加密值并对外返回指纹。
- **监控告警**：Pod 状态、通道、generation、Runtime Guard、资源和遥测 outbox 健康。
- **双审计**：管理员操作进入“操作审计”，Agent Skill 生命周期进入“Skill 执行日志”。

## 架构

```text
console/
├── backend/
│   ├── cmd/console          配置、数据库、Driver、Collector、HTTP 装配
│   ├── internal/api         管理 API、internal API、鉴权和响应封装
│   ├── internal/repo        SQLite schema、状态机与查询
│   ├── internal/driver      Docker/Kubernetes RuntimeDriver
│   ├── internal/runtimeconfig  确定性多用户 Runtime DTO
│   ├── internal/runtimeapply   配置应用、健康检查和回滚
│   ├── internal/collector   有界并发状态采集
│   └── internal/web         dev 文件系统 / prod go:embed
└── frontend/
    ├── src/pages            Pod、用户、Skill、模型、资源平台、审计
    ├── src/components       通用页面、表格、分页和弹窗
    └── src/api.ts           统一 API 客户端
```

核心数据关系：

```text
Pod 1 ── N Human User
Human User 1 ── 1 LLM Model Config（模型配置不可被其他用户复用）
Human User 1 ── N IM Identity
Human User 1 ── N Platform Credential
Human User 1 ── N Private Skill / Skill Policy
Pod ── Runtime generation / service token / state volume
```

## 配置

配置优先级为 `环境变量 > config.yaml > 内置默认值`。`config.yaml` 包含机密并已被 gitignore，生产部署应只读挂载，不得打进镜像。

| YAML 字段 | env | 默认值 | 说明 |
|-----------|-----|--------|------|
| `security.masterKey` | `CONSOLE_MASTER_KEY` | 无 | AES-GCM 主密钥，必填 |
| `security.jwtSecret` | `CONSOLE_JWT_SECRET` | 复用 masterKey | JWT 签名密钥 |
| `admin.user` | `CONSOLE_ADMIN_USER` | `admin` | 首次管理员 |
| `admin.password` | `CONSOLE_ADMIN_PASSWORD` | 无 | 首次管理员密码 |
| `server.listenAddr` | `CONSOLE_LISTEN` | `:8080` | HTTP 监听地址 |
| `server.logDir` | `CONSOLE_LOG_DIR` | 空 | 配置后双写 `<dir>/YYYY-MM-DD/console.log` |
| `server.dbPath` | `CONSOLE_DB` | `/var/lib/muad-console/console.db` | SQLite 文件 |
| `server.collectIntervalSec` | `CONSOLE_COLLECT_INTERVAL` | `30` | 采集周期，秒 |
| `server.consoleInternalURL` | `CONSOLE_INTERNAL_URL` | `http://muad-console:8080` | Worker 上报和 Resolver 地址 |
| `runtime.driver` | `RUNTIME_DRIVER` | `docker` | `docker` 或 `k8s` |
| `runtime.defaultImage` | `DEFAULT_IMAGE` | GHCR latest | Worker 默认镜像 |
| `runtime.skillsDir` | `CONSOLE_SKILLS_DIR` | `/var/lib/muad-console/skills` | Public Skill 原始资产目录 |
| `runtime.timezone` | `CONSOLE_RUNTIME_TIMEZONE` | `Asia/Shanghai` | Worker 时区 |
| `runtime.stateDir` | `CONSOLE_RUNTIME_STATE_DIR` | `/home/node/.openclaw` | Worker 状态挂载点 |
| `runtime.publicSkillsDir` | `CONSOLE_RUNTIME_PUBLIC_SKILLS_DIR` | `/opt/openclaw-skills` | Worker Public Skill 目录 |
| `docker.network` | `MUAD_NET` | `muad-net` | Console 与 Worker 共享网络 |
| `resources.memLimit/cpuLimit/restartPolicy` | `CONSOLE_RESOURCE_*` | `3g` / `2` / `unless-stopped` | Pod 默认资源 |
| `resources.maxSkillConcurrency` | `CONSOLE_RUNTIME_MAX_SKILL_CONCURRENCY` | `2` | Pod 脚本 Skill 并发 |
| `resources.maxBrowserConcurrency` | `CONSOLE_RUNTIME_MAX_BROWSER_CONCURRENCY` | `2` | Pod 浏览器并发 |
| `browser.cdpPortStart/end` | `CONSOLE_RUNTIME_BROWSER_CDP_PORT_START/END` | `18802/65535` | 用户浏览器端口池 |
| `k8s.namespace` | `K8S_NAMESPACE` | `muad` | Worker namespace |
| `k8s.skillsPVC` | `K8S_SKILLS_PVC` | 空 | Public Skill RWX PVC 名 |
| `k8s.skillsStorageClass` | `K8S_SKILLS_STORAGE_CLASS` | 空 | 可动态创建 RWX PVC 的 StorageClass |
| `k8s.skillsSize` | `K8S_SKILLS_SIZE` | `5Gi` | Public Skill PVC 容量 |
| `k8s.storageClass/stateSize` | `K8S_STORAGE_CLASS/K8S_STATE_SIZE` | 集群默认 / `5Gi` | 每 Pod state PVC |

完整模板见 [`backend/config.example.yaml`](backend/config.example.yaml)。

## Docker 部署

```bash
docker network create muad-net
sudo mkdir -p /var/lib/muad-console

cd console
cp backend/config.example.yaml backend/config.yaml
# 填写 masterKey、管理员密码和默认 Worker 镜像
docker compose up -d
```

访问 `http://<host>:18080`。Console 需要挂载 `/var/run/docker.sock` 才能创建 Worker；该权限等价于宿主 root，应与不可信工作负载隔离。

Docker 模式不需要 Public Skill PVC。控制面从 `runtime.skillsDir` 生成 active-only 运行目录，并只读挂载给 Worker。

## Kubernetes 部署

设置：

```yaml
runtime:
  driver: k8s
k8s:
  namespace: muad
  skillsPVC: muad-skills
  skillsStorageClass: nfs-rwx
  skillsSize: 5Gi
  storageClass: local-path
  stateSize: 5Gi
```

- 每个 Worker Pod 使用独立 state PVC 保存用户工作区、会话、浏览器 Profile 和 Private Skill。
- Public Skill 使用共享 RWX PVC。正式环境应使用 NFS、CephFS、EFS 或其他支持 RWX 的存储。
- `skillsPVC` 和 `skillsStorageClass` 已配置时，可在 Skill 管理页创建 PVC；PVC Ready 前禁止上传 Public Skill。
- 只有 RWO 的默认 `local-path` 不能作为多 Pod Public Skill 共享卷。本地单节点可使用仓库 `k8s/` 下的 hostPath 静态 PV 进行功能测试。

## Skill 生效与审计

### Public Skill

1. 上传 `.tar.gz` 或 `.zip`，包内必须且只能有一个有效 `SKILL.md`。
2. 上传、启用、禁用和删除先更新控制面状态并标记 Pod pending。
3. 管理员点击“应用 Skill”后，控制面同步 active-only Public Skill 目录并对所有运行中 Pod 应用 Runtime Config。

### Private Skill

Private Skill 从用户详情上传。Console 通过 `ExecStdin` 调用目标 Pod 内的 installer，将文件写入该 Agent 的工作区；安装或删除后只调和目标 Pod，不需要全局“应用 Skill”。

### 执行日志

`muad-run-skill` 通过 `/internal/v1/skill-executions` 上报执行快照。列表与详情 API 只返回脱敏摘要：

- `running` 只能进入终态，终态不能被迟到事件覆盖。
- 单次工具失败只记录过程，最终状态由 Agent/Runner 结束事件决定。
- Console 暂时不可用时，Worker 将快照写入 state PVC outbox，恢复后按 `executionId + eventSeq` 幂等补传。
- Skill 上传、启禁用和应用进入操作审计；Skill 实际运行只进入 Skill 执行日志。

## HTTP API

除登录和 internal 路由外，`/api/v1` 均要求 Bearer token。

| 领域 | 主要接口 |
|------|----------|
| 登录 | `POST /auth/login`、`GET /me` |
| Pod | `GET/POST /containers`、`GET/PATCH/DELETE /containers/{podId}`、actions、logs、upgrade、channels、resources、apply-config |
| 用户 | `GET /human-users`、`GET/POST /containers/{podId}/human-users`、`GET/PATCH/DELETE /human-users/{id}` |
| 身份绑定 | identities、binding-codes、`POST /internal/v1/bindings/activate` |
| 模型池 | `GET /llm/models`、`POST /llm/models/batch`、`POST /llm/models/test` |
| 平台凭证 | platforms、`/human-users/{id}/platform-credentials`、`/internal/v1/session-credentials/resolve` |
| Skill | `/skills`、`/skills/public-storage`、`/skills/public`、`/skills/reload`、用户 Private Skill 和 policy |
| 审计 | `GET /audit`、`GET /skill-executions`、`GET /skill-executions/{id}`、`GET /alerts` |

实际路由以 [`backend/internal/api/routes.go`](backend/internal/api/routes.go) 为准。

## 开发与验证

```bash
# 后端
cd console/backend
cp config.example.yaml config.yaml
go vet ./...
go test ./...
go run ./cmd/console

# 前端
cd console/frontend
npm install
npm run dev
npm run check

# Console 镜像
cd console
docker build -t muad-console:local .
```

前端开发服务器默认监听 `http://localhost:5173`，并代理 `/api` 到后端 `:8080`。生产构建执行 `vite build`，随后由 Go `embed.FS` 打入 Console 镜像。

## CI / 发布

推送 `console-v*` tag 触发 `.github/workflows/build-console.yml`：

```bash
git tag console-v0.1.0
git push origin console-v0.1.0
```
