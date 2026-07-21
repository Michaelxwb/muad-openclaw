# muad-openclaw

面向企业微信和个人微信的多用户 Agent 平台，可作为 MSS 服务交付的运行时底座：服务经理在企微中发起任务，由 Agent + Skill 自动编排工具与业务平台。控制面以 Pod 为运行单元，每个 Pod 默认最多约 10 个 Human User（`max_users` 可配置）；每个用户拥有独立的 Agent、工作区、浏览器 Profile、模型配置和 IM 身份，同一用户绑定多个 IM 后复用同一份记忆与 Skill。

平台不修改或 fork OpenClaw 上游源码，所有多用户隔离、Skill 执行、身份绑定和业务凭证能力都通过控制面、运行时配置及外置插件实现。

## 核心能力

- **多用户单 Pod**：管理员维护 Pod 容量，用户级 Agent、会话、浏览器、模型和私有状态相互隔离。
- **多 IM 身份**：支持企业微信 `wecom` 和个人微信 `openclaw-weixin`；已知 External ID 可直接绑定，未知身份通过一次性绑定码激活；未绑定发送者不自动开户。
- **模型池**：批量维护 OpenAI 兼容模型配置，创建用户时必须绑定一个未占用模型；不存在全局、Pod 或用户 override 回退链路。
- **Skill 管理**：统一管理 system/public/private Skill，支持 `.tar.gz` 和 `.zip`，Public Skill 显式应用到全部 Pod，Private Skill 直接安装到目标用户工作区。业务 Skill 可扩展（预防流、报告等），不改变底座架构。
- **业务平台凭证**：每个用户可配置业务平台 API Key；`session-manager` 按可信 Agent 上下文解析并生成隔离登录态。产品范围以 **MSSW / SDSP** 为主（实现中可能仍保留历史 adapter，以总设 CONST-PLAT-01 为准）。
- **执行审计**：操作审计与 Skill 执行日志分开查询，记录 Skill 激活、工具进度、终态、耗时和失败摘要。
- **Docker/Kubernetes**：`RuntimeDriver` 同时实现 Docker 和 Kubernetes，配置应用带 generation、健康检查与失败回滚。

## 运行时镜像

Worker 镜像包含：

- OpenClaw `2026.6.10` 与 Chromium/Playwright。
- 企业微信插件 `@wecom/wecom-openclaw-plugin`。
- 个人微信插件 `@tencent-weixin/openclaw-weixin`。
- `muad-run-skill`、`muad-runtime-guard` 和 `session-manager`。
- 多用户配置渲染、Private Skill installer、配置事务与进度 CLI。
- `/opt/openclaw-skills` 下的内置 Skill 种子。

通道凭证、LLM API Key、平台 API Key 和 Pod service token 均在运行时注入，不进入镜像。

## 架构概览

```text
企业微信 / 微信
       │
       ▼
OpenClaw Pod（默认约 10 个 Human User）
  ├── main：仅处理绑定引导
  ├── user-a Agent / workspace / browser / model
  ├── user-b Agent / workspace / browser / model
  ├── muad-run-skill：激活、执行、进度、审计
  ├── runtime-guard：身份、目录、浏览器和健康边界
  └── session-manager：业务平台登录态
       │
       ▼
muad Console
  ├── Pod / 用户 / IM / 模型 / Skill / 平台管理
  ├── Runtime Config 调和与回滚
  ├── 操作审计 / Skill 执行日志 / 告警
  └── SQLite + Docker/K8s RuntimeDriver
```

文档索引：

| 文档 | 说明 |
|------|------|
| [`docs/muad-openclaw-总体设计说明书.md`](docs/muad-openclaw-总体设计说明书.md) | **总设（评审基线）**：产品定位、选型结论、Worker 工具链、数据流、部署与 ADR |
| [`docs/agent-runtime-selection.md`](docs/agent-runtime-selection.md) | Agent 运行时选型调研（OpenClaw vs Hermes、单用户→多用户演进） |
| [`docs/k8s-architecture-100users.md`](docs/k8s-architecture-100users.md) | 100 用户 K8S 容量与部署专题 |
| [`docs/multi-user-single-pod.md`](docs/multi-user-single-pod.md) | 多用户 / bindings / 绑定码机制说明 |
| [`docs/deploy-k8s-linux.md`](docs/deploy-k8s-linux.md) | 测试环境部署 |
| [`docs/images/total-design/`](docs/images/total-design/) | 架构图（上下文 / 组件 / 数据流 / Pod 内部 / K8S 拓扑） |

## 构建 Worker 镜像

```bash
docker build -t muad-openclaw:local .
```

构建过程会校验 OpenClaw 固定版本、插件清单和运行时装配。推送 `v*` tag 会触发 `.github/workflows/build-image.yml`：

```bash
git tag v0.1.0
git push origin v0.1.0
```

## 启动控制面

```bash
cd console/backend
cp config.example.yaml config.yaml
# 配置 security.masterKey、admin.password 和 runtime.driver
go run ./cmd/console
```

本地前端开发：

```bash
cd console/frontend
npm install
npm run dev
```

访问 `http://localhost:5173`。生产镜像会把前端静态文件嵌入 Go 二进制，默认监听 `:8080`。Docker Compose 和 Kubernetes 配置见 [`console/README.md`](console/README.md)。

## 控制台模块

| 模块 | 主要功能 |
|------|----------|
| Pod 管理 | 创建、启停、升级、通道、资源、配置应用、日志和容量 |
| 用户管理 | 全局用户列表、选择未满 Pod、绑定模型、IM 身份、绑定码、平台凭证和 Private Skill |
| Skill 管理 | Public Skill 上传、启禁用、删除、全 Pod 应用、资产扫描和状态查询 |
| 模型配置 | 批量导入模型 Key、连通性测试、占用状态和用户绑定 |
| 资源与平台 | Pod 默认资源、Skill/浏览器并发和业务平台配置 |
| 审计日志 | 平台操作审计与 Skill 执行生命周期两个独立 Tab |

## Skill 约定

每个 Skill 必须包含 `SKILL.md`；`muad.skill.json` 仅用于确定性步骤、入口和进度编排，不是识别或执行的必要条件。

```text
<skill-name>/
├── SKILL.md              # 必需
├── muad.skill.json       # 可选：managed Skill
├── scripts/              # 可选：Shell/Python/Node 脚本
└── references/           # 可选
```

运行时支持：

- `managed`：由 `muad.skill.json` 声明 steps 或 entrypoint。
- `traditional-script`：无 manifest，由已扫描的相对脚本路径执行。
- `traditional-prompt`：无 manifest，按 `SKILL.md` 指导 Agent 使用原生工具。

Skill 激活只在当前用户消息轮次有效。Agent 必须先读取授权 Skill 的精确 `SKILL.md`，无法读取时调用 `muad_use_skill`。若 frontmatter `description` 声明 `MANDATORY before calling ...`，`muad-run-skill` 会在未激活时阻断对应原生工具，避免模型绕过 Skill 后漏记审计。

详见 [`skills/README.md`](skills/README.md) 和 [`tools/muad-run-skill/README.md`](tools/muad-run-skill/README.md)。

## 开发验证

```bash
cd console/backend && go vet ./... && go test ./...
cd console/frontend && npm run check
cd tools/muad-run-skill && npm test
cd tools/muad-runtime-guard && npm test
node --test bin/test/*.test.mjs
```

## 目录结构

```text
Dockerfile                    Worker 镜像
baseline-config.json          OpenClaw 基线配置
bin/                          配置渲染、事务、Private Skill installer
console/                      Go + React 管理控制面
docs/
  ├── muad-openclaw-总体设计说明书.md
  ├── k8s-architecture-100users.md
  ├── multi-user-single-pod.md
  ├── deploy-k8s-linux.md
  └── images/total-design/    架构 SVG
skills/                       内置 Skill 与开发模板
tools/
  ├── muad-run-skill/         Skill 激活、执行、进度和审计插件
  ├── muad-runtime-guard/     多用户运行时边界和健康检查
  ├── session-manager/        业务平台登录态管理
  └── muad-progress/          语言无关进度 CLI
.code-flow/                   规范、设计和任务档案
.github/workflows/            Worker/Console 镜像流水线
```

## CI / 发布

| tag | 流水线 | 镜像 |
|-----|--------|------|
| `v*` | `build-image.yml` | `ghcr.io/<owner>/muad-openclaw` |
| `console-v*` | `build-console.yml` | `ghcr.io/<owner>/muad-console` |

## 注意事项

- 同一个机器人或通道凭证不能同时绑定多个 Pod，否则会发生连接互斥；Pod 与机器人由管理员维护。
- WeCom 主动推送要求用户先向机器人发送过消息。
- Public Skill 在状态变更后必须点击“应用 Skill”才会同步到所有运行中 Pod；Private Skill 安装/删除只作用于目标用户。
- Kubernetes Public Skill 需要可用的 RWX PVC；本地单节点测试可使用 `k8s/` 下的 hostPath 静态 PV 模拟，正式环境应使用 NFS/CephFS/EFS 等共享存储。
