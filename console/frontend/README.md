# muad-console frontend

React 18 + TypeScript + Vite + Semi Design 管理界面。生产构建由 Console 多阶段 Dockerfile 打包，并通过 Go `embed.FS` 内嵌到后端单二进制。

## 页面

- **Pod 管理**：Pod 列表、批量操作、通道、资源、用户容量、配置状态、日志和详情。
- **用户管理**：跨 Pod 用户列表、选择有剩余容量的 Pod 创建用户、模型绑定、IM 身份、绑定码、平台凭证和 Private Skill。
- **Skill 管理**：Public Skill 上传、存储状态、启禁用、删除、扫描和全 Pod 应用。
- **模型配置**：模型池批量创建、占用状态和批量连通性测试。
- **资源与平台**：全局资源默认值及业务平台管理。
- **审计日志**：操作审计和 Skill 执行日志两个独立 Tab；执行日志支持统一模糊搜索、状态/范围/模式/时间筛选、详情和运行中刷新。

## 目录

```text
src/
├── api.ts                 统一 API、鉴权和错误处理
├── types/api.ts           严格 API 类型
├── components/            AppShell、分页、反馈、用户与 Pod 通用组件
└── pages/                 一级页面及页面内模块
test/                      Vitest + Testing Library
```

页面组件禁止直接 `fetch`，所有请求必须通过 `src/api.ts`。表格分页统一使用 `Pagination`，默认每页 10 条，可选 10/20/50/100。

## 本地开发

先启动后端 `:8080`，再运行：

```bash
cd console/frontend
npm install
npm run dev
```

访问 `http://localhost:5173`，Vite 将 `/api` 代理到 Console Backend。

## 验证

```bash
npm run check
```

该命令依次执行 TypeScript strict 检查、ESLint、Prettier 和 Vitest。生产构建：

```bash
npm run build
```

构建产物写入 `dist/`；Console 镜像构建时会将其嵌入 Go 二进制。
