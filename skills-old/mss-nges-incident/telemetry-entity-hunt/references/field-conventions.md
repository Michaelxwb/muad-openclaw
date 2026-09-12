# 字段口径与事件上下文参考（全网排查用）

> 本文件给「按 hash / ip / domain 实体排查」提供：命中哪些表列、这些列对应哪种实体节点、
> 以及回溯上下文里常见的事件类型(edges)→含义。数据格式基于 `data_dr_ops_telemetry_log`
> （aes_10001_sz_3_tenant_group_name.data_dr_ops_telemetry_log）DESCRIBE 实测 + 抽样验证。

## 1. 表基本结构

- 一行 = 一条**事件(edge)**；`source*` / `target*` 前缀列 = 该事件**两端实体**的属性（扁平化到一行）。
- 不存在独立的 "hash/ip/domain" 节点 —— 这些只是实体(节点)的属性：
  - **hash** → Process / File 节点属性（进程文件、落地文件）
  - **ip** → NetworkTraffic 节点属性（C2 外联/横向/RDP/扫描的连通地址）
  - **domain** → Dns 节点属性（解析的域名、钓鱼/C2 域名）
- 顶层还带事件级字段用于解释：`eventTelemetryEventName` / `eventTelemetryEventTypeId`、
  `eventControlGraphId`(同图)、`eventDomainName`、`eventBuiltinTtpTitle/Tactic/Technique` 等。

## 2. hash 排查承载列（匹配列）

| 实体形态 | 表列 | 取值示例(抽样) |
|---|---|---|
| 落地/释放文件 | `sourceFileHashMd5` / `targetFileHashMd5` | 恶意文件 md5 |
| 文件 sha256/sha1 | `sourceFileHashSha256`、`sourceFileHashSha1`（target 同） | 少见但更精确 |
| 进程(其可执行文件) | `sourceHashMd5` / `targetHashMd5` | 进程 hash |
| 进程 sha256 | `sourceHashSha256` / `targetHashSha256` | —— |

要点：hash 排查**两个来源都试**（文件 file 列 + 进程 hash 列），脚本已全列出或命中。
hash 值是无格式字符串 → **精确 `=` 匹配**即可（非 LIKE）。

## 3. ip 排查承载列（匹配列）

| 列 | 含义 | 抽样 |
|---|---|---|
| `targetDestinationIp` | 目标/连接方向远端 IP（NetworkConnect 的远端） | 10.88.200.4 |
| `sourceDestinationIp` | 源方向带出的目标 IP | —— |

观察（实测抽样）：`NetworkConnect` 事件里远端 IP 出现在 `targetName`(名=IP 字符串) 与
`targetDestinationIp`。IP 排查只在这两列做**精确 `=`** 最稳。
schema **没有** `sourceIp/targetIp/eventRemoteIp` 这类顶层列（勿用）。

## 4. domain 排查承载列（匹配列）

| 列 | 含义 |
|---|---|
| `sourceDnsQueryName` / `targetDnsQueryName` | 事件侧发出的 DNS 查询域名 |
| `eventDomainName` | 事件顶层域名（常用于 DnsRequest/域名型告警） |
| `sourceDnsQueryResults` / `targetDnsQueryResults` | 解析返回结果（IP 串） |
| `sourceMotwHostUrl` / `sourceMotwReferrerUrl`、`target*` 同 | 文件下载来源 URL / 来源页 URL（投递溯源，钓鱼关键） |

域名做**大小写无关的包含匹配 `lower(col) LIKE '%domain%'`**（可沾子域/端口/末尾点）。
注意 URL 列里能反查"哪个可疑域名把恶意文件投下来"，对 hash→投递来源高价值。

## 5. 常见事件类型(edges) → 语义（解释命中上下文用）

| node→node | type | 含义 |
|---|---|---|
| ProcessCreate | 0x1013 P→P | 进程启子进程 |
| FileProcessCreate | 0x2502 F→P | 文件拉起进程(白加黑/借道) |
| LnkProcessCreate | 0x2505 F→P | lnk 启动进程(钓鱼快捷方式) |
| FileWrite / FileRename / FileDelete / FileStreamCreate | 0x100d / 0x1009 / 0x1007 / 0x1045 | 文件写入/改名/删除/多流 |
| FileOpen / FileCreate | 0x1005 | 文件创建 |
| ImageLoad | 0x400e | DLL/模块加载 |
| ScriptExecute | 0x5901 P→F | 脚本执行(宏/ps1) |
| NetworkConnect / NetworkAccept / NetworkPacketTransfer | 0x1012 / 0x1011 / 0x1032 P→N | 外联 C2/扫描 |
| DnsRequest | 0x4002 P→Dns | 域名解析(钓鱼/C2 域名) |
| RemoteRpcProcessCreate | 0x250b N→P | 远程 RPC 起进程(横向) |
| AccountLogin | 0x4804 P→User | 登录 |
| ServiceCreate/Modify/Delete、ServiceProcessCreate | 0x1026/0x1028/0x1027、0x2509 | 服务持久化/横向 |
| SchJobProcessCreate、ScheduledJob* | 0x2508、0x1023/0x25/0x24 | 计划任务持久化 |
| RegistrySetValue / RegistryCreateKey | 0x101e / 0x1016 | 注册表持久化(自启/关防) |
| WmiEventFilter/Consumer | 0x4801/0x4802 | WMI 持久化 |
| ProcessInject | 0x250d | 进程注入 |
| RemoteThreadCreate / ProcessOpen / ProcessOperate / ProcessComControl / ProcessRemoteControl | 0x1021 / 0x1014 / 0x3701 / 0x480B / 0x4809 | 注入/操控其它进程 |
| AccountCreate | 0x4805 | 新建账户(后门) |
| SessionNotify | 0x1031 P→? | 会话/用户切换 |
| DriverLoad | 0x1003 | 驱动加载 |

示例投递链的解释：实测抽样里
`fapiaoshangy20235.zip`(源,FileUnzip) → `PrintPDF.exe`(目标,FileWrite,src=WinRAR.exe)
= 恶意 zip 由 WinRAR 解压释放出可执行文件，命中其 hash 即证明同一条投递链在别的主机也出现。

## 6. IOC / 处置（情报与拦截，解释/归因参考）

- 命中实体的**情报命中**、**处置状态**常不在本遥测扁平列直接齐备，但可结合 Dns 节点自带
  `iocResult/iocCategory/iocFamily/iocRiskLevel/iocAction`、`disposalStatus/disposalOptions` 判断
  (域名是否已命中威胁情报/是否已处置)。NetworkTraffic 的 `disposalOptions` 位图可判该 IP 外联是否已被阻断。
- 归因方向：命中同一 hash(md5) = 同一文件/变体同源；命中同一 motw url / queryName / dst ip =
  同一投递源或同一 C2，可合并研判处置面。
