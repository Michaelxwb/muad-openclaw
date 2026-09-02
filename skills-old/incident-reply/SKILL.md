---
name: incident-reply
description: "输出通报事件回函。输入通报源IP、目的IoC（域名/IP/IP+端口）和具体时间，按步骤查询获取结果，基于最终结果生成正式回函文档。"
---

# 通报事件回函

根据输入的通报信息查询获取结果，并生成正式的回函文档。

## 输入

### 第一步：通报信息（必填，前置条件）

用户必须先提供以下三项关键信息，缺一不可：
- **通报的源IP地址**：发起连接/请求的源 IP
- **目的IoC**：目的对象，支持格式：
  - 目的域名（如 example.com）
  - 目的 IP（如 1.2.3.4）
  - 目的 IP + 端口（如 1.2.3.4:8080）
- **具体时间**：事件发生/通报对应的具体时间

**输入判断流程**：
1. 若用户**已同时提供**源IP + 目的IoC + 具体时间 → 记录，继续后续流程。
2. 若用户**缺少任一项或信息不全** → 主动提示补齐缺失项，明确告知还差哪一项。提示话术：
   > 请补齐以下通报信息后才能继续生成回函：
   > 1. **源IP地址**（通报的源 IP）
   > 2. **目的IoC**（目的域名 / 目的 IP / 目的 IP+端口）
   > 3. **具体时间**（事件发生/通报时间）
   > 目前还缺少：**[此处列出缺失项]**
3. 用户补齐全部三项后，确认信息齐全，再继续后续步骤。

> ⚠️ 本流程**不涉及微步情报**，无需用户提供微步信誉结果或威胁标签。

### 第二步：判断资产是否为客户资产

拿到上述通报信息后，判断**源 IP 对应的资产是否属于客户的资产**。

**判定流程（两步脚本串联）：**

1. **获取 company_id**：
   调用 `scripts/asset_check/phase1_company.py --company "公司名"`
   - 输入：客户公司名称
   - 输出：`COMPANY_ID=` 与 `COMPANY_NAME=`（脚本最后两行）
   - 复制自漏扫 skill 的 `phase1_company.py`，逻辑一致（拉取公司列表 → 匹配 → 返回 company_id）

2. **查询资产台账判断归属**：
   调用 `scripts/asset_check/query_assets.py --company-id <company_id> --ip <源IP>`
   - 输入：上一步得到的 company_id + 通报的源 IP（作为 `ip_url_keyword` 字段）
   - 原子性判定结果见下「资产判定结果」

**资产判定结果：**
- 命中（`total > 0` 且 list 非空）→ **属于客户资产** → 继续后续流程（查威胁情报 → 编写回函）。
- 未命中（`total == 0`）→ **不属于客户资产** → 提示用户并退出，不再继续后续流程。
- 请求失败 / 解析失败（退出码 2）→ 报错退出，交用户排查（多为 Cookie 过期）。

**相关脚本：**
- `scripts/asset_check/phase1_company.py` —— 公司名 → company_id
- `scripts/asset_check/query_assets.py` —— company_id + 源 IP → 资产归属判断

**资产台账 API：**
- URL：`https://soar.sangfor.com.cn/gateway/asset-mgr-service/order/v1/asset?_method=GET`
- Header：参考漏扫 skill 的 Header（Cookie + 标准头 + X-Csrftoken）
- Payload 中 `company_id`、`ip_url_keyword` 为动态输入字段；`ip_url_keyword` 源 IP 用于匹配资产
- Cookie：`M:\Users\User\Downloads\cookies.txt`

## 使用场景
- 收到安全通报/风险事件通报后，需输出回函
- 生成正式、规范的回函文档交付

## 工作流
1. **输入判断**：确认用户已提供**源IP + 目的IoC + 具体时间**，缺失则提示补齐，补齐后继续
2. **资产归属判断**：判断来源/目的资产是否为客户资产，不属于则向用户确认
3. **查询深信服威胁情报**：查询通报 IoC 的信誉与威胁标签（域名→域名云查，IP/IP+端口→IP云查 direction=2）
4. **查询 AF 安全日志 + 访问日志**：判断 AF 上是否存在目标 IoC（domain / 目的IP / 目的IP+端口）的安全日志和访问日志
5. **编写回函文档**：生成 md 回函报告

## 一键执行（第五步：生成回函报告）

**唯一入口脚本：** `scripts/generate_reply.py`

用法：
```bash
# 目的IP+端口
python scripts/generate_reply.py --company "风行天下" --src-ip 39.144.190.29 --ioc "192.168.18.35:49001"
# 目的IP
python scripts/generate_reply.py --company "美的集团股份有限公司" --src-ip 10.72.51.15 --ioc "140.143.229.64"
# 域名
python scripts/generate_reply.py --company "深圳市爱德泰科技股份有限公司" --src-ip 10.1.247.1 --ioc "jdhhbs.biz"
# 多条通报：一个客户多条 IoC → 一次生成多份报告（--iocs 为 JSON 数组）
python scripts/generate_reply.py --company "风行天下" --src-ip 39.144.190.29 --iocs '["192.168.18.35:49001","bad.com","140.143.229.64"]'
# 多条通报且各自源IP不同
python scripts/generate_reply.py --company "风行天下" --src-ip 10.0.0.1 --iocs '[{"src_ip":"10.0.0.1","ioc":"192.168.18.35:49001"},{"src_ip":"10.0.0.2","ioc":"bad.com"}]'
```

**单条模式（默认，向后兼容）**：`--ioc` + `--src-ip` → 生成一份报告。

**多条模式（--iocs）**：`--iocs` 接收 JSON 数组，循环对每条 IoC 跑完整流程（资产/EDR → 情报 → 安全日志 → 访问日志），每个 IoC 各生成一份 md + docx 填充参数 JSON。数组元素两种写法可混用：
- 字符串（IoC）：共享 `--src-ip` 作为源 IP
- 对象 `{"src_ip": "...", "ioc": "..."}`：使用各自的源 IP
- 多报告模式下忽略 `--output` / `--output-params`；md/docx 参数文件名自动按「源IP+IoC」区分，避免互相覆盖

串联流程（自动完成）：
1. `phase1_company.py` 解析公司名 → company_id
2. `query_assets.py` 查询资产台账 + EDR(agent_status)安装状态
3. `ti_query.py` 查询深信服威胁情报（通报IoC 信誉 + 威胁标签）
   - 域名 → 域名云查 `domain_v2_repu`
   - IP / IP+端口 → IP云查 `ip_v2`（direction=2；IP+端口时 ipsInfo 携带 port 字段，端口必须为 int）
4. `query_af_logs.py --log-type security` 查询 AF 安全日志（含 action 允许/拒绝分布）
5. `query_af_logs.py --log-type access` 查询 AF 访问日志（不含 action）
6. 生成 md 回函报告，输出到 `reports/回函_{公司}_{源IP}.md`（多条模式为 `回函_{公司}_{源IP}_{IoC}.md`）
   - 同时导出 docx 填充参数 JSON：`reports/docx_params_{源IP}.json`（多条模式为 `docx_params_{源IP}_{IoC}.json`，供 `fill_feedback_generic.ps1` 消费）

报告结构（md，6 大板块）：
一、通报信息（源IP / 通报IoC / IoC类型）
二、资产归属与EDR状态（是否在台账 + 台账资产信息 + EDR安装状态 + **事件处理措施·第1项模板**）
三、深信服威胁情报（通报IoC信誉 + 威胁标签 + 网络类型）
四、AF安全日志（条数 + 最早/最新时间 + 动作分布 允许/拒绝）
五、AF访问日志（条数 + 最早/最新时间，无动作）
六、结论（汇总）

### 事件处理措施·第1项 固定文字模板（build_measure1_text）

基于资产台账接口 response 字段生成固定文字：
- **是否在台账**：看有没有数据（total>0）
- **是否属于 MSS 服务资产**：`status` 字段（1=服务内/属于，0=服务外/不属于）
- **资产分组**：`asset_group_name`（为空则写「未知」）
- **资产名称**：`hostname`（为空则写「未知」）
- **资产类型**：`asset_type`（`server`→服务器 / `endpoint`→终端 / `unknown`→未知）

句式（标点用逗号，不用分号）：
- 在台账且属于 MSS 服务资产：`1.该资产（源IP {ip}）在资产台账且属于MSS服务资产，资产分组：{group}，资产名称：{name}，资产类型：{type}。`
- 在台账但不属于 MSS 服务资产：`1.该资产（源IP {ip}）在资产台账内，但不属于MSS服务资产，资产分组：{group}，资产名称：{name}，资产类型：{type}。`
- 不在资产台账：`1.该资产（源IP {ip}）不在资产台账内，资产分组：未知，资产名称：未知，资产类型：未知。`

### 生成 docx 回函（fill_feedback_generic.ps1）

`generate_reply.py` 已自动导出 docx 填充参数 JSON（含 recvUnit / sheShiTxt / m1~m5 / safeTxt，均为固定句式模板）。用通用填充脚本消费：
```bash
powershell -ExecutionPolicy Bypass -File scripts/fill_feedback_generic.ps1 -paramsJson <docx_params_源IP.json>
```
- m1 由 `build_measure1_text` 固定模板生成
- m2（情报研判）/ m3（安全日志）/ m4（访问日志，域名→DNS / IP+端口→TCP）均按固定句式模板自动生成
- **查询时间范围默认为近两周（15天）**：安全日志/访问日志话术统一带「近两周」，如 `经查近两周的网络安全日志`、`经查近两周的TCP访问日志`、`经查近两周的DNS访问日志`
- **事件处理措施只保留 1-4 点**，m5（综合研判结论）不写入 docx：填充时（m5 为空）自动删除模板中占位的第 5 点整段
- 涉事情况 / 安全管理 按固定句式模板生成
- dstDocx 输出到 `M:\Users\User\Downloads\网络安全事件处理反馈单_{公司}.docx`

## 关键脚本
- `scripts/asset_check/phase1_company.py` —— 公司名 → company_id
- `scripts/asset_check/query_assets.py` —— company_id + 源 IP → 资产归属 + EDR状态
- `scripts/sangfor_ti_cloud_search/ti_query.py` —— 深信服情报查询封装（域名/IP/IP+端口 信誉+威胁标签）
- `scripts/sangfor_ti_cloud_search/cloud_query_ioc.py` —— 深信服云查基础（token + 域名/IP 云查）
- `scripts/af_log_check/query_af_logs.py` —— AF 安全日志/访问日志查询（tableId 56/20/100）
- `scripts/generate_reply.py` —— 一键串联生成回函（md + docx 填充参数 JSON）
- `scripts/fill_feedback_generic.ps1` —— 消费 docx 填充参数 JSON 生成正式 docx
- `scripts/send_reply_webhook.py` —— 把 docx 通过企微群 webhook 发出

## 日志表与字段要点
- AF 安全日志：tableId=56（含 `dnsQueries` 域名字段 + `action` 动作字段）
- AF 访问日志：域名场景 tableId=20（域名字段 `queries`，无 action）；目的IP/IP+端口 tableId=100（无 action）
- 查询接口：`POST https://soar.sangfor.com.cn/gateway/log-search-center-service/datalake/v1/ckQueryList`
- 排查经验：数据湖偶发 `code=9601 查询数据湖异常`，`query_af_logs._fetch_pages` 已内置 3 次自动重试

## 说明
- 具体执行步骤逐步完善中，本流程已含资产判断、深信服情报、AF 日志查询、回函生成。
