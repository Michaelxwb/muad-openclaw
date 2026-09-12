---
name: telemetry-entity-hunt
description: "全网排查/MSSP 实体日志调查。MANDATORY to use when user asks 全网排查/实体日志调查/单机事件是否扩散/回溯域名-hash-IP主机命中/该实体在客户网内是否出现在其他主机. Trigger on: 对 MSSP 安全事件分析出的实体(仅 domain/hash/ip)在 data_dr_ops_telemetry_log 遥测日志进行 7~30 天全网回溯调查。本 skill 查询遥测库，不用于 MSSW/NGES 后台事件库。"
---

# 全网排查（telemetry-entity-hunt）

对一个安全事件里**分析出的实体（仅 domain / hash / ip 三类）**，在本客户全网主机的遥测日志
（`data_dr_ops_telemetry_log`）中回溯：判断某台主机上的事件，是否仅限该机、还是已成全网扩散，
并对每台受影响主机给出可读的命中上下文证据，支撑研判与处置。

> skill 名 `telemetry-entity-hunt`；这是查询脚本名，非平台名（本 skill 不登录任何 Web 平台，直连 ClickHouse）。

## 适用场景（触发词）
- “全网排查 / 实体日志调查 / 单机事件是否扩散 / 顺着 IP/域名/hash 查其它主机”
- 事件里给了攻击 IP / C2 域名 / 恶意文件 hash，想知道**同一客户(tenant)网内其它主机**是否也命中过
- 排查维度只针对 **domain / hash / ip**（hash=md5/sha1/sha256；ip=IPv4；domain=fqdn）

## 前置（必读）
表量极大——单一客户(tenant)近 7 日即约 **2.1 亿行**。任何查询都必须**同时下推**这三条，否则易超时：
1. `tenant=<该客户tenantId>`（必给）
2. `insertTime > NOW() - INTERVAL N DAY`（默认 7，可扩 30）
3. 实体列命中条件（脚本已内置，域名为包含匹配、hash/ip 为精确匹配）

**口径**：遥测表一行=一条事件(edge)，`source*/target*` 前缀列 = 事件两端实体属性。不存在独立的
hash/IP/domain 节点 —— hash 是 Process/File 的属性、ip 是 NetworkTraffic 属性、domain 是 Dns 属性，
故按实体检索就是命中这些 source*/target* 列（脚本已把三类的相关列都试）。

## 快速调用（直接跑脚本，勿自行拼 SQL）
```bash
cd skill-staging/telemetry-entity-hunt
python3 scripts/hunt_entity.py <实体值> \
    --tenant <该客户tenantId> \
    [--type auto|hash|domain|ip] \
    [--days 7|30] \
    [--mode summary|byagent|detail|all] \
    [--agent <agentId>] [--events A,B] [--limit N]
```

### 参数
- `<实体值>`：域名 / md5(32hex) / sha1(40hex) / sha256(64hex) / IPv4。`--type auto` 会自动识别。
- `--tenant`：必给，为该客户 tenantId（等于事件基础信息里的 tenantId）。也可用 env `HUNT_TENANT`。
- `--days`：回溯窗口，默认 7；若命中偏少需看更早可改 30（视量级谨慎）。
- `--mode`：
  - `summary`：仅汇总 —— 全网命中条数 + 受影响主机数。**最优先跑这个**，0 命中即"未扩散"结论。
  - `byagent`：按受影响主机(agentId)聚合：每台命中条数、涉及事件种类数、末次时间。
  - `detail`：代表性命中上下文明细(限制条数，不会全拉)：进程/文件/motw URL/IP/DNS、时间、agent。
  - `all`：依次 summary → byagent → detail。
- `--agent / --events / --limit`：detail 聚焦某主机的某几类事件、限制条数。

### 典型话术（推荐流）
1. 先 `--mode summary`：`✅ 全网无其它命中(0条)` → 单机事件未见扩散，可下结论；
   `⚠️ 命中 N 条 / 涉及 M 台主机` → 有扩散面，继续 byagent。
2. 有命中再 `--mode byagent` 看扩散到哪几台、几次、什么时候。
3. 对疑点主机 `--mode detail --agent <id> --limit 20` 拉上下文证据样例。

## 输出交付
把运行结果整理成调查结论给用户，并写回交付归档（如有事件目录）：
- 结论：命中情况(总命中/受影响主机)、是否全网扩散、扩散到哪些主机/次数/时间、代表性命中上下文。
- 归因建议：结合命中的文件/进程/IP/DNS/motw 来源，说明是同一投递链(同源)还是独立变体。
- 若该主机即为原始事件主机且无其它扩散 → “确认仅在源主机，未扩散”。

## 配置 / 连接
- 连接参数集中于本 skill `config/api_config.json`（远程 ClickHouse）。脚本自身定位 skill 根读它。
- 环境变量可覆盖：`HUNT_CH_HOST/PORT/USER/PASSWORD/DB`、`HUNT_TENANT`。
- 首次装依赖：`pip install --break-system-packages -i https://mirrors.aliyun.com/pypi/simple clickhouse-driver`

## references
- `references/field-conventions.md`：hash/ip/domain 三种实体各自的承载列(扁平列)、事件边上文(event types)、
  与节点实体(Process/File/NetworkTraffic/Dns)及 IOC/处置字段的对应关系（写查询/解释上下文用）。
