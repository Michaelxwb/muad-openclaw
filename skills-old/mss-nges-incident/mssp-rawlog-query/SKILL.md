---
name: mssp-rawlog-query
description: "MANDATORY before calling 取GPTRawLog/按CGID取日志/查模型日志/GPTRawLog. Trigger on: 按 CGID/告警ID/seq 从 ClickHouse 模型日志库 data_dr_ops_gpt_analysis_log 查询获取 GPTrawLog（终端GPT模型原始分析日志），并按需保存最后一条。"
---

# MSSP 模型日志库 GPTrawLog 查询（mssp-rawlog-query）

走 **ClickHouse 直连**取 GPTrawLog。GPTrawLog 是安全事件经终端 GPT 分析后的**完整原始日志**（JSON，含威胁定性、攻击链、进程树、IOC、处置建议），是 MSS 自动化"取日志 + 智能分析"环节（自动化运营流程 步骤6）的核心数据源。

> ⚠️ 本 skill 直连 ClickHouse（独立凭据，非 MSSP 平台 cookie）。在自动化流程 `mss-event-autoflow` 中由 阶段C（步骤6）调用；CGID 通常由前置步骤5（关联告警）获得，或 OB 库不通时人工取。

## 触发词 / 使用场景

用户给 **CGID**（→ `--cgid`）、**告警ID**（→ `--alertid`）、**seq**（→ `--seq`），或要求"按 CGID 取日志 / 查 GPTrawLog / 拉取 rawlog / 看模型分析日志"。


## 命令（工作目录 = 本 skill 目录）

```bash
# 最常用：按 CGID（默认 aes_10001 库；时间默认最近 30 天，自动覆盖新事件）
python3 scripts/mssp_ch_query.py --cgid 11700511476238644789

# 指定模型日志库（不同租户群）
python3 scripts/mssp_ch_query.py --db aes_10002_sz_3_tenant_group_name --cgid 17937119307574291111

# 按告警ID / 按 seq
python3 scripts/mssp_ch_query.py --alertid 270301879910256667
python3 scripts/mssp_ch_query.py --seq 1787404803822

# 自定义 SQL
python3 scripts/mssp_ch_query.py --sql "SELECT GPTrawLog FROM ... WHERE ..."

# 指定返回值窗口（默认最近30天，可不传）
python3 scripts/mssp_ch_query.py --cgid ... --start "2026-09-01 00:00:00" --end "2026-09-03 00:00:00"

# 保存到指定文件 / 目录
python3 scripts/mssp_ch_query.py --cgid ... --out /path/to/raw.json            # 指定文件
python3 scripts/mssp_ch_query.py --cgid ... --save-dir /path/to/dir            # 指定目录
python3 scripts/mssp_ch_query.py --cgid ... --no-save                          # 多条不保存仅打印
```

## 行为约定（遵循脚本实现）

1. **命中 ≥1 条**：打印实际条数。
2. **多条**：打印所有命中记录的 `seq / insertTime / cgId / alertId`，然后**只保留最后一条**（seq 最大）的 GPTrawLog 并保存。
3. **单条**：仅展示，不自动保存（需保存可加 `--out` / `--save-dir`）。
4. **0 条**：打印"无数据"。
5. 每次打印最后一条 GPTrawLog 解析出的**审计摘要**：模型版本、定性标签、事件名称、AI分析、处置建议、analyseAnswer。

### 保存位置约定

脚本写出的 GPTrawLog 默认保存位置：
- 存在环境变量 `SKILL_OUTPUT_DIR` → 保存到该目录（平台托管规范，skill 根只读仍可写）。
- 否则 → 保存到本 skill 目录下 `rawlog/`。
- 亦可用 `--out <文件>` / `--save-dir <目录>` 显式指定。

> 批注：运行前请以本 skill 目录为工作目录；多个库/多租户若 expect 命中，请分别 `--db` 查询确认。

## 连接与配置（集中管理）

连接参数集中在 `config/api_config.json` 的 `clickhouse` 段（不再硬编码在脚本中），并**支持环境变量覆盖**，便于多环境复用且避免泄露敏感值到代码：

| env | 对应 |
|---|---|
| `RAWLOG_CH_HOST` | host |
| `RAWLOG_CH_PORT` | port |
| `RAWLOG_CH_USER` | user |
| `RAWLOG_CH_PASSWORD` | password |
| `RAWLOG_CH_DB` | 默认库（实际切换仍走 `--db`）|

默认值：`HOST=10.150.69.100`、`PORT=30200`、默认库 `aes_10001_sz_3_tenant_group_name`（见 api_config.json）。支持的库：
`aes_10001/10002/10003/10004_sz_3_tenant_group_name`。

> ⚠️ 时间窗口默认**最近 30 天（滚动）**，而非固定日期——历史固定日期窗口曾导致 9/2 新事件漏查。如需更长再显式 `--start/--end`。

## 数据表结构（关键字段）

表：`{db}.data_dr_ops_gpt_analysis_log`（`db` 取上面的库）

| 字段 | 含义 |
|---|---|
| seq | 日志序列（可排序，取最后一条=max seq）|
| GPTrawLog | 模型 GPT 分析**完整日志（JSON 字符串）**——核心 |
| taskcontentCgId | CGID（关联告警获得）|
| taskcontentAlertId | 告警ID |
| agentId / tenant | Agent / 租户 |
| insertTime | 入库时间 |
| runtimeReceiveAt / runtimeFinishedAt | 模型接收 / 完成时间 |
| gptresponseStatus | 模型响应状态 |

GPTrawLog 关键结构（JSON）：
- `Runtime.analyseAnswer` — AI 最终定性（black/gray/white TAG + 攻击过程）
- `Runtime.analysePrompt` — 含完整行为数据（treeList/treeList 的'事件json文件'段）
- `taskContent.gptResponse` — 事件名称 / overview / threatTag / 处置建议 / analysis / maliciousEntities
- `taskContent.trees` — 完整进程树

## 输出呈现规范（给用户展示时）

1. 查询条件 + 命中条数
2. 最后一条摘要：威胁标签（black/gray/white）、AI 分析概述、事件名称、处置建议、analyseAnswer 关键内容
3. 保存情况：多条时明确给出已保存的最后一条 GPTrawLog 路径

## 执行纪律

1. 严格使用本 skill 自带 `scripts/mssp_ch_query.py`，不绕过脚本、不临时改 SQL 之外的逻辑。
2. **凭据不泄露**：ClickHouse 密码不对用户/日志明文展示打印。
3. 连接失败 / 超时 / SQL 错 → 如实反馈，不伪造数据。
4. 优先 `--cgid`；多个查询条件互斥（cgid/alertid/seq/sql 四选一，脚本已互斥校验）。
5. 多租户库不确定时，可按 `aes_10001..10004` 逐个查或按 `tenantId` 定位后确认库。
