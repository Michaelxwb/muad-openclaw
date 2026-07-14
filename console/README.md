# muad 管理监控控制台

多租户 openclaw 企微 Agent 平台的 Web 控制台:把容器开通 / 删除 / 改 LLM / 排障 / 监控从 `provision-user.sh` + `docker` CLI 上移到页面,管理员零 CLI 操作。

> 设计文档:`.code-flow/tasks/2026-06-27/muad-admin-console.design.md`
> 任务台账:`.code-flow/tasks/2026-06-27/muad-admin-console.md`

## 能力

- **容器全生命周期**:建(user_id/bot_id/secret)、列、删(可选删卷)、start/stop/restart/reap/revive、镜像升级(保卷重建)
- **LLM 配置**:全局默认 + per-user 覆盖 + 连通性测试(保存前必测)+ 批量应用到存量(滚动重启)
- **监控**:CPU/MEM、WeCom 连接健康、最后活跃、10 天回收倒计时;down/断连/高内存/即将回收 告警
- **运维**:日志查看、skill 热更(滚动重载全队)、审计日志、管理员登录鉴权

## 架构

```
console/
├── backend/        Go 控制面(单二进制，内嵌前端)
│   ├── cmd/console            装配 + 优雅退出 + 后台 collector
│   └── internal/
│       ├── config crypto repo auth   env 配置 / AES-GCM 加密 / SQLite / bcrypt+HMAC 鉴权
│       ├── driver                    RuntimeDriver 抽象（docker 实现 + k8s 桩 + factory）
│       ├── llm gateway collector monitor   LLM 探活 / 采集适配器 / 并发 Collector / 内存缓存
│       ├── api                       HTTP 接口 + 鉴权/审计中间件
│       └── web                       embed 前端 + SPA fallback
└── frontend/       React + Vite + TS SPA（登录 / 容器监控 / LLM / 审计）
```

设计要点:
- **运行时抽象**:`RuntimeDriver` 屏蔽 docker / k8s;P0 写实 docker（走 `docker` CLI），k8s 留桩。
- **凭证**:secret / api_key 经 AES-256-GCM 加密落 SQLite，运行时经 env 注入容器，**不进镜像**。
- **监控采集**:复用容器内 `openclaw status --json`（`docker exec`），不在 Go 重写 openclaw WS 握手。
- **网络**:gateway 端口不发布;控制台与用户容器共享 `muad-net`，按容器名 `muad-oc-<id>:18789` 访问。

## 配置（唯一来源 config.yaml，无凭证入镜像）

所有运行时配置（含机密）都在 `config.yaml`。该文件已 gitignore、运行时只读挂进容器、不入镜像。
env 仍可作为最高优先级覆盖（`env > config.yaml > 内置默认值`），但部署不再依赖 `.env`。

| 字段（config.yaml） | env 覆盖键 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `security.masterKey` | `CONSOLE_MASTER_KEY` | ✅ | — | 派生 AES 加密主密钥（加密 DB 内凭证） |
| `security.jwtSecret` | `CONSOLE_JWT_SECRET` | | = 主密钥 | session token 签名密钥 |
| `admin.user` / `admin.password` | `CONSOLE_ADMIN_USER` / `CONSOLE_ADMIN_PASSWORD` | 首启建议 | `admin` / — | 初始管理员（幂等引导） |
| `server.listenAddr` | `CONSOLE_LISTEN` | | `:8080` | 监听地址 |
| `server.logDir` | `CONSOLE_LOG_DIR` | | 空（仅 stdout） | 配置后双写 `<logDir>/YYYY-MM-DD/console.log` |
| `server.dbPath` | `CONSOLE_DB` | | `/var/lib/muad-console/console.db` | SQLite 路径（挂卷持久化） |
| `server.collectIntervalSec` | `CONSOLE_COLLECT_INTERVAL` | | `30` | 监控采集周期（秒） |
| `server.consoleInternalURL` | `CONSOLE_INTERNAL_URL` | | `http://muad-console:8080` | Worker 访问 Console internal API 的地址 |
| `runtime.driver` | `RUNTIME_DRIVER` | | `docker` | `docker` 或 `k8s` |
| `runtime.defaultImage` | `DEFAULT_IMAGE` | | `ghcr.io/michaelxwb/muad-openclaw:latest` | 建 Pod/容器默认镜像 |
| `runtime.skillsDir` | `CONSOLE_SKILLS_DIR` | | `/var/lib/muad-console/skills` | Console Public Skill 原始资产库目录；docker 模式会从该目录派生 `.muad-active-public-skills` 运行视图 |
| `runtime.timezone` | `CONSOLE_RUNTIME_TIMEZONE` | | `Asia/Shanghai` | 注入 worker 的时区 |
| `runtime.stateDir` | `CONSOLE_RUNTIME_STATE_DIR` | | `/home/node/.openclaw` | worker 状态目录挂载点 |
| `runtime.publicSkillsDir` | `CONSOLE_RUNTIME_PUBLIC_SKILLS_DIR` | | `/opt/openclaw-skills` | worker 内 public skill 目录 |
| `docker.network` | `MUAD_NET` | | `muad-net` | 共享 docker 网络名 |
| `resources.*` | `CONSOLE_RESOURCE_*` / `CONSOLE_RUNTIME_MAX_*` | | `3g` / `2` / `unless-stopped` / `2` / `2` | Pod 资源和并发默认值 |
| `browser.cdpPortStart` / `browser.cdpPortEnd` | `CONSOLE_RUNTIME_BROWSER_CDP_PORT_START` / `CONSOLE_RUNTIME_BROWSER_CDP_PORT_END` | | `18802` / `65535` | 浏览器 CDP 端口分配范围 |
| `k8s.*` | `K8S_*` | | 见模板 | K8s namespace、PVC、StorageClass 和容量配置 |

## 快速开始

### Docker Compose（生产/单机，推荐）

```bash
# 共享网络（控制台与用户容器互通），首次部署创建一次
docker network create muad-net
# DockerDriver 通过 docker.sock 创建 worker，bind mount 源路径必须是宿主可见路径
sudo mkdir -p /var/lib/muad-console

cd console
cp backend/config.example.yaml backend/config.yaml   # 填 security.masterKey / admin.password 等
docker compose up -d
# 浏览器打开 http://<host>:18080 登录（端口/镜像版本在 docker-compose.yml 内编辑）
```

`console/backend/config.yaml` 是统一配置入口：Docker Compose 会把它只读挂载到容器内 `/etc/muad-console/config.yaml`，backend 本地开发则从当前目录直接读取它。

> 控制台需 `docker.sock` 才能管理容器（DockerDriver）。持有 docker.sock 即 root 等价（RISK-03），
> 请将控制台与不可信用户容器隔离部署。

### 本地构建镜像

```bash
cd console
docker build -t muad-console:local .
```

## 开发

```bash
# 后端（dev 不需要前端产物）
cd console/backend
cp config.example.yaml config.yaml   # 填 masterKey 等（config.yaml 含机密，已 gitignore）
go test ./...                        # 单测（test/ 黑盒包）
go run ./cmd/console                 # 自动读取 config.yaml；env 可覆盖任意字段

# 前端（vite dev，代理 /api → :8080）
cd console/frontend
npm install
npm run dev                          # http://localhost:5173
npm run build                        # tsc 类型检查 + 打包 dist/
```

- **配置优先级:env > config.yaml > 内置默认值**。config.yaml 是唯一配置源（含机密），已 gitignore、不入镜像；env 仅作可选覆盖。
- 后端 HTTP 用 stdlib `net/http`；单测集中在 `backend/test/`（`package test` 黑盒）。
- 前端构建产物 `dist/` 在镜像构建时由 `-tags prod` 内嵌进 Go 二进制（dev 构建不需要）。

## HTTP API（`/api/v1`，除 login 外均需 Bearer token）

| 方法 + 路径 | 说明 |
|---|---|
| `POST /auth/login` | 登录，返回 token |
| `POST /containers` | 建容器（userId/botId/secret[/imageTag/llmOverride]） |
| `GET /containers` | 列表（含监控快照） |
| `DELETE /containers/{id}?deleteVolume=` | 删容器（默认保状态卷） |
| `GET /containers/{id}/logs?tail=` | 日志 |
| `POST /containers/{id}/actions/{action}` | start/stop/restart/reap/revive |
| `POST /containers/{id}/upgrade` | 镜像升级（保卷重建） |
| `GET /llm` · `PUT /llm` · `POST /llm/test` | 全局 LLM 读/写/连通性测试 |
| `PUT /containers/{id}/llm` · `POST /llm/apply` | per-user 覆盖 / 批量应用到存量 |
| `POST /skills/reload` | skill 热更（滚动重启运行中容器） |
| `GET /audit` · `GET /alerts` | 审计查询 / 当前告警 |

## CI / 发布

推送 `console-v*` tag 触发 `.github/workflows/build-console.yml`，构建并推到 `ghcr.io/<owner>/muad-console`：

```bash
git tag console-v0.1.0 && git push origin console-v0.1.0
```

> 与 openclaw 工作镜像的 `v*` tag 区分，互不触发。

## 现状与后续

- ✅ 后端全链路 + 前端全页面 + 镜像端到端验证通过（TASK-001~021）。
- 后续:k8s driver 写实（目前桩）；真机 WeCom 在线时回归 `channelSummary` 解析；告警外发通道（webhook/邮件）。
