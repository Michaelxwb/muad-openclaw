# SKILL.md - 漏洞扫描（vuln-scan）

本 skill 包含四个业务流：
1. **执行漏扫任务** — 创建扫描任务、轮询状态、下载报告
2. **初始化&修改客户配置** — 查看当前配置、修改配置项
3. **导出/下载漏扫报告** — 根据任务名称导出已有扫描的报告
4. **执行漏洞复测** — 针对历史处置中/修复失败的漏洞，发起复测扫描

---

## 🚀 快速调用速查

> **脚本均在 `run-vuln-scan/` 目录下执行。Cookie 路径：`M:\Users\User\Downloads\cookies.txt`**

| 场景 | 命令 |
|------|------|
| **执行漏扫（立即）** | `python phase1/phase1_trigger.py --company "公司名"` |
| **执行漏扫（定时）** | `python phase1/phase1_trigger.py --company "公司名" --start-time "2026-06-09 11:20:00"` |
| **初始化/查看/修改配置** | `py init-config/init_config_display.py "公司名" --output-file "%TEMP%\out.txt"` → 用户发修改行 → `step5_validate.py` → `step6_write.py` |
| **执行复测（立即）** | `python phase1/phase1_retest_trigger.py --company "公司名"` |
| **执行复测（定时）** | `python phase1/phase1_retest_trigger.py --company "公司名" --start-time "2026-06-09 11:00:00"` |
| **导出漏扫报告** | `python phase2/phase2_export_report.py "漏扫任务_公司名_时间戳"` |
| **继续中断任务** | `python phase1/phase1_trigger.py --auto-resume`（Phase 4-5）或 `--auto-resume-phase3`（Phase 3-5） |

### 重要区分
- 用户说「复测」→ `phase1_retest_trigger.py`（仅 Phase 1-2，自动拉取处置中/修复失败漏洞）
- 用户说「漏扫」→ `phase1_trigger.py`（Phase 1-5，需 {company_id}.json 配置）
- 两者入口不同，不可混淆

---

## ⚠️ 执行约束（最高优先级，所有业务流均适用）

### 铁律一：严丝合缝跑脚本，中途不转交给模型处理
- 所有业务流全程由脚本掌控，**不允许跑到一半自行判断下一步怎么做**
- 脚本内部有等待逻辑，脚本自行处理，不干预
- 禁止自行传入 `--delay-minutes` 等参数跳过等待

### 铁律二：Cookie 路径
- 路径：`M:\Users\User\Downloads\cookies.txt`（有 s）
- 优先顺序：命令行参数 > 环境变量 > 该路径

### 铁律三：field_mapping.json 和 config_display_template.txt 不可修改
- 路径：`init-config/templates/field_mapping.json`、`init-config/templates/config_display_template.txt`
- 两个文件只能由用户后台修改，AI 只能读取使用

### 铁律四：Windows 执行编码（所有 init-config 脚本）
- 所有 init-config 目录下的脚本输出**必须走文件**，禁止通过 print()/exec 管道直接输出
- 调用时必须使用 `--output-file` 参数写入临时文件
- 读取临时文件用 PowerShell：`Get-Content "<path>" -Raw -Encoding utf8`
- 读取完成后立即删除临时文件
- 脚本输出原样展示，不加工、不整理、不重新格式化

---

## 业务流一：执行漏扫任务

### 触发词

「做漏扫」「执行漏扫」「下发漏扫」「发起漏扫」「创建漏扫任务」「漏扫任务」等。

### 入口

**唯一入口：** `run-vuln-scan/phase1/phase1_trigger.py`

### 使用方式

```bash
# 立即执行
python phase1/phase1_trigger.py --company "公司名称"

# 定时执行
python phase1/phase1_trigger.py --company "公司名称" --start-time "2026-05-07 15:00"

# 断点恢复
python phase1/phase1_trigger.py --auto-resume          # Phase 4-5
python phase1/phase1_trigger.py --auto-resume-phase3   # Phase 3-5
```

### 公司名称解析

- `给客户A做漏扫` / `给A客户做漏扫` / `给A做漏扫` → 公司名=A
- 传入 `--company` 的参数为**纯公司名称**，不含修饰语

### 执行纪律

1. 不传额外参数，不跳过等待，不自行判断流程
2. 多候选时禁止自动选第一个，必须确认
3. 脚本报错直接退出，交用户判断

### 关键文件

| 用途 | 路径 |
|------|------|
| 公司配置 | `run-vuln-scan/companies/{company_id}.json` |
| 配置模板（新公司） | `run-vuln-scan/templates/default_user_config.json` |

---

## 业务流二：初始化&修改客户配置

### 触发词

「读取/查看/看看/初始化/修改/调整/重置/配置」+ 客户名/公司名，如：
- 查看XX的配置 / 初始化XX的配置 / 修改XX的配置
- 给XX做漏扫前的配置

### 入口

**唯一入口：** `init-config/init_config_display.py`

### 完整流程

```
用户：「查看XX配置」或「初始化XX配置」
    ↓
【步骤1-4】init_config_display.py
    调用：py init_config_display.py "公司名" --output-file "%TEMP%\init_config_<ts>.txt"
    读取：Get-Content "<path>" -Raw -Encoding utf8 → 原样展示 → 删除临时文件
    ↓
用户：发送多行修改（每行「配置项：值」）
    ↓
【步骤5】step5_validate.py
    调用：py step5_validate.py "公司名" --output-file "%TEMP%\step5_out.txt"
    读取并原样展示结果
    ↓
【步骤6】step6_write.py
    调用：py step6_write.py "公司名" --output-file "%TEMP%\step6_out.txt"
    读取并原样展示结果
    ↓
【步骤7】重新展示完整配置
    重新调用 init_config_display.py 展示修改后的全量配置
```

### 指定资产支持服务标签

在「资产范围」为「指定资产」时，`指定资产` 的值中除了 IP、IP段（CIDR）、URL 外，还支持：
- **安全托管服务** — 自动拉取 asset_tag=3 的资产列表
- **网站监测服务** — 自动拉取 asset_tag=20 的资产列表

用法（嵌入在 `指定资产：` 行中，逗号分隔）：
```
指定资产：1.1.1.1,2.2.2.2,3.3.3.0/24,安全托管服务
指定资产：1.1.1.1,2.2.2.2,3.3.3.0/24,网站监测服务
指定资产：排除1.1.1.1,2.2.2.2,3.3.3.0/24,安全托管服务
```

### 执行纪律

1. **展示必须走文件**：init_config_display.py 必须用 `--output-file`，禁止 print 管道输出
2. **脚本输出原样展示**：不重新格式化、不解码、不整理，配置项原文照录不压缩
3. **禁止展示内部字段名**：不暴露 `asset_mode`、`fuzz_scan`、`conc_module` 等英文字段名，严格使用脚本的中文输出
4. **修改配置后必须重新展示全量配置**：step6 写入成功后重新调用 init_config_display.py，不得只输出「配置已更新」
5. **展示后追加固定提示**（每次展示漏扫配置都加）：
   > 详情参考企微群内容，请按照企微群要求的格式进行修改。
6. **不暴露内部实现细节**：不说「临时文件」「脚本输出」「文件已删除」等内部信息
7. 脚本报错直接退出，交用户判断

---

## 业务流三：导出/下载漏扫报告

### 触发词

「导出漏扫报告」「下载漏扫报告」「导出/下载xxx的漏扫报告」

### 入口

**唯一入口：** `run-vuln-scan/phase2/phase2_export_report.py`

### 使用方式

```bash
python phase2/phase2_export_report.py "漏扫任务_公司名_时间戳"
```

### 执行纪律

1. 从任务名称提取公司名（格式：`漏扫任务_公司名_12位时间戳`）
2. 严丝合缝调用脚本，中途不自行判断下一步

---

## 业务流四：执行漏洞复测

### 触发词

「漏洞复测」「复测」「做复测」「发起复测」「执行复测」等。

### 入口

**唯一入口：** `run-vuln-scan/phase1/phase1_retest_trigger.py`

### 使用方式

```bash
# 立即执行
python phase1/phase1_retest_trigger.py --company "公司名称"

# 定时执行
python phase1/phase1_retest_trigger.py --company "公司名称" --start-time "2026-06-01 09:00:00"
```

### 流程说明

```
Phase 1：查询处置中/修复失败漏洞 → 提取资产IP → 创建复测任务
Phase 2：轮询任务状态 → 完成
```

复测无 Phase 3-5，任务完成即结束。

### 执行纪律

1. 不传额外参数，不跳过等待
2. 多候选时禁止自动选第一个
3. 复测只有 Phase 1-2，不进入漏洞审核和报告导出

---

## 注意事项

- 所有脚本使用 Python 3，不临时用 curl/node/powershell
- 执行漏扫的**唯一入口**是 `phase1/phase1_trigger.py`，禁止跨过直接调用其他阶段
- 漏洞复测的**唯一入口**是 `phase1/phase1_retest_trigger.py`
- Cookie 有效期约 6 小时，如提示无权限需更新 Cookie
