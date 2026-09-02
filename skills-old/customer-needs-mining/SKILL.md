---
name: customer-needs-mining
description: 从企微客户群聊天记录中挖掘客户需求。自动拉取群聊历史消息，区分企微用户和微信用户，提取客户需求（功能需求/问题反馈/咨询/投诉），分析优先级和情绪，输出结构化需求报告。
---

# 客户需求挖掘

> 从企微客户群聊天记录中提取和分析客户需求。**完全自包含**，不依赖外部 MCP 服务。

## ⚡ 首次使用（仅需一次）

在某台机器上第一次使用时，AI Agent 应执行：

```bash
node scripts/install.js
```

这会在 wecom-openclaw-plugin 中注入群消息自动入库的钩子。

安装完成后重启 Gateway：`openclaw gateway restart`

之后将机器人拉入任意群，群内所有消息都会自动记录到本地。

> 💡 `install.js --dry` 可干跑检查，`install.js --undo` 可卸载还原。

## 架构

```
skill/customer-needs-mining/
├── SKILL.md              ← 本文件（AI 操作手册）
├── scripts/
│   ├── install.js        ← 一键安装钩子（仅首次执行）
│   └── store.js          ← 消息存储 & 查询（纯 Node.js，零依赖）
└── data/                 ← 数据文件（自动创建）
    ├── group_<群名1>.json
    ├── group_<群名2>.json
    └── ...
```

## 前置条件

1. **Node.js 可用**（标准库即可，零额外依赖）
2. **已安装钩子**（`install.js` 执行过一次）
3. **机器人已加入目标客户群**

## 触发条件

- 用户说"分析客户群需求"、"提取群聊需求"、"看看群里客户提了什么需求"
- 用户指定群名 + 时间范围要求分析
- 用户直接发送群名

## 数据工具：`scripts/store.js`

所有命令在 skill 目录下通过 `node scripts/store.js <cmd>` 执行。

### 命令参考

```bash
# 插入一条消息
node scripts/store.js insert <群名> <群ID> <发送者ID> <发送者名称> "<消息内容>" "<时间>"

# 查询群消息（分页）
node scripts/store.js query <群名> [--days=7] [--sender=xxx] [--limit=200] [--offset=0]

# 列出所有有消息的群
node scripts/store.js list

# 列出群内发言者（按消息数排序）
node scripts/store.js senders <群名>

# 清理 N 天前的旧数据（默认 7 天）
node scripts/store.js cleanup [--days=7]

# 统计群消息概况
node scripts/store.js stats <群名> [--days=7]
```

### 数据字段

每条消息存储的字段：

| 字段 | 说明 |
|------|------|
| `msgid` | 消息唯一标识（自动生成） |
| `roomid` | 群 ID（企微原始群 ID） |
| `roomname` | 群名称（人类可读） |
| `sender` | 发送者 ID |
| `sender_name` | 发送者名称（优先企微姓名，其次微信昵称） |
| `msgtype` | 消息类型：`text` |
| `content` | 消息文本内容 |
| `msgtime` | 发送时间 `YYYY-MM-DD HH:mm:ss` |

## 核心流程

```
用户指定目标群 + 时间范围
    │
    ├─ 0. 如果用户说"录入/收集/记录"群消息
    │       └─ 先调用 wecom_mcp call msg get_message 拉取企微消息
    │          然后逐条用 store.js insert 写入本地
    │
    ├─ 1. node scripts/store.js list → 确认群名存在
    │       └─ 如果用户给的群名匹配不上，提示可用的群列表
    │
    ├─ 2. node scripts/store.js senders <群名> → 了解群内成员
    │       └─ sender_name 里带有"微信"或匹配不上的 → 标注为微信客户
    │
    ├─ 3. node scripts/store.js query <群名> --days=N → 分页拉取
    │       └─ 如果 has_more=true，用 --offset 翻页，直到全部获取
    │
    ├─ 4. AI 需求分析
    │       ├─ 需求识别: 功能需求 / 问题反馈 / 咨询 / 投诉 / 建议
    │       ├─ 需求分类: 按主题/产品/模块
    │       ├─ 紧急度: 🔴高 🟡中 🟢低
    │       ├─ 客户画像: 谁提的最多、情绪趋势、活跃度
    │       ├─ 未响应标记: 客户发问后无人回复的
    │       └─ 关键信号: 流失风险/续约意愿/竞品提及
    │
    └─ 5. 输出结构化报告
```

## 输出格式

```markdown
## 📊 客户需求分析报告

**群名称**：XX客户服务群
**分析时段**：YYYY-MM-DD ~ YYYY-MM-DD
**消息总量**：X,XXX 条
**活跃人数**：XX 人

---

### 🔥 需求摘要

| # | 时间 | 客户 | 类型 | 需求描述 | 紧急度 | 状态 |
|---|------|------|------|----------|--------|------|
| 1 | 07-22 14:30 | 张三(微) | 功能需求 | 希望增加批量导出 | 🔴高 | ⚠️未响应 |
| 2 | 07-23 09:15 | 李四(企) | 问题反馈 | 登录页白屏 | 🟡中 | ✅已处理 |

### 📈 需求分布

- 功能需求：X 条（XX%）
- 问题反馈：X 条（XX%）
- 咨询：X 条（XX%）
- 投诉：X 条（XX%）
- 建议：X 条（XX%）

### 👤 客户画像

- 最活跃：XXX（XX 条消息）
- 情绪趋势：积极 / 中性 / 消极
- 微信用户 XX 人 / 企微用户 XX 人

### 🤖 AI 分析

- **热点需求 TOP 3**：
  1. ...
  2. ...
  3. ...
- **风险信号**：
  - ⚠️ 未响应需求 X 条（超过24小时无人回复）
  - ⚠️ 提及竞品 X 次
- **建议行动**：
  1. ...
  2. ...
```

## 消息入库流程

⚠️ **重要**：分析之前，消息必须先入库。入库有两种方式：

### 方式 A：从企微拉取（推荐）

如果 `wecom_mcp` 可用，直接从企微拉取消息并写入本地：

```
1. wecom_mcp call msg get_msg_chat_list → 获取群列表，找到目标群 chatid
2. wecom_mcp call msg get_message (chat_type=2) → 拉取群消息
3. 逐条调用: node scripts/store.js insert "<群名>" "<chatid>" "<userid>" "<sender_name>" "<content>" "<send_time>"
4. 最后: node scripts/store.js cleanup --days=7
```

### 方式 B：手动批量导入

用户提供 JSON 格式的群消息，用脚本批量写入。

### 方式 C：Webhook 实时收集

配合企微 Webhook 回调，消息实时写入 `store.js insert`。

## 用户类型区分规则

| sender / sender_name 特征 | 判定 | 标签 |
|--------------------------|------|------|
| sender_name 含中文字符（无"微信"标记） | 企微用户 | (企) |
| sender_name 含"微信"标记 / 特殊格式 | 微信用户 | (微) |
| sender_name 为纯英文/数字/emoji | 可能是微信用户 | (微?) |

⚠️ `store.js` 存储的是 `sender_name`（回调中已含的昵称），区分规则基于此字段做推断。

## 注意事项

1. **7 天自动清理**：每次 `insert` 操作后自动删除 7 天前的旧记录，防止数据膨胀
2. **按群名隔离**：每个群一个 JSON 文件，互不干扰
3. **ID 一致性**：同一用户在不同消息中 sender 保持一致，用于统计
4. **非文本消息**：图片/文件/语音暂不分析内容，消息类型会标注
5. **隐私保护**：报告中展示的是 sender_name，不暴露原始 sender ID
6. **分页控制**：单次 query 默认 200 条，群消息量大时分批拉取
7. **可迁移**：`store.js` 零依赖，只需 Node.js，复制整个 skill 目录即可在其他环境使用
