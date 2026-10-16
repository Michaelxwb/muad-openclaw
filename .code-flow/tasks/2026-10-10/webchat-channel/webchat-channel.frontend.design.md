# WebChat 对话入口 前端模块需求与设计简报

> **文档编号**: FE-WEBCHAT-001
> **文档版本**: v1.4
> **创建日期**: 2026-10-10
> **文档状态**: 草稿

**评审边界说明**:
- **需求评审**: 第 2 章（需求分析）→ 通过后锁定需求基线
- **设计评审**: 第 3 章（前端技术设计）→ 通过后锁定设计基线

**ID 体系**: US（用户故事，来自 PRD）、FEAT（功能）、CMP（组件）、NFR（非功能指标）
场景编号：S-（正常）、E-（异常）、B-（边界）

**填写约定**: 本简报覆盖**两个前端单元**：① 业务平台（MSSW/MSSP）内的聊天 UI（主交付）② muad Console 管理侧的最小登记改动（通道选项与类型）。框架中立描述，业务平台按自身栈实现。

**v1.2 修订说明**：交互改为**单窗口单会话线**（与企微一致）；删除会话列表/新建/切换全部交互；`/new` 等斜杠命令作为普通消息发送，Console 原样透传；前端不再持有 `conversationId` 状态。

**v1.3 修订说明**：附件预检类型收窄为白名单（办公文档 + 压缩包 + 常用图片，见 §3.1 数据请求节）；历史消息改为**仅展示最近 200 条**，删除"向上滚动加载更早"交互与滚动监听逻辑。

**v1.4 修订说明**：鉴权**直接复用平台既有的 session JWT**，不再由平台额外签发、也不由前端签发。前端只负责把已在手里的 JWT 带到 Console（或靠 cookie 透传，前端零改动）。`getToken` prop 的语义随之改变，见 §3.2。

---

## 目录

- [1. 文档控制](#1-文档控制)
- [2. 需求分析](#2-需求分析)
  - [2.1 需求概述](#21-需求概述-必填)
  - [2.2 功能方案](#22-功能方案-必填)
  - [2.3 范围与边界](#23-范围与边界-必填)
  - [2.4 验收条件](#24-验收条件-必填)
- [3. 前端技术设计](#3-前端技术设计)
  - [3.1 技术选型](#31-技术选型-必填)
  - [3.2 页面与路由结构](#32-页面与路由结构-必填)
  - [3.3 组件设计](#33-组件设计-必填)
  - [3.4 组件接口契约](#34-组件接口契约-必填)
  - [3.5 状态与数据流](#35-状态与数据流-必填)
  - [3.6 UI 状态](#36-ui-状态-必填)
  - [3.7 样式方案](#37-样式方案-必填)
- [4. 风险与依赖](#4-风险与依赖)
- [Spec Compliance Matrix](#spec-compliance-matrix)
- [附录：术语表](#附录术语表)

---

## 1. 文档控制

### 1.1 责任人

| 角色 | 姓名 | 职责范围 |
|------|------|---------|
| 开发负责人（业务平台前端） | 待定 | 聊天 UI 实现 |
| 开发负责人（muad Console） | 待定 | 通道登记与管理侧最小改动 |
| 设计/交互 | 待定 | 视觉与交互稿（参照现有安全 GPT 助手） |

### 1.2 修订历史

| 版本 | 日期 | 作者 | 变更描述 |
|------|------|------|---------|
| v0.1 | 2026-10-10 | | 初始草稿 |
| v1.3 | 2026-10-11 | | 确立附件类型白名单；历史仅展示最近 200 条，移除向上翻页 |
| v1.4 | 2026-10-13 | | 鉴权改为直接复用平台 session JWT，前端零额外签发逻辑 |

---

## 2. 需求分析

### 2.1 需求概述 [必填]

| 项目 | 内容 |
|------|------|
| **模块名称** | WebChat 对话入口（业务平台内置） |
| **需求类型** | 新页面 / 新组件 / 新交互 |
| **业务背景** | Human User 在已登录的 MSSW/MSSP 页面上直接与安全 GPT 助手对话，无需切换到外部 IM |
| **核心目标** | 提供与现有安全 GPT 助手体验一致的对话界面：问候语、输入框、快捷指令、建议问题、附件上传与下载；**单对话窗口，`/new` 开新会话（与企微一致）** |

**对齐结论**：前端入口代码写在**业务平台**内；muad Console 只提供后端 API；浏览器经**平台 nginx** 以 `location /muad-api/` 前缀重写反代到 Console 的 `/api/v1/webchat/`，MSSW Flask/uWSGI 不在聊天链路上。

**关键简化**：一个用户只有一条会话线，**无会话列表、无会话切换**；`/new` 只是输入框里的一条普通消息，claw 回 `✅ New session started.`——与企微逐字一致。前端因此**不需要管理任何会话标识**。

**鉴权（v1.4）**：身份凭据就是平台自己的 session JWT，**前端不需要新造任何东西**：

| 平台 JWT 存放形式 | 前端要做的事 |
|---|---|
| **HttpOnly cookie（推荐）** | **零**。同域路径下浏览器自动带 cookie，nginx 透传给 Console |
| localStorage | 请求时带上 `Authorization: Bearer <token>`；401 时静默刷新或引导重新登录 |

具体走哪种由平台方确认（`{待平台补充}`），前端按其中一种实现即可，两者都只需十几行。

### 2.2 功能方案 [必填]

| 功能ID | 功能名称 | 功能描述 | 优先级 | 来源 |
|--------|---------|---------|--------|------|
| FEAT-F01 | 对话主界面 | 问候语（含用户名）、输入框、发送、附件按钮 | P0 | 需求描述 |
| FEAT-F02 | 消息列表 | 用户/助手消息气泡，文本 + 图片 + 附件卡片 | P0 | US-01 |
| FEAT-F03 | 增量渲染 | SSE 块级流式（默认）或长轮询降级 | P0 | US-01 |
| FEAT-F04 | 附件上传 | multipart 上传，前端预检大小（30 MiB）与**白名单类型** | P0 | US-03 |
| FEAT-F05 | 附件下载/预览 | 图片内联渲染；非图片经签名 URL 下载 | P0 | US-04 |
| FEAT-F06 | 历史消息展示 | 拉取**最近 200 条**；无向上翻页、无加载更多 | P1 | US-02 |
| FEAT-F07 | 新会话（`/new`） | 输入 `/new` 或点按钮发出普通消息；claw 回确认语 | P1 | US-06 |
| FEAT-F08 | 通知提示 | 未读通知角标；重开页面拉取 `pendingNotifications` | P1 | US-07 |
| FEAT-F09 | 快捷指令与建议问题 | 横向滚动 chips + "你可以问我"列表 | P1 | 需求描述 |
| FEAT-F10 | Console 通道登记 | `channels.ts` 增 mssw/mssp；`types/api.ts` 扩 Channel 联合；i18n 双语 | P0 | FEAT-02（后端） |

> **已删除**（v1.0 遗留，v1.1 起因上游不支持多会话、v1.2 因确立单窗口）：原 FEAT-F06「会话列表：会话切换、未读数、新建会话」整体移除。

---

### 2.3 范围与边界 [必填]

| 类别 | 内容 |
|------|------|
| **范围（In Scope）** | ① 业务平台聊天页（组件树 / 契约 / 状态 / 四态）② 附件上传下载交互 ③ SSE + 长轮询双模客户端 ④ **单窗口 + `/new` 透传** ⑤ 历史消息分页 ⑥ 通知角标 ⑦ muad Console 侧通道登记（`channels.ts`/`types/api.ts`/i18n） |
| **非范围（Out of Scope）** | ① muad Console 托管聊天 SPA（已否决）② 业务平台侧会话存储 ③ 逐字 token 级流式 ④ 后端 API 实现（见后端设计简报）⑤ 视觉设计稿产出（仅给结构与状态规范）⑥ **会话列表 / 会话切换 / 会话新建**（上游只有一条会话线，UI 给出即误导）⑦ 斜杠命令的包装、解释或白名单（原样透传） |
| **有意妥协 / 技术债** | ① 块级流式（1 s 内增量），非逐字 ② 长轮询降级路径作为 SSE 不可用时的兜底 ③ 附件预览仅图片内联，其余走下载 ④ `/new` 后旧消息仍可见（与企微一致），由用户自行理解新会话语义 |

### 2.4 验收条件 [必填]

**正常场景**

| 场景ID | 功能ID | 优先级 | 测试层级 | 关键真实边界 | 操作步骤 | 预期 UI 结果 |
|--------|--------|--------|---------|-------------|---------|-------------|
| S-01 | FEAT-F01/F02 | P0 | E2E | Browser → nginx → Console API → UI | 已登录平台，打开聊天页，输入问题并发送（JWT 随请求自动/显式携带） | 用户消息立即上屏（右对齐）；助手回复以块级增量出现；发送按钮在 in-flight 期间禁用 |
| S-02 | FEAT-F03 | P0 | E2E | Browser → SSE → UI | 发送消息后保持页面打开 | 回复分块持续渲染；done 后输入框恢复可用 |
| S-03 | FEAT-F04 | P0 | E2E | Browser → Console 上传 → UI | 选择 5 MiB `.png` 随消息发送 | 上传进度可见；消息带图片缩略图；助手回复引用该图 |
| S-04 | FEAT-F05 | P0 | E2E | Browser → 签名 URL → UI | 助手回复含附件 | 图片内联渲染；非图片显示下载卡片，点击经签名 URL 下载 |
| S-05 | FEAT-F06 | P1 | E2E | Browser → Console → UI | 已有超过 200 条历史；退出平台重新登录 | 显示**最近 200 条**；**无「加载更多」按钮、无向上滚动加载**；更早消息不可见 |
| S-06 | FEAT-F07 | P1 | E2E | Browser → Console → 真实 Pod | 输入 `/new` 并发送 | `/new` 作为右对齐消息气泡上屏；claw 回 `✅ New session started.`（左对齐 + 内容由AI生成）；**与企微逐字一致，无额外分隔线 UI** |
| S-07 | FEAT-F08 | P1 | E2E | Browser → Console → UI | 长任务运行期间关闭页面，完成后重开 | 未读角标显示；点击通知跳到消息位置并看到结果 |
| S-08 | FEAT-F10 | P0 | E2E | Console 前端 → Console API | 管理员在新建 Pod 表单勾选 mssw/mssp | 复选框与标识正常渲染；Pod 创建请求 channels 含新通道 |

**异常场景**

| 场景ID | 功能ID | 测试层级 | 关键真实边界 | 触发条件 | UI 表现 |
|--------|--------|---------|-------------|---------|---------|
| E-01 | FEAT-F01 | integration | Service → UI | JWT 过期或验签失败（401） | 提示"登录已过期，请重新登录"，不展示任何历史内容 |
| E-02 | FEAT-F01 | integration | Service → UI | 已登录但未授权（eligibility 返回 canChat:false） | **不渲染聊天入口**（平台侧根本不展示） |
| E-03 | FEAT-F02 | integration | Service → UI | 历史消息接口失败 | 错误文案 + 重试按钮 |
| E-04 | FEAT-F04 | integration | Service → UI | 附件超 30 MiB | 上传前即拦截，提示大小上限，不发起请求 |
| E-05 | FEAT-F04 | integration | Service → UI | 附件类型不在白名单 | 选择后即提示不支持该类型 |
| E-06 | FEAT-F03 | E2E | Browser → SSE | SSE 连接中断（网络/nginx） | 自动降级为长轮询；顶部提示"连接不稳定，已切换兼容模式" |
| E-07 | FEAT-F03 | E2E | Browser → Console | Pod 不可用（`pod_unavailable`） | 消息已上屏但标记"服务恢复中"；不丢消息 |
| E-08 | FEAT-F06 | integration | Service → UI | 历史消息接口失败/游标异常 | 展示已加载部分并提示刷新重试；不做无限重试 |

**边界场景**

| 场景ID | 测试层级 | 关键真实边界 | 字段/条件 | 边界值 | 预期行为 |
|--------|---------|-------------|----------|--------|---------|
| B-01 | unit | 上传预检函数 | 附件大小 | 30 MiB / 30 MiB+1 | 前者放行，后者拦截且不发请求 |
| B-02 | unit | 上传预检函数 | 附件数量 | 9 / 10 | 9 放行；10 拦截 |
| B-03 | unit | 文本长度 | text 字符数 | 64 KiB / 64 KiB+1 | 输入框计数提示；超出禁止发送 |
| B-06 | unit | 附件类型预检 | 扩展名 + 大小 | `.png` / `.exe` / 30 MiB+1 | `.png` 放行；`.exe` 直接拦截不发请求；超限拦截 |
| B-04 | unit | 轮询退避 | 连续失败次数 | 3 次 | 停止轮询并提示重试，避免打爆接口 |
| B-05 | unit | 命令识别 | text 以 `/` 开头 | `/new` / 普通文本 | `/new` 仍按普通消息发出（**前端不解释、不拦截命令**） |

**非功能指标**

| 指标ID | 指标名称 | 目标值 | 测量方法 |
|--------|---------|-------|---------|
| NFR-PERF-01 | 首屏可交互 | ≤ 2 s（内网） | Lighthouse / 实测 |
| NFR-PERF-02 | 发送到首字上屏 | ≤ 3 s（不含模型耗时） | 实测 |
| NFR-PERF-03 | 长列表滚动 | 50 条无卡顿 | 实测 |
| NFR-SEC-01 | JWT 不在前端新造/不落额外存储 | 不自行生成、不修改、不另存 token；`authMode='cookie'` 时前端完全接触不到 JWT | 代码审查 |

---

### 3.1 技术选型 [必填]

| 类别 | 选型 | 版本 | 选型理由 |
|------|------|------|---------|
| 框架（业务平台） | 按其现有栈 | — | 不引入新框架；本文档只定义契约与行为 |
| 框架（muad Console） | React 18 + TypeScript + Vite | 沿用 | 仅加通道登记，不动架构 |
| 状态管理（业务平台） | 页面/组件局部状态 | — | 聊天状态不跨页共享；单窗口无需会话级 store |
| 路由（业务平台） | 平台现有路由，新增 `/assistant`（或既有入口） | — | 入口在业务平台内 |
| 样式方案 | 平台现有样式体系 + 设计 tokens | — | 与业务平台视觉一致 |
| 数据请求 | 平台现有封装，新增 `webchatService` | — | 统一收口，组件内禁止裸 fetch；`webchatService` 负责按 `authMode` 附带 JWT |
| 流式 | SSE（`EventSource` 或 `fetch` + ReadableStream） | — | `EventSource` 无法带 `Authorization` 头，故**默认用 `fetch` streaming** |
| UI 组件库（muad Console） | Semi Design | 沿用 | `channels.ts` 复用既有 `ChannelDef` |

**关于 SSE 客户端的重要约束**：`new EventSource(url)` **不支持自定义请求头**，而本方案必须带 `Authorization: Bearer <token>`。因此默认实现用 `fetch` + `response.body.getReader()` 手动解析 `data:` 行。若平台更倾向 `EventSource`，则需改为 query 传 token（会进 nginx access log，不推荐）或 nginx 转 cookie。

### 3.2 页面与路由结构 [必填]

| 页面 | 路由 | 布局 | 说明 |
|------|------|------|------|
| 安全 GPT 助手（弹层/抽屉） | 平台现有入口触发 | **单栏消息流**（桌面与窄屏一致，无侧栏） | 参照现有设计：问候语 + 输入框 + 快捷指令 + 建议问题；`/new` 即一条普通消息 |
| 会话历史（可选独立页） | `/assistant/history` | 列表 | 若产品要独立历史页则启用 |

> 布局与现有"安全 GPT 助手"保持一致：时间问候语（上午好/下午好）+ 用户名 + 副标题；中部建议问题列表（"你可以问我"）；底部输入框 + 附件 + 发送；输入框上方横向滚动快捷指令 chips；右下/底部"历史会话"入口。

### 3.3 组件设计 [必填]

**组件树**

```
<AssistantPage>                      # 容器：鉴权、会话解析、编排（无会话状态）
├─ <MessageThread>                   # 容器：消息分页 + 滚动加载
│  ├─ <MessageBubble>                # 展示：role 决定左右对齐
│  │  ├─ <TextBody>                  # 展示
│  │  ├─ <ImageAttachment>           # 展示：签名 URL 懒加载
│  │  └─ <FileCard>                  # 展示：名称/大小/下载
│  └─ <StreamingBubble>              # 展示：整体替换 currentReply
├─ <QuickPrompts>                    # 展示：横向 chips
├─ <SuggestedPrompts>                # 展示：建议问题列表
└─ <Composer>                        # 容器：输入 + 附件 + 发送（/new 即普通文本）
   ├─ <AttachmentPreview>            # 展示：待发送附件列表
   └─ <UploadProgress>               # 展示
```

> **已删除**（v1.2）：`<SessionSidebar>` / `<SessionItem>` / `<NewSessionButton>` 及"会话切换"全部交互——上游只有一条会话线，UI 不给切换入口（RULE-12）。

| 组件ID | 组件名 | 类型 | 复用来源/去向 | 职责 |
|--------|--------|------|--------------|------|
| CMP-01 | AssistantPage | 容器 | 新建 | 鉴权初始化、唯一会话解析、编排 |
| CMP-03 | MessageThread | 容器 | 新建 | 消息分页、游标、滚动加载 |
| CMP-04 | MessageBubble | 展示 | 新建 | role 样式、文本、媒体分发 |
| CMP-05 | StreamingBubble | 展示 | 新建 | 整体替换 `currentReply`，不自增 append |
| CMP-06 | ImageAttachment / FileCard | 展示 | 新建 | 签名 URL 懒加载、下载 |
| CMP-07 | Composer / AttachmentPreview / UploadProgress | 容器+展示 | 新建 | 输入、附件预检、上传进度、发送 |
| CMP-08 | QuickPrompts / SuggestedPrompts | 展示 | 新建 | 指令与建议问题 |
| CMP-09 | useWebchatStream | hook | 新建 | SSE 连接、自动降级轮询、退避 |
| CMP-10 | useMessages | hook | 新建 | 历史消息分页与游标 |
| CMP-11 | webchatService | service | 新建 | 全部 HTTP 调用的唯一出口 |
| CMP-12 | ChannelDef(mssw/mssp) | 配置 | 改 `console/frontend/src/channels.ts` | Console 通道登记 |

> **分层纪律**：容器组件负责数据与状态，展示组件纯 UI（props in / events out）。`webchatService` 是唯一发请求的地方，组件/hook 不得裸 `fetch`。

### 3.4 组件接口契约 [必填]

**CMP-01 `<AssistantPage>`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| platform | `'mssw' \| 'mssp'` | Y | — | 平台标识 |
| authMode | `'cookie' \| 'bearer'` | Y | — | 由平台 JWT 存放形式决定 |
| checkEligibility | `() => Promise<boolean>` | Y | — | 平台侧决定是否展示入口 |
| containerMode | `'modal' \| 'page'` | N | `'modal'` | 弹层或独立页 |
| entryText | string | N | — | 外部传入的待发送首条消息（从建议问题进入） |

| Events / 回调 | 载荷类型 | 触发时机 |
|--------------|---------|---------|
| `onUnreadChange` | `{count}` | 未读数变化 |

> **无会话相关 Props/Events**：一个用户只有一条会话线，前端不持有任何会话标识。
> **无 `getToken` Prop**：v1.4 起不再需要前端换取 token——`authMode` 已足够描述两种透传方式。

**CMP-04 `<MessageBubble>`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| message | `WebchatMessage` | Y | — | 消息对象 |
| selfUserId | string | Y | — | 判断 role=user 时靠右 |
| resolveMediaUrl | `(mediaId) => Promise<string>` | Y | — | 取签名 URL |

| Events | 载荷类型 | 触发时机 |
|--------|---------|---------|
| `onRetry` | `{messageId}` | 失败消息点击重试 |
| `onDownload` | `{mediaId, fileName}` | 点击下载 |

**CMP-07 `<Composer>`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| disabled | boolean | N | false | in-flight 期间禁用 |
| maxTextBytes | number | N | 65536 | 64 KiB |
| maxAttachments | number | N | 9 | |
| maxAttachmentBytes | number | N | 31457280 | 30 MiB |
| acceptedExtensions | string[] | N | `['.txt','.md','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.zip','.tar.gz','.tgz','.png','.jpg','.jpeg','.gif','.webp','.bmp']` | 附件类型白名单（§3.1 数据请求节）；后端以嗅探 MIME 为最终判据 |

| Events | 载荷类型 | 触发时机 |
|--------|---------|---------|
| `onSend` | `{text, files: File[]}` | 点击发送 |
| `onAttachmentRejected` | `{reason, fileName}` | 预检失败 |

> 组件内**禁止直接修改 props**；改值通过事件上抛。附件预检（大小/数量/类型）在 `Composer` 内完成，不合法则不发请求（B-01/B-02/B-03）。

**CMP-09 `useWebchatStream`**

| 返回值 | 类型 | 说明 |
|--------|------|------|
| status | `'idle' \| 'streaming' \| 'polling' \| 'error'` | 当前模式 |
| currentReply | string | 已累积回复文本（整体替换） |
| connect / disconnect | `() => void` | 手动控制 |
| error | `ApiError \| null` | 最近错误 |

> 内部行为：优先建 SSE；断线/失败自动切长轮询（`GET .../{id}?after=cursor`）；长轮询连续失败 3 次退避停止（B-04）。

### 3.5 状态与数据流 [必填]

**状态划分**

| 状态 | 作用域 | 形状 | 读写方 |
|------|--------|------|--------|
| messages | 页面级 | `{items[], nextSeq, loading}` | useMessages（无 `hasMore`：不做更早分页） |
| currentReply | 页面级 | `{runId, text, inFlight}` | useWebchatStream |
| attachments | 组件级 | `{pending: File[], uploading: Record<string, number>}` | Composer |
| unread | 页面级 | `number` | useNotifications |
| token | 内存（不落 localStorage） | `{value, expiresAt}` | AssistantPage |

> **无 `session` / `conversations` 状态**：会话由 Console 按登录用户唯一解析，前端零会话管理负担。

**数据流**

```
用户操作 → 事件处理 → webchatService(API 封装) → 页面 State → 重渲染
                                          ↑
                              SSE / 轮询推送 currentReply
```

**数据获取层**

| Service 方法 | 对应后端接口 | 调用方组件/hook |
|-------------|-------------|----------------|
| `checkEligibility()` | `GET /webchat/v1/eligibility`（带 JWT） | AssistantPage（入口展示判断） |
| `uploadAttachment(file)` | `POST /webchat/v1/attachments` | Composer |
| `listMessages(afterSeq?, limit?)` | `GET /webchat/v1/messages`（带 JWT） | useMessages（`limit` ≤ 200；无 `afterSeq` 时返回最近 200 条） |
| `sendMessage(payload)` | `POST /webchat/v1/messages`（带 JWT） | Composer（`/new` 即 `{text:"/new"}`） |
| `openStream(onEvent)` | `GET /webchat/v1/stream`（带 JWT） | useWebchatStream |
| `resolveMediaUrl(mediaId)` | `GET /webchat/v1/attachments/{mediaId}/content` | MessageBubble |

> 斜杠命令不走独立 service：`sendMessage({text:"/new"})` 即可，claw 的确认语经 `listMessages`/`openStream` 同路返回。

### 3.6 UI 状态 [必填]

| 视图/交互 | loading | empty | error | success |
|----------|---------|-------|-------|---------|
| 消息线程 | 首屏骨架 | 空会话显示问候语 + 建议问题 | 错误 Banner + 重试 | 最近 200 条消息气泡流（无翻页控件） |
| 增量回复 | StreamingBubble 呼吸动效 | — | `error` 帧提示 + 重试按钮 | 文本逐块增长 |
| 附件上传 | 进度条 + 百分比 | — | 大小/类型拦截提示（不发请求） | 预览缩略图 / FileCard |
| 附件下载 | 按钮 loading | — | 下载失败提示 | 浏览器下载或图片放大 |
| 通知角标 | — | 无未读不显示 | 拉取失败静默（不打扰对话） | 角标数字 |

### 3.7 样式方案 [必填]

| 维度 | 约定 |
|------|------|
| **样式与逻辑分离** | 业务平台按自身规范；muad Console 侧仅通道登记，无新增样式 |
| **设计 tokens** | 间距/颜色/字号引用平台 design token，不散落魔法值 |
| **响应式断点** | 单栏布局，≥768px 与 <768px 仅调整输入区与气泡最大宽度，不改变结构 |
| **滚动行为** | 消息区自动滚底；因仅有最近 200 条、无向上翻页，**不实现滚动位置恢复与「回到底部」悬浮按钮**（v1.3 简化） |
| **可访问性** | 语义标签（`<main>`/`<ul>`/`<li>`）；图片 `alt`；输入框 `aria-label`；焦点管理（打开弹层聚焦输入框，关闭还原焦点）；键盘可达（Enter 发送、Shift+Enter 换行） |

---

## 4. 风险与依赖 [按需]

| 风险ID | 描述 | 影响 | 应对 | 验证场景 |
|--------|------|------|------|---------|
| RISK-F01 | `EventSource` 不能带 Authorization 头 | 无法直接用于鉴权 | 用 `fetch` streaming；或改 query/cookie | S-02 |
| RISK-F02 | nginx 无法关 buffering / 调 timeout | SSE 不可用 | 前端自动降级长轮询 | E-05 |
| RISK-F03 | 平台前端框架与 SSE/ReadableStream 兼容问题 | 流式不可用 | 降级长轮询（同一接口） | E-05 |
| RISK-F04 | 附件预检规则与产品预期不一致 | 用户体验 | 白名单与上限做成 props 可配，产品确认后调整 | B-01/B-02 |
| RISK-F05 | JWT 存 localStorage 遭 XSS 窃取 | 安全 | 优先推动平台用 HttpOnly cookie（前端零接触）；若只能是 localStorage，则不另存副本、只读用 | NFR-SEC-01 |
| RISK-F09 | 平台 JWT 无用户 `_id` claim 或 claim 名与约定不符 | 高 | 方案立项前已确认含 user_id；实现时由后端以配置声明 claim 名并对样例 token 启动校验 | S-01 |
| RISK-F10 | 平台轮换签名密钥后 Console 公钥失效 | 全量 401 | 后端支持多公钥按 `kid` 并存；平台轮换前先推新公钥 | E-01 |
| RISK-F06 | 块级流式观感粗于预期 | 体验 | 实测粒度；必要时与后端协商逐字方案 | S-02 |
| RISK-F07 | 用户误以为 `/new` 后历史被删除 | 困惑/重复提问 | 旧消息仍可见且 `/new` 气泡即分隔，与企微一致；可在首次使用时加一次引导 | S-06 |
| RISK-F08 | 用户需要 200 条以前的上下文 | 无法追溯 | 产品已确认只需最近 200 条；如确有需要再由后端评估提高上限（镜像表全量落库，数据仍在） | S-05 |

---

## Spec Compliance Matrix

| Spec/Rule | enforcement | 设计影响 | 设计落点 | 验证场景 | 状态/N/A 理由 |
|-----------|-------------|---------|---------|---------|----------------|
| `frontend-directory-structure#RULE-frontend-directory-001` | required | muad Console 新增通道必须登记在 `src/channels.ts`，HTTP 经 `api.ts`；业务平台侧要求等价收敛（`webchatService`） | FEAT-F10；§3.3 CMP-11/CMP-12；§3.5 数据获取层 | S-08 | applied |
| `frontend-directory-structure#RULE-frontend-api-types-001` | required | webchat 契约类型集中定义并 re-export，避免页面重复定义漂移 DTO | §3.4 各组件 Props 类型引用统一契约；FEAT-F10 | S-01, S-08 | applied |
| `frontend-quality-standards#RULE-frontend-quality-001` | required | strict typing；异步必须显式 loading/error/success 三态 | §3.6 UI 状态表（每个视图四态齐备） | S-01, E-02 | applied |
| `frontend-quality-standards#RULE-frontend-api-client-001` | required | Console 侧如有管理页必须走 `api.ts`（`/api/v1`、`code===0` 解包、401 清 token + `UNAUTHORIZED_EVENT`）；业务平台侧按等价约定 | §3.5 数据获取层；FEAT-F10 | S-08 | applied |
| `frontend-quality-standards#RULE-frontend-i18n-001` | required | 新增 `channel.mssw`/`channel.mssp` 及 hint key 须同步 `locales/zh.ts` 与 `en.ts` | FEAT-F10 | S-08 | applied |
| `frontend-component-specs#RULE-frontend-component-001` | required | props 必须类型化；展示组件不含网络 IO；列表 key 稳定；布局优先组件库而非 inline style | §3.3 分层纪律；§3.4 Props 表 | S-01 | applied |
| `frontend-component-specs#RULE-frontend-semi-shell-001` | required | muad Console 侧沿用 `ConfigProvider`（`main.tsx`），不新包一层 | FEAT-F10（零架构改动） | S-08 | applied |

> `PATTERN-*` 为 advisory，仅作参考实践。

---

## 附录：术语表

| 术语 | 定义 |
|------|------|
| CMP | Component，组件 |
| 容器组件 | 负责数据获取与状态的组件 |
| 展示组件 | 纯 UI、props 驱动、事件上抛的组件 |
| SSE | Server-Sent Events，服务端推送 |
| 块级流式 | 以 `reply_payload_sending` 粒度的增量推送，非逐字 |
| 签名 URL | 带 HMAC 签名与过期时间的媒体访问地址 |
| 降级长轮询 | SSE 不可用时改用 `GET .../{id}?after=cursor` 轮询 |

---

*文档结束*
