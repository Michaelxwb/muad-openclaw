# WebChat 统一聊天页面与嵌入接入设计

> **文档编号**: FE-WEBCHAT-001
> **文档版本**: v1.6
> **创建日期**: 2026-10-10
> **修订日期**: 2026-10-21
> **文档状态**: 设计评审中；页面、SDK 和模拟环境尚未实现

与[后端设计](webchat-channel.backend.design.md)同一基线，API 与身份、媒体、事件契约以后端 §3.4 为准；继承同目录 Spec Context。本文场景 ID 独立，跨文档引用注明"后端"。

## 1. 文档控制

### 1.1 责任与交付

muad 实现聊天页面、消息渲染、流式客户端和可选接入 SDK；业务平台只提供入口容器与认证适配，不实现另一套聊天 UI。测试提供本地模拟平台和完整场景报告，负责人任务拆解时指定。

### 1.2 修订历史

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1–v1.4 | 2026-10-10~13 | 初稿；附件白名单、最近 200 条、复用平台 JWT |
| v1.5 | 2026-10-21 | 托管统一页面、iframe 主接入、可选无框架 SDK；统一快照流、认证桥、无 nginx 与本地模拟 |
| v1.6 | 2026-10-21 | 同步后端认证：复用现有 JWT，不换票、不新增断言签发；每请求携带 JWT 由 Console 验证 |

## 2. 需求分析

### 2.1 目标与已对齐边界

核心是正确接收、持续渲染对话结果。同一套 UI 运行于 Console 托管的 iframe，宿主可用 HTML/React/Vue，不需使用本项目组件库。

对外交付 `/webchat/embed` 和可选纯 JS SDK：mount 创建 iframe 并封装认证握手，宿主无需监听 onChunk/onMessage/onUnread/onClose/跳转等业务事件；直接 iframe 加少量认证代码同样支持，协议一致。业务平台可在挂载前用用户 JWT 调 API-06 查询资格，决定是否展示入口。消息发送、历史、SSE/轮询、附件、Markdown、错误和断线恢复都在 iframe 内；统一页面用 React/TypeScript/Semi，框架中立只指宿主接入。本期保留单窗口、最近 200 条、普通文本 `/new`、块级流式，无多会话和更早历史。

### 2.2 功能方案

用户故事 US-01 至 US-11 来自后端 §2.2；本需求无独立 PRD。

| ID | 功能与职责 | 优先级 | 来源 |
|---|---|---|---|
| FEAT-F01 | 统一聊天容器、身份初始化、登录/无权限状态 | P0 | US-01、US-09 |
| FEAT-F02 | 消息气泡、Markdown/代码/表格、图片/文件 | P0 | US-01、US-04 |
| FEAT-F03 | SSE 完整快照增量显示、游标恢复、轮询降级 | P0 | US-01、US-02 |
| FEAT-F04 | 附件预检/上传状态、单文件 30MiB、最多 9 个 | P0 | US-03 |
| FEAT-F05 | 授权 Blob 下载、object URL 预览及释放 | P0 | US-04 |
| FEAT-F06 | 最近 200 条和活动请求恢复，无更早加载 | P1 | US-02 |
| FEAT-F07 | `/new` 等作为普通消息，原生确认回复 | P1 | US-06 |
| FEAT-F08 | 聊天页内部的长任务结果/未读通知恢复与已读 | P1 | US-07 |
| FEAT-F09 | 页面内部建议问题和快捷输入 | P1 | US-01 |
| FEAT-F10 | Console 管理侧通道/authority 登记、类型和双语 | P0 | US-08 |
| FEAT-F11 | iframe 页面、可选无框架依赖挂载 SDK | P0 | US-10 |
| FEAT-F12 | 现有 JWT 握手、每请求认证、续期/退出/切用户隔离 | P0 | US-08、US-10 |
| FEAT-F13 | HTML/React/Vue 本地模拟宿主与完整认证/对话验收 | P0 | US-11 |

### 2.3 范围与边界

| 类别 | 约定 |
|---|---|
| 范围内 | 统一页面/可选 SDK、认证桥、完整对话渲染、媒体、恢复、本地模拟 |
| 宿主责任 | 提供容器和 Console 地址；通过接入适配提供现有平台 JWT（获取方式接入时定）；可用同一 JWT 调 API-06 决定入口显隐；卸载/退出时销毁实例 |
| 范围外 | 宿主实现聊天 UI/SSE；宿主机业务事件；原生 React/Vue 组件包；逐 token；多会话；前端私钥或自签 JWT |
| 部署 | Console 可直接 IP:端口；生产在 AD 上配置独立 webchat 域名并整体分流到 Console；iframe 与其 API 同源、与宿主页面跨域；HTTPS 宿主需可信 HTTPS 聊天地址 |
| 接入条件 | 浏览器可达；frame-src/frame-ancestors 匹配；认证 profile 待联调；HttpOnly Cookie 需平台后端或适配读取 |

### 2.4 验收条件

跨认证/API/SQLite/Gateway/浏览器渲染的流程必须 E2E；组件/纯函数测试不代替。所有场景待实现。

#### 正常场景

| ID | 功能 | 层级 | 关键边界、操作与可见结果 |
|---|---|---|---|
| S-01 | FEAT-F01/02 | E2E | 模拟宿主→iframe→真 Console→真 Gateway；登录发消息，用户气泡一次，助手持续显示并完成 |
| S-02 | FEAT-F03 | E2E | 真 SSE 完整快照逐块到达；同 messageId 更新，最终文本/媒体与 API-03 一致 |
| S-03 | FEAT-F04 | E2E | 5MiB 图片真实上传/Pod 拉取/模型输入，状态与预览可见 |
| S-04 | FEAT-F05 | E2E | 真实 Skill 出站文件→Console 存储→api.ts 授权下载；hash 一致，图片可预览 |
| S-05 | FEAT-F06 | E2E | >200 条后刷新；只显示最近 200 条，无更早加载，活动请求恢复 |
| S-06 | FEAT-F07 | E2E | 发 `/new`，原生上下文重置，原生回复显示；不硬编码回复或创建第二条对话 |
| S-07 | FEAT-F08 | E2E | 长任务期间关闭 iframe，完成后重开；内部未读/结果可见，已读幂等，无宿主回调 |
| S-08 | FEAT-F10 | E2E | Console 管理登记 mssw/mssp 及 authority，提交真 API 并 apply；双语正确 |
| S-09 | FEAT-F11 | E2E | HTML/React/Vue 宿主挂同一 iframe；不装 Semi、不监听结果，都能聊天 |
| S-10 | FEAT-F11/12 | E2E | 同一宿主分别用直接 iframe 协议、SDK mount 完成认证和对话 |
| S-11 | FEAT-F11 | E2E | 无 nginx 的 IP:端口直连与 webchat 独立域名经 AD 分流两种模式的页面/API/SSE；HTTPS profile 单独通过 |
| S-12 | FEAT-F12 | E2E | HttpOnly 登录→适配取得现有 JWT→postMessage→Console 每请求验证；前端无私钥，第三方 Cookie 不是依赖 |
| S-13 | FEAT-F03/06 | E2E | 生成中断网/刷新后按 eventSeq 恢复；文本不重不漏、附件去重 |
| S-14 | FEAT-F02 | E2E | 真流含跨块代码围栏、表格、中文/emoji；中间安全显示，最终 Markdown 完整 |
| S-15 | FEAT-F12 | E2E | A 退出/切 B，销毁或续期识别身份变化；旧内容/Blob/游标先清空，B 只见本人消息 |
| S-16 | FEAT-F13 | E2E | 本地模拟平台登录到真实后半链路，双用户双平台、媒体、重连均有报告 |
| S-17 | FEAT-F09 | E2E | 点击页面内建议问题，只填入/发送普通正文；同 API 与幂等流程 |
| S-18 | FEAT-F12 | E2E | 宿主以用户 JWT 调 API-06：canChat=true 才展示/挂载；未授权/停权返回 false 不展示；跨 origin 直连走 eligibility allowlist，后端代调同样验证 JWT |

#### 异常场景

| ID | 功能 | 层级 | 触发与 UI 行为 |
|---|---|---|---|
| E-01 | FEAT-F01/12 | E2E | 真 401/到期：停止流、清内存 JWT 和敏感内容；补取失败显示重新登录 |
| E-02 | FEAT-F01 | E2E | 有效身份 canChat=false，iframe 显示无对话权限，不跳 Console 管理员登录 |
| E-03 | FEAT-F06 | E2E | 历史 API 故障，显示错误/重试；不把旧缓存当结果 |
| E-04 | FEAT-F04 | integration | 组件+预检：超 30MiB 拦截，无上传请求 |
| E-05 | FEAT-F04 | integration | 不支持扩展名预检拒绝；后端拒绝伪装文件时显示稳定文案 |
| E-06 | FEAT-F03 | E2E | 真 SSE 断开/代理缓冲，退避/轮询保持内容；连续 3 次失败提示手动重试 |
| E-07 | FEAT-F03 | E2E | 后端排队/unknown/interrupted/failed 分别显示，不凭超时自行发新 ID |
| E-08 | FEAT-F03/06 | E2E | 游标过期/超前、重复/乱序→resync/单调合并，终态不倒退 |
| E-09 | FEAT-F12 | E2E | 错 origin/source/instanceId/nonce 或伪造/过期 JWT 拒绝；有效 JWT 重复使用不误判重放 |
| E-10 | FEAT-F11 | E2E | HTTPS→HTTP、禁止 frame 策略、不可达地址：mount 给明确失败，不假装连接成功 |
| E-11 | FEAT-F02 | integration | Markdown 含脚本、事件属性、危险链接；不执行、不产生危险 URL |
| E-12 | FEAT-F05 | E2E | 用他人 mediaId 下载 403/404；登录失效清 Blob URL |
| E-13 | FEAT-F03 | E2E | POST 已入库但响应丢失，同 clientMessageId 重试，Agent 只启动一次 |
| E-14 | FEAT-F12 | E2E | 对话中停权或续期失败：关连接、清内容，不转轮询绕过鉴权 |
| E-15 | FEAT-F13 | integration | 生产构建无模拟宿主路由/测试私钥/模拟 issuer 信任 |
| E-16 | FEAT-F03 | integration | SSE 字节解析错误/缓冲超限：明确错误并重拉，不截断当成功 |

#### 边界场景

| ID | 功能 | 层级 | 输入与断言 |
|---|---|---|---|
| B-01 | FEAT-F04 | unit | 30MiB/30MiB+1 接受/拒绝 |
| B-02 | FEAT-F04 | unit | 9/10 个附件接受/拒绝 |
| B-03 | FEAT-F01 | unit | TextEncoder 测 UTF-8 64KiB 和多字节越界，不按字符数 |
| B-04 | FEAT-F03 | unit | 退避上限与连续失败 3 次停止，卸载取消 timer/fetch |
| B-05 | FEAT-F07 | unit | `/new` 与普通文本均原样进入 sendMessage |
| B-06 | FEAT-F04 | unit | 扩展名/大小预检，最终类型以后端为准 |
| B-07 | FEAT-F03 | unit | UTF-8 跨字节、CRLF、跨 chunk 的 data、多行 data、注释/空行正确解析 |
| B-08 | FEAT-F03 | unit | 重复 revision 幂等、旧 revision 丢弃、同 ID 映射、终态不倒退 |
| B-09 | FEAT-F11 | integration | 重复 mount/destroy、握手超时、容器移除无残留监听器/iframe |
| B-10 | FEAT-F02 | integration | 200 消息、长代码/宽表格、窄屏和中文输入法；可滚动且不误发送 |

#### 非功能目标

| ID | 目标 | 验证 |
|---|---|---|
| NFR-F01 | 内网首次可交互≤2s，认证耗时单独记录 | 实测，不作为已达成 |
| NFR-F02 | Pod 可投递块到显示≤1s，块级而非逐字 | 与后端 NFR-PERF-04 同口径 |
| NFR-F03 | 最近 200 条渲染/滚动可用，无每块全屏 loading | B-10、浏览器性能记录 |
| NFR-F04 | 凭据仅内存，宿主无需业务事件订阅 | S-09/12、E-09/14 |

## 3. 前端技术设计

### 3.1 技术选型（F-STACK）

| 部分 | 选型与理由 |
|---|---|
| 聊天页 | console/frontend 的 React 18、TypeScript strict、Vite、Semi，版本以锁文件为准 |
| 宿主 | 任意框架/普通 HTML；只依赖 iframe 和 postMessage |
| SDK | 独立纯 TS/JS 小入口，仅 DOM/认证握手，不打包 React/Semi |
| 状态 | 页面局部状态与 hooks，无宿主全局 store 或事件总线 |
| HTTP | src/api.ts 的显式 WebChat 客户端；DTO 在 src/types/api.ts 并 re-export |
| 流 | fetch streaming + 增量 UTF-8/SSE 解析；bearer 不放 query，不用 EventSource 自定义 header |
| 样式 | Semi token + CSS Modules，iframe 与宿主 CSS 隔离 |
| Markdown | 成熟渲染器，支持代码/表格；默认禁原始 HTML，过滤链接协议；版本实施时验证 |

### 3.2 页面、路由与产物（F-ROUTES）

| 页面/产物 | 路由/目录 | 说明 |
|---|---|---|
| 统一嵌入页 | `/webchat/embed`，src/pages/WebChat/ | 单栏聊天，脱离管理员 AppShell/登录守卫 |
| 可选 SDK | src/webchat/embed.ts，产物 `/webchat/sdk.js` | mount/destroy、认证握手 |
| 消息展示组件 | src/components/webchat/ | 容器/展示分离 |
| hooks | src/hooks/webchat/ | 请求、流、认证、媒体生命周期 |
| 协议/类型 | src/types/api.ts；src/api.ts | API/事件/握手类型集中 |
| 本地宿主 | test/webchat/ | HTML/React/Vue fixture，测试构建独立 |

main.tsx 统一挂 ConfigProvider/i18n/theme，按路由选择 WebChat 根或管理根；聊天页不读管理员 token、不弹管理员登录、不要求 Console 管理权限。

embed URL 只含 platform、parentOrigin、instanceId（SDK 生成）；Go handler 按 allowlist 校验并注入 bootstrap，这些参数不构成身份。生产在 AD 上配置独立 webchat 域名并整体指向 Console，API base 默认同源 `/api/v1/webchat`；iframe 与其 API 同源，宿主页面是另一 origin，postMessage 按 parentOrigin allowlist 校验。业务平台直连 eligibility 属跨 origin，仅该路由开 CORS allowlist，也可由平台后端代调。Console 直连 HTTP 仅用于本地验证；生产 HTTPS 宿主需可信 HTTPS 入口；宿主 frame-src 与 embed 的 frame-ancestors 均须匹配。

### 3.3 组件设计（F-COMPONENTS）

| ID | 单元 | 职责 |
|---|---|---|
| CMP-01 | WebchatPage | 认证/资格/编排，身份变化清空用户状态 |
| CMP-03 | MessageThread | 按 seq 展示最近 200 条与当前回复，无会话侧栏/分页 |
| CMP-04 | MessageBubble/MarkdownBody | 纯展示、消息状态、安全渲染 |
| CMP-05 | useWebchatStream | SSE 解析、eventSeq 恢复、按 revision 合并，无匿名 currentReply |
| CMP-06 | ImageAttachment/FileCard+useMedia | 容器负责授权拉取和 URL 生命周期，展示组件无网络 IO |
| CMP-07 | Composer | 字节/数量预检、输入与发送，不裸 fetch |
| CMP-08 | SuggestedPrompts | 内部快捷输入，无宿主事件 |
| CMP-09 | useWebchatAuth | 握手、JWT 获取/传递、受控续期、销毁 |
| CMP-10 | useMessages | 快照、乐观消息/服务端 ID 合并、活动请求 |
| CMP-11 | api.webchat | 全部聊天 HTTP/SSE/文件唯一出口 |
| CMP-12 | 管理侧 ChannelDef | mssw/mssp 及 authority 字段、双语 |
| CMP-13 | embed SDK | 无框架依赖的 iframe 挂载与认证协议 |

### 3.4 接入与组件契约

#### 3.4.1 对外最小 SDK（F-EMBED）

以下为拟实现接口，不代表已有可安装包。

```ts
type Platform = "mssw" | "mssp";
type AuthChallenge = {
  platform: Platform;
  nonce: string;
  consoleOrigin: string;
  parentOrigin: string;
};
type MountOptions = {
  container: HTMLElement;
  consoleUrl: string;
  platform: Platform;
  getToken: (challenge: AuthChallenge) => Promise<string | null>;
  locale?: "zh" | "en";
  theme?: "light" | "dark";
};
type WebchatHandle = { destroy: () => void };
declare function mount(options: MountOptions): Promise<WebchatHandle>;
```

getToken 由宿主现有认证封装提供当前平台 JWT（如从平台后端或接入适配取得），不在浏览器签名；返回 null 表示无登录态。mount Promise 覆盖加载/握手错误，聊天中的业务状态由 iframe 展示；直接 iframe 按同一协议写初始化代码；destroy 用于卸载/退出/切用户，不是监听聊天关闭。

#### 3.4.2 内部握手与认证（F-AUTH）

宿主可在挂载前用用户 JWT 调 API-06 查询资格决定是否展示入口；该调用不替代 iframe 内的资格检查，也不产生业务事件。

1. SDK 校验 URL，注册监听后创建 iframe；URL 含 platform、parentOrigin、随机 instanceId，不含 token/userId/sessionKey。
2. embed handler 验证宿主配置；iframe 生成随机 nonce，经 targetOrigin 发送 `webchat.ready {version,instanceId,nonce}`。
3. 父页校验 event.origin、event.source、instanceId 和结构；getToken 取得现有 JWT 后以 `webchat.auth` 发回 consoleOrigin。
4. iframe 校验 event.origin/source、instanceId/nonce/version，将 JWT 仅存内存；每个请求带 `Authorization: Bearer <JWT>` 与 `X-Webchat-Platform` 调 API-06/API-03/API-05。服务端独立验证签名/解密/时效/claims；postMessage 来源不作身份凭证。
5. API-06 检查资格后取 API-03 快照并连流；iframe 用 `webchat.initialized {version,instanceId,nonce,ok,errorCode?}` 确认初始化，SDK 内部完成 mount，不向宿主广播业务事件；认证失效时 SDK 内部重新握手/取 JWT 一次。

拒绝 `targetOrigin="*"`、错误窗口、旧 nonce、重复初始化和无界重试；握手超时 15 秒并报明确错误。刷新 iframe 产生新 nonce；JWT 可重复使用，不是一次性断言；完整消息/附件不经 postMessage 回父页。

API-06 返回 principalRef；续期或 401 后若 principalRef/platform 改变，先 abort 流/下载、清消息/草稿/tickets/Blob/游标，再按新身份初始化；宿主漏做 destroy 也不复用旧视图。JWT 到期只补取一次；拒绝/停权进入登录/无权限态，不用轮询绕过。凭据寿命即 JWT 有效期；平台退出即时生效范围取决于平台撤销机制（接入时定）；webchat 独立域名下业务 Cookie 不随 iframe 请求发送；HttpOnly Cookie 由平台后端或适配读取后交给 iframe，iframe 不直接读取，第三方 Cookie 不是依赖。

#### 3.4.3 内部 UI 契约（F-PROPS）

共享 DTO 引用 types/api.ts。WebchatMessage 含 messageId/seq/revision/role/textBody/status/runId/attachments；父页不能输入 sessionKey 或用户身份覆盖认证。

| 单元 | Props/内部回调 | 约束 |
|---|---|---|
| MessageBubble | message、mediaView、onDownload | 仅内部 UI 回调；无请求、无 props 修改 |
| Composer | disabled、busy、maxTextBytes=65536、maxAttachments=9、maxAttachmentBytes=31457280、onSend | busy→try/catch/finally；预检后交容器发送 |
| ConnectionStatus | connectionMode、activeRequest、error | queued/running/unknown/failed 清晰区分 |
| useWebchatStream | JWT 提供器、eventSeq、mergeEvent；返回 connectionMode/error | 卸载 abort，认证错不自动降级 |
| useMedia | mediaId、认证 epoch | 经 api.ts 取 Blob，防身份切换后旧结果回填 |

### 3.5 状态、流协议与数据获取

#### 3.5.1 客户端边界（F-API）

所有请求经 src/api.ts 的 WebChat 客户端，base path `/api/v1`；成功 `code===0` 解包 data，失败抛 ApiError（status/code/detail/requestId），Accept-Language 沿用 i18n。管理 client 用现有 token helper；webchat client 用注入的内存 JWT，绝不读取/回退管理员 token。全部聊天请求带 `Authorization: Bearer <JWT>` 与 `X-Webchat-Platform`。401 清当前 scope 凭据并派发 UNAUTHORIZED_EVENT（携带 scope）；管理根只处理 admin scope，WebChat 根只处理 webchat scope，聊天 root 回认证提示或重新握手，不跳管理员登录页。SSE/二进制解析属于 api.ts 或纯解析 helper，pages/components/hooks 不裸 fetch；JSON/SSE/文件错误统一转 ApiError，通知失败可重试。

| 方法 | 接口 | 使用者 |
|---|---|---|
| checkEligibility | API-06 | WebchatPage / 宿主入口 |
| getSnapshot / pollEvents | API-03 | useMessages/useWebchatStream |
| sendMessage | API-04 | 容器发送流程 |
| openStream | API-05 | useWebchatStream |
| uploadAttachment / downloadMedia | API-01/02 | 上传/媒体容器 |
| listNotifications / markRead | API-11/12 | iframe 内部通知 |

#### 3.5.2 状态和发送（F-STATE）

| 状态 | 内容 | 生命周期 |
|---|---|---|
| auth | jwt/expiresAt/principalRef/platform/authEpoch | 仅内存，失效/切用户清理 |
| messages | Map(messageId→完整消息)、按 seq 排序 | 最近 200 条；较新 revision 覆盖 |
| optimistic | clientMessageId→待确认用户气泡 | 同一次发送复用 ID，ACK 后合并正式 messageId |
| activeRequest | requestId/state/runId 或 null | 来源服务端，不凭 UI 计时猜完成 |
| stream | eventSeq/mode/retry/error | SSE 和轮询共用位点，切身份清零 |
| uploads/media | 上传状态、ticket、BlobURL 及 owner epoch | 卸载/切身份 abort 并释放 |
| notifications | items/unread/read | iframe 内部，无宿主共享 store |

发送：预检→上传→固定 clientMessageId→POST→合并 ACK→等服务端快照。网络结果未知时重试同 ID；明确失败且用户发起新一轮才生成新 ID，不能因超时自动重跑；unknown 保持发送互斥并显示待核实。

#### 3.5.3 流接收和恢复（F-STREAM）

1. 首屏 API-03 取一致 snapshot 和 eventSeq，保存完整消息后按该游标建 SSE。
2. fetch 流经 TextDecoder 增量解码；SSE 解析处理跨 chunk 行、CRLF、多行 data、空行、注释心跳；一个网络 chunk 不等于一个事件。
3. message.snapshot 携带 eventSeq 与完整 message，仅较新 revision 替换，不 append textBody；request.state 带真实 runId；notification 只更新内部通知。
4. 帧处理成功后才推进 eventSeq；重复丢弃；缺口/resync_required/游标过期按 API-03 重拉；超 24 小时恢复窗用完整快照；无匿名 currentReply 旁路。
5. 终态消息先持久显示再解除对应请求 busy；最终内容以服务端快照为准，不因流关闭显示成功。
6. 网络故障按 1/2/4…30 秒退避；45 秒无帧视为失活；SSE 不可用时长轮询 `afterEventSeq/waitMs=25000`，每批 200 事件有积压立即续取；连续 3 次失败停止并提示重试。
7. 401/403、auth.expired/auth.revoked 走认证流程，不轮询兜底；后台刷新不设首载 loading；解析缓冲有界，超限提示并重同步；销毁/切身份取消读流、timer 和迟到 setState。

#### 3.5.4 渲染与媒体（F-RENDER）

- Markdown 始终用当前完整 textBody；流中未闭合围栏/表格可暂按文本，后续快照重新解析。
- 禁执行代码/原始 HTML/事件属性；链接只允许约定安全协议，新窗口加 noopener/noreferrer；动态媒体只用授权下载的 object URL，不把正文 URL 当资源。
- 稳定 messageId 为 key，禁止数组 index；按 revision 避免重算已完成消息；长代码/表格在气泡内横向滚动。
- api.ts 带 JWT 取 Blob；图片懒加载、文件点击下载，及时 revoke；单文件 ≤30MiB，避免预加载全部附件。
- 用户位于底部时随新块滚动，上翻查阅时保持位置；本期无更早历史加载。

### 3.6 UI 四态（F-UI）

| 视图 | loading | empty | error | success |
|---|---|---|---|---|
| 身份初始化 | 正在连接/认证 | 等待平台登录凭据 | 未登录/无权限/配置错误 | 进入聊天 |
| 消息 | 首屏骨架 | 问候与建议问题 | 错误+重试 | 最近 200 条 |
| 回复 | queued/running | 无活动请求 | failed/interrupted/unknown 分别提示 | complete 完整内容 |
| 连接 | 重连/轮询提示 | 未建立连接 | 停止重试/重新登录 | 正常收块 |
| 上传 | 每文件状态，可显示真实进度 | 无附件 | 预检/后端错误可操作 | ticket 就绪 |
| 下载 | 按钮 loading | 无媒体 | 授权/网络失败 | 预览/下载 |
| 内部通知 | 后台加载不挡聊天 | 无未读 | 非阻塞错误+重试 | 摘要/结果/已读 |

上传如无法提供真实百分比，用不确定进度，不伪造；queued 不显示为模型已开始回复；unknown 不提供无条件"重新生成"。

### 3.7 样式与可访问性（F-STYLE）

iframe 尺寸由宿主容器决定，内部响应式单栏；沿用 Semi token/CSS Modules，不依赖父页 CSS，不接受任意 CSS/脚本注入。locale/theme 仅支持定义枚举，在 main.tsx 统一 Provider。文本走 useTranslation/i18n.t，同步 zh/en；技术 detail 沿 ErrorDetail 折叠，禁裸堆栈/路径。输入框/按钮可键盘操作，图片 alt、语义列表、状态 aria-live；Enter 发送、Shift+Enter 换行，IME 组合期间不发送；iframe 有明确 title。

## 4. 本地模拟与风险

### 4.1 本地模拟交付（F-LOCAL）

提供独立启动说明/入口和配置样例，运行模拟平台后端、HTML/React/Vue 宿主页、真实 Console 和目标 OpenClaw 容器；不同宿主端口模拟跨 origin；AD 网关/域名分流模式用本地反向代理或多端口/多 host 模拟 webchat 域名与业务域名；TLS 测试用浏览器信任的证书。模拟后端设置 HttpOnly 登录 Cookie，登录 A/B/未授权/停用账户；签发真实测试 JWT（测试 profile），支持退出、切用户、过期、错签名/claims、key 轮换；有效 JWT 可重复使用。

完整场景覆盖认证→资格→发送→真实原生通道→流式 Markdown/代码/表格→双向媒体→刷新/断网/重启。宿主只挂载和认证，测试需断言宿主没有聊天 API/SSE 请求或结果事件处理器。测试密钥临时生成、数据独立，模拟端与 fixture 不进生产产物；协议测试可用标注的 provider 替身，目标模型和 Skill 按后端 D-LOCAL 另行验收。

### 4.2 风险与依赖

| ID | 风险 | 应对 | 场景 |
|---|---|---|---|
| RISK-F01 | bearer 流式认证 | fetch streaming，凭据不放 query | S-02、S-12 |
| RISK-F02 | SSE 中断/缓冲 | 同契约轮询/游标恢复 | E-06、S-13 |
| RISK-F03 | 宿主技术栈不同 | iframe + 纯 JS SDK，无框架依赖 | S-09、S-10 |
| RISK-F04 | 前后端文件规则差异 | 后端最终验证，预检只改善体验 | E-04、E-05、B-06 |
| RISK-F05 | 凭据/身份串用 | 内存 JWT、准确窗口来源、认证 epoch 清理 | E-09、S-15 |
| RISK-F06 | 块级与逐字预期不同 | 目标镜像实测；只承诺收块即更新 | S-02 |
| RISK-F07 | `/new` 误认为删历史 | 原生回复展示，旧消息可见 | S-06 |
| RISK-F08 | 需要更早历史 | 本期明确最近 200 条 | S-05 |
| RISK-F09 | 认证算法/凭据获取未定 | 复用 JWT + 测试 profile，每请求验证；接入前定获取方式 | S-12、E-01 |
| RISK-F10 | 续期/轮换失败 | 一次受控重取后提示登录 | E-01、E-14 |
| RISK-F11 | HTTP/HTTPS、跨域嵌入及 AD 网关缓冲 | 可信 HTTPS/域名分流、embed 独立策略；AD 网关关闭 SSE 缓冲并放宽上传/长连接 | S-11、E-10 |
| RISK-F12 | Markdown/SSE 边界损坏 | 安全渲染、完整快照、真字节解析 | S-14、E-11、E-16、B-07 |
| RISK-F13 | 重试重复执行 | clientMessageId 稳定、unknown 不盲重发 | E-07、E-13 |
| RISK-F14 | 模拟泄漏生产 | fixture/构建/私钥隔离 | E-15 |

## 5. 需求追溯

| 功能 | 后端契约/设计落点 | 验收 |
|---|---|---|
| FEAT-F01 | API-06、F-AUTH/F-UI | S-01、E-01、E-02 |
| FEAT-F02 | API-03/05、F-RENDER | S-02、S-14、E-11 |
| FEAT-F03 | API-03/04/05、F-STREAM | S-13、E-06、E-08、E-13、B-07/08 |
| FEAT-F04 | API-01、F-PROPS | S-03、E-04、E-05 |
| FEAT-F05 | API-02、F-RENDER | S-04、E-12 |
| FEAT-F06 | API-03、F-STATE | S-05、E-03 |
| FEAT-F07 | API-04 原文、F-STATE | S-06、B-05 |
| FEAT-F08 | API-09/11/12、内部通知 | S-07 |
| FEAT-F09 | API-04、CMP-08 | S-17 |
| FEAT-F10 | 管理登记、F-ROUTES | S-08 |
| FEAT-F11 | embed/SDK、F-EMBED | S-09、S-10、S-11、B-09 |
| FEAT-F12 | API-06、F-AUTH/F-API | S-12、S-15、S-18、E-09、E-14 |
| FEAT-F13 | F-LOCAL、后端 D-LOCAL | S-16、E-15 |

## Spec Compliance Matrix

applied 表示约束已进入设计，不表示实现/测试完成；后端/Runtime 规则矩阵见后端设计。

| Spec/Rule | enforcement | 设计影响与落点 | item ID | 验证 | 状态 |
|---|---|---|---|---|---|
| frontend-directory-structure#RULE-frontend-directory-001 | required | §3.2 F-ROUTES 分层；§3.5 F-API 统一请求 | SC-F01 | S-01、S-08、目录审查 | applied |
| frontend-directory-structure#RULE-frontend-api-types-001 | required | §3.4 F-PROPS、§3.5 F-API，types/api.ts 与 re-export | SC-F02 | S-02、B-07、类型检查 | applied |
| frontend-quality-standards#RULE-frontend-quality-001 | required | §3.1 strict、§3.6 F-UI 四态，tsc/lint/format/vitest | SC-F03 | E-01、E-03、E-06 | applied |
| frontend-quality-standards#RULE-frontend-api-client-001 | required | §3.5 F-API，code===0/ApiError、scope 凭据清理 + UNAUTHORIZED_EVENT | SC-F04 | E-01、E-14、S-15 | applied |
| frontend-quality-standards#RULE-frontend-i18n-001 | required | §3.7 F-STYLE，全页面/SDK 错误 zh/en、i18n key | SC-F05 | S-08、S-09、双语切换 | applied |
| frontend-component-specs#RULE-frontend-component-001 | required | §3.3 F-COMPONENTS、§3.4 F-PROPS，纯展示/稳定 key/CSS Modules | SC-F06 | S-14、B-08、B-10 | applied |
| frontend-component-specs#RULE-frontend-semi-shell-001 | required | §3.1 F-STACK、§3.2 F-ROUTES，main.tsx 统一 ConfigProvider | SC-F07 | S-08、S-09、主题/语言回归 | applied |

## 附录：术语

前端 SDK 是可选的 iframe 挂载/认证封装；统一聊天组件是 iframe 内复用的 UI；块级流式是收到可交付块后显示完整消息新版本；eventSeq 用于恢复，revision 用于单消息单调更新；principalRef 是服务端返回的非秘密主体标识，用于避免切用户时复用旧视图，不作鉴权凭据。
