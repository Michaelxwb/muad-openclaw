# SKILL.md - 资产发现（asset-discovery）

## 🚀 快速调用速查

> **脚本均在 `run-asset-discovery/` 目录下执行。Cookie 路径：`M:\Users\User\Downloads\cookies.txt`**

| 场景 | 命令 |
|------|------|
| **执行资产发现（立即）** | `python phase1/phase1_trigger.py --company "公司名"` |
| **执行资产发现（定时）** | `python phase1/phase1_trigger.py --company "公司名" --start-time "2026-06-09 11:10:00"` |
| **导出资产发现结果** | `python phase2/phase2_run_through.py --task-name "资产发现_公司名_时间戳"` |

---

## 业务流一：执行资产发现任务

### 触发词

「资产发现」「执行资产发现」「下发资产发现」「发起资产发现」「资产发现任务」等。

### 入口

**唯一入口：** `run-asset-discovery/phase1/phase1_trigger.py`

### 使用方式

```bash
# 立即执行
python phase1/phase1_trigger.py --company "公司名称"

# 定时执行
python phase1/phase1_trigger.py --company "公司名称" --start-time "2026-06-09 11:10:00"
```

### 公司名称解析

- `给客户A做资产发现` / `给A客户做资产发现` / `给A做资产发现` → 公司名=A
- 传入 `--company` 的参数为**纯公司名称**，不含修饰语

### 执行纪律

1. 严丝合缝跑脚本，不传额外参数，不跳过等待，不自行判断流程
2. 脚本报错直接退出，交用户判断
3. 多候选时禁止自动选第一个，必须确认
4. 禁止自行传入 `--delay-minutes` 跳过等待

---

## 业务流二：导出/查看资产发现结果

### 触发词

「导出资产发现结果」「查看资产发现结果」「资产发现结果」等。

### 入口

**入口脚本：** `run-asset-discovery/phase2/phase2_run_through.py`

### 任务名称格式

```
资产发现_{公司名}_{时间戳}
例如：资产发现_托管服务测试_202605280015
```

### 使用方式

```bash
python phase2/phase2_run_through.py --task-name "资产发现_托管服务测试_202605280015"
```

---

## 注意事项

- 所有脚本使用 Python，不临时用 curl/node/powershell
- Cookie 有效期约 6 小时，如提示无权限需更新 Cookie
- 定时任务通过 `phase1_wait_and_run.py` 后台进程等待，不用 schtasks / shell
