# Multi-User Single-Pod 架构设计

> 版本 v3（2026-07-10）｜ 结论：**企微私聊多人共享单 Pod 可行；微信多人共享、群聊强隔离、浏览器自动按用户隔离仍有边界或待验证；多 agent 并发 LLM 调用已确认可按 agent 选择不同 provider/key。**

---

## 1. 问题背景

当前架构：**每人一个 Pod**，资源消耗大。

目标：**部署一套 Pod，申请一个企微机器人，多人共享。**

当前判断：
- **可作为主方案推进**：企微私聊入口，多人共享一个 Pod，每个用户路由到独立 agent/workspace/session。
- **需要实现后才能产品化**：Console 多用户配置模型、`inject-env.mjs` 多用户配置注入、peer 自动发现/绑定管理。
- **不能作为强承诺**：微信群聊/企微群聊按人强隔离、多个用户共享同一个个人微信登录态、浏览器 profile 自动随用户切换。

核心挑战：

| 维度 | 单用户 Pod | 多用户单 Pod | 方案 |
|------|-----------|-------------|------|
| 会话隔离 | 每人一个 gateway 进程 | 同一 gateway 内隔离 | `dmScope: per-channel-peer` + bindings |
| 记忆隔离 | 每人一个 MEMORY.md | 每人一个 agent workspace | 多 agent + per-agent workspace |
| 浏览器隔离 | 每人一个 Chromium | 每人一个 browser profile | `browser.profiles` + 显式 profile 选择（待验证自动路由） |
| 一人多 IM | 同一 Pod 内多 channel | 多 channel 路由到同一 agent/workspace | `bindings` 为主，`identityLinks` 辅助身份归一 |

---

## 2. 核心机制：OpenClaw 原生 multi-agent + bindings

OpenClaw **原生支持**多 agent 架构，通过以下配置实现：

### 2.1 dmScope — 会话隔离基础

```json
{
  "session": {
    "dmScope": "per-channel-peer"
  }
}
```

- `"main"`（默认）→ 所有私聊共享 `agent:main:main` 一个 session ❌
- `"per-channel-peer"` → 按 channel+peer 分 session ✅

效果：`agent:main:wecom:direct:<用户A的userid>` 和 `agent:main:wecom:direct:<用户B的userid>` 是两个独立 session。

### 2.2 agents.list — 多人各自 workspace

```json
{
  "agents": {
    "list": [
      { "id": "alice", "workspace": "/home/node/.openclaw/agents/alice/agent" },
      { "id": "bob",   "workspace": "/home/node/.openclaw/agents/bob/agent" }
    ]
  }
}
```

每个 agent 有自己的 workspace 目录，内藏独立的 `MEMORY.md` 和 `BOOTSTRAP.md`。

### 2.3 bindings — peer → agent 路由

```json
{
  "bindings": [
    {
      "type": "route",
      "agentId": "alice",
      "match": {
        "channel": "wecom",
        "peer": { "kind": "direct", "id": "zhangsan" }
      }
    },
    {
      "type": "route",
      "agentId": "bob",
      "match": {
        "channel": "wecom",
        "peer": { "kind": "direct", "id": "lisi" }
      }
    }
  ]
}
```

WeCom 插件收到消息时调用 `resolveAgentRoute()`，按 `bindings[].match.peer` 精确匹配发送者的 WeCom userid → 路由到对应 agent → 生成独立 session key → 加载对应 workspace 的 MEMORY.md。

注意：OpenClaw 配置 schema 是 strict 模式，不能写成扁平 `{ "peer": "...", "agentId": "..." }`，必须使用 `type + match.channel + match.peer` 的结构。

匹配优先级链：`peer > peer.parent > peer.wildcard > guild+roles > guild > team > account > channel > default`

### 2.4 一人多 IM — 会话可分离，记忆必须共享

```json
{
  "session": {
    "dmScope": "per-channel-peer",
    "identityLinks": {
      "alice": ["wecom:zhangsan", "openclaw-weixin:wxid_alice"],
      "bob":   ["wecom:lisi"]
    }
  }
}
```

Alice 在 WeCom 上的 `zhangsan` 和微信上的 `wxid_alice` 应通过 `bindings` 路由到同一个 agent `alice`。两端可以保持不同 session key，但只要 agent 相同，就会使用同一个 agent workspace，并共享该 workspace 下的 `MEMORY.md` / `memory/*.md`。

注意：
- 记忆共享的关键是 **WeCom / WeChat 都路由到同一个 `agentId`**，不是必须落到同一个 session key。
- `identityLinks` 只影响 direct-message session key 的 peer canonical 化，可作为身份归一辅助；它不是共享 `MEMORY.md` 的必要条件。
- 微信通道前缀必须使用 OpenClaw 实际 channel id：`openclaw-weixin`。`wechat` / `weixin` 只是外部别名，不应直接写进 `identityLinks`。

已确认配置细节：
- `session.dmScope` 保持 `per-channel-peer`，让不同 IM 通道仍有独立会话。
- WeCom 私聊通过 `bindings[].match.channel="wecom"` + 原始大小写 userid 路由到用户 agent。
- 微信私聊通过 `bindings[].match.channel="openclaw-weixin"` + 微信 peer id 路由到同一个用户 agent。
- 同一自然人的多个 IM 身份都落到同一个 `agentId`，例如 `alice`。
- `agents.list[].workspace` 指向该用户独立 workspace，例如 `/home/node/.openclaw/agents/alice/agent`。
- 该 workspace 内的 `MEMORY.md` / `memory/*.md` 是跨 IM 共享记忆边界；会话不共享，但记忆共享。
- `AGENTS.md` 中需要补充规则：当用户从另一个 IM 询问个人事实时，先查当前 agent workspace 的记忆。

### 2.5 browser.profiles — 浏览器隔离

```json
{
  "browser": {
    "enabled": true,
    "headless": true,
    "noSandbox": true,
    "defaultProfile": "main",
    "profiles": {
      "main":  { "driver": "openclaw", "cdpPort": 18801 },
      "alice": { "driver": "openclaw", "cdpPort": 18802 },
      "bob":   { "driver": "openclaw", "cdpPort": 18803 }
    }
  }
}
```

每个 OpenClaw-managed profile 会使用独立浏览器状态目录，Chromium cookies、localStorage、登录态可以隔离。

注意：当前只确认 profile 配置能表达隔离意图；agent 是否会在工具调用时自动选择对应 profile 仍待验证。若不能自动选择，需要通过系统提示词、工具封装或 muad 层 profile 注入来保证。

---

## 3. 运行时配置（环境变量注入）

目标形态：Docker 容器启动时通过以下环境变量注入多用户配置。

当前状态：`bin/inject-env.mjs` 仍只支持通道、通道凭证、单 LLM provider、默认 agent model、工具白名单等基础配置；下面这些多用户 env var 是**待实现接口**，不是当前镜像已支持的能力。

| 环境变量 | 格式 | 说明 |
|----------|------|------|
| `AGENTS_CONFIG` | `[{"id":"alice","model":{"primary":"deepseek/deepseek-chat"}},{"id":"bob"}]` | 定义所有 agent，可选 per-agent model |
| `IDENTITY_LINKS` | `{"alice":["wecom:zhangsan","openclaw-weixin:wxid_alice"],"bob":["wecom:lisi"]}` | 一人多 IM 身份映射，channel 前缀使用 OpenClaw 实际 channel id |
| `BINDINGS_CONFIG` | `[{"channel":"wecom","peerKind":"direct","peerId":"zhangsan","agentId":"alice"}]` | peer → agent 路由规则，由注入脚本转换成 OpenClaw strict `bindings[]` |
| `BROWSER_PROFILES` | `{"alice":{"driver":"openclaw","cdpPort":18802},"bob":{"driver":"openclaw","cdpPort":18803}}` | per-user 浏览器配置 |
| `LLM_PROVIDERS` | `{"deepseek":{"apiKey":"sk-xxx"},"openai":{"apiKey":"sk-yyy","baseUrl":"https://api.openai.com/v1"}}` | 多 LLM provider（可选；未设则用旧单 provider 变量） |

**不设这些 env var 时**：保持当前单用户模式，只有 `main` agent，行为与之前一致。

---

## 4. 完整配置示例

### 4.1 Docker Compose 环境变量

```yaml
services:
  muad-shared:
    image: ghcr.io/OWNER/muad-openclaw:latest
    environment:
      - PC_USER=shared
      - LLM_PROVIDER=deepseek              # 默认 provider（向后兼容）
      - LLM_MODEL=deepseek-chat
      - LLM_API_KEY=sk-deepseek-xxx
      # 多 provider（可选，覆盖上面的单 provider 设置）
      # - LLM_PROVIDERS={"deepseek":{"apiKey":"sk-deepseek-xxx"},"openai":{"apiKey":"sk-openai-yyy","baseUrl":"https://api.openai.com/v1","api":"openai-completions"}}
      - CHANNELS=wecom
      - WECOM_BOT_ID=bot-xxx
      - WECOM_SECRET=yyy
      # 多用户配置
      - AGENTS_CONFIG=[{"id":"alice","model":{"primary":"deepseek/deepseek-chat"}},{"id":"bob","model":{"primary":"openai/gpt-4o","fallbacks":["deepseek/deepseek-chat"]}},{"id":"charlie"}]
      - IDENTITY_LINKS={"alice":["wecom:zhangsan"],"bob":["wecom:lisi"],"charlie":["wecom:wangwu"]}
      - BINDINGS_CONFIG=[{"channel":"wecom","peerKind":"direct","peerId":"zhangsan","agentId":"alice"},{"channel":"wecom","peerKind":"direct","peerId":"lisi","agentId":"bob"},{"channel":"wecom","peerKind":"direct","peerId":"wangwu","agentId":"charlie"}]
      - BROWSER_PROFILES={"alice":{"driver":"openclaw","cdpPort":18802},"bob":{"driver":"openclaw","cdpPort":18803},"charlie":{"driver":"openclaw","cdpPort":18804}}
    volumes:
      - muad-shared-state:/home/node/.openclaw
      - ./skills:/opt/openclaw-skills:ro
```

### 4.2 生成的 openclaw.json（关键部分）

```json
{
  "session": {
    "dmScope": "per-channel-peer",
    "identityLinks": {
      "alice": ["wecom:zhangsan"],
      "bob": ["wecom:lisi"],
      "charlie": ["wecom:wangwu"]
    }
  },
  "agents": {
    "defaults": {
      "workspace": "/home/node/.openclaw/workspace",
      "model": { "primary": "deepseek/deepseek-chat" }
    },
    "list": [
      {
        "id": "alice",
        "workspace": "/home/node/.openclaw/agents/alice/agent",
        "model": { "primary": "deepseek/deepseek-chat" }
      },
      {
        "id": "bob",
        "workspace": "/home/node/.openclaw/agents/bob/agent",
        "model": { "primary": "openai/gpt-4o", "fallbacks": ["deepseek/deepseek-chat"] }
      },
      { "id": "charlie", "workspace": "/home/node/.openclaw/agents/charlie/agent" }
    ]
  },
  "bindings": [
    {
      "type": "route",
      "agentId": "alice",
      "match": {
        "channel": "wecom",
        "peer": { "kind": "direct", "id": "zhangsan" }
      }
    },
    {
      "type": "route",
      "agentId": "bob",
      "match": {
        "channel": "wecom",
        "peer": { "kind": "direct", "id": "lisi" }
      }
    },
    {
      "type": "route",
      "agentId": "charlie",
      "match": {
        "channel": "wecom",
        "peer": { "kind": "direct", "id": "wangwu" }
      }
    }
  ],
  "browser": {
    "enabled": true,
    "headless": true,
    "noSandbox": true,
    "defaultProfile": "main",
    "profiles": {
      "main": { "driver": "openclaw", "cdpPort": 18801 },
      "alice": { "driver": "openclaw", "cdpPort": 18802 },
      "bob": { "driver": "openclaw", "cdpPort": 18803 },
      "charlie": { "driver": "openclaw", "cdpPort": 18804 }
    }
  }
}
```

---

## 5. 文件系统布局

```
/home/node/.openclaw/
├── openclaw.json                    # gateway 配置
├── workspace/                       # main agent 默认 workspace（单用户模式）
├── agents/
│   ├── main/                        # main agent 状态目录
│   ├── alice/
│   │   ├── agent/                   # alice 的 workspace
│   │   │   ├── BOOTSTRAP.md
│   │   │   └── MEMORY.md
│   │   └── sessions/
│   │       └── sessions.json
│   ├── bob/                         # bob 的 workspace
│   │   ├── agent/
│   │   │   ├── BOOTSTRAP.md
│   │   │   └── MEMORY.md
│   │   └── sessions/
│   └── charlie/
│       └── ...
├── browser/
│   ├── main/user-data/              # 默认 OpenClaw-managed browser profile
│   ├── alice/user-data/             # alice 的 Chromium profile
│   ├── bob/user-data/               # bob 的 Chromium profile
│   └── charlie/user-data/           # charlie 的 Chromium profile
└── openclaw-weixin/                 # 微信登录态（绑定给一个人或不启用）
```

---

## 6. BOOTSTRAP.md 行为

目标形态：`inject-env.mjs` 在容器启动时根据是否启用多用户模式，生成不同的 agent bootstrap。

当前状态：现有 `inject-env.mjs` 只为 `main` agent 写入跨通道同一用户的基础 `BOOTSTRAP.md`，尚未实现 per-agent bootstrap 生成，也尚未写入浏览器 profile 选择规则。

- **单用户模式**（只有 `main` agent，无 `IDENTITY_LINKS`）：使用原始提示词（"你服务的是同一个人"）
- **多用户模式**（多个 agent 或有 `IDENTITY_LINKS`）：使用多用户提示词，包含：
  - 如何通过 session key 判断当前用户
  - 记忆隔离规则（只存取当前用户的记忆）
  - 浏览器 profile 选择规则
  - 跨 session 数据隔离要求

---

## 7. 从当前架构迁移

### 当前：一人一 Pod

```
Pod: muad-oc-alice → WeCom bot A, MEMORY.md for alice
Pod: muad-oc-bob   → WeCom bot B, MEMORY.md for bob
```

### 目标：多人共享一 Pod

```
Pod: muad-shared → WeCom bot（共享）
  ├── agent:alice → MEMORY.md for alice, browser profile alice
  ├── agent:bob   → MEMORY.md for bob, browser profile bob
  └── agent:main  → fallback
```

**迁移步骤：**
1. 先完成 Console 多用户配置模型与 `inject-env.mjs` 多用户注入能力
2. 在目标 Pod 设置多用户 env var
3. 将各用户之前的 MEMORY.md 内容迁移到对应 agent workspace
4. 将各用户之前的 browser profile 数据迁移到对应 `browser/<profile>/user-data` 目录
5. 在企微后台保持同一个机器人不变
6. 灰度验证 peer → agent 路由、skill 进度、session-manager cookie 隔离
7. 停掉旧的 per-user Pod

---

## 8. 已知限制与 FAQ

### 8.1 限制

| 限制 | 说明 | 影响 |
|------|------|------|
| **群聊无强用户隔离** | 同一群聊的所有人共享一个 session（`agent:<id>:wecom:group:<群ID>`） | 不能承载需要严格私有上下文的任务 |
| **微信单人绑定** | 一个微信登录态只能绑定一个人，详见 §8.2 | 多用户微信需求仍需独立 Pod |
| **Browser profile 动态选择待验证** | browser tool 默认不会天然知道“当前 agent 应使用哪个 profile” | 需要系统提示词、工具封装或 muad 层注入 |
| **资源竞争** | 多人共享一个 Pod 内的 LLM 调用、浏览器、skill 子进程和文件系统资源 | 需要限制并发任务数、浏览器任务数和单任务超时 |
| **配置注入未完成** | 当前 `inject-env.mjs` 尚未支持多 agent/bindings/browser profiles/multi-provider env | 需要先实现注入脚本和 Console 管理面 |

### 8.2 微信：一个 Pod 只能绑定一个微信

**原因：** 微信插件（`@tencent-weixin/openclaw-weixin`）使用扫码登录，一个微信账号同时只能在一个地方保持登录态。登录态存储在 `/home/node/.openclaw/openclaw-weixin/` 下。

**影响：**
- 一个 Pod 最多绑定一个微信，无法给多个自然人共享同一个微信登录态
- 如果多个人都需要微信入口，仍需独立 Pod

**在多用户 Pod 中如何使用微信：**
- 方案 A：不开微信通道（最简）
- 方案 B：微信绑定给特定一个人，通过 `bindings` 路由到同一个 agent（如 Alice 同时用 WeCom + WeChat，共享同一份 agent workspace 记忆）。`identityLinks` 可作为身份归一辅助，但不要求 WeCom / WeChat 共享同一个 session key。

```json
{
  "session": {
    "identityLinks": {
      "alice": ["wecom:zhangsan", "openclaw-weixin:wxid_alice"]
    }
  }
}
```

- 方案 C：需要微信的人走独立 Pod（保持现有架构）

### 8.3 如何获取 WeCom peer ID

bindings 需要每个人的企微 userid（如 `zhangsan`），获取途径：

**方法一：企微管理后台（推荐）**
登录 [work.weixin.qq.com](https://work.weixin.qq.com) → 通讯录 → 成员详情 → 账号（userid）。

**方法二：从 session 记录自动发现（推荐做进 Console）**
让每个用户给机器人发一条消息，然后在容器的 `sessions.json` 中提取：

```json
// ~/.openclaw/agents/<agentId>/sessions/sessions.json
{
  "agent:main:wecom:direct:zhangsan": { ... },
  "agent:main:wecom:direct:lisi":     { ... }
}
```

session key 格式为 `agent:<id>:wecom:direct:<userid>`，`<userid>` 部分就是 peer ID。

Console 可以实现「从最近消息发现」功能：
1. 调用 `openclaw channels status --json` 获取最近活跃的 peer
2. 列出所有已出现的 peer ID
3. 管理员给每个 peer 分配 human user 标签（alice / bob / charlie）

**方法三：企微 API**
`GET https://qyapi.weixin.qq.com/cgi-bin/user/list?access_token=TOKEN&department_id=DEPT_ID`

可以拉取部门通讯录，拿到所有成员的 userid。

### 8.4 多 IM 身份绑定：预录入与绑定码激活

多用户模型不应直接把企微 `userid` 当作平台用户 ID。平台内应使用自己的 `human_user_id`，各 IM 的用户标识只作为外部身份：

```text
human_user
  └── identities[]
        - channel
        - external_id
        - external_id_type
        - pod_id
        - agent_id
```

示例：

```text
human_user: u_xuwenbin
agent_id: xuwenbin
pod_id: 66667

identities:
- wecom:XuWenBin                         # 超管机器人可拿到的企业明文 userid
- wecom:wojmppEQAA1lYfixAU-eb0rhEmcVD2gg # 普通机器人拿到的 scoped userid
- openclaw-weixin:o9cq804HgKSer0_xAOY8nQB7lye4@im.wechat
- feishu:ou_xxx
```

#### 新用户首个 IM 身份

当管理员可以提前拿到外部 ID（如超管创建的企微机器人拿到明文 userid），可直接创建：

```text
管理员选择 Pod
  -> 创建 human_user
  -> 创建 agent/workspace/browser profile
  -> 录入 identity(channel, external_id)
  -> 写入 bindings / identityLinks
```

当管理员无法提前拿到外部 ID（如普通用户创建的企微机器人、微信、飞书等），使用绑定码激活：

```text
管理员创建 pending human_user
  -> 选择目标 Pod / agent / channel
  -> 生成一次性绑定码
  -> 用户在指定 IM 机器人里发送绑定码
  -> Pod 从消息上下文拿到 channel + external_id
  -> 将该 external_id 绑定到 pending human_user
  -> 写入 bindings / identityLinks
```

绑定码不是用来识别用户本身，而是用来证明“当前发消息的这个 IM 身份应归属于管理员预创建的 human user”。

#### 已有用户新增 IM 身份

已有用户增加飞书、微信或另一个企微身份时，必须从用户详情页发起，不创建新用户、不创建新 agent：

```text
用户详情 -> 新增 IM 身份
  -> 选择 channel（如 feishu）
  -> 默认复用该用户当前 Pod 和 agent
  -> 生成绑定码
  -> 用户在飞书机器人里发送绑定码
  -> 系统拿到 feishu external_id
  -> 新增 identity，复用原 human_user / agent / workspace
```

绑定成功后，OpenClaw 配置新增对应 channel 的 route，并把该 identity 加入同一个 `identityLinks` 分组：

```json
{
  "bindings": [
    {
      "type": "route",
      "agentId": "xuwenbin",
      "match": {
        "channel": "feishu",
        "peer": { "kind": "direct", "id": "ou_xxx" }
      }
    }
  ],
  "session": {
    "identityLinks": {
      "xuwenbin": [
        "wecom:wojmppEQAA1lYfixAU-eb0rhEmcVD2gg",
        "feishu:ou_xxx"
      ]
    }
  }
}
```

#### 绑定码约束

- 绑定码必须指向一个明确的 `human_user_id`，不能“谁发了就新建谁”。
- 绑定码有用途：`create_user_first_identity` 或 `add_identity_to_existing_user`。
- 绑定码限定 channel、Pod、agent，避免用户发错机器人后误绑。
- 绑定码一次性使用，设置过期时间。
- `(channel, external_id)` 必须全局唯一，已绑定到其他用户时拒绝。
- 绑定成功后只更新 identity / bindings / identityLinks；已有用户新增 IM 时不得创建新 agent。

### 8.5 不同 agent 可以使用不同 LLM 供应商

openclaw 原生支持 per-agent model 配置。`agents.list` 每个 entry 的 `model` 字段（`AgentModelConfig` 类型）可以覆写全局默认：

```json
{
  "models": {
    "providers": {
      "deepseek": {
        "api": "openai-completions",
        "baseUrl": "https://api.deepseek.com",
        "apiKey": "sk-deepseek-xxx"
      },
      "openai": {
        "api": "openai-completions",
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "sk-openai-xxx"
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "deepseek/deepseek-chat" }
    },
    "list": [
      {
        "id": "alice",
        "model": { "primary": "deepseek/deepseek-chat" }
      },
      {
        "id": "bob",
        "model": {
          "primary": "openai/gpt-4o",
          "fallbacks": ["deepseek/deepseek-chat"]
        }
      }
    ]
  }
}
```

**配置优先级：** `agents.list[].model` > `agents.defaults.model`

**前提条件：**
1. 所有需要的 provider 都在 `models.providers` 里配置好（含各自的 API key）
2. 运行时通过环境变量注入多 provider 的 key（当前 `inject-env.mjs` 只支持单 provider，需扩展）
3. 如果用同一个 provider 但不同 API key（如两个 DeepSeek 账号），需要在 provider 层做区分

**多 provider 环境变量设计（待实现）：**

| 环境变量 | 格式 | 说明 |
|----------|------|------|
| `LLM_PROVIDERS` | `{"deepseek":{"apiKey":"sk-xxx","baseUrl":"...","api":"openai-completions"},"openai":{"apiKey":"sk-yyy","baseUrl":"...","api":"openai-completions"}}` | 多 provider 定义 |

与现有 `LLM_API_KEY` / `LLM_PROVIDER` 单 provider 的兼容：设了 `LLM_PROVIDERS` 就用多 provider 模式，否则 fallback 到原有的单 provider 变量。

---

## 9. Console 改造方向（TODO）

当前 Console 管理模型：`user → container → WeCom bot credentials`

需要演进为：`human user → identity (IM peer IDs) → agent → container (pod)`。Pod 与机器人绑定关系由管理员维护；用户也由管理员分配到指定 Pod，不引入独立 Message Router。

### 9.1 数据模型

```
container (pod)
  ├── channels (wecom bot, optional wechat)
  ├── agents[]
  │     ├── id, agentDir, workspace
  │     ├── model (optional per-agent override)
  │     └── browser profile (optional per-agent)
  ├── identityLinks (human user → list of channel:peerId)
  └── bindings (peer → agentId)

human_user
  ├── id, displayName, status
  ├── podId, agentId
  └── identities[]
        ├── channel
        ├── externalId
        ├── externalIdType
        └── status

binding_code
  ├── code
  ├── humanUserId
  ├── channel
  ├── podId, agentId
  ├── purpose (create_user_first_identity | add_identity_to_existing_user)
  ├── status (pending | used | expired)
  └── expiresAt
```

### 9.2 关键改动

1. **DB 层**：
   - `users` 表新增 `identity_links`、`agent_list`、`bindings`、`browser_profiles` 四列（JSON 文本）
   - 新增 human user / identity / binding code 管理表或等价 JSON 配置结构
   - `(channel, external_id)` 做全局唯一约束，避免同一个 IM 身份绑定到多个用户或多个 Pod
2. **API 层**：容器创建/编辑接口支持多用户配置字段
3. **前端**：
   - 容器编辑页新增「多人模式」tab，配置 agent list + bindings + identityLinks
   - 用户详情页支持「新增 IM 身份」，为已有 user 生成绑定码，绑定成功后复用原 Pod / agent
   - 创建用户时支持两种首个身份方式：直接录入 external ID，或生成绑定码等待激活
   - **Peer ID 自动发现**：作为兜底能力，从容器 `sessions.json` 提取已出现的 peer ID，列出让管理员分配 human user 标签
   - 浏览器 profile 管理（per-user 创建/删除）
4. **多 LLM provider**：`inject-env.mjs` 扩展支持 `LLM_PROVIDERS` JSON 注入多 provider 配置
5. **向后兼容**：不填多用户字段 = 单用户模式，行为与现在完全一致

---

## 10. 参考对比：Hermes Agent 的多用户模型

[Hermes Agent](https://github.com/NousResearch/hermes-agent) 是另一个开源的 Agent 平台（Python，Nous Research）。
以下是其多用户架构与 OpenClaw 的对比分析（源码分析日期：2026-07-09）。

### 10.1 架构差异

| 维度 | OpenClaw | Hermes |
|------|----------|--------|
| **语言** | TypeScript (Node.js) | Python 3.11+ |
| **IM 通道** | 插件架构（100+ 扩展） | 内置适配器 + 插件（24+：含 WeCom, Discord, Telegram, Slack, Signal, WhatsApp, WeChat） |
| **WeCom 支持** | ✅ 官方 npm 插件（`@wecom/wecom-openclaw-plugin`） | ✅ 插件适配器（`plugins/platforms/wecom/`） |
| **持久化** | JSON 文件（`sessions.json`） | **SQLite**（`state.db`, WAL + FTS5 全文搜索） |
| **并发模型** | per-session 序列锁 | `asyncio` + `contextvars` task-local |
| **设计重心** | 单用户多 channel → 通过 bindings 扩展为多人 | **多用户为核心设计目标** |

### 10.2 Session 隔离对比

| 场景 | OpenClaw | Hermes |
|------|----------|--------|
| **DM 隔离** | 需配置 `dmScope: "per-channel-peer"` | **默认隔离**（按 `chat_id` 或 `user_id`） |
| **群聊 per-user 隔离** | ❌ 不支持 | ✅ `group_sessions_per_user: true`（**默认！**） |
| **线程隔离** | 可选 `:thread:<id>` suffix | `thread_sessions_per_user: false`（默认共享） |
| **Session key 格式** | `agent:<id>:<channel>:<peerKind>:<peerId>` | `agent:<ns>:<platform>:<chat_type>:<chat_id>[:<user_id>]` |

**Hermes session key 生成**（`gateway/session.py:870-958`）：
```python
# DM: agent:main:wecom:dm:<chat_id>
# 群聊 group_sessions_per_user=true: agent:main:wecom:group:<群ID>:<userID>
# 群聊 group_sessions_per_user=false: agent:main:wecom:group:<群ID>
```

Hermes 默认群聊 per-user 隔离——群内每人独立 session。OpenClaw 做不到。

### 10.3 用户身份传递

| 维度 | OpenClaw | Hermes |
|------|----------|--------|
| **用户身份载体** | 隐含在 session key 中 | `SessionSource` 显式 dataclass |
| **字段** | peerId, channel, peerKind | `user_id`, `user_name`, `user_id_alt`, `chat_id`, `chat_type`, `thread_id`, `scope_id`, `profile` 等 12+ 字段 |
| **传递方式** | 函数参数链 | `contextvars.ContextVar`（asyncio task-local，并发安全） |
| **跨平台身份链接** | `session.identityLinks` ✅ | ❌ 无内置支持 |

### 10.4 Memory 对比

| 维度 | OpenClaw | Hermes |
|------|----------|--------|
| **内置 Memory** | `MEMORY.md` 文件（per-agent workspace） | `MEMORY.md` + `USER.md` 文件（per-profile） |
| **外部后端** | QMD（语义搜索） | 8 种插件（honcho, mem0, holographic, supermemory 等） |
| **隔离粒度** | per-agent workspace（通过多 agent → per-user） | per-session（session DB 关联 `user_id`） |
| **注入方式** | context file 加载到系统提示词 | `<memory-context>` XML fence + prefetch |

### 10.5 持久化对比

**OpenClaw** — `sessions.json`（JSON 文件，per-agent）：
```json
{ "agent:main:wecom:direct:zhangsan": { "sessionId": "uuid", "sessionFile": "xxx.jsonl" } }
```

**Hermes** — `state.db`（SQLite，WAL 模式）：
```sql
sessions (id, source, user_id, session_key, chat_id, chat_type, ...)
messages (session_id, role, content, tool_calls, ...)  -- 含 FTS5 全文索引
gateway_routing (scope, session_key, entry_json, ...)
```

### 10.6 WeCom 适配器对比

| 维度 | OpenClaw WeCom 插件 | Hermes WeCom 适配器 |
|------|---------------------|---------------------|
| **连接方式** | WebSocket（`@wecom/aibot-node-sdk`） | WebSocket（`wss://openws.work.weixin.qq.com`） |
| **认证** | botId + secret | bot_id + secret |
| **消息格式** | 全功能（文本、图片、文件、模板卡片） | 文本 + 媒体上传 |
| **群聊 per-user** | ❌ 群聊共享 session | ✅ `group_sessions_per_user: true` |
| **访问控制** | 插件内 DM/群组策略 | `WECOM_ALLOWED_USERS` + dm_policy / group_policy |
| **动态路由** | `resolveAgentRoute()` + bindings | `build_session_key()` 含 user_id |

Hermes 的 WeCom 适配器在**消息类型丰富度**上不如 OpenClaw 插件，但**群聊多人隔离**能力强于 OpenClaw。

### 10.7 对 muad 的影响

| 考量 | 结论 |
|------|------|
| **群聊多用户** | Hermes 默认支持 per-user 隔离 → 如果群聊是核心场景，Hermes 更合适 |
| **WeCom 生态** | OpenClaw 官方插件功能更全 → 企微私聊场景 OpenClaw 更好 |
| **工具链** | muad-progress、muad-run-skill、session-manager 围绕 OpenClaw 构建 |
| **语言栈** | Python（Hermes）vs Go+TS（muad Console）→ 团队技能匹配？ |
| **持久化** | Hermes SQLite > OpenClaw JSON |

**当前建议：**
- 以 OpenClaw 为主力平台，通过本文档的方案实现 DM 多用户
- 群聊多用户隔离的缺失通过 BOOTSTRAP.md 系统提示词部分弥补
- 如果群聊是核心场景且 WeCom 消息类型需求不复杂，可评估 Hermes
- 长期关注 Hermes WeCom 适配器的功能完善程度

---

## 11. Public + Private Skill 支持

需求：管理员维护一套 **public skills**（所有人共享），每个用户可以配置自己的 **private skills**。两者合集即是该用户拥有的全部技能。

### 11.1 OpenClaw：✅ 原生支持，与多 agent 架构完美匹配

Skill 加载有 6 层，按优先级从低到高（`src/skills/loading/workspace.ts:1229`）：

```
优先级（低→高）:
 extraDirs < bundled < managed < agents-skills-personal < agents-skills-project < workspace
```

| 层级 | 路径 | muad 用法 |
|------|------|----------|
| 1. extraDirs | `/opt/openclaw-skills/`（`skills.load.extraDirs`） | **Public skills**（只读挂载） |
| 2. bundled | OpenClaw 内置 skills | 忽略 |
| 3. managed | `~/.openclaw/skills/` | 不用 |
| 4. agents-skills-personal | `~/.agents/skills/` | 可选（跨项目个人 skills） |
| 5. agents-skills-project | `<workspace>/.agents/skills/` | 可选 |
| 6. workspace | `<agent-workspace>/skills/` | **Private skills**（最高优先级） |

**多用户部署示例**：

```
/opt/openclaw-skills/                   ← 所有 agent 共享（read-only mount，最低优先级）
├── mss-soar/SKILL.md                   ← public skill
├── xdr-query/SKILL.md                  ← public skill
└── session-manager/SKILL.md            ← public skill

/home/node/.openclaw/agents/
├── alice/agent/skills/                 ← alice 的 private skills（最高优先级）
│   └── my-custom/SKILL.md              ← 仅 alice 可见，可覆盖同名 public skill
├── bob/agent/skills/                   ← bob 的 private skills
│   └── bob-tools/SKILL.md              ← 仅 bob 可见
└── charlie/agent/skills/               ← charlie 无 private skill（只用 public）
```

**同名 skill override**：OpenClaw 原生加载顺序中 workspace（private）优先级最高，但 Muad 发布校验和 `muad-run-skill` 默认拒绝同名覆盖。确需覆盖时，private manifest 必须记录自身版本、被覆盖 public 版本和审批编号；未审批的同名 private skill 不执行。

**Per-agent skill 白名单**（`agents.list[].skills`）：限制某个 agent 只能看到指定的 skill：

```json
{
  "agents": {
    "list": [
      {
        "id": "alice",
        "skills": ["mss-soar", "xdr-query", "my-custom"]
      },
      {
        "id": "bob",
        "skills": ["mss-soar", "bob-tools"]
      }
    ]
  }
}
```

- Alice 看到：`mss-soar`, `xdr-query`, `my-custom`（2 public + 1 private）
- Bob 看到：`mss-soar`, `bob-tools`（1 public + 1 private）
- Charlie（无白名单）：所有 public skills（3 个）

**Skill 上限控制**（防止 prompt 过大）：

```json
{
  "skills": {
    "limits": {
      "maxSkillsInPrompt": 150,
      "maxSkillsPromptChars": 18000
    }
  }
}
```

### 11.2 Hermes：⚠️ 需通过 profiles 实现，不是原生 per-agent

Hermes 的 skill 加载只有两层（`agent/skill_utils.py:503-511`）：

```
优先级:
  1. ~/.hermes/skills/          ← 本地 user skills
  2. skills.external_dirs       ← 外部目录（config.yaml 配置）
```

**问题**：`~/.hermes/skills/` 是全局的，不属于某个 agent。所有 session 共享同一个 skill 目录。

**要实现 per-user private skill**，必须走 profiles（`multiplex_profiles`）：

```
~/.hermes-profiles/
├── alice/
│   └── skills/                  ← alice 的 skills（public + private 混合）
│       ├── mss-soar/            ← 从 shared 复制来的 public
│       └── my-custom/           ← alice 的 private
├── bob/
│   └── skills/                  ← bob 的 skills
│       ├── mss-soar/
│       └── bob-tools/
└── shared-skills/               ← external dir（所有 profile 共享）
    ├── mss-soar/SKILL.md
    └── xdr-query/SKILL.md
```

这种方式的问题：
- profile 的 `skills/` 目录混合了 public + private（没有分离）
- public skill 更新时需要同步到所有 profile
- 没有同名 override 机制——local skills 目录和 external dirs 之间不按同名 override，先找到的生效
- 没有 per-user skill 白名单

### 11.3 对比总结

| 特性 | OpenClaw | Hermes |
|------|----------|--------|
| **Public skills（共享只读）** | `extraDirs` ✅ | `skills.external_dirs` ✅ |
| **Private skills（per-user）** | `workspace/skills/` ✅ | ❌ 需走 profile + `skills/` |
| **同名 override（private > public）** | ✅ 6 层优先级，workspace 最高 | ❌ 先找到的生效 |
| **Per-user skill 白名单** | `agents.list[].skills` ✅ | ❌ |
| **加载优先级** | 6 层（代码注释明确规定） | 2 层（local > external） |
| **Skill 数量/字符上限** | `maxSkillsInPrompt` + `maxSkillsPromptChars` ✅ | ❌ |
| **与多用户方案的集成** | 多 agent workspace 天然隔离 | 多 profile 手工隔离 |
| **Public skill 更新** | 改一次，所有 agent 即时生效（`watch: true`） | 需同步到所有 profile |

**结论**：OpenClaw 的 public + private skill 架构较好适配 muad 的需求，尤其适合“public skill 只读共享 + private skill 放入 agent workspace”的模式。Hermes 需要额外的手工同步和 profile 管理。

---

## 12. 实机验证记录

在测试 Pod `muad-oc-66667`（K8s, OpenClaw 2026.6.10, DeepSeek v4-pro）上逐项验证。
验证日期：2026-07-09 至 2026-07-10。

### 12.1 ✅ dmScope: "per-channel-peer" — 会话隔离

**配置：**
```json
{ "session": { "dmScope": "per-channel-peer" } }
```

**验证方式：** 两个不同企微用户分别给同一个机器人发私聊。

**结果：**
```
agent:main:wecom:direct:wojmppeqaak5ytes5hexbxkosm1bot5w    ← 用户 A
agent:main:wecom:direct:wojmppeqaazzqcloxwtg7deml3worz5g    ← 用户 B
```
两个用户各自独立的 session key，对话上下文不互通。✅

### 12.2 ✅ bindings — peer → agent 路由

**正确格式（关键！）：**
```json
{
  "bindings": [
    {
      "type": "route",
      "agentId": "alice",
      "match": {
        "channel": "wecom",
        "peer": { "kind": "direct", "id": "wojmppEQAAk5ytes5HExBXKoSM1bOt5w" }
      }
    }
  ]
}
```

> **⚠️ 踩坑：** 不能写成扁平 `{peer, agentId}`。必须用嵌套 `match.peer` + `match.channel`。Schema 是 `.strict()` 模式，格式不对直接报 `Invalid input`。`peer.id` 必须用**原始大小写**的 WeCom userid（非 session key 中的小写版本）。

**日志确认：**
```
[wecom] [dynamic-routing] matchedBy=binding.peer, agentId=alice
[wecom] 检测到匹配的 bindings (matchedBy=binding.peer)，跳过动态路由
```

**结果：** WeCom 用户消息正确路由到 `agent:alice`。✅

### 12.3 ✅ 一人多 IM — 同 agent 共享记忆

**配置：**
```json
{
  "session": {
    "dmScope": "per-channel-peer",
    "identityLinks": {
      "alice": ["wecom:wojmppEQAAk5ytes5HExBXKoSM1bOt5w", "openclaw-weixin:o9cq804HgKSer0_xAOY8nQB7lye4@im.wechat"],
      "bob":   ["wecom:wojmppEQAAZZqcLOxwtG7dEML3WoRZ5g"]
    }
  }
}
```

> **注意：** `identityLinks` 的 channel 前缀必须与 OpenClaw 实际参与 session key 计算的 channel ID 一致。个人微信使用 `openclaw-weixin`，不是 `wechat`。跨 IM 共享记忆的关键不是 session key 是否相同，而是 WeCom / WeChat 是否都通过 `bindings` 路由到同一个 `agentId`。

**结果：**
- WeCom 消息 → `sessionKey="agent:alice:wecom:direct:alice"` ✅
- WeChat 消息 → 可通过 binding 路由到 `agent:alice` ✅
- 两者 session 可以按 channel 分开，但都使用 `/home/node/.openclaw/agents/alice/agent` workspace，能共享 `MEMORY.md` / `memory/*.md` ✅
- 已实机确认：在 WeCom 写入个人记忆后，WeChat 能通过同一 agent workspace 读回该记忆 ✅

**当前验证环境配置细节：**
- `dmScope`: `per-channel-peer`
- WeCom Alice peer: `wojmppEQAAk5ytes5HExBXKoSM1bOt5w`
- WeChat Alice peer: `o9cq804HgKSer0_xAOY8nQB7lye4@im.wechat`
- WeChat channel id: `openclaw-weixin`
- Alice agent workspace: `/home/node/.openclaw/agents/alice/agent`
- Alice workspace 已补充 `AGENTS.md` 规则：跨 IM 会话可以分离，但同一 agent workspace 是共享记忆边界。
- Bob agent workspace: `/home/node/.openclaw/agents/bob/agent`
- Bob workspace 同样补充了跨 IM 记忆边界规则，后续绑定 Bob 的微信时沿用相同模式。

### 12.4 ✅ `_comment` 字段 — Schema 兼容性

**验证方式：** 往 `openclaw.json` 手动插入 `_comment` key，重启 gateway。

**结果：**
```
session: Unrecognized key: "_comment"
<root>: Unrecognized key: "_comment"
```

**结论：** OpenClaw schema 全局 `.strict()`——任何未知 key 都会导致启动失败。

**影响：**
- `baseline-config.json` 可以保留 `_comment`（`seed-config.mjs` 的 deep merge 跳过 `_` 前缀 key）✅
- `openclaw.json` 绝不能有 `_comment`（`inject-env.mjs` 全程不写 `_comment`——安全）✅

### 12.5 ✅ 多 agent 同时启动

**配置：**
```json
{
  "agents": {
    "list": [
      { "id": "alice", "workspace": "/home/node/.openclaw/agents/alice/agent" },
      { "id": "bob",   "workspace": "/home/node/.openclaw/agents/bob/agent" }
    ]
  }
}
```

**验证方式：** 配 2 个 agent + 各自 bindings + identityLinks，重启 gateway。

**结果：**
- Gateway 启动无错误，`ready`
- alice/、bob/、main/ 三个 agent workspace 目录全部存在 ✅
- alice 的 `MEMORY.md` 和 sessions 完整保留（PVC 持久化）✅
- bob 的 `MEMORY.md` 和 sessions 自动创建 ✅
- WeCom + WeChat 通道全部认证成功，无竞态问题 ✅

### 12.6 ✅ muad 工具链兼容性（muad-run-skill + muad-progress）

**验证方式：** Alice 通过企微触发 `example-long-task` skill。

**结果：**
```
[muad-run-skill] progress skill=example-long-task stage=accepted   outbound=true
[muad-run-skill] progress skill=example-long-task stage=auth       outbound=true
[muad-run-skill] progress skill=example-long-task stage=query      outbound=true
[muad-run-skill] progress skill=example-long-task stage=analysis   outbound=true
[muad-run-skill] progress skill=example-long-task stage=done       outbound=true
```

全部 5 个阶段 `outbound=true`，进度正确投递到 Alice 的企微会话。

**路由原理：** `delivery.mjs:resolveDeliveryContext()` 从 `toolContext.sessionKey`（如 `agent:alice:wecom:direct:alice`）解析 channel + recipient → `sendDurableMessageBatch` 投递。基于 session key 路由，多 agent namespace 天然隔离，无需额外改造。✅

### 12.7 ⚠️ Browser profile 多用户隔离 — 待验证

**正确配置（已验证可启动）：**
```json
{
  "browser": {
    "enabled": true,
    "headless": true,
    "noSandbox": true,
    "cdpPortRangeStart": 18800,
    "defaultProfile": "main",
    "profiles": {
      "main":  { "driver": "openclaw", "cdpPort": 18801 },
      "alice": { "driver": "openclaw", "cdpPort": 18802 },
      "bob":   { "driver": "openclaw", "cdpPort": 18803 }
    }
  }
}
```

> **⚠️ 踩坑：**
> - 每个 profile 必须指定 `cdpPort`（或 `cdpUrl`），否则 schema 报 `Profile must set cdpPort or cdpUrl`
> - `userDataDir` 只能用 `driver="existing-session"`，`driver="openclaw"` 下 openclaw 自动管理 `~/.openclaw/browser/<name>/user-data`
> - Browser 配置变更**必须完整重启 Pod**（`kubectl rollout restart`），SIGUSR1 hot-reload 不够

**当前状态：** 配置已正确，Chrome 懒启动。Agent 需要触发 browser tool 才能验证 tab 隔离和 profile 路由。

**待验证：**
- Agent 能否根据当前 session 选择正确的 browser profile？
- 两个用户同时用浏览器时，tabs 是否按 session 隔离（`session-tab-registry.ts`）？
- 并发浏览器任务的内存峰值？

### 12.8 ⚠️ 并发浏览器任务 — 待验证

同 §12.7，需要两个用户同时触发 browser tool 才能实测。

### 12.9 ⚠️ 群聊 per-user 隔离 — 待验证

OpenClaw 不支持群聊 per-user 隔离（所有群成员共享 `agent:<id>:wecom:group:<群ID>` 一个 session）。Hermes 默认支持（`group_sessions_per_user: true`）。

需要群聊实测确认 agent 在共享 session 中能否正确识别发言人（通过 `[sender_name]` 前缀）。

### 12.10 ✅ 多 agent 并发 LLM 调用

**验证方式：** 在 `muad-oc-66667` 内配置 3 个 agent，其中 Alice / Charlie 分别绑定不同 DeepSeek provider，Bob 走默认 provider，然后同时触发三路 LLM 调用。

**关键配置：**
```json
{
  "models": {
    "providers": {
      "deepseek": { "baseUrl": "https://api.deepseek.com", "api": "openai-completions" },
      "deepseek-old": { "baseUrl": "https://api.deepseek.com", "api": "openai-completions" },
      "deepseek-new": { "baseUrl": "https://api.deepseek.com", "api": "openai-completions" }
    }
  },
  "agents": {
    "list": [
      {
        "id": "alice",
        "workspace": "/home/node/.openclaw/agents/alice/agent",
        "model": { "primary": "deepseek-old/deepseek-v4-pro" }
      },
      {
        "id": "bob",
        "workspace": "/home/node/.openclaw/agents/bob/agent"
      },
      {
        "id": "charlie",
        "workspace": "/home/node/.openclaw/agents/charlie/agent",
        "model": { "primary": "deepseek-new/deepseek-v4-pro" }
      }
    ]
  }
}
```

**结果：**

| Agent | Session Key | Trajectory provider | 回复标记 | 状态 |
|-------|-------------|---------------------|----------|------|
| alice | `agent:alice:llm-diffkey-alice` | `deepseek-old` | `ALICE_DIFFKEY_OK` | success |
| bob | `agent:bob:llm-diffkey-bob` | `deepseek` | `BOB_DIFFKEY_OK` | success |
| charlie | `agent:charlie:llm-diffkey-charlie` | `deepseek-new` | `CHARLIE_DIFFKEY_OK` | success |

结论：
- `agents.list[].model.primary` 可以为不同 agent 指向不同 provider/model。
- 同一 Pod 内多 agent 并发 LLM 调用没有出现模型配置串用。
- provider 的 API key 按 provider 配置隔离；文档只记录 provider 名称，不记录真实 key。
- 本轮通过 `openclaw agent` CLI 触发，CLI 因 Gateway scope pending approval 自动走 embedded fallback；provider 选择逻辑已在 trajectory 中确认。若要覆盖完整 IM/Gateway 链路，可再由 Alice / Charlie 分别从企微触发一次同类测试。

---

### 验证汇总

| # | 验证点 | 状态 | 关键结论 |
|---|--------|------|---------|
| 1 | dmScope 会话隔离 | ✅ | `per-channel-peer` 下不同企微用户各自独立 session |
| 2 | bindings 路由 | ✅ | 必须嵌套 `match.peer` 格式，peer.id 用原始大小写 |
| 3 | 跨 IM 共享记忆 | ✅ | WeCom + WeChat 路由到同一 agent/workspace；记忆写入后可跨 IM 回读 |
| 4 | `_comment` schema | ✅ | `.strict()` 拒绝未知 key，方案不受影响 |
| 5 | 多 agent 启动 | ✅ | 2+ agent 同时启动无竞态，workspace 正确初始化 |
| 10 | 工具链兼容性 | ✅ | muad-run-skill 进度正确投递到正确 session |
| 6 | Browser 多用户隔离 | ⚠️ | 配置已就绪，功能待实测 |
| 7 | WeCom dynamic vs bindings | ✅ | bindings 匹配时跳过 dynamic routing |
| 8 | 群聊 per-user 隔离 | ⚠️ | OpenClaw 不支持，需群聊实测 |
| 9 | 并发 LLM 调用 | ✅ | Alice/Charlie 可分别使用不同 DeepSeek provider/key，Bob 走默认 provider，无串用 |

### 验证环境关键配置汇总

```json
{
  "session": {
    "dmScope": "per-channel-peer",
    "identityLinks": {
      "alice": ["wecom:wojmppEQAAk5ytes5HExBXKoSM1bOt5w", "openclaw-weixin:o9cq804HgKSer0_xAOY8nQB7lye4@im.wechat"],
      "bob": ["wecom:wojmppEQAAZZqcLOxwtG7dEML3WoRZ5g"],
      "charlie": ["wecom:wojmppEQAA1lYfixAU-eb0rhEmcVD2gg"]
    }
  },
  "agents": {
    "list": [
      {
        "id": "alice",
        "workspace": "/home/node/.openclaw/agents/alice/agent",
        "model": { "primary": "deepseek-old/deepseek-v4-pro" }
      },
      { "id": "bob", "workspace": "/home/node/.openclaw/agents/bob/agent" },
      {
        "id": "charlie",
        "workspace": "/home/node/.openclaw/agents/charlie/agent",
        "model": { "primary": "deepseek-new/deepseek-v4-pro" }
      }
    ]
  },
  "bindings": [
    {
      "type": "route", "agentId": "alice",
      "match": { "channel": "wecom", "peer": { "kind": "direct", "id": "wojmppEQAAk5ytes5HExBXKoSM1bOt5w" } }
    },
    {
      "type": "route", "agentId": "alice",
      "match": { "channel": "openclaw-weixin", "peer": { "kind": "direct", "id": "o9cq804HgKSer0_xAOY8nQB7lye4@im.wechat" } }
    },
    {
      "type": "route", "agentId": "bob",
      "match": { "channel": "wecom", "peer": { "kind": "direct", "id": "wojmppEQAAZZqcLOxwtG7dEML3WoRZ5g" } }
    },
    {
      "type": "route", "agentId": "charlie",
      "match": { "channel": "wecom", "peer": { "kind": "direct", "id": "wojmppEQAA1lYfixAU-eb0rhEmcVD2gg" } }
    }
  ],
  "models": {
    "providers": {
      "deepseek": { "baseUrl": "https://api.deepseek.com", "api": "openai-completions" },
      "deepseek-old": { "baseUrl": "https://api.deepseek.com", "api": "openai-completions" },
      "deepseek-new": { "baseUrl": "https://api.deepseek.com", "api": "openai-completions" }
    }
  },
  "browser": {
    "enabled": true, "headless": true, "noSandbox": true,
    "cdpPortRangeStart": 18800, "defaultProfile": "main",
    "profiles": {
      "main":  { "driver": "openclaw", "cdpPort": 18801 },
      "alice": { "driver": "openclaw", "cdpPort": 18802 },
      "bob":   { "driver": "openclaw", "cdpPort": 18803 }
    }
  }
}
```

对应 agent workspace 还需要补充提示文件规则，建议写入每个用户 workspace 的 `AGENTS.md`：

```md
## Muad Cross-IM Memory

This user may talk to you from WeCom and WeChat. Those channels can have separate conversation sessions, but they are the same human when routed to this agent workspace.

- Use this workspace as the shared memory boundary for the person behind this agent.
- When the user asks you to remember a durable personal fact, update MEMORY.md or memory/YYYY-MM-DD.md in this workspace.
- When the user asks for a remembered personal fact from another IM channel, consult this workspace memory before saying you do not know.
- Do not share this workspace memory with other agents or group/shared contexts.
```

---

## 13. 核心待确认点

以下 2 项是当前方案仍未完全确认的点。它们不影响“企微私聊多用户共享 Pod”的主路径判断，但会影响方案边界和上线承诺。

| 待确认项 | 当前判断 | 建议验证方式 |
|----------|----------|--------------|
| Browser profile 多用户隔离 | 待确认 | Alice/Bob 同时触发 browser tool，检查是否使用各自 profile、tab 是否隔离；若不能，补工具封装或 prompt 约束 |
| 群聊 per-user 隔离边界 | 已知不支持强隔离，待确认可用边界 | 只做非敏感场景试用，确认 agent 能否可靠识别发言人；敏感任务强制引导用户私聊机器人 |

以下是落地任务或压测项，不归入“待确认点”：

- `inject-env.mjs` 多用户配置注入：实现 `AGENTS_CONFIG`、`BINDINGS_CONFIG`、`IDENTITY_LINKS`、`BROWSER_PROFILES`、`LLM_PROVIDERS` 解析与 schema 校验。
- Console 管理模型：新增 human user / identity / agent / binding 管理能力，先支持企微私聊。
- WeCom peer ID 自动发现：让未绑定用户先发消息，从 sessions 或 channel status 中发现 peer，再由管理员绑定到 agent。
- session-manager cookie 隔离：按 agent workspace 或用户状态目录隔离 SOAR/XDR/MSSW/SDSP 登录态。
- private skill 安装/覆盖策略：验证 Alice 的 private skill 能覆盖 public skill，Bob 不受影响。
- 100 人容量模型：明确 100 注册用户还是 100 并发用户，再压测 LLM、skill 子进程、浏览器和消息通道。
