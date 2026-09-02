# SKILL.md — 策略检查（policy-check）

## 🚀 快速调用速查（先看这里！）

> **脚本均在 `policy-check/` 目录下执行。Cookie 路径：`M:\Users\User\Downloads\cookies.txt`**

| 场景 | 命令 |
|------|------|
| **执行策略检查（立即）** | `python phase1/phase1_trigger.py --company "公司名"` |
| **执行策略检查（定时）** | `python phase1/phase1_trigger.py --company "公司名" --start-time "2026-06-09 11:00:00"` |
| **导出策略检查报告** | `python phase2/phase2_run_through.py --task-name "af策略检查_20260607103648" --company-name "公司名"` |

### 检查覆盖设备
AF（防火墙）、SIP（安全感知平台）、EDR（端点检测响应）、STA（安全流量分析）

---

安全设备策略检查 Skill，负责对 AF、SIP、EDR、STA 四类安全设备进行策略配置检查。

## 流程概览

```
用户输入公司名
    ↓
Phase 1（phase1_trigger.py）
  ├── 确认公司（SOAR API 模糊匹配）
  ├── 获取设备 ID
  ├── 创建策略检查任务
  └── 启动后台等待进程（定时场景）或直接进入 Phase 2-4
    ↓
Phase 2（phase2_wait_check.py）
  └── 轮询策略检查任务状态（等待完成）
    ↓
Phase 3（phase3_export_report.py）
  └── 下载/导出报告（docx 格式）
    ↓
Phase 4（phase4_generate_message.py）
  └── 生成策略检查话术
```

## 目录结构

```
policy-check/
├── SKILL.md                    ← 本文件
├── shared/                     ← 共享模块
│   ├── __init__.py              ← 主模块（cookie、HTTP、日志、配置管理）
│   └── notify.py               ← 企微通知
├── cache/                      ← 缓存目录（多候选公司临时文件、断点恢复）
├── templates/                  ← 配置模板
├── reports/                    ← 下载的报告和话术
├── phase1/                     ← 阶段1：任务创建
│   ├── phase1_trigger.py       ← 唯一入口（定时/直接执行）
│   ├── phase1_wait_and_run.py  ← 后台等待进程（定时场景）
│   ├── phase1_company.py       ← 公司确认（SOAR API）
│   ├── get_dev_id.py           ← 获取设备 ID
│   └── policy_check_task.py    ← 创建策略检查任务
├── phase2/                     ← 阶段2：轮询检查状态
│   ├── phase2_wait_check.py    ← 轮询策略检查任务
│   └── phase2_run_through.py   ← Phase 2-4 串联入口
├── phase3/                     ← 阶段3：导出报告
│   └── phase3_export_report.py ← 导出 docx 报告
└── phase4/                     ← 阶段4：生成话术
    └── phase4_generate_message.py ← 生成策略检查话术
```

## 使用方式

### 1. 立即执行

```bash
python phase1/phase1_trigger.py --company "公司名称"

# 直接指定公司ID
python phase1/phase1_trigger.py --company-id 12345678

# 从候选项文件按编号定位
python phase1/phase1_trigger.py --select 1
```

### 2. 定时执行

```bash
python phase1/phase1_trigger.py --company "公司名称" --start-time "2026-06-04 09:00"
```

## 触发词

策略检查触发词：做策略检查、执行策略检查、下发策略检查、策略检查任务、发起策略检查、设备策略检查、安全检查

**定时策略检查识别规则**：输入含具体时间 + 执行类动词 → 走 `--start-time` 流程。

**导出策略检查报告触发词**：导出策略检查报告、下载策略检查报告、导出xxx的策略检查报告

### 导出策略检查报告使用方式

```bash
python phase2/phase2_run_through.py --task-name "af策略检查_20260607103648" --company-name "托管服务测试"
```

- `--task-name`：完整任务名称（格式：`af策略检查_时间戳` 或 `af策略检查等组合_时间戳`）
- `--company-name`：公司名（用于反查 company_id）
- 脚本内部会走 Phase 2-4：轮询匹配任务 → 导出报告 → 生成话术

## 公司名称解析规范

- `给客户A做策略检查` → 公司名=A
- `客户A策略检查` → 公司名=A
- `给A做设备策略检查` → 公司名=A

## Cookie 配置

优先顺序：环境变量 `POLICY_CHECK_COOKIE` > `VULN_SCAN_COOKIE` > `COOKIE` > `M:\Users\User\Downloads\cookies.txt`

## 待实现的占位部分

以下模块当前为占位实现，后续需要替换为实际 API：

| 模块 | 占位内容 |
|------|---------|
| `phase1/get_dev_id.py` | 设备列表查询 API |
| `phase1/policy_check_task.py` | 策略检查任务创建 API |
| `phase2/phase2_wait_check.py` | 任务状态查询 API（含状态码） |
| `phase3/phase3_export_report.py` | 报告导出/下载 API |
| `phase4/phase4_generate_message.py` | 话术生成逻辑/模板 |

## 执行纪律

1. **严格使用现有 Python 脚本**，不临时用 curl/node/powershell 测试 API
2. **脚本报错直接退出**，不自行修改、不尝试修复
3. **执行策略检查的唯一入口**是 `phase1/phase1_trigger.py`
