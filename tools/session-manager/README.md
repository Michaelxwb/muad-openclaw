# session-manager

`session-manager` 解析当前 agent 的业务平台凭据，并落地一份隔离的浏览器会话状态。无平台归属的 Skill 不应调用它。

## 命令行用法

```text
session-manager get-state --skill-name <name>
```

OpenClaw 插件对外暴露等价的 `session_get_state` Tool，参数为 model 可见的 Skill：

```json
{
  "skillName": "mssw-query"
}
```

插件只从 OpenClaw 受信任的工具上下文读取 `agentId` 和 `sessionKey`，不接受 Tool 参数传入。清单中声明 `contracts.tools=["session_get_state"]`，插件入口为 `openclaw-plugin.mjs`。

CLI 身份只从受信任的 `MUAD_SESSION_KEY` 解析（Runtime Guard 在 exec 环境注入 `agent:<agentId>:...` 形式的会话密钥）；自报的 `MUAD_AGENT_ID` 不再被信任、被完全忽略，没有 `MUAD_SESSION_KEY` 时 fail closed。CLI 故意不暴露 `--agent-id`、`--pod-id`、API key、Cookie 或账号选择参数。Pod service token 只从 `/run/secrets/muad/pod-service-token` 读取，结果以稳定 JSON 写到 stdout。

## 会话状态存储路径

`bundle.json` 是 session-manager 的**私有缓存**（agent 级、平台名作为 key 分区），
对脚本不可见；`get-state` 每次按 Skill 裁剪出一份仅含当前 Skill 声明平台的
skill-scoped 文件返回给调用方：

```text
/home/node/.openclaw/agents/<agentId>/session-store/
  bundle.json        # { version, platforms: { <platform>: <session section> } } 私有缓存
  <skill>.session.json      # get-state 按 Skill 裁剪的只读输出
  bundle.lock        # per-agent 写锁，串行化 bundle 的读改写
  <platform>.refresh.lock   # per-platform 刷新锁，串行化跨进程冷刷新
```

`session-manager get-state` 在 stdout 返回按 Skill 裁剪的 `sessionStateFile` 和每个平台的
`{ platform, source, expiresAt, credentialFingerprint }`；**cookie 与 storageState
不进入输出**，脚本按 `sessionStateFile` + 平台名读对应 Skill 的 section。

每次请求都会先解析当前凭据：Console 把 `agentId + skillName` 映射到生效 Skill 及其声明的平台依赖，再逐个解析该用户的平台凭据 JSON，一次返回该 Skill 声明的**全部平台**凭证。Skill 声明了多个平台时，任何一个平台未配置/停用都会导致整个请求失败（不做部分降级）。缓存状态只有在 Human User、agent、Pod、平台、凭据指纹、过期时间全部一致时才复用。per-platform 刷新锁串行化跨进程刷新（多平台冷刷新并行、单平台去重），崩溃残留的过期锁会在有界超时后回收；bundle 的读改写统一在 `bundle.lock` 写锁内完成，避免并发写掉其他平台 section。

平台不是运行时代码播种的。管理员在 Console 创建平台名、上传带可选平台依赖的 Skill、再为各用户保存所需平台的凭据 JSON。

## Cookie 消费边界

- 脚本/CLI：Skill 脚本直接调用 `session-manager get-state --skill-name <name>` 保证状态新鲜，再从返回值 `sessionStateFile` 读该 Skill 的 `<platform>.cookies` section（文件只含当前 Skill 声明的平台，不含其他 Skill 的平台）。无需 env 注入，CLI 身份只由 Runtime Guard 注入的 `MUAD_SESSION_KEY` 决定。
- 浏览器：部署配置会把 agent 到 browser profile 的映射传给 session-manager 插件；插件在 `session_get_state` 成功后通过 OpenClaw 可信 `browser.request` 给当前 agent profile 写入 cookies。该路径要求 session-manager 插件以 bundled/trusted official 权限加载；否则会显式返回 `browser_apply_failed`。
- 文件工具：`read`/`write`/`edit`/`apply_patch` 仍禁止访问 `session-store`，避免 cookie 进入模型上下文或普通工具日志。

当前浏览器应用器支持 cookies。若适配器返回带 `localStorage` 的 `storageState.origins`，插件会显式返回 `browser_apply_failed`；这需要 OpenClaw 浏览器侧补 context-level storageState import 路由后再启用，不能通过导航当前 tab 到任意 origin 来替代。

### 信任边界与残余风险

本模型把已安装的 Skill 脚本视为可信执行体（它们是经管理员安装、随 pod 分发的代码）。在此前提下：

- **身份**：`MUAD_SESSION_KEY` 由 Runtime Guard 注入，CLI 只从它解析 agent，自报环境变量无法伪造身份；跨 agent-user 的会话密钥会被 Resolver 的归属校验拒绝。
- **平台隔离**：CLI 返回的 `sessionStateFile` 只含当前 Skill 声明的平台，任何脚本读不到其他 Skill/平台的数据；agent 级 `bundle.json` 不再通过 CLI 暴露。
- **残余**：同一 UID 下的恶意脚本仍可直接读其他 agent 的 `bundle.json`，或携带 pod token 直接调用 Resolver。这不是 CLI 层能关闭的，接受为信任边界的一部分——只信任已安装 Skill，不信任任何用户代码。

## 适配器体系

session-manager 的登录逻辑以 `PlatformAdapter` 形式接入，按平台名选择实现：

- **预注册适配器**：在 `src/adapters/registry.ts` 的 `createInstalledAdapterRegistry` 中显式注册，目前只有 `mssw`。
- **通用 HTTP 适配器（fallback）**：任何符合 `PLATFORM_PATTERN` 的平台名都会落到 `HTTPSessionAdapter`，按下面"通用 HTTP 平台"字段读取凭据，无需写代码。
- **新平台定制适配器**：当平台登录需要特殊签名、CSRF、多步流程时，在 `src/adapters/` 下新增一个 `.ts` 实现 `PlatformAdapter` 接口，并在 `registry.ts` 的 `createInstalledAdapterRegistry` 中注册。

### 通用 HTTP 平台（无需写代码）

凭据 JSON 字段：

```json
{
  "baseUrl": "https://platform.internal",
  "sessionEndpoint": "/api/session",
  "healthEndpoint": "/health",
  "ak": "user-access-key",
  "sk": "user-secret-key",
  "sessionMode": "storage_state",
  "sessionTtlSeconds": 900
}
```

行为约定：

- 含 `apiKey`：作为内存态 `Authorization: Bearer` 头发送，不落盘。
- 含 `ak/sk` 或 `accessKey/secretKey`：只作为 `X-Access-Key` / `X-Secret-Key` 头发送，不写入登录请求体。
- 登录响应可从 JSON 或 `Set-Cookie` 头返回 cookies；可选 Playwright `storageState`，可选 `expiresAt`。
- 配置 `healthEndpoint` 时，复用缓存前会先 GET 校验；401/403 清缓存并触发重新登录。
- 适配器若尝试把敏感凭据值写入持久化状态会被拒绝。

### MSSW 平台适配器（定制示例）

`mssw` 平台用专用适配器实现 Sangfor MSSW SigV4 风格 AK/SK 签名。凭据 JSON 字段：

```json
{
  "baseUrl": "https://sitmssw.soar.sangfor.com",
  "sessionEndpoint": "/gateway/mss-auth-acl-service/v1/certification/login_agent",
  "healthEndpoint": "/v1/rtt",
  "ak": "agent_ak_xxx",
  "sk": "secret-sk-value",
  "csrfEnabled": false,
  "sessionTtlSeconds": 900
}
```

签名细节：

- 规范请求 = `POST` + 网关剥离后的路径 + 排序后的 query + 签名头（`content-type`、`sign-date`）+ SHA256 body hash。
- 用 SK 做 HMAC-SHA256 签名，发送 `Authorization: algorithm=HMAC-SHA256,Access=...,SignedHeaders=content-type;sign-date,Signature=...,sign-date=<unix-seconds>` 头。
- 实际 HTTP 请求使用完整 URL（保留 `/gateway/<service>/` 前缀），但签名路径会剥离网关前缀以匹配服务端 `r.URL.Path`。
- `sign-date` 是 **Unix 秒**，对齐 Go 参考实现 `time.Now().Unix()`。
- `csrfEnabled=true` 时，先 GET `/v1/certification/get_token` 拿 `csrf_token` cookie，再以 `x-csrftoken` 头附在登录请求上。
- 登录响应通过 `Set-Cookie` 设置 `soc-token`（JWT）和 `login-source=agent`。
- 配置 `healthEndpoint` 时，缓存复用前会 GET 校验；401/403 返回 `false` 触发重新登录。

## 接入一个新平台的登录逻辑

接入新平台分两种路径，按平台登录协议复杂度选择。

### 路径 A：通用 HTTP 登录（无需写代码）

如果平台登录是标准 HTTP POST + Cookie/JSON 响应、可选 health 校验，且不需要自定义签名，直接走通用 HTTP 适配器：

1. 在 Console 创建平台名（需匹配 `^[a-z][a-z0-9_]{0,63}$`）。
2. 为该平台准备凭据 JSON，包含下面这些信息：
   - `baseUrl`：平台根地址（含协议，例如 `https://platform.internal`）。
   - `sessionEndpoint`：登录接口路径（相对 `baseUrl`，例如 `/api/session`）。
   - `healthEndpoint`（可选）：缓存复用前的校验路径，返回 401/403 触发重新登录。
   - `ak` / `sk`（或 `accessKey` / `secretKey`，或 `apiKey`）：根据平台鉴权方式选一种。
   - `sessionMode`（可选，默认 `storage_state`）。
   - `sessionTtlSeconds`（可选，默认 900 秒）。
3. 在 Console 把该凭据 JSON 保存到对应用户的该平台凭据槽位。
4. 上传 Skill 并声明该平台依赖。

### 路径 B：定制适配器（需要写代码）

如果平台登录需要自定义签名（如 SigV4、HMAC）、CSRF 多步、特殊请求头编排或非标准响应解析，按以下步骤新增：

1. **准备信息**（写到代码里或 Console 凭据 JSON 里）：
   - 平台名（匹配 `^[a-z][a-z0-9_]{0,63}$`）。
   - `baseUrl`、`sessionEndpoint`、可选 `healthEndpoint`。
   - 鉴权材料：AK/SK、用户名密码、token、证书等，决定放凭据 JSON 还是环境/Secret。
   - 签名算法（如有）：参与签名的请求方法、路径、query、header、body 的拼接规则与密钥派生方式。
   - 登录响应结构：cookie 来源（`Set-Cookie` 头 / JSON body）、必要 storage state、过期时间。
   - 健康检查方法：GET 路径、识别失效的状态码集合。
   - CSRF/多步：是否需要先取 token、是否需要回填 header、cookie 名与 header 名。
   - TLS：是否自签证书（适配器内统一通过 `insecureSkipVerifyFetch` 类 helper 跳过校验，对齐 Go `InsecureSkipVerify: true`）。

2. **实现适配器**：在 `src/adapters/<platform>.ts` 实现 `PlatformAdapter` 接口（参考 `src/adapters/mssw.ts`）：
   - `readonly platform = "<platform>"` 与平台名一致。
   - `refresh(input)`：解析凭据、构造签名/请求、发起登录、把响应归一为 `AdapterSessionState`（cookies + storageState + expiresAt）。
   - `validate(input)`（可选）：用缓存 cookies 调 healthEndpoint，401/403 返回 `false`，其他非 2xx 抛 `PlatformAdapterError(false, retryable)`。
   - 错误统一用 `PlatformAdapterError(authenticationFailed, retryable)`：鉴权失败设 `authenticationFailed=true`（会触发清缓存），网络/5xx 设 `retryable=true`。
   - 凭据字段解析放进独立 `parseCredential` 函数，对未知字段做忽略、对必填缺失抛 `PlatformAdapterError(true, false)`。
   - 永远不要把 sk、apiKey 等敏感字段写入 `AdapterSessionState`，框架会在落盘前再做一次敏感值扫描拒绝写入。

3. **注册适配器**：在 `src/adapters/registry.ts` 的 `createInstalledAdapterRegistry` 中加进构造列表：

   ```typescript
   import { NewPlatformAdapter } from "./<platform>.js";
   // ...
   return new AdapterRegistry(
     [new MSSWSessionAdapter(fetchLike), new NewPlatformAdapter(fetchLike)],
     (platform) => new HTTPSessionAdapter(platform, fetchLike),
   );
   ```

4. **加单元测试**：在 `test/mssw-adapter.test.mjs` 旁边加 `test/<platform>-adapter.test.mjs`，用 fake fetch（参考 `makeFetch`）覆盖：正常登录、签名头格式、CSRF（如启用）、health 401/403、登录 401/403、凭据缺失。

5. **加本地探测脚本**（可选）：在 `scripts/` 下加 `probe-<platform>.mjs`（参考 `probe-mssw.mjs`），用于在开发期对真实端点验证签名算法。脚本只读 `--ak/--sk/--url` 等参数，不引入新依赖。

6. **更新文档**：在本 README 适配器体系章节加一段该平台的凭据字段和签名细节说明；把容易踩坑的隐式行为（时间戳单位、签名头大小写、canonical request 末尾换行等）写进对应 memory 文件。

7. **构建与验证**：`npm run build && npm test`，本地用探测脚本对真实端点跑一次 refresh+validate。

## 本地调试

对 mssw 端点做本地探测（TLS 校验跳过，对齐 Go 的 `InsecureSkipVerify: true`）：

```bash
npm run build
node scripts/probe-mssw.mjs \
  --ak <AK> --sk <SK> \
  --url https://sitmssw.soar.sangfor.com/gateway/mss-auth-acl-service/v1/certification/login_agent \
  [--health-endpoint /v1/rtt] [--csrf] [--agent-id local-debug] [--validate]
```

输出 refresh 结果（cookie 名、value 长度、domain、`expiresAt`）。带 `--validate` 和 `--health-endpoint` 时会额外用刚拿到的 cookies 调 `adapter.validate()` 并打印是否有效。脚本从 `dist/adapters/mssw.js` import 构建后的 adapter，所以改 `src/adapters/mssw.ts` 后要先 `npm run build`。

Windows + Git Bash 下，MSYS 会把以 `/` 开头的参数（如 `/v1/rtt`）自动转成 Windows 原生路径（如 `c:/Program Files/Git/v1/rtt`），导致 `new URL()` 报 `Protocol "c:" not supported`。带 `--health-endpoint` 时需加 `MSYS_NO_PATHCONV=1` 前缀：

```bash
MSYS_NO_PATHCONV=1 node scripts/probe-mssw.mjs --ak ... --health-endpoint /v1/rtt --validate
```

## 集成示例与构建

`fixtures/` 下有 Python、TypeScript、Shell 三种语言的集成示例。它们都只调同一个 CLI，故意不包含 Resolver、缓存或适配器实现。

构建与测试（Node.js 24）：

```text
npm ci
npm test
```

镜像构建由 `build/docker-build/task0-session-manager.sh` 负责，只跑 `npm install` + `npm run build`（产出 `dist/`），不跑测试（容器内无 python3，cross-language 合约测试会失败）。`scripts/` 下的 `.mjs` 探测脚本不参与 tsc 编译、不进入 `dist/`，不影响镜像产物。
