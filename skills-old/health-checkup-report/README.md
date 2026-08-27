# Health Checkup Report

生成指定客户、指定时间段的安全体检 HTML 报告。

当前版本以 MSSW 作为唯一业务主链路生成 HTML 报告。`--mssw-cookie-path` 和 `--xdr-cookie-path` 在 `generate` 主流程中都必传，其中 XDR Cookie 当前只做校验和透传保留，不参与主链路取数。

## Run

```powershell
node health_report.js `
  --customer "示例客户" `
  --mssw-cookie-path "M:\Users\$env:USERNAME\Downloads\mssw_cookies.txt" `
  --xdr-cookie-path "M:\Users\$env:USERNAME\Downloads\xdr_cookies.txt"
```

也可以显式传时间：

```powershell
node health_report.js `
  --customer "示例客户" `
  --start "2026-06-01" `
  --end "2026-06-16" `
  --mssw-cookie-path "M:\Users\$env:USERNAME\Downloads\mssw_cookies.txt" `
  --xdr-cookie-path "M:\Users\$env:USERNAME\Downloads\xdr_cookies.txt"
```

时间规则：

- `--start` 和 `--end` 要么同时传，要么都不传
- 都不传时，脚本会通过 MSSW 项目列表接口自动推导
- 默认开始时间取所有 `service_info[*].service_start` 的最早值
- 默认结束时间取 `min(报告生成时刻, 所有非空 service_end 的最小值)`

输出文件默认写入 `output/`。接口拿到并用于填充 HTML 的结构化数据会落盘到 `output/report-data.json`，可用 `--output-json` 指定路径。

默认只输出简洁摘要；如需完整 JSON 结果，加 `--json`。

生成流程会在所有数据统计和 Word 导出完成后、ZIP 打包前，使用 `excel-beautifier` 的 `classic` 主题统一美化 `安全体检报告/风险清单` 内的 Excel。默认启用；传入 `--beautify-excel false` 可跳过。单个表美化失败时会保留原文件并继续生成报告。

说明：

- `--mssw-cookie-path` 是当前所有报告、导表、设备统计、时间范围推导的唯一业务凭证
- `--xdr-cookie-path` 当前只做必传保留，不会触发旧 XDR 资产、事件、设备或统计逻辑

默认会导出 `asset,incident`。如需指定表格：

```powershell
node health_report.js `
  --customer "示例客户" `
  --start "2026-06-01" `
  --end "2026-06-16" `
  --mssw-cookie-path "M:\Users\$env:USERNAME\Downloads\mssw_cookies.txt" `
  --xdr-cookie-path "M:\Users\$env:USERNAME\Downloads\xdr_cookies.txt" `
  --xdr-tables "asset,incident"
```

## Data Contract

当前 `output/report-data.json` 的字段约定如下。后续新增取值逻辑必须继续补这张表。

| 字段 | 语义 | 来源 | 取值逻辑 |
| --- | --- | --- | --- |
| `projectBackground.customerName` | 客户名称 | `--customer` | 直接取命令行参数 |
| `projectBackground.startDate` | 报告开始日期 | `--start` / MSSW 项目列表接口 | 用户传时间时直接取命令行参数；未传时取最早 `service_start` |
| `projectBackground.endDate` | 报告结束日期 | `--end` / MSSW 项目列表接口 + 运行时 | 用户传时间时直接取命令行参数；未传时取 `min(报告生成时刻, 最早非空 service_end)` |
| `assetLedger.core_asset` | 核心资产数 | 导出的资产表 Excel | 读取第二行表头里的 `重要级别` 列；列值非空且包含 `核心` 时计为核心资产 |
| `assetLedger.manage_asset` | 台账资产数 | 导出的资产表 Excel | 统计第三行开始的有效行数 |
| `assetLedger.ready_to_outbound` | 7天内即将退库资产数 | MSSW 资产台账 count 接口 | 取 `{"ready_to_outbound":{"op":"=","val":"last7d"}}` 的 `total` |
| `assetLedger.typeDistribution` | 资产类型分布 | 导出的资产表 Excel | 读取第二行表头里的 `资产类型(一级)` 列；值包含 `服务器` 计入服务器，包含 `终端` 计入终端，其余计入其他 |
| `assetLedger.protectionDistribution` | 资产防护统计 | 导出的资产表 Excel | 读取第二行表头里的 `agent状态` 列；值恰好等于 `在线 / 离线 / 已禁用 / 已降级` 时分别计数，值等于 `已卸载 / 已移除 / 未接入 / 未授权` 时统一归并到 `未防护`，并按 `在线 / 离线 / 已禁用 / 已降级 / 未防护` 这 5 个固定枚举输出 |
| `assetLedger.internetExposureDistribution` | 互联网暴露资产分布 | 导出的资产表 Excel | 读取第二行表头里的 `互联网暴露` 列；列值非空且不等于 `未暴露` 时视为暴露，再按 `资产类型(一级)` 列统计 `服务器 / 终端 / 其他` |
| `assetLedger.internetExposureTotal` | 互联网暴露资产总数 | 导出的资产表 Excel | 读取第二行表头里的 `互联网暴露` 列；列值非空且不等于 `未暴露` 时计为 1 |
| `riskOverview.securityLogTotal` | 接收安全日志数 | MSSW 安全日志量接口 | 取 MSSW 日志统计接口返回的总数 |
| `riskOverview.alertTotal` | 有效告警数 | MSSW 告警统计接口 | 取 MSSW 事件表统计接口返回的总数 |
| `riskOverview.totalEvents` | 有效安全事件数 | 导出的事件表 Excel | 直接复用 `riskDetails.totalEvents` |
| `riskOverview.closedEvents` | 处置闭环数 | 导出的事件表 Excel | 直接复用 `riskDetails.closedEvents`，即 `处置状态 = 处置完成` 的事件行数 |
| `riskOverview.containedAlerts` | 已遏制告警数 | MSSW 告警统计接口 | 查询处置动作为 `已遏制(组件同步)` 或 `已遏制(已封禁地址)` 的告警总数 |
| `riskOverview.alertReductionRate` | 告警消减率 | MSSW 告警统计接口 + 导出的事件表 Excel | 直接复用 `riskDetails.alertReductionRate`；若未显式提供，则按 `(alertTotal - totalEvents) / alertTotal` 计算，结果保留两位小数 |
| `riskOverview.closeRate` | 事件闭环率 | 导出的事件表 Excel | 直接复用 `riskDetails.closeRate`，保证与风险详情完全一致 |
| `riskOverview.riskAssetCount` | 风险资产数 | 风险清单目录中的事件表 Excel + 弱口令表 Excel + 漏洞表 Excel + 暴露面表 Excel + 资产表 Excel | 在五张风险清单归档完成后综合统计：事件表取 `影响资产` 且排除 `处置状态 = 处置完成`；弱口令表取 `风险资产` 且若存在 `处置状态` 列则排除 `处置完成`；漏洞表取 `风险资产`；暴露面表中 `Web服务风险分布` 通过 `访问路径 -> 端口表.Host` 映射资产，`非Web服务风险分布` 直接取 `IP地址/子域名`；最后按资产键去重计数 |
| `riskOverview.affectedAssetCount` | 影响资产数 | 导出的事件表 Excel | 直接复用 `riskDetails.uniqueAssetCount`；遍历事件表所有事件，提取“影响资产”列中的 IPv4 地址后去重计数 |
| `riskOverview.incidentGptStats.total` | 已确认的威胁运营事件总数 | MSSW 事件表 Excel | `incidentGptStats.hostCompromise.total + incidentGptStats.virusTrojan.total` |
| `riskOverview.incidentGptStats.hostCompromise.total` | 已确认 C2 外联事件数 | MSSW 事件表 Excel | 先筛 `GPT研判结论` 属于 `主机失陷活动 / 病毒木马活动` 的候选事件；再按 `外网IP地址`、`域名`、`文件` 顺序检查带 `（黑）` 的实体，网络字段任一命中即归类 C2 外联，计数 |
| `riskOverview.incidentGptStats.hostCompromise.confirmedIncidentIds` | 已确认 C2 外联事件 ID 列表 | 同上 | 同上，按事件表遍历顺序输出事件 ID |
| `riskOverview.incidentGptStats.virusTrojan.total` | 已确认病毒木马事件数 | MSSW 事件表 Excel | 同一候选池中，只有 `外网IP地址` 和 `域名` 都未命中 `（黑）`，且 `文件` 命中 `（黑）` 时归类病毒木马，计数 |
| `riskOverview.incidentGptStats.virusTrojan.confirmedIncidentIds` | 已确认病毒木马事件 ID 列表 | 同上 | 同上，按事件表遍历顺序输出事件 ID |
| `riskOverview.incidentGptStats.threatActorStats` | 威胁家族 Top2 | MSSW 事件表 Excel / MSSW 事件查询接口 | 遍历全部已确认事件的 `GPT定性结论`，按内置威胁家族关键字匹配并计数，按命中次数倒序取前 2 |
| `riskOverview.incidentGptStats.threatTypeRanking` | 威胁类型 Top2 | 同上 | 在已命中的威胁家族集合上，按内置固定优先级顺序取前 2 |
| `riskOverview.incidentGptStats.virusAttackAsset` | 首个病毒攻击资产 IP | 事件表 Excel + 资产表 Excel | 在已确认事件里，取第一个已确认病毒木马事件的 `影响资产` 中提取到的首个 IPv4 |
| `riskOverview.incidentGptStats.nonAesCoveredAssets` | 未被 AES 覆盖资产 IP 列表 | 事件表 Excel + 资产表 Excel | 对已确认事件涉及资产按事件表顺序去重；在资产表中若 `数据源` 缺失或不包含 `EDR`，则视为未被覆盖，最多返回 3 个 |
| `riskOverview.incidentGptStats.unlabeledAssets` | 未标注责任人资产 IP 列表 | 事件表 Excel + 资产表 Excel | 对已确认事件涉及资产按事件表顺序去重；在资产表中若 `责任人` 为空或资产缺失，则计入，最多返回 2 个 |
| `riskOverview.exploitStats.total` | 漏洞利用事件总数 | 导出的事件表 Excel | 读取 `安全事件一级分类` 列，值等于 `漏洞利用` 的事件行数 |
| `riskOverview.exploitStats.highRiskAsset` | 漏洞利用高风险资产 | 导出的事件表 Excel | 取第一条 `安全事件一级分类 = 漏洞利用` 事件的 `影响资产` 原始值 |
| `riskOverview.exploitStats.closedCount` | 漏洞利用已闭环数 | 导出的事件表 Excel | 在 `安全事件一级分类 = 漏洞利用` 的事件中，统计 `处置状态 = 处置完成` 的事件行数（已闭环） |
| `riskOverview.exploitStats.processingCount` | 漏洞利用处置中数 | 导出的事件表 Excel | 在 `安全事件一级分类 = 漏洞利用` 的事件中，统计 `处置状态 = 处置中` 的事件行数 |
| `riskOverview.exploitStats.incidentIds` | 漏洞利用事件 ID 列表 | 导出的事件表 Excel | 保留 `安全事件一级分类 = 漏洞利用` 的事件 ID，按事件表遍历顺序输出 |
| `riskDetails.totalEvents` | 事件总数 | 导出的事件表 Excel | 统计事件表有效数据行数 |
| `riskDetails.severeEvents` | 严重事件数 | 导出的事件表 Excel | 读取表头为 `等级` 的列，统计值等于 `严重` 的事件行数 |
| `riskDetails.highEvents` | 高危事件数 | 导出的事件表 Excel | 读取表头为 `等级` 的列，统计值等于 `高危` 的事件行数 |
| `riskDetails.closedEvents` | 已闭环事件数 | 导出的事件表 Excel | 统计 `处置状态` 列值等于 `处置完成` 的事件行数；指标名仍保留“已闭环” |
| `riskDetails.containedAlerts` | 已遏制告警数 | MSSW 告警统计接口 | 与 `riskOverview.containedAlerts` 一致，查询处置动作为 `已遏制(组件同步)` 或 `已遏制(已封禁地址)` 的告警总数 |
| `riskDetails.processingEvents` | 处置中事件数 | 导出的事件表 Excel | 读取表头为 `处置状态` 的列，统计值等于 `处置中` 的事件行数 |
| `riskDetails.closeRate` | 闭环率 | 导出的事件表 Excel | 用 `closedEvents / totalEvents * 100` 计算，结果保留两位小数 |
| `riskDetails.alertReductionRate` | 告警消减率 | MSSW 告警统计接口 + 导出的事件表 Excel | 若未显式提供，则按 `(alertTotal - totalEvents) / alertTotal` 计算，结果保留两位小数 |
| `riskDetails.uniqueAssetCount` | 涉及到的资产数 | 导出的事件表 Excel | 遍历事件表所有事件，提取“影响资产”列中的 IPv4 地址（如 `10.5.40.62(未归类组)` 取 `10.5.40.62`）后去重计数 |
| `riskDetails.AvgResponseTime` | 全量事件平均响应时间 | 导出的资产表 Excel + 事件表 Excel | 遍历所有 `处置状态 = 处置完成` 的事件，用 `完成时间 - 事件创建时间` 计算每起事件的响应分钟数，最后求平均并保留 1 位小数；任一时间缺失或无法解析则跳过该事件 |
| `riskDetails.highRiskIncidentExamples.vulnExploits` | 高危及以上事件举例-漏洞利用类 | 导出的事件表 Excel + `riskOverview.exploitStats.incidentIds` | 回查 `incidentIds` 命中的事件，读取 `等级` 列并按 `严重 > 高危 > 中危 > 低危` 排序，同等级保持事件表原始顺序，最多取 5 条；带出 `事件名称`、`受影响资产`、`最近发生时间`、`处置状态` |
| `riskDetails.highRiskIncidentExamples.viruses` | 高危及以上事件举例-病毒木马类 | MSSW 事件表 Excel + `riskOverview.incidentGptStats.virusTrojan.confirmedIncidentIds` | 回查已确认病毒木马事件，先从 `文件` 列中提取所有标记为 `黑` 的 MD5 并用 `、` 拼接，再按 `等级` 列的 `严重 > 高危 > 中危 > 低危` 排序，同等级保持事件表原始顺序，最多取 5 条，同时带出 `受影响资产`、`最近发生时间`、`处置状态` |
| `riskDetails.highRiskIncidentExamples.c2Connections` | 高危及以上事件举例-C2外联类 | MSSW 事件表 Excel + `riskOverview.incidentGptStats.hostCompromise.confirmedIncidentIds` | 回查已确认 C2 外联事件，先从 `外网IP` 和 `域名` 列中提取所有标记为 `黑` 的实体并用 `、` 拼接，再按 `等级` 列的 `严重 > 高危 > 中危 > 低危` 排序，同等级保持事件表原始顺序，最多取 5 条，同时带出 `受影响资产`、`最近发生时间`、`处置状态` |
| `riskOverview.devices` | 接入组件数 | 深信服设备列表接口 + 第三方设备列表接口 | 深信服设备总数优先取 `/api/apex/device/v1/devices/list` 返回的 `data.total`，第三方设备数取 `/api/apex/thirdparty/v1/app/instance/list` 的 `data.count`，两者相加 |
| `riskDetails.devices` | 接入安全设备数 | 深信服设备列表接口 + 第三方设备列表接口 | 保留兼容字段，值与 `riskDetails.sangfor + riskDetails.third` 一致 |
| `riskDetails.sangfor` | 深信服设备数 | 深信服设备列表接口 | 取 `/api/apex/device/v1/devices/list` 返回的 `data.total` |
| `riskDetails.third` | 第三方设备数 | 第三方设备列表接口 | 取 `/api/apex/thirdparty/v1/app/instance/list` 返回的 `data.count` |
| `riskDetails.af` | AF 设备数 | 深信服设备列表接口 | 遍历设备列表中 `devType` 等于 `3` 的记录计数 |
| `riskDetails.aes` | aES 设备数 | 深信服设备列表接口 | 遍历设备列表中 `devType` 属于 `12 / 37 / 100038 / 50038 / 100012` 的记录计数 |
| `riskDetails.sip` | SIP 设备数 | 深信服设备列表接口 | 遍历设备列表中 `devType` 等于 `9` 的记录计数 |
| `riskDetails.sta` | STA 设备数 | 深信服设备列表接口 | 遍历设备列表中 `devType` 等于 `25` 的记录计数 |
| `riskDetails.other_sf` | 其它深信服设备数 | 深信服设备列表接口 | 遍历设备列表中未命中上述映射的记录计数 |

说明：

- 真实模式下，结构化 JSON 以 `projectBackground`、`assetLedger`、`riskDetails`、`riskOverview`、`appendix` 为主。
- `riskOverview` 当前主要给模板里的风险总览章节预留，后续新增真实取值时必须继续补上来源和逻辑。

## Template Strategy

推荐模板里显式放占位符：

```html
{{ projectBackground.customerName }}
{{ projectBackground.startDate }}
{{ assetLedger.manage_asset }}
```

对于已有模板中的 KPI，可继续使用：

```html
<div data-field="assetLedger.manage_asset">520</div>
```

渲染器会按数据路径回填 `data-field` 的文本内容，并把完整 `window.SECURITY_REPORT_DATA` 注入页面，方便后续图表脚本读取结构化数据。

复杂表格、列表、图表建议不要靠纯文本替换，后续应扩展成命名 section renderer，例如 `renderKeyRisksTable(reportData.risks.keyRisks)`。
