# SKILL.md - 漏洞扫描（vuln-scan）

本 skill 包含三个业务流：
1. **执行漏扫任务** — 创建扫描任务、轮询状态、下载报告
2. **初始化&修改客户配置** — 查看当前配置、修改配置项
3. **执行漏洞复测** — 对处置中/修复失败的漏洞发起复测扫描、轮询结果

---

## 目录结构

```
vuln-scan/
├── init-config/              ← 初始化&修改客户配置业务
│   ├── SKILL.md              ← 本文件（仅描述 init-config）
│   ├── templates/
│   │   ├── field_mapping.json         ← 字段映射表（中文配置名 ↔ 英文key ↔ 值的映射）
│   │   └── config_display_template.txt ← 配置展示模板
│   ├── init_config_display.py  ← 展示当前客户配置（步骤1-4）
│   ├── init_config_interactive.py  ← 交互式配置入口
│   ├── step5_validate.py       ← 接收用户输入并校验（步骤5）
│   ├── step6_write.py          ← 将配置写入 {company_id}.json（步骤6）
│   └── asset_translator.py     ← asset_id ↔ IP 转换工具
│
└── run-vuln-scan/             ← 执行漏扫任务业务
    ├── SKILL.md               ← 业务说明文档
    ├── cache/                  ← 缓存目录
    │   ├── phase1_candidates.json  ← 多候选公司时写入，确认后删除
    │   ├── phase1_resume.json      ← 定时任务断点
    │   ├── phase3_resume.json      ← Phase 3（导出报告）断点
    │   └── phase4_resume.json      ← Phase 4 断点
    ├── webhook_config.json      ← 企微群 webhook 配置
    ├── config_manager/         ← 配置管理
    ├── companies/              ← 运行时生成的公司配置 JSON
    ├── templates/              ← 配置模板
    │   ├── default_user_config.json  ← 新客户配置来源
    │   └── default_other_config.json ← API payload 部分字段来源
    ├── reports/                ← 下载的报告文件
    ├── shared/                 ← 共享模块
    │   ├── __init__.py         ← shared 主模块（含 get_cookie、log、request_with_retry 等）
    │   └── notify.py           ← 企微通知
    ├── phase1/                 ← 阶段1：扫描任务创建
    │   ├── phase1_trigger.py          ← 唯一入口（Task Scheduler / 直接执行）
    │   ├── phase1_wait_and_run.py    ← 后台等待进程（定时场景）
    │   ├── phase1_scheduled_runner.py ← 定时任务执行脚本
    │   └── phase1_prepare/            ← Phase 1 前置
    │       ├── phase1_company.py       ← resolve_company
    │       ├── get_dev_id.py
    │       ├── vuln_scan_task.py
    │       ├── company_config.py
    │       ├── payload_builder.py
    │       └── asset_processor.py
    ├── phase2/                 ← 阶段2：轮询扫描状态
    ├── phase3/                 ← 阶段3：漏洞审核 + 报告任务创建
    ├── phase4/                 ← 阶段4：轮询报告生成
    └── phase5/                 ← 阶段5：下载报告并发送群
```

---

## 业务流一：执行漏扫任务

### 核心入口

**唯一入口：** `run-vuln-scan/phase1/phase1_trigger.py`

### 使用方式

#### 1. 立即执行

```bash
python phase1_trigger.py --company "公司名称"

# 公司名模糊匹配（匹配到多个公司 → 企微通知用户 → 用户回复编号或全名）
python phase1_trigger.py --company "XDR"

# 直接指定公司ID（跳过公司确认）
python phase1_trigger.py --company-id 50655704

# 从候选项文件按编号定位
python phase1_trigger.py --select 1
```

#### 2. 定时执行

```bash
# 指定时间执行
python phase1_trigger.py --company "公司名称" --start-time "2026-05-07 15:00"

# 延迟N分钟后执行
python phase1_trigger.py --company "公司名称" --start-time "NOW+30min"
```

#### 3. 断点续执

```bash
# 从 Phase 3 断点恢复（Phase 3-5）
python phase1_trigger.py --auto-resume-phase3

# 从 Phase 4 断点恢复（Phase 4-5）
python phase1_trigger.py --auto-resume
```

### 公司名称解析规范

- `给客户A做漏扫` → 公司名=A
- `给客户:A做漏扫` → 公司名=A
- `给A客户做漏扫` → 公司名=A
- `给A做漏扫` → 公司名=A
- `客户A托管服务测试` → 公司名=A（示例，不要照抄）

**触发词**：做漏扫、执行漏扫、下发漏扫、发漏扫任务、创建漏扫任务、发起漏扫、漏扫任务，以上均视为执行漏扫的意图。

**定时漏扫识别规则**：用户输入含**具体时间**（如「明天9点」「2026-05-26 09:00」「今晚8点」等）+ **执行类动词**（做、执行、下发、发、创建、发起、漏扫任务等）→ 走 `--start-time` 定时执行流程。

### 定时任务触发机制

1. `phase1_trigger.py` 接收 `--start-time` → `spawn_wait_and_run` 启动后台进程 `phase1_wait_and_run.py`
2. `phase1_wait_and_run.py` 后台进程等待目标时间到达 → 执行 Phase 1 → 等 30 分钟 → 执行 Phase 2-5

### Cookie 配置

优先顺序：命令行参数 > 环境变量 `VULN_SCAN_COOKIE` / `COOKIE` > `M:\Users\User\Downloads\cookies.txt`

---

## 业务流二：初始化&修改客户配置

### 流程说明

```
用户说「初始化[公司名]的配置」或「查看[公司名]配置」
    ↓
步骤1-4：init_config_display.py — 展示当前配置（从 {company_id}.json 读取并翻译）
    ↓
用户修改配置项（发送多行配置）
    ↓
步骤5：step5_validate.py — 校验用户输入合法性
    ↓
步骤6：step6_write.py — 将配置写入 {company_id}.json
```

### 触发方式

用户说「初始化客户配置」「修改XX配置」「查看XX配置」等类似意图时，自动进入此流程。

### 配置展示格式

完全按照 `templates/config_display_template.txt` 输出，包括：
- 默认配置项（端口存活检测、漏洞范围）
- 可选配置项（11项，含选项和当前值）
- 修改提示（从模板文件读取，不自己构造）

### 字段映射

`templates/field_mapping.json` 是核心映射表：
- **正向映射**（英文key → 中文配置名 + 数字值 → 中文值）
- **反向映射**（中文配置名 → 英文key + 中文值 → 数字值）
- **特殊字段**：`自定义端口`、`指定资产` 单独处理（无 value 映射）

### 特殊字段处理

#### 自定义端口（diy_port）
- **前置条件**：`port_type` 必须是 `"diy"`（自定义端口）
- **输入格式**：`自定义端口：80,443`
- **校验规则**：逗号分隔，每项 0-65535

#### 指定资产（asset_list）
- **前置条件**：`asset_mode` 必须是 `1`（指定资产）
- **输入格式**：`指定资产：1.1.1.1,2.2.2.2,3.3.3.0/24`
- **排除模式**：`指定资产：排除1.1.1.1,2.2.2.2`
- **CIDR 展开**：自动展开为独立 IP 列表

#### 嵌套字段（export_file）
- `vul_fix_schema`、`vul_proof_report` 写入 `export_file` 嵌套对象
- 展示时从 `export_file` 层读取并翻译

### 修改提示格式

从 `config_display_template.txt` 末尾读取，原始内容：

```
如若修改配置，请修改按照如下格式配置输入您需要更改的字段，其余字段无需输入，会按当前选择
配置项1：配置值1
配置项2：配置值2
配置项3：配置值3
......
若要配置自定义端口和指定资产，输入格式为：
自定义端口：80,443
指定资产：1.1.1.1,2.2.2.2,3.3.3.0/24；或者输入：排除1.1.1.1,2.2.2.2,3.3.3.0/24
```

### 执行纪律

1. **严格使用现有 Python 脚本**，不临时用 curl/node/powershell 测试 API
2. **脚本报错直接退出**，不自行修改、不尝试修复，交给用户判断
3. **用户只给客户名称 ≠ 可以直接创建定时任务**。必须先走完整 phase0 配置流程

---

## 业务流三：执行漏洞复测

### 何时触发

用户说「执行复测」「下发复测」「漏洞复测」「复测任务」「做复测」「给XX做复测」等执行意图时，进入本业务流。

### 核心入口

**唯一入口：** `run-vuln-scan/phase1/phase1_retest_trigger.py`

### 流程说明

漏洞复测是独立于完整漏扫的轻量流程，仅包含 2 个阶段：

```
Phase 1（phase1_retest_trigger.py）
  步骤1：查询公司中 vulnerability_status 为「处置中(1)」和「修复失败(9)」的漏洞
         → 提取 vuln_id 列表
  步骤2：调用复测 API（POST /vulnmgr/vuln/retest）下发复测任务
         ↓
Phase 2（phase2_retest_poll.py 或 phase2_retest_run_through.py）
  步骤1：用 keyword="漏洞复测" 查询任务列表，找到 start_time 最大的 task
  步骤2：轮询该 task 的 status
         - status=5 完成 → 企微通知「复测扫描已完成」
         - status=4 失败 → 企微通知失败原因
         - 超时（180分钟未完成）→ 企微通知超时
```

### 使用方式

#### 1. 立即执行

```bash
python phase1/phase1_retest_trigger.py --company "公司名称"

# 模糊匹配
python phase1/phase1_retest_trigger.py --company "XDR"
```

#### 2. 定时执行

```bash
# 指定时间执行
python phase1/phase1_retest_trigger.py --company "公司名称" --start-time "2026-06-02 20:00"
```

### 与漏扫的区别

| 维度 | 漏扫 | 复测 |
|------|------|------|
| 入口脚本 | phase1_trigger.py | phase1_retest_trigger.py |
| 阶段数 | Phase 1-5 | Phase 1-2 |
| 任务下发 API | 创建扫描任务 | /vulnmgr/vuln/retest |
| Phase 2 查询方式 | 按 task_name 精确匹配 | 按 keyword="漏洞复测" + start_time 最大 |
| 后续流程 | 轮询扫描→审核→报告→下载 | 仅轮询扫描状态（无报告导出） |
| 漏洞来源 | 配置指定（全部/指定资产） | 自动拉取「处置中」+「修复失败」漏洞 |

### 待复测漏洞范围

仅自动拉取以下状态的漏洞：
- `vulnerability_status = 1`：处置中
- `vulnerability_status = 9`：修复失败

如果客户没有这些状态的漏洞，脚本会输出提示并退出（不创建任务）。

### Phase 2 轮询参数

- 轮询间隔：10 秒
- 任务首次匹配超时：30 分钟
- status 轮询总超时：180 分钟
- 进度通知间隔：每 10 分钟企微通知一次

### 执行纪律

1. **严格使用现有 Python 脚本**，不临时用 curl/node/powershell 测试 API
2. **脚本报错直接退出**，不自行修改、不尝试修复，交给用户判断
3. **复测不需要提前配置**：漏洞来源由脚本自动查询，不从 {company_id}.json 读取扫描配置
4. **执行复测任务的唯一入口**是 `phase1/phase1_retest_trigger.py`

---

## Windows 执行编码声明（必须遵守）

在 Windows 上通过 exec 工具调用 Python 脚本时，**必须**使用 `--output-file` 参数将输出写入 skill 自己的 cache 目录，再读取文件内容展示。

所有 `init-config` 目录下的脚本调用（init_config_display.py、step5_validate.py、step6_write.py 等）统一使用此方式。

**标准流程：**
1. 调用：`exec(command='py "skills\vuln-scan\init-config\init_config_display.py" "公司名" --output-file "skills\vuln-scan\init-config\cache\init_config_out.txt"', env={"PYTHONUTF8": "1"})`
2. 读取文件内容并原样展示给用户
3. 展示完成后立即删除该文件

**输出文件路径（任何人电脑上都一样，skill 自带）：**
```
skills\vuln-scan\init-config\cache\init_config_out.txt
```

这是 exec 工具在 Windows 上的机制要求，与脚本本身无关，任何电脑都通用。

---

## 注意事项

- 所有脚本使用 Python 3，不使用 PowerShell / curl / node / js 脚本
- 执行漏扫任务的**唯一入口**是 `run-vuln-scan/phase1/phase1_trigger.py`
- 执行漏洞复测的**唯一入口**是 `run-vuln-scan/phase1/phase1_retest_trigger.py`
- Cookie 有效期约 6 小时，如任务执行中提示无权限需更新 Cookie