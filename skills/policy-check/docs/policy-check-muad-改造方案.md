# policy-check 改造为 muad 架构 skill — 最终方案（一页）

> 目标：把 `skills-old/policy-check/`（原 Windows 本地 Python skill）改造成符合 muad 运行时架构、可在集群 Linux Pod 正常执行的业务 skill。
> 产物目录：`skills/policy-check/`（开发目录，改造完成后按 skill-upload 流程上传，pending 待管理员审批）。

## 〇、前置知识：baseUrl（域名）与 API 端点（小白版）

本 skill 核心是"用 mssw 平台的登录态去调 mssw 的接口拿数据"。要理解改造，先分清两件事：

**① baseUrl = 平台域名（根地址）**
- 就是一串"协议 + 域名"，`https://mssw.sangfor.com.cn`，指"我要连的是哪个网站"。它不含具体接口路径。
- 旧 skill 里它叫 `origin`，`session-manager` 的 mssw 适配器里叫 `baseUrl`，是同一个东西。

**② API 端点（endpoints）= 每个具体接口的相对路径**
- 每个接口一条路径，全部配在 `config/api_config.json` 的 `endpoints` 表里（现在是相对路径，以 `/` 开头）：
  | 名字 | 相对路径 |
  |------|----------|
  | company_list | `/gateway/customer-mgr-service/order/v1/user/customer_statistic?_method=GET` |
  | device_info | `/api/apex/device/v1/devices/list` |
  | policy_check_create | `/gateway/idps/order/v1/tools/task/xdr_policy_check/create` |
  | policy_check_status | `/gateway/idps/order/v1/tools/task/xdr_policy_check/status` |
  | policy_list | `/gateway/idps/order/v1/tools/task/xdr_policy_check/result` |

**③ 完整请求 URL = 域名 + 接口路径**
```
完整URL = https://mssw.sangfor.com.cn  +  /gateway/idps/order/v1/tools/task/xdr_policy_check/create
         https://mssw.sangfor.com.cn/gateway/idps/order/v1/tools/task/xdr_policy_check/create
```
打个比方：baseUrl 是"公司地址"，endpoints 是"我要去公司的哪个办公室房间号"。合起来才知道具体去哪。

**④ 记忆口诀**
- **baseUrl**：就一个域名（`https://mssw.sangfor.com.cn`），全 skill 共用。
- **endpoints**：很多个，每个接口一个相对路径。
- muad 改造后**二者都保持不变**（作者确认：muad 只负责帮我们带登录态发请求，具体打哪个 URL 仍用原来的）。

## 用户旅程（本次改造保持不变）

> ⚠️ 核心原则：**用户与 skill 的完整交互旅程，本次改造一行都不改**。下面的旅程就是改造后 100% 保真的用户视角。脚本语言、登录方式、文件位置等都属于实现层，对用户完全透明。

### 旅程总览：3 个独立场景，用户随时按需触发

用户可在任意时刻反复、跳跃地问这三个场景，互不强制依赖：

```
场景① 下发策略检查   （用户说"给X公司做策略检查"）
场景② 查询任务状态   （用户问"任务怎么样了/跑完了吗"）
场景③ 查询策略结果   （用户问"结果/有哪些风险/检查详情"）
```

### 场景① 下发策略检查任务

1. 用户给出公司名（规则：`给客户A做策略检查`→公司名=A）。
2. skill 在 mssw 做公司模糊匹配确认；**若命中多个候选**，则列出「编号 + 公司名 + ID」让用户用编号确认（`--select` 分支，全程由 skill 引导，用户只需报编号）。
3. 获取设备 ID，创建策略检查任务。
4. 自动记录本次会话（供场景②③默认读取）。
5. 向用户**仅输出模板1（下发结果）**：客户、设备数（AF/SIP/EDR 分别几个）、任务数 + task_ids、跳过台数；并提示"本次只做下发，不返回结果，下次可问我查询状态/结果"。
6. **不自动进入场景②③**，静默结束，等用户下一句。

### 场景② 查询任务状态

1. 用户问"任务怎么样了/跑完了吗/状态如何"。
2. skill 用最近一次会话的 task_ids（或用户显式指定）**查询一次**当前状态。
3. 输出模板2（状态分布 + 整体结论）：
   - 全部终态 → 提示可问"查询策略检查结果"看详情；
   - 仍有进行中 → 提示"任务还在跑，稍后再问我一次状态"；
   - 全部不存在(9906) → 切"⚠️ 未找到任务，可能已过期/被清理"分支。
4. **单次查询、不自动轮询**——用户想更新就再问一次。

### 场景③ 查询策略检查结果

1. 用户问"结果/有哪些风险/检查详情"。
2. skill 用最近会话的公司/设备 + 时间范围（**默认最近7天**，可用 `--start/--end` 指定）查询结果。
3. 输出模板3，按三类分组（**空分组整组省略**）：
   - 【1】策略获取失败
   - 【2】授权过期/未开通
   - 【3】其他风险项（按设备类型 AF/SIP/EDR 再分组）
4. 空结果 → 切"✅ 策略检查结果为空"分支。

### 旅程不变项自查核对

| 旅程元素 | 是否改动 | 说明 |
|----------|:--:|------|
| 触发词 & 意图识别（下发/状态/结果） | 不变 | 原样保留 |
| 场景① 多候选 `--select` 交互 | 不变 | 保留，用户仅报编号 |
| 场景①②③ 输出模板 1/2/3 | 不变 | 保留，含空组省略、空结果/未找到任务等分支 |
| 三场景分离、不自动轮询 | 不变 | 保留，用户主动问才看 |
| 会话记录跨场景默认读取 | 不变 | 仍把最近会话记下来供②③默认读（仅落盘位置从 skill 根移到 `SKILL_OUTPUT_DIR`，对用户不可见）|
| 企微通知 | 不影响旅程 | 它是旁路通知，不在用户旅程输出中；去掉后用户收到的仍是模板1/2/3 |

> **结论**：本次改造只动"嘴到接口"的实现层（凭据/登录、curl→python、写文件位置、错误处理）、以及去掉旁路企微通知；**用户看到的每个场景的提问方式、分支交互、返回模板完全保持原样**。

## 一、关键技术决策（已确认）

| 项 | 决策 |
|----|------|
| 业务平台 | `mssw`（`muad.skill.json.platforms = ["mssw"]`，须已存在于 Console） |
| 脚本语言 | Python3；依赖 `requests`（须确保列入 `requirements.txt`） |
| 登录态 | 由 `session-manager get-state --skill-name <skill>` 获取（agent 身份由 guard 注入的 `MUAD_SESSION_KEY` 决定，脚本不自报、不手动粘贴 cookie） |
| 业务 URL | **仍用原本的** `https://mssw.sangfor.com.cn` + `/gateway/...`（作者：muad 只代发请求、只管登录态，具体 URL 不变；脚本内置原值为默认，并保留 `POLICY_CHECK_BASE_URL` env 覆盖槽位——已确认） |
| 写文件 | 所有会话/候选/报告移到 guard 注入的 `SKILL_OUTPUT_DIR`（skill 根只读） |
| 企微通知 | **去掉**（作者：暂时用不了） |
| 输出模板 | 保留原模板 1/2/3；脚本吐 JSON 数据到 stdout，由 `SKILL.md` 渲染 |

## 二、目录结构（改造后）

```
skills/policy-check/
├── SKILL.md                 # 重写：frontmatter + 指令 + 模板 1/2/3 + 触发词
├── muad.skill.json          # 新增：{ name, platforms:["mssw"], runtime:"script", version }
├── references/              # 可选：策略检查说明
└── scripts/                 # Python 脚本（原先 phase1/phase2/phase4 逻辑归拢于此）
    ├── policy_check.py      # 共享：session-manager 登录态读取 + HTTP + 配置
    ├── trigger.py           # Phase1 下发（替代 phase1_trigger.py）
    ├── status.py            # Phase2 状态查询（替代 phase2_wait_check.py）
    └── result.py            # Phase4 结果查询（替代 phase4_generate_message.py）
```

## 三、登录态与请求改造

- 原 `shared/__init__.py` 的 `get_cookie`/`get_cookie_from_file`/`cookie_file`（Windows 绝对路径）/字符串混淆校验 **全部废弃**。
- 新建：脚本调用 `session-manager get-state --skill-name policy-check` → 从返回 `sessionStateFile` 读 `platforms.mssw.cookies`，组装 `Cookie` 头；业务 API 基于原 `origin`（默认 `https://mssw.sangfor.com.cn`，读取顺序：`POLICY_CHECK_BASE_URL` env → 内置原值）。
- 请求仍 `verify=False`（集群内 mssw 自签 TLS）；失败写 stderr 并 exit 非 0（fail loud），结果数据写 stdout。
- 模块导入：去掉基于 `__file__` 的 sys.path hack，统一 `scripts/` 内相对 import；保留 `sys.dont_write_bytecode` 避免向只读根写 `__pycache__`。

## 四、输出目录规划（skill 根只读）

| 旧路径（只读，不可写） | 改造后（写 `$SKILL_OUTPUT_DIR/`） |
|---|---|
| `cache/last_session.json` | `$SKILL_OUTPUT_DIR/last_session.json` |
| `cache/phase1_candidates.json` | `$SKILL_OUTPUT_DIR/candidates.json` |
| `reports/` | `$SKILL_OUTPUT_DIR/reports/` |
| `templates/default_policy_config.json` | 保留为只读参考，不写 |

- `SKILL_OUTPUT_DIR` 实际绝对路径模板（Pod 内，`<agentId>` 为业务 agent、`<peerId>` 为 per-user 会话标识）：
  ```
  /home/node/.openclaw/workspace-<agentId>/skill-outputs/<peerId>/
  ```
  依据：`agent.workspace = /home/node/.openclaw/workspace-<agentId>`（`runtimeconfig/builder.go`:17,316），guard 注入 `SKILL_OUTPUT_DIR = <workspace>/skill-outputs/<peerId>/`（`skill-output-hooks.mjs`:37）。
- 脚本经 `os.environ["SKILL_OUTPUT_DIR"]` 读取，**不硬编码路径**，因此多用户自动隔离；缺失时仅开发调试 fallback 到本地临时目录。
- 它位于 workspace 内，可被原生 read / 媒体投递读走。
- 进度日志不走该目录，走 stdout/stderr。`SKILL.md` 中相关路径描述同步改。

### 输出目录是不是每个用户一份？——结合原逻辑的结论
- **原实现不是 per-user**：`reports/` 与 `cache/last_session.json` 都是 skill 根下**单一共享目录**；且 `clean_reports()` 明确"每次执行前/后清空 reports 避免堆积"（`shared/__init__.py`:281,284），即**共享一份 + 每次执行清空重写**。这在"每台 Windows 机器绑定单个使用者"的旧模型下成立（一个人的电脑上共享一份 = 个人的）。
- **改造后天然 per-user，无需额外设计**：`SKILL_OUTPUT_DIR` 的 `<peerId>` 按用户隔离 → **每个用户自动各自一份**。这同时**纠正了旧缺陷**：原来多用户共用一台/多用户互相会踩 `last_session.json`、用 `clean_reports()` 清掉别人的报告；现在互不干扰。
- **清理策略（已确认）**：**保持与旧 `clean_reports` 语义一致**——在每次执行开始时清空**本用户** `$SKILL_OUTPUT_DIR` 下的本 skill 产物（防单用户长期堆积），仅清自己目录、绝不清他人。不做历史保留。

## 五、SKILL.md / muad.skill.json 要点

- frontmatter `name: policy-check`（skill 名，横杠）与目录名、`muad.skill.json.name` 三者一致；`description` 不含内部 URL/cookie。
- 正文显式写明「skill 名 policy-check / 平台名 mssw」；删除 Cookie 配置、企微通知章节。
- 快速调用速查改为 `python scripts/trigger.py ...`；触发词与模板 1/2/3 保留。
- 明确脚本只吐数据、由本 skill 按模板渲染输出。

## 六、执行工作流（按迁移流程贴合）

1. **老 Skill 现状盘点**：`policy-check`（Python/Windows/mssw）→ 已梳理运行环境、依赖（python3+requests+session-manager）、配置、权限、5 个 mssw 外部接口、IM 调用链路；标注高风险（登录态切换、skill 根只读）、不迁移（企微、cookie_file）。
2. **新旧环境兼容性评估**：运行时差异见前三、四；URL 不变→接口/返回结构应兼容（用法需对齐）；权限机制由手动 cookie 收敛到 session-manager。
3. **完成 Skill 适配改造**：新建 `skills/policy-check/` + `muad.skill.json` + 重写 `SKILL.md`（前文五）+ 归拢 `scripts/`（登录态/写目录/fail-loud）+ 删企微 + 确认 requests 依赖。
4. **测试环境部署验证**：与生产一致的 Linux 环境验证安装/启动/停止/升级/卸载/重部署。
5. **核心功能及调用链验证**：覆盖下发/状态/结果 3 场景用例及输入/输出/异常；验证与 mssw 交互与跨场景会话读取；**用模板 1/2/3 快照对比改造前后，确认无功能退化、旅程零变化**。
- 收尾：产出后按 skill-upload 流程上传，待管理员审批。

## 七、几点补充（按需执行，不强制逐条）

下列事项在对应阶段顺手覆盖，不必为做而做：
- 版本与元数据在 `muad.skill.json.version` 落地（当前无版本）。
- 测试若无法连真实 mssw，用 fake/mock（可参考 `tools/fake-business-platform/`）模拟 `session-manager`/`SKILL_OUTPUT_DIR`；测试凭据与 cookie 脱敏、不进日志。
- 上传前检查 `policy-check` 是否已存在于 Console（避免 `skill already exists` 冲突），并决定 `skills-old/` 是否保留。
- 上线后留一条回滚/删除路径。

## 八、已确认 / 风险（原待确认项已全部落定）

### 已确认（从待确认中划掉）
- **链接可达性**：集群 Pod → `https://mssw.sangfor.com.cn` 可达性与出网放行 —— 不管（作者确认 URL 沿用原值，运维连通由运维侧负责）。
- **测试环境 mssw 桩**：不管（可连真实平台 / 用现有 fake 机制兜底）。
- **baseUrl 处理**：内置原值为默认 + 保留 `POLICY_CHECK_BASE_URL` env 覆盖槽位（用户已选）。
- **`requests` 依赖**：已满足——仓库根 `requirements.txt` 已含 `requests>=2.31`，Dockerfile 在 app 层自动 `pip3 install -r`，无需额外处理。

### 老 skill Python 依赖核对结论（已逐一比对）
- 对 `skills-old/policy-check` 全部脚本做 import 扫描：**唯一用到的第三方包是 `requests`**；其余均为 Python 标准库（`os/sys/json/re/time/warnings/glob/uuid/argparse/traceback/urllib.request/datetime/typing`）。
- 仓库根 `requirements.txt` 已含 `requests>=2.31` → **全覆盖，无需新增任何依赖、无需改动 `requirements.txt`**。
- 注：`requirements.txt` 里其余包（`openpyxl/PyYAML/beautifulsoup4/lxml/python-docx/Pillow/playwright`）是仓库内**其他** skill 的依赖，`policy-check` 用不到；改造时也不新增（已去除企微 urllib 通知，`urllib` 为标准库）。
