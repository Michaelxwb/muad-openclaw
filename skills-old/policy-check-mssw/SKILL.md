---
name: policy-check
description: 对指定客户下发策略检查任务、查询任务状态、检查结果。根据本文档执行用户要求的操作，回复必须简洁并且严格按照下方模板要求的格式。
---
# SKILL.md — 策略检查（policy-check）

## 🚀 快速调用速查（先看这里！）

> **脚本均在 `policy-check/` 目录下执行。登录地址和cookie文件可修改config/api_config.json内容

| 场景 | 命令 |
|------|------|
| **执行策略检查（下发任务）** | `python phase1/phase1_trigger.py --company "公司名"` |
| **查询任务执行状态** | `python phase2/phase2_wait_check.py` |
| **查询策略检查结果** | `python phase4/phase4_generate_message.py --start "2026-08-01" --end "2026-08-07"` |

### 检查覆盖设备
AF（防火墙）、SIP（安全感知平台）、EDR（端点检测响应）

---

安全设备策略检查 Skill，负责对 AF、SIP、EDR 三类安全设备进行策略配置检查。

## 流程概览（改造后：下发与查询分离）

```
用户输入公司名
    ↓
Phase 1（phase1_trigger.py）— 仅立即触发
  ├── 确认公司（SOAR API 模糊匹配）
  ├── 获取设备 ID
  ├── 创建策略检查任务
  ├── 写入 cache/last_session.json（task_ids/company_id/company_name/dev_id_list）
  └── 打印精简模板 1（下发结果），结束
    ↓
（用户按需主动询问）
    ↓
Phase 2（phase2_wait_check.py）— 单次查询，不轮询
  ├── 默认读 cache/last_session.json，或 --task-ids 显式传
  ├── 调用状态 API 一次
  └── 打印精简模板 2（任务状态汇总）
    ↓
Phase 4（phase4_generate_message.py）— 用户询问详情时
  ├── 默认读 cache/last_session.json，或 --company-id/--dev-ids 显式传
  ├── 必传时间范围 --start/--end（不传默认最近 7 天）
  ├── 按 latest_time UTC 数组入参（参考 policy_check_export.py）
  └── 打印精简模板 3（策略检查结果，按 3 类分组）
```

## 目录结构

```
policy-check/
├── SKILL.md                    ← 本文件
├── shared/                     ← 共享模块
│   ├── __init__.py              ← 主模块（cookie、HTTP、日志、配置、session 缓存）
│   └── notify.py               ← 企微通知
├── cache/                      ← 缓存目录（last_session.json、多候选公司临时文件）
├── templates/                  ← 配置模板
├── reports/                    ← 完整策略结果 JSON（备用）
├── phase1/                     ← 阶段1：任务创建（仅立即触发）
│   ├── phase1_trigger.py       ← 唯一入口
│   ├── phase1_company.py       ← 公司确认（SOAR API）
│   ├── get_dev_id.py           ← 获取设备 ID
│   └── policy_check_task.py    ← 创建策略检查任务
├── phase2/                     ← 阶段2：查询任务状态
│   └── phase2_wait_check.py    ← 单次查询入口
└── phase4/                     ← 阶段4：查询策略检查结果
    └── phase4_generate_message.py ← 按需查询入口
```

## 使用方式

### 1. 下发策略检查（Phase 1，仅立即触发）

```bash
# 通过公司名模糊匹配
python phase1/phase1_trigger.py --company "公司名称"

# 直接指定公司ID
python phase1/phase1_trigger.py --company-id 12345678

# 从候选项文件按编号定位（多候选场景）
python phase1/phase1_trigger.py --select 1
```

下发完成后：
- 返回精简模板 1（客户名、设备数、task_ids、跳过设备数）
- 自动写入 `cache/last_session.json`，供 Phase 2/4 默认读取
- **不再自动进入 Phase 2 轮询**，由用户主动询问

### 2. 查询任务状态（Phase 2，用户主动询问）

```bash
# 默认读 cache/last_session.json
python phase2/phase2_wait_check.py

# 显式指定 task_ids
python phase2/phase2_wait_check.py --task-ids '["id1","id2"]' --company-name X
```

每次调用仅查询一次当前状态，立即返回模板 2（任务状态汇总）。
不再自动轮询到终态——用户想看更新就再问一次。

### 3. 查询策略检查结果（Phase 4，用户主动询问详情）

```bash
# 默认读 cache，时间默认最近 7 天
python phase4/phase4_generate_message.py

# 显式指定时间范围
python phase4/phase4_generate_message.py --start "2026-08-01" --end "2026-08-07"

# 完整显式传参
python phase4/phase4_generate_message.py --company-id 12345 --dev-ids '[338,222]' \
    --start "2026-08-01" --end "2026-08-07"
```

返回模板 3（按"策略获取失败 / 授权过期未开通 / 其他风险项"三类分组）。

## 触发词

策略检查触发词：做策略检查、执行策略检查、下发策略检查、策略检查任务、发起策略检查、设备策略检查、安全检查

**任务状态查询识别规则**：输入含"任务怎么样了/跑完了吗/状态如何"等查询意图 → 走 `phase2/phase2_wait_check.py`

**策略检查结果查询识别规则**：输入含"结果/有哪些风险/检查详情"等 → 走 `phase4/phase4_generate_message.py`

## 公司名称解析规范

- `给客户A做策略检查` → 公司名=A
- `客户A策略检查` → 公司名=A
- `给A做设备策略检查` → 公司名=A

## Cookie 配置

优先顺序：环境变量 `POLICY_CHECK_COOKIE` > `COOKIE` > `config/api_config.json` 中的 `cookie_file`

## 返回模板（精简化设计）

> **⚡ 输出强制要求**：最终给用户的结果**必须完全按照下方模板 1/2/3 的格式输出**，不得自行发挥、不得增删字段、不得改成其它排版。模板里的占位符按实际值填入，空的分组按模板注释整组省略。这是本 skill 的最高优先级输出要求，任何情况下都不得偏离。

### 模板 1 — 下发结果

```
✅ 策略检查任务已下发
客户：{corrected_name}（company_id={company_id}）
设备：{device_count} 台（AF {af_count}、SIP {sip_count}、EDR {edr_count}）
任务：{task_count} 个，task_ids={task_ids}
跳过：{skipped_count} 台 或 无

⚠️本次只做任务下发，不返回任务结果
下次可问我：「查询策略检查任务状态」「查询策略检查结果」
```

异常分支：精简错误消息，不展示栈和 traceid。
多候选分支：列出编号 + 公司名 + ID，引导用户用 `--select` 确认。

### 模板 2 — 任务状态查询

```
📊 策略检查任务状态
客户：{company_name}（company_id={company_id}）
任务总数：{total}

状态分布：
  ✅ 评估完成（无失败）：{count_60}
  ⚠️ 评估完成（存在失败）：{count_40}
  ❌ 评估失败：{count_30}
  ⚪ 任务不存在：{count_9906}
  ⏳ 进行中（待评估/评估中/暂停）：{count_in_progress}

整体：{label}

（全部终态时）可问我：「查询策略检查结果」查看详情
（仍有进行中）任务还在跑，稍后再问我一次状态
```

全部 9906 时切到"⚠️ 未找到任务"分支，提示可能已过期或被清理。

### 模板 3 — 策略检查结果

```
📋 策略检查结果
客户：{company_name}（company_id={company_id}）
查询时间范围：{start_str} ~ {end_str}
总条目：{total}（其中风险项 {risk_count} 条）

【1】策略获取失败（{n} 条）
{按 dev_type 分组，每条：序号. 设备名 → 策略名}

【2】授权过期/未开通（{n} 条）
{按 dev_type 分组，每条：序号. 设备名 → 策略名 → 策略状态}

【3】其他风险项（{n} 条，按设备类型分组）
AF（{n} 条）
  1.【设备名】风险描述
  2.【设备名】风险描述
SIP / EDR / ...
```

某分组为空时整组省略。空结果切到"✅ 策略检查结果为空"分支。

## 执行纪律

1. **严格使用现有 Python 脚本**，不临时用 curl/node/powershell 测试 API
2. **脚本报错直接退出**，不自行修改、不尝试修复
3. **下发策略检查的唯一入口**是 `phase1/phase1_trigger.py`
4. **查询任务状态**走 `phase2/phase2_wait_check.py`（默认读 cache，不传参即可）
5. **查询策略结果**走 `phase4/phase4_generate_message.py`（默认读 cache，时间默认最近 7 天）
6. **最终输出必须严格按模板 1/2/3 输出**，字段、顺序、分组、标点均与模板一致，不得增删或改写。脚本只负责执行并给出模板所需数据，由本 skill 按模板渲染给用户。
