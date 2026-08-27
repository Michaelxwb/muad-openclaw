# health-checkup-report 改造为 muad 架构 skill — 最终方案（一页）

> 目标：把 `skills-old/health-checkup-report/`（原 Windows 本地 Node + Python 混合 skill）改造成符合 muad 运行时架构、可在集群 Linux Pod 正常执行的业务 skill。
> 产物目录：`skills/health-checkup-report/`（按 skill-upload 流程上传，pending 待管理员审批）。
> 状态：**定稿**（关键决策已与用户确认）。

---

## 〇、本 skill 是什么（一段话）

用户说"生成 `xxx` 客户 `x月x日` 到 `y月y日` 的安全体检报告"，skill 解析客户名/时间/订阅参数，
把客户安全相关的资产台账、风险事件、漏洞/弱口令/暴露面等统计汇总，输出 HTML 报告 + 风险清单 Excel +
Word 附件，打包成 ZIP，经企微交付给客户。

---

## 一、现状盘点（原架构）

- **单入口 Node.js**（`health_report.js`，`npm run generate`），Node >= 18；仅用内置模块（https/http/fs/child_process/path/os），无 npm 第三方依赖。
- **大量功能由 Python3 子进程承担**（`execFile/spawn('python3'/'python')`）：`scripts/*.py` 统计、`excel-beautifier`（Excel 美化 CLI）、`分支1/`（报告正文计算 + HTML→Word 导出）、资产分页导出。
- **登录态从 Windows 文件读**：`--mssw-cookie-path`（`M:\...\mssw_cookies.txt`）、`--xdr-cookie-path`。
- **双平台双登录态**：客户其他数据（资产/事件/策略/设备/告警等）从 **MSSW** 取；easm 相关（暴露面/弱口令/漏洞/防护表）从 **mssp** 取，最终汇总成一份报告。测试：MSSW SIT `sitmssw.soar.sangfor.com`、mssp SIT `sitsoar.sangfor.com.cn`；均支持上生产切域。XDR cookie 仅透传、不参与主线（去掉）。
- **写路径散落 skill 根**：`output/`、`tmp/`、`cache/`、`安全体检报告/`（zip）。
- **交付**：生成 zip，经 `--delivery-id` 复制到 OpenClaw outbound 子目录，由企微插件发送。

### 主链路流程（health_report.js）
1. 解析参数 + help；读 MSSW/XDR cookie → 按 `--customer` 查 company_id
2. 校验 `--af`/`--sip` 为 true/false
3. `exportMsswDeviceList` 设备列表导出
4. `resolveEffectiveTimeRange` 时间范围（不传自动推导，≤30 天，end 不晚于今天）
5. `exportConfiguredXdrTables` 导表（asset/incident）
6. 各类统计（资产/事件/漏洞利用/遏制告警/托管资产/响应时间/风险资产）
7. `collectReportData` MSSW 资产概览 + 攻击态势
8. `分支1` 报告正文数据 + **Word 导出**（html_to_word）
9. `excel-beautifier` 美化风险清单 Excel（classic 主题）
10. `template_renderer` 渲染 HTML（注入 `window.SECURITY_REPORT_DATA`）
11. 打包 zip → 复制到 outbound（`--delivery-id`）

### 用户旅程（本次改造保持不变）
- 客户名必填；`--af`/`--sip` 必填，缺则**反问**（不猜默认）；时间缺省自动推导（最近 30 天）。
- 输出「安全体检报告.zip」给客户，禁止只发 html、禁止瞎编文件。
- **红线**：只做"生成报告"；禁止用现有接口满足其他需求（防隐私泄露）；禁止自编代码满足报告相关需求。
- 交付 `--delivery-id` 由系统提供，原样使用、不猜测不展示。

---

## 二、关键决策（已确认）

| 项 | 决策 | 说明 |
|---|---|---|
| 业务平台 | **双平台** `["mssw","mssp"]`（`muad.skill.json.platforms=["mssw","mssp"]`）；session-manager 已具 `MSSW/MSSP` 两个 adapter | 客户数据走 mssw；easm 数据走 mssp |
| 业务 host | MSSW SIT `sitmssw.soar.sangfor.com`（与 policy-check 一致）；**mssp SIT `sitsoar.sangfor.com.cn`**；上生产切回各自生产域 | host 分别与 session-manager 两平台凭据 baseUrl 对应 |
| 运行时 | **Node(>=18) + Python3 混合** | Node 主链路 + Python 子进程；runtime=script |
| 登录态 | 取 **mssw + mssp 两套 session**（session-manager 分别 get-state 两平台 cookies） | 替换 readMsswCookieInfo 等文件读取 |
| XDR cookie | **去掉** | 仅透传不参与主线；session-manager 无 XDR 平台，零损失 |
| 写文件 | 全部搬 `SKILL_OUTPUT_DIR` | output/tmp/cache/zip/美化输出；skill 根只读 |
| 只读资源 | 保留在 skill 根 | 模板 html、xlsx、png、yaml、config |
| 交付 | **保留 `--delivery-id` + outbound** | 核心能力；muad 下 outbound 目录解析待实施确认 |
| 目录 | **全量保留 + 目录名英文化（生成/交付文件名保持中文）** | 分支1→branch1、分支2→branch2、输出目录 安全体检报告→report；策略检查清单.xlsx / 漏洞清单.xlsx / 安全体检报告.zip 等生成文件名保持中文不变 |

---

## 二点五、改造后目录结构（贴近老结构，同 policy-check 思路）

> 原则：**尽量保留老 skill 的目录层级与命名，不重新归堆**。只做必要的最小调整：
> 新增 muad 必需件（`muad.skill.json`）、物理目录英文化（`分支1/分支2/安全体检报告`）、新增本方案文档 `docs/`；
> 其余文件/脚本/资源原位保留。

```
skills/health-checkup-report/
├── SKILL.md                  # 重写：frontmatter + 指令（旅程/红线不变；命令去 cookie 路径）
├── muad.skill.json           # 新增：{ name, platforms:["mssw","mssp"], runtime:"script", version }
├── README.md                 # 既有说明（登录/交付描述随改造更新）
├── package.json              # engines.node >= 18（主链路 Node）
├── requirements.txt          # 合并根/分支1/excel-beautifier；去 pywin32；含 playwright
├── health_report.js          # 主入口（登录态/写路径/baseUrl=SIT 改造）
├── src/                      # 既有 Node 模块（新增 session.js 统一登录）
├── scripts/                  # 既有 Python 脚本（目录路径引用同步英文目录）
├── excel-beautifier/         # 独立子技能原样保留（含其 SKILL.md/CLI）
├── branch1/                  # 原 分支1/（报告正文 + HTML→Word）
├── branch2/                  # 原 分支2/（开发遗留，全量保留）
├── report/                   # 原 安全体检报告/（运行时生成 → 写 SKILL_OUTPUT_DIR；zip 名仍中文）
└── docs/                     # 新增：本次改造方案
```

对比老结构：除 `分支1/→branch1`、`分支2/→branch2`、输出目录 `安全体检报告/→report`、新增 `muad.skill.json`、`docs/` 外，
其余（`health_report.js`、`src/`、`scripts/`、`excel-beautifier/`、各资源文件）**结构与命名保持原样**，不重新归堆，与 policy-check 的"贴老结构"思路一致。

---

## 三、登录态与请求改造（重点）

原：`readMsswCookieInfo` 读 Windows cookie 文件，解析 cookie/csrf 拼 header。

改造：
- 新增统一登录模块 `src/session.js`：分别调 `session-manager get-state --skill-name health-checkup-report` 取 **mssw 与 mssp 两平台**的 session，读对应 `sessionStateFile` 的 `platforms.mssw.cookies` / `platforms.mssp.cookies` 拼 `Cookie` header。
- **mssw 凭据**供客户数据请求（资产/事件/策略/设备/告警）；**mssp 凭据**供 easm 数据请求（暴露面/弱口令/漏洞/防护表）。两套分别注入、互不混用。
- **删除** `--mssw-cookie-path`/`--xdr-cookie-path`/`--cookie-path`/`--easm-cookie-path` 及所有文件读取逻辑（readMsswCookieInfo/readXdrCookieInfo/readSoarCookieInfo；删 update_cookie.js/update_domain.js）。
- 凭据（cookie/csrf）绝不打 stdout/日志（fail-loud）。
- host：mssw SIT `sitmssw.soar.sangfor.com`，mssp SIT `sitsoar.sangfor.com.cn`；各留 env 覆盖槽位（`HEALTH_CHECKUP_MSSW_BASE_URL` / `HEALTH_CHECKUP_MSSP_BASE_URL`），不改死代码。

---

## 三点五、登录态触点盘点与串联设计（本 skill 特有，重点）

> 背景：原 skill 由三位开发者分别实现，session/凭据获取方式不统一。**改造必须保证一个登录态贯穿全旅程**，
> 每个会联网取数的模块都能拿到正确凭据，否则某一段会断链导致报告不完整。

### 3.5.1 现状触点审计（三套写法）

| 触点 | 位置 | 凭据来源 | 打哪个平台 | 在主链路? |
|---|---|---|---|---|
| A1 Node 请求 | `src/mssw_client.js`：`readMsswCookieInfo`(2098)/`readXdrCookieInfo`(290)/`readSoarCookieInfo`(2118) → `requestJson` | 读 `mssw_cookies.txt` / `xdr_cookies.txt` / `cookies.txt` | **mssw**（客户数据） | **是**（全部客户数据接口） |
| A2 Node→Python 资产分页 | `src/mssw_asset_paged_export.js` → `scripts/mssw_asset_paged_export.py`（`--cookie-path`） | 传 cookie 文件路径 | **mssw** | 是（资产 Excel 分页） |
| B1 Python 策略检查 | `分支1/report/policy_check_export.py`（`--cookie-path`；`DEFAULT_BASE_URL=sitmssw.soar.sangfor.com.cn`⚠️带.cn） | 读 cookie 文件路径 | **mssw** | 是（策略检查清单） |
| B2 Python 防护/easm/分支2 | `scripts/export_prevention_table.py` → `分支2/excel_scripts/{exposuer,weak,vuln}_report.py` | 硬编码 `C:\...\cookies.txt` + `mssw_cookies.txt` | **mssp（easm）+ mssw** | 是（弱口令/漏洞/暴露面/防护表，已确认接入） |
| C 辅助 | `scripts/update_cookie.js` / `update_domain.js` | `M:\...` + Postman | - | 否（开发辅助，删除） |

**根因**：A1 在 Node 内存用 cookie；A2/B1/B2 在各自 Python 子进程里**再从文件读**（或硬编码盘符路径）。
Node 调 Python 时传的是 **cookie 文件路径**（`--cookie-path <resolvedPath>`），Python 再读文件。

### 3.5.2 改造后：一套凭据贯穿全旅程

1. **主入口 Node 一次性取两套凭据**：新增 `src/session.js`，分别调 `session-manager get-state` 取 **mssw 与 mssp** 的 cookies（cookie 串 + csrf），构建两个凭据对象：`msswCred`（客户数据）/ `msspCred`（easm 数据）。
2. **Node 侧请求**：msswCred 供客户数据请求，msspCred 供 easm 数据请求；所有 `readMsswCookieInfo`/`readXdrCookieInfo`/`readSoarCookieInfo` 替换为对应凭据（XDR 删除）。
3. **写给 Python 子进程**：主入口把两套凭据**内容**分别写为 `SKILL_OUTPUT_DIR/session/mssw_cookies.txt` 与 `.../mssp_cookies.txt`（`0o600`、本次运行唯一、随任务清理），
   按数据源把对应**文件路径**经 `--mssw-cookie-path`/`--easm-cookie-path` 传给各 Python（A2/B1 用 mssw；B2 分支2 用 mssp）——**Python 侧"读 cookie 文件"这步保持不动**，改动最小且保证串联。
4. **凭据安全**：两套 cookie/csrf 只存在于各自私有文件与 Node 内存，绝不打印到 stdout/日志；临时文件权限 600。

### 3.5.3 各模块最终交付效果对照（保证旅程完整串联）

| 报告组成部分 | 依赖的取数模块 | 改造后凭据通路 |
|---|---|---|
| HTML 报告主体（资产/风险/事件/攻击态势/遏制告警） | A1（MSSW 全接口） | Node session 凭据 → 直接请求 |
| 时间范围自动推导 | A1（项目列表） | 同上 |
| 资产 Excel（分页） | A2（mssw） | mssw 凭据 → 写 `mssw_cookies.txt` → 传 Python |
| 策略检查清单 Excel | B1（mssw） | 同上（mssw） |
| 防护/弱口令/漏洞/暴露面 | B2（**mssp** easm + mssw） | **mssp** 凭据 → 写 `mssp_cookies.txt` → 传分支2 |
| Word 附件（html_to_word） | 分支1 + excel-beautifier | 无联网（读已生成文件/模板） |
| ZIP 交付 | delivery-id → outbound | 不涉凭据 |

**任一环节缺凭据 → 该表格/章节为空或报错**；因此统一"Node 取一次 + 写私有文件 + Python 读同一文件"是串联的关键。

### 3.5.4 已确认（开发者澄清 + 决策）

- [x] **两个平台、两套登录态（mssw + mssp）**：开发者确认"EASM/SOAR 就是 mssp 的登录态，EASM 只是给 mssp 提供数据，取数仍调 mssp API"。故**客户数据走 mssw、easm 数据走 mssp**，各取各的 session、互不混用，最终汇总；不能用 mssw 凭据去调 easm 接口。
- [x] **B2（分支2 弱口令/漏洞/暴露面/防护表）必须接入，凭据走 mssp**：报告含这些清单，缺了不完整。改造时把分支2 脚本里**硬编码**的 `C:\...\cookies.txt`/EASM/SOAR 域 改为读 **mssp 凭据文件** + **mssp 查询域名**；其中 vuln_report 另用到的 mssw cookie 走 mssw 凭据。
- [x] **域名统一**：mssw 相关统一为 SIT `sitmssw.soar.sangfor.com`（如 B1 `policy_check_export.py` 原 `sitmssw.soar.sangfor.com.cn` 去 `.cn`）；**mssp 相关统一为 SIT `sitsoar.sangfor.com.cn`**（分支2 原 `soar59.sangfor.com.cn`/`pre.soar.sangfor.com` 等改到 mssp 域 + mssp 凭据）。
- [x] **分支2 全量保留且接入**（不是"保留未接入"）。

---

## 四、文件系统改造（重点）

skill 根只读 →
| 原 | 改造后 |
|---|---|
| 读：模板 html、xlsx、png、yaml、config | 保留 skill 根（只读加载） |
| 写：`output/`、`tmp/`、`cache/`、`安全体检报告/`（+`风险清单/`）、word 导出 | 全部 → `SKILL_OUTPUT_DIR` 下按角色子目录 |
| outbound 交付目录 | 按原 `--delivery-id` 语义，muad 环境定位待实施确认 |

所有 Python 子进程的 `cwd`/相对写路径改为可注入输出根，不假设 skill 根可写。

---

## 五、中文目录名英文化（本 skill 特有，重点）

> 用户的澄清：**只改文件夹名；生成/对外交付的文件名保持中文不变**。
> 客户看到的 `安全体检报告.zip`、`漏洞清单.xlsx`、`策略检查清单.xlsx`、HTML 文件名等**一律保持中文**，SKILL.md 里的输出描述也不变。

**仅物理重命名目录（跨 JS/PY 对目录路径的引用同步）**：

| 原（中文目录） | 英文化 |
|---|---|
| 目录 `分支1/` | `branch1/` |
| 目录 `分支2/` | `branch2/` |
| 输出目录 `安全体检报告/`（内含 `风险清单/`） | 实现层 `report/`（内含 `risk_list/`）；打包出的 zip 名仍是「安全体检报告.zip」 |

**保持不变（生成/对外文件，名不改，仅搬去 SKILL_OUTPUT_DIR 或保留 skill 根只读）**：
- `安全体检报告.zip`、`漏洞清单.xlsx`、`策略检查清单.xlsx`
- 生成 HTML `【深信服】安全体检报告-<客户>-<时间>.html`
- `分支1/report/` 下的静态参考 `策略检查清单.xlsx` 等文件名不改

**需同步的目录路径引用（只改目录、不改文件名）**：
- JS：`src/branch1_adapter.js`（`分支1` 根 → `branch1`；`安全体检报告/风险清单` 目录 → `report/risk_list`）、`health_report.js`（输出目录 `安全体检报告/` → `report/`；`漏洞清单.xlsx` 等文件名不变）。
- PY：`scripts/prevention_data.py`（`分支2/generate_data.py` → `branch2/generate_data.py`）、`scripts/export_prevention_table.py`（`分支2/excel_scripts/...` → `branch2/excel_scripts/...`）等。

---

## 六、Python 依赖 & 运行时确认（重点）

- Node：无需第三方 npm（仅内置模块）；`engines.node >= 18`。
- Python3 依赖（合并根 + `分支1` + `excel-beautifier`）：`openpyxl`、`PyYAML`、`requests`、`beautifulsoup4`、`lxml`、`python-docx`、`Pillow`。
- **playwright（+ Chromium）**：分**两层**，务必区分——
  1. **Python 包层（playwright）**：根 `requirements.txt` **已含 `playwright>=1.40.0`**（第 11 行；分支1/excel-beautifier 亦有），`pip3 install -r` 在 **Dockerfile 构建期**自动装入 app 镜像 ✅；若 Pod 内 `import playwright` 缺失，需 `pip3 install --user --break-system-packages "playwright>=1.40.0"`（开发者 pod01 实测可升到 1.62.0）。
  2. **浏览器二进制层（Chromium）**：`pip install` **不下载浏览器二进制**。**已确认（开发者 + pod01 实测）**：base 镜像（Dockerfile.base）**已预置 Chromium**——`ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` + `node .../playwright-core cli.js install --with-deps chromium`，实际路径 **`/home/node/.cache/ms-playwright/chromium-<ver>/chrome-linux/chrome`**（**不在** `/usr/bin/chromium`）。**关键坑**：Python Playwright 默认找自己的 headless shell（`chromium_headless_shell-<ver>/chrome-linux/headless_shell`，该文件不存在）→ 报 `Executable doesn't exist ...`；**必须显式 `executable_path` 指向已装 Chromium**。
  **定稿方案（路径C｜复用 base 预置 Chromium，不新增镜像体积）**：改 [`html_to_word_export.py`](../branch1/html_to_word/html_to_word_export.py:377) 的 `_find_system_chrome()`，增加 glob 探测 `/home/node/.cache/ms-playwright/chromium-*/chrome-linux/chrome` 与 headless-shell 变体，并在 `render_html()` 的 `launch()` 传 `executable_path`（失败回退自带 chromium）。前提：Pod 内 Python 端 `import playwright` 可用 + base 已设 `PLAYWRIGHT_BROWSERS_PATH`。
- **去掉 pywin32 / Word COM**（仅 win32）：`html_to_word` 的 `_update_fields_via_word`（[`html_to_word_export.py`](../分支1/html_to_word/html_to_word_export.py:987)）用 `win32com` 调 Word 刷新域，Linux 不支持 → **优雅跳过**（docx 域代码保留，仅不自动刷新 TOC/PAGE，避免 Linux 崩溃）；删除 `_find_system_chrome` 的 Windows `C:\Program Files\...chrome.exe` 候选（见六点五 C3）。执行统一 `python3`（去除 `execFile('python')` 回退混乱）。
- 长任务：资产分页导出 `spawn` + 2h 超时 → 需确认 muad 执行超时/长任务机制。

---

## 六点五、Windows→Linux 路径改造清单（本 skill 特有，重点）

> 用户强调：不要只补某一处被点名的路径（如 Chromium），而要**提前把整一类 Windows→Linux 路径迁移点全部列清**，避免运行态逐个碰壁。
> 本 skill 由三位开发者编写、四处散落，路径类改造集中为 **4 类**：盘符绝对路径 / Windows 专属字体 / Windows 专属可执行与 COM / 相对写路径假设。下表逐一清零。

### A. Windows 盘符 / 环境变量绝对路径（硬编码 → 注入/删除）

| 触点 | 位置 | 现状（Windows） | 改造（Linux/muad） |
|---|---|---|---|
| A1 临时/输出目录 | `分支2/excel_scripts/{weak,vuln,exposuer}_report.py` | `TEMP_DIR` / `OUTPUT_FILE` = `C:\Users\User\Downloads\...` | 注入 `SKILL_OUTPUT_DIR`；禁止硬编码盘符 |
| A2 cookie 文件路径 | 同上 `EASM_COOKIES_FILE` / `MSSW_COOKIES_FILE` = `C:\Users\User\Downloads\*.txt` | 改读 **注入的凭据文件**（`SKILL_OUTPUT_DIR/session/{mssw,mssp}_cookies.txt`，见三点五） |
| A3 USERPROFILE | `scripts/update_cookie.js`(9)、`update_domain.js`(24) `process.env.USERPROFILE\Downloads` | 脚本**整体删除**（开发辅助） |
| A4 M 盘 / env 路径 | `SKILL.md`(12,22-23)、`README.md`(12,23,52-53) `M:\Users\$env:USERNAME\Downloads\...` | 命令去除 cookie 路径参数；文档移除 Windows 路径示例 |
| A5 历史产物 | `tmp/branch1-report.json`(159-160) `C:\Users\User\Desktop\...` | 删除（不随迁） |

### B. Windows 专属字体（水印/渲染退化）

| 触点 | 位置 | 现状 | 改造 |
|---|---|---|---|
| B1 水印字体 | `excel-beautifier/scripts/excel_beautifier/watermark.py`(31-36) `C:/Windows/Fonts/msyh.ttc` 等 | 补 **Linux 字体候选**（`/usr/share/fonts/**/*.ttc|.otf`）＋存在性检测；缺失则水印退化（不崩溃） |
| B2 报告/Word 字体 | `security-report-preview.html`(39) 引用 Google Fonts + Windows 字体 | 内网 Pod 不可达公网字体 → 回退系统字体；验收报告与 Word 字体可接受 |

### C. Windows 专属可执行 / COM（Linux 需换路径或优雅降级）

| 触点 | 位置 | 现状（Windows） | 改造（Linux/muad） |
|---|---|---|---|
| C1 Word COM 域刷新 | `html_to_word/html_to_word_export.py` `_update_fields_via_word`(987) | 依赖 `win32com`+Word | Linux **优雅跳过**（域不自动刷新，进 docx 保留代码），配合第六节去 pywin32 |
| C2 Office/WPS 探测 | `html_to_word/scripts/check_env.py`(253) 探测 `C:\Program Files\...Office/WPS` | 删除 Windows 探测分支；仅保字体/可用性检查 |
| C3 Chromium 探测 | `html_to_word/html_to_word_export.py` `_find_system_chrome`(380) `C:\Program Files\*chrome.exe` | **换 Linux/Playwright 路径**：`/home/node/.cache/ms-playwright/chromium-*/chrome-linux/chrome` + PATH（路径C，见第六节）；删除 Windows `chrome.exe/msedge.exe` 候选 |

### D. 相对 / 写路径假设（skill 根只读 → 写搬 SKILL_OUTPUT_DIR）

| 触点 | 位置 | 现状（假定 cwd/skill 根可写） | 改造 |
|---|---|---|---|
| D1 输出根 | `health_report.js`(104-106,605,622) `root=__dirname` → `output/`、`安全体检报告/` | 输出根改 `SKILL_OUTPUT_DIR`；`root` 仅保留 **只读资源**（模板 html/xlsx/png） |
| D2 tmp 写 | `src/*.js` 大量 `path.join(__dirname,'..','tmp',...)`（[`mssw_client.js`](../src/mssw_client.js:1924)、`risk_asset_count.js`(8)、`prevention_exports.js`(7)、`branch1_adapter.js`(13,110) 等） | `tmp` → `SKILL_OUTPUT_DIR/tmp` |
| D3 相对路径 | `分支2/generate_data.py`(5) `BASE_DIR="风险清单"`；`分支1/report/policy_check_export.py`(29-30) `DEFAULT_OUTPUT_PATH/TMP_DIR`；`html_to_word` `tmp_dir`(561) | 改注入/环境输出根，**不假设 cwd=skill 根可写** |
| D4 覆盖原文件 | `excel-beautifier/scripts/cli.py`(23-30) 不传 `-o` 则覆盖输入 | 调用方一律传绝对 `-o`（`SKILL_OUTPUT_DIR/...`），**不覆盖只读的 skill 根输入** |

---

## 七、SKILL.md 改造

- 保留：用户旅程、缺参/反问规则、红线段、输出 zip 要求。
- frontmatter：`name: health-checkup-report`；描述沿用。
- command 改为 skill 根内 `node health_report.js`，去掉 cookie 路径参数；保留 `--customer/--af/--sip/--start/--end/--delivery-id`；生成/交付文件名（`安全体检报告.zip` 等）保持中文不变。

---

## 八、边界/风险

- **playwright/Chromium**：已定稿**路径C**——base 镜像已预置 Chromium（`/home/node/.cache/ms-playwright/chromium-*/chrome-linux/chrome`），SKILL 必须显式 `executable_path`（默认找 headless_shell 会失败）；**不新增镜像体积**；待实施确认 Pod 内 Python 已装 playwright + `PLAYWRIGHT_BROWSERS_PATH` 生效。
- **outbound 交付目录**：muad 环境路径来源需确认。
- **长任务**：资产分页导出超时需匹配 muad 执行上限。
- **敏感数据**：报告含客户资产/事件明细，禁止写日志；cookie 不出现在任何日志。
- **多技能边界**：`excel-beautifier` 是独立子技能（现有 SKILL.md），并入本 bundle 时保留其 CLI 用法。

---

## 九、验证方式（改造后）

- `node --check` 全量 JS；`python3 -m py_compile` 全量 py。
- 回归组合：仅 customer（默认时间/订阅反问）→ 显式时间 → 显式 delivery-id → af/sip 组合 → 空数据客户。
- 核实集群 Pod 到 SIT `sitmssw.soar.sangfor.com` 连通；Console mssw 凭据 baseUrl 与业务 host 一致（上生产切回 `mssw.sangfor.com.cn`）。
- 验证 ZIP 内容完整、含 HTML+风险清单+Word；outbound 交付落位正确。

---

## 十点五、改造接口 / API 清单（对照溯源）

> 说明：本表整理本次改造**会触达或改动**的全部**外部 HTTP API（平台 REST 端点）**与**内部调用接口（JS 函数 / Python CLI / 参数）**，实现与回归时按此逐项对照，避免遗漏。host 统一口径见第二节决策表（mssw SIT `sitmssw.soar.sangfor.com` / mssp SIT `sitsoar.sangfor.com.cn`）；"凭据"一项指该接口取数所使用的 session（mssw=mssw 凭据、mssp=mssp 凭据）。

### A. 外部 HTTP API（平台 REST 端点）

| # | 平台 | 端点（相对 host） | 所在文件 | 用途 | 改造动作 |
|---|---|---|---|---|---|
| A1 | mssw | `/apps/asset/view/asset/asset_view/count?_method=GET` | `src/mssw_client.js`(41,1975,1991) `MSSW_ASSET_COUNT_ENDPOINT` | 资产总量 / 待交付资产 | host 统一 SIT mssw；走 mssw 凭据 |
| A2 | mssw | `/gateway/mss-mdr/web/api/mssw/mss-mdr/v1/incident_table` | `src/mssw_client.js`(42,2034) `MSSW_INCIDENT_TABLE_ENDPOINT` | 事件表分页 | 同上 |
| A3 | mssw | `/gateway/mss-mdr/web/api/mssw/mss-mdr/v1/incidents/export/tasks` | `src/mssw_client.js`(35) `MSSW_INCIDENT_EXPORT_ENDPOINT` | 事件列表导出任务 | 同上 |
| A4 | mssw | `/gateway/log-search-center-service/datalake/v1/ckCount` | `src/mssw_client.js`(43,3144) `MSSW_LOG_SEARCH_COUNT_ENDPOINT` | 安全日志数统计 | 同上 |
| A5 | mssw | `/gateway/log-search-center-service/datalake/v1/personalized_report/security_check_report_stats` | `src/mssw_client.js`(44,3284) | 待处置统计 | 同上 |
| A6 | mssw | `/ngsoc/INCIDENT/api/v1/table/query/alertTableQueryHandler?...` | `src/mssw_client.js`(24) `ALERT_QUERY_ENDPOINT` | 告警查询 | 同上 |
| A7 | mssw | `/ngsoc/INCIDENT/api/v1/incidents/attckCount` | `src/mssw_client.js`(45,1092) `ATTCK_COUNT_ENDPOINT` | 攻击统计 | 同上 |
| A8 | mssw | `/ngsoc/INCIDENT/api/v1/table/query/incidentTableQueryHandler` | `src/mssw_client.js`(46,1175) | 案例事件查询 | 同上 |
| A9 | mssw | `/ngsoc/INCIDENT/api/v1/incidents` | `src/mssw_client.js`(32,1107) `DISPOSAL_TABS_ENDPOINT` | 事件详情/处置时间线 | 同上 |
| A10 | mssw | `/api/apex/device/v1/devices/list?...` | `src/mssw_client.js`(33,2975) `DEVICE_LIST_ENDPOINT` | 设备列表导出 | 同上 |
| A11 | mssw | `/api/apex/thirdparty/v1/app/instance/list?...` | `src/mssw_client.js`(34,2996) | 第三方设备统计 | 同上 |
| A12 | mssw | `/gateway/customer-mgr-service/order/v1/user/customer_statistic` | `src/mssw_client.js`(36,2613) `MSSW_CUSTOMER_STATISTIC_ENDPOINT` | 客户统计 / 客户列表查询 | 同上 |
| A13 | mssw | `MSSW_PROJECT_LIST_ENDPOINT`（常量，`src/mssw_client.js`(2641) 使用） | `src/mssw_client.js` | 项目列表 → 时间范围推导 | 同上 |
| A14 | mssw | 资产导出任务 / 结果下载 / 分页（`src/mssw_asset_paged_export.js` → `scripts/mssw_asset_paged_export.py`） | 资产管理出口 | 资产 Excel 分页导出 | 走 mssw 凭据文件；`--base-url` 注入 SIT mssw |
| A15 | mssp | `/order/v1/vul_manage/vul_risk_export`（接口8/9 触发导出） | `分支2/excel_scripts/vuln_report.py`(415) / `weak_report.py`(440) | mssw 侧漏洞/弱口令导出触发 | host 统一 SIT mssw；走 mssw 凭据 |
| A16 | mssp | `/order/v1/vul_manage/download_file?file=`（接口10） | `分支2/excel_scripts/vuln_report.py`(502) / `weak_report.py`(522) | mssw 侧导出文件下载 | 同上 |
| A17 | mssp | `/gateway/customer-mgr-service/order/v1/user?_method=GET`（接口0/8-0） | `分支2/excel_scripts/*`(vuln 276,weak 297,exposuer 164) | 客户模糊搜索 | host 统一 SIT mssp；走 **mssp 凭据** |
| A18 | mssp | `/gateway/vuln-manager/vm/order/v1/weak_pwd/easm/summary_list`（接口7-1） | `分支2/excel_scripts/weak_report.py`(337) | EASM 弱口令母表 | 同上（mssp） |
| A19 | mssp | `/gateway/vuln-manager/vm/order/v1/weak_pwd/easm/list?ip=`（接口7-2） | `weak_report.py`(379) | EASM 弱口令子表 | 同上（mssp） |
| A20 | mssp | `/gateway/vuln-manager/vm/order/v1/weak_pwd/weak_pwd_info?_method=GET` | `weak_report.py`(423) | 弱密码详情 | 同上（mssp） |
| A21 | mssp | `/gateway/vuln-manager/vm/order/v1/vulnmgr/exposed_surface/report`（接口5） | `vuln_report.py`(318) | EASM 漏洞导出触发 | 同上（mssp） |
| A22 | mssp | `/gateway/vuln-manager/vm/order/v1/vulnmgr/exposed_surface/report_async_task`（接口6） | `vuln_report.py`(353) | EASM 导出轮询 | 同上（mssp） |
| A23 | mssp | `${SOAR_BASE_URL}{download_path}` | `vuln_report.py`(386) | EASM 漏洞文件下载 | 同上（mssp） |
| A24 | mssp | `/order/v1/report/template_list`（接口1） | `exposuer_report.py`(192) | 报告模板列表 | 同上（mssp） |
| A25 | mssp | `/order/v1/report/generate_easm_report`（接口2） | `exposuer_report.py`(211) | 暴露面报告生成 | 同上（mssp） |
| A26 | mssp | `/order/v1/report/report_status`（接口3） | `exposuer_report.py`(231) | 报告状态轮询 | 同上（mssp） |
| A27 | mssp | `/order/v1/report/report_download?task_id=`（接口4） | `exposuer_report.py`(267) | 报告压缩包下载 | 同上（mssp） |
| A28 | mssw | `/gateway/idps/order/v1/tools/task/xdr_policy_check/result`（`API_PATH`；`DEFAULT_BASE_URL=https://sitmssw.soar.sangfor.com.cn`） | `分支1/report/policy_check_export.py`(26,27) | 策略检查清单结果 | `DEFAULT_BASE_URL` **去 `.cn`** → SIT mssw；走 mssw 凭据 |

### B. 内部调用接口（JS 函数 / Python CLI / 参数）

| # | 触点 | 类型 | 位置 | 改造动作 |
|---|---|---|---|---|
| B1 | `src/session.js` | 新增模块 | 新建 | 统一调 `session-manager get-state` 取 mssw + mssp 两套 session，构建 `msswCred`/`msspCred`，供全链路 |
| B2 | `readMsswCookieInfo` / `readXdrCookieInfo` / `readSoarCookieInfo` | Node 函数 | `src/mssw_client.js`(2098 / 290 / 2118) | 删除，改用 `src/session.js` 凭据（XDR 整体去掉） |
| B3 | `buildMsswHeaders` / `buildMsswExportHeaders` / `buildMsswAssetExportHeaders` | Node 函数 | `src/mssw_client.js`(2142,2173,2182) | 凭据来源由 cookie 文件 → session 凭据注入 |
| B4 | `DEFAULT_MSSW_BASE_URL`(22) / `DEFAULT_SOAR_BASE_URL`(23) | Node 常量 | `src/mssw_client.js` | 改 SIT host + 支持 env 覆盖（`HEALTH_CHECKUP_MSSW_BASE_URL`/`HEALTH_CHECKUP_MSSP_BASE_URL`） |
| B5 | `--mssw-cookie-path` / `--xdr-cookie-path` / `--cookie-path` / `--soar-base-url` | CLI 参数 | `health_report.js` help(698-705) | 删除 cookie 路径类；baseUrl 统一 SIT + env 覆盖 |
| B6 | `/`→Python 资产分页导出 | Node→Py 子进程 | `src/mssw_asset_paged_export.js` → `scripts/mssw_asset_paged_export.py`(`--cookie-path`/`--base-url`/`--company-id`) | 注入 SIT mssw base-url + mssw 凭据文件路径 |
| B7 | 防护/easm/分支2 导出 | Node→Py 子进程 | `scripts/export_prevention_table.py` → `分支2/excel_scripts/{exposuer,weak,vuln}_report.py` | 注入 mssp 凭据文件（easm）+ mssw 凭据文件（漏洞导出）+ SIT 双域；**去掉硬编码 `C:\...\cookies.txt`** |
| B8 | 策略检查 | Node→Py 子进程 | `分支1/report/policy_check_export.py`(`--cookie-path`/`--mssw-base-url`) | 注入 mssw 凭据文件 + SIT mssw 域 |
| B9 | 分支1 适配 | Node 模块 | `src/branch1_adapter.js`(9,24) | `分支1` → `branch1`、`安全体检报告/风险清单` → `report/risk_list` 目录引用 |
| B10 | 分支2 数据加工 | Python | `分支2/generate_data.py`(5 等) | 目录引用 `分支2` → `branch2`；内部读取 `风险清单/漏洞清单.xlsx` 路径搬 `SKILL_OUTPUT_DIR` |
| B11 | 开发辅助 | JS 脚本 | `scripts/update_cookie.js` / `update_domain.js` | **删除**（仅开发本机用，非业务链路） |
| B12 | Word 导出 / Excel 美化 | Python | `分支1/html_to_word/html_to_word_export.py`(`_find_system_chrome`@377、`render_html`@328)、`excel-beautifier/` | `_find_system_chrome()` glob 探测 `/home/node/.cache/ms-playwright/chromium-*/chrome-linux/chrome` + `launch(executable_path=…)`；输出路径搬 `SKILL_OUTPUT_DIR` |

---

## 十、待实施时确认（不影响开工方向）

- [x] 已确认（开发者 + pod01 实测）：base 镜像已预置 Chromium（`/home/node/.cache/ms-playwright/chromium-*/chrome-linux/chrome`）+ Pod 内 Python Playwright 可用；SKILL 需**显式 `executable_path`**（路径C）。待实施验证：Pod 内 `import playwright` 可用 + `PLAYWRIGHT_BROWSERS_PATH` 生效。
- [ ] outbound 交付目录在 muad 的具体绝对路径 / 是否由 guard 注入。
- [x] 已澄清：生成/对外交付文件名保持中文不变（`安全体检报告.zip` 等），仅目录名英文化；无待定。
