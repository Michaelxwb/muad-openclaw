---
name: telemetry-entity-hunt
description: "全网排查/MSSP 实体日志调查。MANDATORY to use when user asks 全网排查/实体日志调查/单机事件是否扩散/回溯域名-hash-IP主机命中/该实体在客户网内是否出现在其他主机. Trigger on: 对 MSSP 安全事件分析出的实体(仅 domain/hash/ip)在 data_dr_ops_telemetry_log 遥测日志回溯调查，默认 3 天窗口、最多 30 天。本 skill 查询遥测库，不用于 MSSW/NGES 后台事件库。"
allowed-tools: Read, Write, Bash, Glob, Grep
---

# 全网排查（telemetry-entity-hunt）

对一个安全事件里**分析出的实体（仅 domain / hash / ip 三类）**，在本客户全网主机的遥测日志
（`data_dr_ops_telemetry_log`，跨 4 个库）中回溯：判断某台主机上的事件，是否仅限该机、还是已成全网扩散，
并对每台受影响主机用 **agentId → 资产库** 翻译成可读的终端资产，输出「命中终端 + 资产详情」，支撑研判与处置。

> skill 名 `telemetry-entity-hunt`；这是查询脚本名，非平台名（本 skill 不登录任何 Web 平台，直连 ClickHouse）。

## 适用场景（触发词）
- “全网排查 / 实体日志调查 / 单机事件是否扩散 / 顺着 IP/域名/hash 查其它主机”
- 事件里给了攻击 IP / C2 域名 / 恶意文件 hash，想知道**同一客户(tenant)网内其它主机**是否也命中过
- 排查维度只针对 **domain / hash / ip**（hash=md5/sha1/sha256；ip=IPv4；domain=fqdn）

## 前置（必读）
表量极大——单一客户(tenant)近 7 日即约 **2.1 亿行**。任何查询都必须**同时下推**这三条，否则易超时：
1. `tenant=<该客户tenantId>`（必给）
2. `insertTime > NOW() - INTERVAL N DAY`（**默认 3**，最多可扩 30）
3. 实体列命中条件（脚本已内置，域名为包含匹配、hash/ip 为精确匹配）

**多库**：遥测数据分布在 **4 个库**中：
- `aes_10001_sz_3_tenant_group_name`
- `aes_10002_sz_3_tenant_group_name`
- `aes_10003_sz_3_tenant_group_name`
- `aes_10004_sz_3_tenant_group_name`

脚本按序对每个库下发同一查询，**一旦某库命中即短路返回，不再查询后续库**（实现假设：同一 tenant 的数据只落在一个库）。
库列表由 `config/api_config.json` 的 `default_db` + `dbs` 决定（本 skill 不写死单库）；
`--tenant` 仍为过滤条件，与库无关。

**口径**：遥测表一行=一条事件(edge)，`source*/target*` 前缀列 = 事件两端实体属性。不存在独立的
hash/IP/domain 节点 —— hash 是 Process/File 的属性、ip 是 NetworkTraffic 属性、domain 是 Dns 属性，
故按实体检索就是命中这些 source*/target* 列（脚本已把三类的相关列都试）。

## 快速调用（直接跑脚本，勿自行拼 SQL）
在 skill 根目录下执行（脚本自行定位 `config/api_config.json`，无需 cd 到别处）：
```bash
python3 scripts/hunt_entity.py <实体值> \
    --tenant <该客户tenantId> \
    [--type auto|hash|domain|ip] \
    [--days 7|30] \
    [--mode summary|byagent|detail|all] \
    [--company-id <数字company_id>] [--asset] \
    [--agent <agentId>] [--events A,B] [--limit N]
```

### 参数
- `<实体值>`：域名 / md5(32hex) / sha1(40hex) / sha256(64hex) / IPv4。`--type auto` 会自动识别，并在输出首行打印识别结果——**务必核对**：auto 的兜底是 domain，打错的 hash 会被静默当成域名做包含匹配，结果看似“无命中”实则类型判错。
- `--tenant`：必给，为该客户 tenantId（等于事件基础信息里的 tenantId）。也可用 env `HUNT_TENANT`。
- `--days`：回溯窗口，**默认 3**；若命中偏少需看更早可改 7/30（视量级谨慎）。
- `--mode`：
  - `summary`：仅汇总 —— 全网命中条数 + 受影响主机数。**最优先跑这个**，0 命中即"未扩散"结论。
  - `byagent`：按受影响主机(agentId)聚合：每台命中条数、涉及事件种类数、末次时间。
  - `detail`：代表性命中上下文明细(限制条数，不会全拉)：进程/文件/motw URL/IP/DNS、时间、agent。
  - `all`：依次 summary → byagent → detail。
- `--agent`：**仅 `--mode detail` 生效**，聚焦某主机的命中明细；`byagent` 模式下会被忽略。
- `--events / --limit`：detail 过滤事件名（逗号分隔）、限制条数。
- `--company-id`：该客户的**数字 company_id**（不等于 tenantId）。用于把命中 agentId 反查 MSSP 资产；
  也可用 env `HUNT_COMPANY_ID`。
- `--asset`：开启「命中终端资产」环节（需 `--company-id`）。对每台命中主机用其 agentId 查资产库，
  **每台主机只输出最相关、信息最全、最新的一条资产**，并附该资产的**全部关键字段**。

> **交付口径**：`--asset --company-id` 缺一不可——仅有 agentId 客户不可读，
> 必须翻译成终端资产后再交付（见下方「输出交付」）。缺 `--company-id` 时脚本会静默跳过资产环节、
> 直接输出裸 agentId，属**不可交付**状态，调用方须补参重跑。

> **规模提示**：资产环节的翻译台数同样受 `--limit` 约束（默认 100）。命中主机数超过 limit 时，
> 仅前 limit 台会输出资产详情，属静默截断；扩散面较大时应显式调高 `--limit`。

### 标准流程（IOC → agentId → 资产）
1. **输入 IOC**（hash/ip/domain），`--type auto` 自动识别类型（核对首行识别结果）。
2. **查遥测库**：对该租户 `tenant` 在 4 个遥测库中回溯（默认 3 天）——`summary` 档先拿总命中条数/受影响主机数；
   有命中则 `byagent` 按主机(agentId)聚合。**0 命中即为“未扩散”结论**，无需后续步骤。
3. **得到 agentId**：每台命中主机的 agentId 即为中间输出。
4. **用 agentId + company_id 查资产**（`--asset --company-id`）：反查 MSSP 资产库，
   每台主机选最相关、最全、最新的一条，得到「终端资产详情」作为最终输出。

### agentId → 终端资产（本 skill 的核心产出）
全网排查得到的是 agentId；仅有 agentId 对客户不可读，必须**再经资产库把 agentId 翻译成终端**。
资产查询逻辑：`scripts/asset_lookup.py`（复用老平台 session/端点）。同一 agentId 常对应**多条**资产
（多网段/多采集），筛选规则依次为：**存活优先（is_alive=1）→ 信息完整度（非空字段加权）→ 最新（update_time）**，
选定后返回该条资产的**全部字段**。

### 输出交付（重要：禁止直接输出 agentId）
- **0 命中**：直接给“全网无其它命中，单机事件未见扩散”的结论；不输出空表格。
- **有命中**：最终结论必须把 agentId **翻译成终端资产**后再表述，形如：

> ⚠️ 全网排查命中 **192.168.55.160（DESKTOP-E3PL0DT / 终端 / Windows）** 终端，命中 N 条遥测日志。
> 终端资产详情：
> - 资产IP：192.168.55.160
> - 主机名：DESKTOP-E3PL0DT
> - 资产类型：终端（endpoint）
> - 操作系统：windows
> - MAC：28-D0-EA-CB-2E-24
> - 业务名称：笔记本X1
> - 业务等级：一般
> - 资产分组：内网IP范围
> - 存活状态：在线
> - 责任人：阳耀（13480730927）
> - agentId：3237244065
> - 首次发现：…／最近更新：…

即：**输出 = 「全网排查命中 xx 终端」+「该终端的完整资产信息」**，agentId 仅作为追溯字段附带，
不得作为主要结果直接抛给用户。

汇总交付时组织成调查结论：
- 结论：命中情况(总命中/受影响主机)、是否全网扩散、**扩散到哪些终端(用资产信息表述)**、次数、时间。
- 归因建议：结合命中的文件/进程/IP/DNS/motw 来源，说明是同一投递链(同源)还是独立变体。
- 若该终端即为原始事件主机且无其它扩散 → “确认仅在源主机，未扩散”。
- 若命中主机数超过 `--limit` 导致资产翻译被截断，须在结论中如实说明（如“另有 N 台未展开资产”），不得当作已全覆盖。

## 配置 / 连接
- 遥测库连接参数集中于本 skill `config/api_config.json`（远程 ClickHouse），含 `dbs`（4 个库）与
  `default_db`。脚本自身定位 skill 根读它。
  环境变量可覆盖：`HUNT_CH_HOST/PORT/USER/PASSWORD/DB`、`HUNT_TENANT`、`HUNT_COMPANY_ID`、`HUNT_DAYS`。
- 资产查询登录态复用 `monitor-mssp-events` 的 session-manager 约定（cookie 由平台代管，不落盘）；
  脚本路径 `/opt/openclaw-skills/monitor-mssp-events/scripts` 已由 `asset_lookup.py` 注入 `sys.path`。
- 首次装依赖：`pip install --break-system-packages -i https://mirrors.aliyun.com/pypi/simple clickhouse-driver`

## references
- `references/field-conventions.md`：hash/ip/domain 三种实体各自的承载列(扁平列)、事件边上文(event types)、
  与节点实体(Process/File/NetworkTraffic/Dns)及 IOC/处置字段的对应关系（写查询/解释上下文用）。
