# 命名陷阱：skill 名 ≠ 平台名

这是自建 Skill 最容易踩的坑，模型容易把平台名当 skill 名传，导致 Console 报 `agent is not active`。

## 两个不同概念

| 概念 | 出处 | 格式 | 例 |
|------|------|------|------|
| **skill 名** | SKILL.md frontmatter `name` / `muad.skill.json` `name` / 目录名 | 横杠 `-` 分隔 | `smoke-platform`、`policy-check-new` |
| **平台名** | `muad.skill.json` `platforms` 数组元素 / Console 配置 | 自由字符串 | `mssw`、`smoke_platform` |

两者是不同概念，**不要长得像**。

## 反例

```
skill 名: smoke-platform
平台名: smoke_platform
```

只差横杠/下划线——模型会把平台名当 skill 名传给工具，Console 按 skill 名解析时找不到、报 `agent is not active`。

## 正例

```
skill 名: smoke-platform-query      （描述这是干什么的）
平台名: smoke_platform
```

skill 名描述功能，平台名是 Console 里的标识，两者语义不同就不会混。

## SKILL.md 里怎么写

若 SKILL.md 正文提到平台，**明确写**：

> skill 名是 `smoke-platform-query`，平台名是 `smoke_platform`。

不要只写一个名字让模型自己猜是哪个。

## 脚本里怎么写

`platform_request` 的平台名必须与 `muad.skill.json` 的 `platforms` 一致；skill 名只用于 manifest、SKILL.md、目录名和 `session-manager get-state --skill-name`，不作为平台名传给 `platform_request`。

```python
from muad_skill_http import platform_request

# ✅ 对：平台名与 manifest platforms 一致；state_file 来自 session-manager
response = platform_request(
    "smoke_platform", "GET", "/api/v1/items", state_file=state_file,
)

# ❌ 错：把 skill 名当平台名
response = platform_request(
    "smoke-platform-query", "GET", "/api/v1/items", state_file=state_file,
)
```
