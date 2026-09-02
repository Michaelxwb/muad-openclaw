---
name: wecom-group-msg-monitor
description: "监控与分析企微群聊消息。从企微群聊中拉取消息，拆解用户需求，提取并分析客户需求（功能需求/问题反馈/咨询/投诉），输出结构化分析报告。"
---

# 企微群消息监控与分析

> 从企微客户群聊天记录中自动拉取消息并按用户需求分析提取结构化结果。

## 架构

```
skill/wecom-group-msg-monitor/
├── SKILL.md              ← 本文件（AI 操作手册）
├── scripts/
│   ├── find_wechat_id.py  ← 根据客户名称查找 wechat_id
│   └── fetch_and_store.py ← 拉取企微群聊消息
└── references/            ← 参考文档（如需）
```

## 前置条件

1. **Cookie 有效**：`M:\Users\User\Downloads\cookies.txt` 包含有效的 SOAR 登录 Cookie
2. **Python 脚本可用**：`scripts/find_wechat_id.py` 和 `scripts/fetch_and_store.py`

## 触发条件

- 用户说"监控群聊"、"分析群消息"、"看看群里在聊什么"、"客户群里有什么需求"
- 用户指定群名 + 分析维度
- 用户提出需要从企微群中提取某类信息

---

## 第一步：需求拆解

从用户输入中拆解出三个关键信息：

1. **客户信息**：一个客户名称 / 多个客户名称 / N个客户 / 全部客户
   - ⚠️ **必填**，未指定时必须主动询问
2. **时间信息**：哪个时段的消息？
   - 如果用户未指定，**默认取近1天**（最近一天），并告知用户
3. **诉求/分析目标**：要分析什么？

   分析维度可选：功能需求 / 问题反馈 / 咨询 / 投诉 / 建议 / 竞品提及 / 情绪趋势 / 未响应消息 / 活跃度 / 全面分析

**拆解确认模板**：

```
从你的需求中，我理解需要：
📌 客户：[客户A、客户B] / [所有客户]
📌 时段：[2026-07-29 ~ 2026-07-30]（用户未指定，默认取近1天）
📌 诉求：[功能需求 + 问题反馈]

确认无误的话我就开始拉取消息。
```

> ⚠️ **客户信息必填**，未指定时必须主动询问。
> ⚠️ **时间信息未指定时默认近1天**，并告知用户。
> ⚠️ **诉求信息未指定时默认全面分析**，并告知用户。

---

## 第二步：拉取群消息

分三个子步骤：获取 wechat_id → 设置时间范围 → 循环拉取消息。

### 2.1 获取 wechat_id

基于第一步拆解出的客户范围，调用 `find_wechat_id.py` 获取 wechat_id。

```
用法：
  py skills/wecom-group-msg-monitor/scripts/find_wechat_id.py --keyword "<客户名称>" [--limit 100] [--offset 0] [--output-file <path>]

返回 JSON：
  - 精准匹配：{"is_match": "match", "result": {"wechat_id": "customer"}}
  - 模糊匹配：{"is_match": "fuzz_match", "result": {"wechat_id1": "customer1", ...}}
  - 无匹配：   {"is_match": "not_match", "result": null}
  - keyword为空：{"total": N, "result": {"wechat_id": "customer", ...}}
```

#### 场景 A：单个客户名称

用户输入 `"南充职业技术学院"` → 调用 `find_wechat_id.py --keyword "南充职业技术学院"`：

- **情况 A1**：`is_match=match`，或 `is_match=fuzz_match` 且 result 只有一个 key → 直接取这个 `{wechat_id: customer}` dict
- **情况 A2**：`is_match=fuzz_match` 且 result 有多个 key → 列出所有 customer 值让用户选：

  ```
  匹配到多个客户群：
  [1] 中国水利水电第九工程局有限公司
  [2] 中国水利水电第九工程局项目部
  请回复编号或完整名称确认。
  ```

  用户选择后，精确匹配到对应的 `{wechat_id: customer}` dict。

- **情况 A3**：`is_match=not_match` → 告知用户未找到：
  ```
  未找到与"XXX"匹配的客户群，请确认客户名称后重新输入。
  ```

#### 场景 B：多个客户名称

用户输入 `"南充职业技术学院、五洲传播出版社"` → 对每个名称单独执行**场景 A**的逻辑，汇总所有 `{wechat_id: customer}` dict。

#### 场景 C：取 N 个客户 / 全部客户

用户输入 `"取50个客户"` / `"所有客户"` → 调用 `find_wechat_id.py --keyword "" --limit 100 --offset 0`：

- 取返回的 `result` dict（`{wechat_id: customer, ...}`）
- 如果 result 数量不足目标数，`offset += limit` 继续翻页
- 目标数由用户指定；"全部客户"时翻页直到 result 不再增长

### 2.2 设置时间范围

根据第一步拆解出的时间范围，转换为毫秒时间戳：

```
during_start = 起始日期的毫秒时间戳（当天 00:00:00）
during_end   = 结束日期的毫秒时间戳（当天 23:59:59）
```

### 2.3 循环拉取群消息

对 2.1 获取到的 `{wechat_id: customer}` dict，调用 `batch_fetch.py`：

```bash
py skills/wecom-group-msg-monitor/scripts/batch_fetch.py \
  --wechat-map-file "skills/wecom-group-msg-monitor/tmp/wechat_map.json" \
  --during-start <ms> \
  --during-end <ms> \
  --limit 20 \
  --output-file "skills/wecom-group-msg-monitor/tmp/batch_fetch.json"
```

> 所有临时文件统一写到 `skills/wecom-group-msg-monitor/tmp/`，不要用 `%TEMP%`。

**脚本逻辑**：
- 外层遍历每个 wechat_id
- 内层以 `message_seq` 循环翻页，直到返回为空
- 每次翻页后合并 messages 并按 `msg_time` 升序排列

**输出结构**：

```json
{
  "<wechat_id>": {
    "customer": "客户名称",
    "messages": [
      {"msg_time": "2026-07-22 09:00:00", "content": "消息内容"},
      ...
    ]
  },
  ...
}
```

**拉取完成提示**：

```
已拉取完成：
📌 北京中央戏剧学院：48 条消息（2026-07-22 ~ 2026-07-30）
📌 五洲传播出版社：26 条消息（2026-07-22 ~ 2026-07-30）
共 74 条消息，开始分析...
```

---

## 中间存储：JSON 文件

第二步的输出写入 `skills/wecom-group-msg-monitor/tmp/` 目录。

- `tmp/` 目录统一存放本次流程的所有临时文件（wechat_map JSON、batch_fetch 输出 JSON、分析脚本等）
- 第三步读取该文件进行分析
- ⚠️ **第四步清理时删除整个 `tmp/` 目录下所有文件**

### 2.4 API limit 上限

`batch_fetch.py` 默认 `--limit 100`，但 SOAR wechat/view API 的实际 limit 上限为 **20**。
超过 20 会返回 `code=9064, msg=无效的输入`。

**必须使用 `--limit 20`** 调用 `batch_fetch.py`，不允许使用默认值 100。

---

## 第三步：分析与输出

读取第二步生成的 JSON 文件，获取 `customer_wechat_msg_dict` 进行 AI 分析。

### 分析原则

1. **只分析 messages 字段**：聚焦 `customer_wechat_msg_dict[wechat_id].messages` 中每条消息的 `content`
2. **每条结论必须有举证**：引用具体的客户名（`customer`）、发送者（`sender`）、时间（`msg_time`）、消息内容原文
3. **区分 user_type**：`expert` 是服务方发言，`customer` 是客户发言，分析需求时重点关注 `customer` 类型的消息

### 分析维度

| 维度 | 关注点 | 举证要求 |
|------|--------|----------|
| 功能需求 | 客户提出的新功能诉求、改进建议 | 引用客户原话 |
| 问题反馈 | Bug 报告、使用问题、异常情况 | 引用问题描述 + 时间 |
| 咨询 | 产品使用疑问、配置询问、流程咨询 | 引用问句 + 是否有回复 |
| 投诉 | 不满情绪、服务抱怨 | 引用情绪化表达 |
| 竞品提及 | 提到竞品名称、对比、切换意向 | 引用竞品名 + 上下文 |
| 情绪趋势 | 积极/中性/消极 | 引用典型消息佐证 |
| 未响应 | 客户发问后长时间无人回复 | 引用问句 + 回复时间差 |
| 活跃度 | 发言频率、活跃时段 | 统计发言次数 |

### 输出格式

每条分析结论必须附举证，格式如下：

```markdown
## 📊 群消息分析报告

**客户**：客户A、客户B
**分析时段**：YYYY-MM-DD ~ YYYY-MM-DD
**消息总量**：X 条

---

### 🔥 需求发现

#### 1. [需求类型] 需求标题
- **需求描述**：xxx
- **举证**：
  > [客户名] [发送者] @ [时间]
  > "消息内容原文"
- **紧急度**：🔴高 / 🟡中 / 🟢低
- **处理状态**：✅已响应 / ⚠️未响应 / ⏳处理中

...（逐条列出所有发现的需求）

### 📈 整体分析

- 需求分布统计
- 客户情绪趋势
- 热点问题 TOP 3

### 🎯 建议行动

1. ...
2. ...
```

### 重要提醒

- ⚠️ **必须有原文举证**：不要凭空下结论，每个判断都要从 messages 中找到对应的消息原文
- 📌 **保留上下文**：customer 字段（客户名）、sender（发送者）、msg_time（时间）是举证的关键信息，不可丢失
- 🎯 **关注 customer 发言**：客户（user_type=customer）的发言是需求分析的核心来源

---

## 第四步：清理临时文件（强制）

> ⚠️ **此步骤不可跳过！** 分析报告输出完毕后必须立即执行。

### 4.1 执行清理

删除 `tmp/` 目录下所有文件：

```powershell
Remove-Item "skills\wecom-group-msg-monitor\tmp\*" -Force -ErrorAction SilentlyContinue
```

### 4.2 确认

确认 `tmp/` 目录已清空。

### 4.3 告知

清理完成后告知用户：`已清理本次临时文件。`

---

## 注意事项

1. **先拆解再行动**：务必先和用户确认客户、时段、分析目标，再拉取数据
2. **模糊匹配多候选时列出来让用户选**：不要替用户做决定
3. **Cookie 过期处理**：遇到 9064 错误提示用户刷新 cookies.txt
4. **翻页控制**：用 `earliest_message_seq` 翻页，返回消息数 < limit 时停止
5. **时间范围**：用户未指定时默认近1天，并告知用户
6. **隐私**：报告中只展示 sender_name，不暴露原始 sender ID
7. **走脚本不直接调 MCP**：所有拉取走 `scripts/` 下的 Python 脚本
8. **batch_fetch.py 必须传 --limit 20**：API 上限为 20，传 100 会 9064 报错
9. **第四步清理不可跳过**：分析完成后删除 `tmp/` 目录下所有文件，不询问、不等待
10. **所有临时文件统一写到 `skills/wecom-group-msg-monitor/tmp/`**，禁止使用 `%TEMP%` 散落各处
