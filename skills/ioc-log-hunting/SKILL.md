---
name: ioc-log-hunting
description: "全网日志恶意内容摸排。按客户检索该客户在 MSSP/SOAR 检索中心日志表中与给定恶意内容(URL/域名/IP)存在交互的主机。支持域名(DNS)与恶意IP(TCP)反查；不处理文件 Hash。MANDATORY before 调用日志检索/恶意内容反查/看哪些主机碰过某恶意IP域名等场景。限定 MSSP(SOAR) log-search 平台，不适用于 MSSW。"
---

# 全网日志恶意内容摸排（ioc-log-hunting）

本 skill 用于：使用者给出**一个客户** + **一个恶意内容**(URL/域名 | IP)，在该客户的 SOAR 检索中心 **log-search** 相应日志大数据表中反查**近 3 天内与该恶意内容产生过交互的客户主机 IP(srcIp)**，输出去重后的主机清单 + 命中数 + 最早/最晚交互时间 + 关键日志证据，供使用者对客户做深度风险提醒。

> 业务边界：**判定"恶意内容是否真恶意"由使用者侧情报负责**，本 skill 只做客观检索与关联，不做情报认定。每次只查使用者指定的**单一客户**，不跑所有客户。

## 平台/登录态
- 绑定 **mssp**(SOAR) 平台。登录态由 muad(session-manager) 代管，脚本经内置 `shared.get_cookie()` 自取，**禁止手动粘贴 Cookie / 打凭据到日志**。
- 业务 API origin 由 `config/api_config.json` 的 `platforms.mssp.origin` 决定（默认内网 `http://soar-inner.sangfor.com.cn:30001`，对应公网 `https://soar.sangfor.com.cn`），可被环境变量 `IOC_HUNT_BASE_URL` 覆盖。
- mssp 请求必须带平台固定头 `X-CSRFToken` + `timezone(+08:00)`（shared.build_headers 已内置）。

## 触发词
日志检索 / 恶意内容反查 / 全网日志摸排 / 查哪些主机碰过某恶意IP(URL/域名/IP) / 检索中心 / IOC 关联主机

> 本 skill 支持 **域名(URL)** 与 **恶意IP** 两类恶意的反查；**不支持文件 Hash**（业务上明确不做 hash 摸排）。

## 强制用户旅程（不得跳步/自选/猜测补default）
### 旅程1 收集：客户 + 恶意内容
开始任何平台调用前，必须从本次对话取得：
1. **要查的客户**（可提示客户简称/名称）
2. **恶意内容**：类型(URL/域名 | IP) + 具体值（可能是一**整批**多个恶意域名/IP）
3. **匹配方式**（仅单个内容时按需确认；**整批多个时不问匹配，直接精确 OR**）：
   - 单域名→询问精确？模糊？(默认精确，略反问)：
     - 精确(exact)：完整域名全等 → `filter queries="<完整域名>"`
     - 模糊(fuzzy)：子串关键词(如 `qianwen.com`)，摸排子域名/旁路 → `filter queries LIKE "%<关键词>%"`
   - **一整批多个域名→不问匹配，自动精确 OR**：每域名一条 `queries="x"` 用 `OR` 连结，一次检索并集(见旅程4)。
   - **恶意IP：固定按精确匹配（仅匹配 dstIp=外联目标方向），不提供模糊。**
   若使用者只给单个完整域名且未提模糊 → 按精确执行(避免干扰)；若关键词明显是域名后缀想覆盖子域 → 追问一次确认是否模糊。

> 内容值输入可为多个，用空格/逗号/分号/换行分隔均可。单个为一条；多个为整批。

### 旅程2 确客
- 用独立解析脚本把客户简称/名称解析为**数字 company_id**，只展示候选完整 `company_name` + 数字 `company_id`，经使用者确认后才能进入检索。禁止自选/默认客户。

### 旅程3 内容类型 → 目标表映射(强约束，硬编码)
| 恶意内容 | 查哪张表(tableId) | 检索字段 | 匹配方式 | 受影响主机 |
|---|---|---|---|---|
| **URL/域名(单个)** | DNS `[20]` | `queries` | 精确(默认) `=` 或模糊 `LIKE "%子串%"`(对话问) | 该行 `srcIp` |
| **URL/域名(一整批多个)** | DNS `[20]` | `queries` | 自动精确多个纯 `OR` 子句 | 该行 `srcIp` |
| **恶意IP(单个或整批)** | TCP `[100]` | `dstIp`（外部外联目标/C2） | 自动精确 `=` / 多个纯 `OR` 子句 | 该行 `srcIp` |
| **Hash** | 不支持 | — | — | — |

- **IP 只查 TCP 表，且仅匹配 `dstIp`(外联目标)，不做 srcIp 方向检索**；域名/URL 永不查 TCP。
- **Hash 明确不支持**（业务决定不再做文件 hash 摸排）；**URL 永不查 TCP(IP)**；IP 永不查 DNS。
- 语句可用性（2026-09 实测）：单个 → `=`；整批 → **`OR` 可用且并集语义正确**；DNS/URL 模糊匹配用 `LIKE "%子串%"`；**`IN(...)` 返回total=0 不可用**，`"a","b"`(逗号) 亦不可用 → 批查询用 OR，勿用 IN。单条默认精确（向后兼容）。模糊匹配需使用者明确要求。

### 旅程4 执行检索（DNS-URL 与 TCP-IP 均已跑通）
运行：
```bash
# --- 域名/URL（dns_hunt.py）---
# 单条精确（默认）：完整域名
python3 scripts/dns_hunt.py --company-id <ID> --url "<完整恶意URL>"
# 单条模糊（摸排子域名/旁路）
python3 scripts/dns_hunt.py --company-id <ID> --url "<子串关键词>" --mode fuzzy
# 整批多个恶意域名 → 自动精确 OR
python3 scripts/dns_hunt.py --company-id <ID> --url "a.com b.com,c.com;d.com"

# --- 恶意IP（tcp_ip_hunt.py）---
# 单条恶意IP：精确匹配 dstIp
python3 scripts/tcp_ip_hunt.py --company-id <ID> --ip "1.2.3.4"
# 整批恶意IP → 自动精确 OR
python3 scripts/tcp_ip_hunt.py --company-id <ID> --ip "1.2.3.4 5.6.7.8,9.10.11.12"
```
- 时间窗 = **近 3 天**；`constrains=[customer]`；排序 `recordTime desc`。
- 先 `ckCount` 拿命中 total；若 **total>10000**：提示"访问量过大，可能非真恶意，请复核"，翻取前 1 万条；否则全量翻。
- 对翻取日志按 `srcIp` 去重（**不滤内网**），每台记命中数 + 最早/最晚 `recordTime`。

### 旅程5 输出
- 对话侧按**内容(域名/IP)分组**展示主机。去重命中 srcIp 总数 **≤20 台时直接全量在对话给结论**(不生成 Excel)；**>20 台**时，完整明细自动导出 Excel 供交付。
- 每行含：主机IP + `资产组`(asset_group_name) + `业务`(business_name) + 命中数 + 最早/最晚时间；资产组/业务为空显示 `-`；资产表无此 IP 标 **服务外资产**。
- **Excel 仅当去重命中 srcIp >20 台时导出** `(.xlsx)` 到 `SKILL_OUTPUT_DIR`(零新增依赖，用已装 openpyxl)，打印 `[Excel]` 行给出路径后，由 muad **作为 wecom 附件发送给当前会话**；≤20 台不生成。
- 脚本输出的 Markdown/文本须**原样保留**给使用者，禁止重排/润色/加总结。格式见 scripts 输出。
- 无命中的输入内容单列 `[无命中域名/IP]` 示警；同一主机命中多个恶意内容 → 每个命中组下都出现。

### 排除IP（可选，供与其他 skill 组合联动）
- 使用者可能给出一个或多个 **srcIp 排除名单**：命中结果里带这些 IP 一律过滤掉，当作无命中处理（不进去重统计/资产反查/Excel/展示）。
- 排除名单由 `--exclude-ip` 传入，支持空格/逗号/分号/换行分隔的多个 IP。仅在翻回日志后做本地过滤，不改检索语句与 ckCount。

## 平台执行细节
- 检索内容入口是请求体 `searchString` 的 `filter` 语法：`filter <字段>="精确值"` / `LIKE "%含%"` / `AND`。
- `constrains` 只放 `customer`(客户作用域)；乱塞内容字段会 code 9001。
- 翻页到底依据 **ckCount.total**；`isLimit` 字段不可信(恒 False 不代表到底)。
- 不可用算子：`IN(...)`(total=0)、`=` 带 `*` 通配、`CONTAINS`(9603)、`EXIST`。
  → DNS `queries` **模糊匹配只能用 `LIKE "%子串%"`**，勿用 `*` 通配或 CONTAINS。IP 一律精确 `=`，无模糊。

## 命令与参数说明
本脚本的参数集（两脚本共用一致命名）：
- `--company-id` 客户数字ID（必填）
- 内容值二选一：
  - `--url`：恶意域名/URL（走 DNS 表）；单个=exact完整URL(或 fuzzy 子串关键词，配 `--mode`)；多个=整批精确 OR
  - `--ip`：恶意IP（走 TCP 表，匹配 dstIp）；单个/多个=整批精确 OR
- `--mode` 可选 `exact`(默认) / `fuzzy`；仅单域名生效，多域名自动忽略；对 IP 不适用
- `--exclude-ip` 可选：要排除的 srcIp，可多个（空格/逗号/分号/换行分隔）。命中结果带这些 IP 一律过滤，当作无命中
- 对话展示：多内容(域名/IP)按命中分组；资产标注=资产组+业务/服务外资产；去重命中 srcIp ≤20 不生成 Excel，仅 >20 才自动导出 Excel(openpyxl，无额外装包依赖)

## 必须遵守
1. 只执行给定客户+恶意内容(域名/IP)的日志反查；不做与检索无关的事(红线同其它业务skill)。
2. 登录态由 session-manager 代管，不手贴 Cookie、不打凭据。
3. 客户/恶意值必须来自本次明确收集并经旅程2确客；不猜不默认。
4. 时间窗近 3 天，天然不翻全历史。
5. **不处理文件 Hash**（业务上已明确不再做 hash 摸排）。
6. 禁止把原始大 JSON 贴回对话；输出精简为脚本的主机清单结果。
7. 全程简体中文，单条消息精简，一次问清缺失参数。
