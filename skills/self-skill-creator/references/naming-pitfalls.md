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

`session-manager get-state --skill-name <skill名>` 的 skill 名**硬编码**为 `muad.skill.json` 的 `name`，**不是 `platforms` 里的值**。

```js
// ✅ 对：skill 名硬编码
const skillName = "smoke-platform-query";
await execFileAsync("session-manager", ["get-state", "--skill-name", skillName]);

// ❌ 错：用平台名
const skillName = "smoke_platform";  // 这是平台名，session-manager 会找不到
```
