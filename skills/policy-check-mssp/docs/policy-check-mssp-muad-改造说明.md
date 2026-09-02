# MSSP 策略检查 Muad 改造说明

## 结论

`skills/policy-check-mssp/` 是 MSSP（老平台）独立 Skill。MSSW 的 `skills/policy-check/` 不参与本次改造，用户旅程和代码保持原状。

当前版本已经从“Phase 1-4 自动串联的长任务”调整为四个独立短任务。用户可以按正常顺序逐步执行，也可以直接要求某一步；每次调用只做一个 Phase 并立即返回。

Phase 1 支持一次输入多个客户并发下发。默认并发 4、最多 8；不同客户独立执行和保存状态，同一客户仍禁止并发重复下发。批量中的单个客户失败不会撤销其他客户已经成功创建的任务。

批量下发后，后续 Phase 必须显式携带对应的 `company_id`；不能用 `--latest` 推断要查询哪个客户。批量名称出现多候选时，该项返回候选列表并失败，其他项继续执行；用户确认后再单独处理该客户。

## 用户旅程

```text
用户要求下发
  -> Phase 1：确认一个或多个客户、并发获取各自设备并下发任务
  -> 当前聊天收到逐客户下发结果

用户要求查状态
  -> Phase 2：查询 MSSP 一次
  -> 当前聊天立即收到 not_found/running/completed/failed

用户要求导出报告
  -> Phase 3：使用最新上下文或显式参数导出 DOCX
  -> 当前聊天收到 DOCX 附件

用户要求看结果或生成话术
  -> Phase 4：查询策略结果并生成话术
  -> 当前聊天收到话术
```

Phase 1 不会自动启动 Phase 2；Phase 2 不会等待到完成；Phase 3 和 Phase 4 互不触发。

## 与老 MSSP Skill 的旅程差异

| 环节 | 老 MSSP Skill | Muad MSSP 短任务 Skill |
|---|---|---|
| 入口 | 本机脚本，可立即或定时执行 | 当前 Claw 聊天按意图调用单个 Phase |
| 登录态 | 本机 Cookie 文件或环境变量 | `session-manager` 按用户、按 Skill 提供 MSSP session |
| 执行方式 | 后台等待或 Phase 1-4 自动串联 | 四个短任务完全拆开，不后台等待 |
| 多客户下发 | 单次处理一个客户 | Phase 1 可批量并发，不同客户互不阻塞 |
| 状态查询 | 脚本持续轮询，最长约 3 小时 | 每次只查询一次，需要刷新时再次调用 Phase 2 |
| 报告导出 | 自动在状态完成后继续导出 | 用户单独要求 Phase 3 时导出 |
| 结果话术 | 自动接在报告后生成 | 用户单独要求 Phase 4 时生成 |
| 定时执行 | 支持本机定时参数 | 移除 |
| 过程通知 | 企微 Webhook 分阶段推送 | 移除 Webhook，每一步只回当前 Claw 聊天 |
| 运行文件 | Skill 目录内共享 cache/reports | `$SKILL_OUTPUT_DIR/policy-check-mssp/` 按用户隔离，敏感状态文件 0600 |

对用户需要同步的变化是：下发后不会自动等待、导报告和生成话术；用户可以分别说“查状态”“导出报告”“查看结果”，系统每次只执行对应一步。

## 独立调用与上下文

Phase 1 按客户分别保存 `company_id`、公司名、设备 ID 和任务列表基线。Phase 2 显式传 `company_id` 时读取该客户上下文并保存 `task_id`、任务名和最新远端状态；不传时读取 `last_session.json` 中最近更新的客户。Phase 3、Phase 4 使用相同选择规则。

Phase 1 的客户解析已由旧 `/order/v1/user/company_simple_info` 切换到 MSSP 客户搜索接口 `/gateway/customer-mgr-service/order/v1/user?_method=GET`。接口只负责根据用户输入返回 `company_name + company_id`；本地仍执行原有精确匹配、模糊匹配和多候选确认，后续设备、任务、报告和策略接口不变。显式传入数字 `company_id` 时仍跳过客户搜索。

每个 Phase 也接受显式参数：

- Phase 2：`company_id`、`task_id`
- Phase 3：`task_id`、`company_id`、`task_name`
- Phase 4：`company_id`、`dev_ids`、`task_name`、公司名

因此既能走完整顺序，也能在用户已经提供必要标识时单独执行某一步。

## 状态和失败恢复

状态文件区分两层：

```text
status       MSSP 远端业务任务：submitted/not_found/running/completed/failed
execution    最近一次本地短步骤：running/succeeded/failed/interrupted
```

客户状态保存在 `cache/companies/<company-key>.json`，客户锁保存在 `cache/locks/<company-key>.lock`，报告和结果保存在 `reports/<company-key>/`。`company-key` 使用 company_id 的稳定摘要，状态文件内容仍保存原始 company_id。`last_session.json` 是兼容快照，不承担多客户状态存储；并发任务不会因为它被更新而覆盖各自客户文件或产物。

状态查询后，本地步骤结束并释放锁；远端 `running` 会继续保留，不会因本地进程退出被误改成 `interrupted`。只有 `execution.status=running` 且文件锁已释放时，才说明本地步骤异常中断。

Phase 1 重新下发前不直接相信旧状态文件。只要旧状态可能对应一次已尝试的下发且保留了客户和任务基线上下文，就先查询 MSSP：仍运行则拒绝重复下发；失败、完成或找不到则允许重新下发。某一步本地失败也不会永久占锁，可以立即重试。

HTTP 500 不解释为登录失效，也不自动重试。Skill 直接返回 MSSP 的 HTTP 状态、Content-Type 和系统响应体；只对 Cookie、Token 等敏感字段做脱敏，并把响应体限制在 4 KB 内。Claw 应把该错误内容原样反馈给用户，不补充 Skill 自行推断的故障原因。

`session-manager get-state` 当前没有强制刷新参数。401、403或明确的登录失效业务码可以重新获取会话；会话没有变化时直接返回原系统错误，不会删除或改写 Muad 框架的会话缓存。

## 保持不变的业务规则

- 设备范围：AF、SIP、EDR、STA。
- 任务识别：下发前保存当日任务基线，查询时只匹配基线之后的新任务。
- 完成条件：`assess_status == 40` 且 `report_status == "finish"`。
- 报告导出入参：`_id + company_id`。
- 策略查询：`status=at_risk`，每页 100 条。
- 时间窗：昨天 00:00（含）到明天 00:00（不含），东八区。
- 去重键：设备名、策略名、策略状态。
- 话术分组：策略获取失败、授权过期或未开通、其余风险项按设备类型分组。

## 安全边界

- MSSP origin 固定为 `http://soar-inner.sangfor.com.cn:30001`，统一带 `Host: inner.sangfor.com.cn`；不允许通过环境变量覆盖回公网地址。
- `origin` 只用于拼接请求 URL 和 Referer，不作为 HTTP `Origin` 请求头发送；所有 MSSP 请求使用 `requests`，客户搜索头部与已调通的 `monitor-mssp-events` 对齐。
- 所有 MSSP 接口统一强制携带固定 `X-CSRFToken: [REDACTED_SECRET]` 和 `Timezone: +08:00`，不能只给客户搜索单独配置，否则设备查询、任务下发等接口会返回 403/非法操作。
- Cookie 只在内存请求头中使用，不进入日志、状态或产物。
- 报告只有在 HTTP 成功、内容非空、ZIP 完整并包含 DOCX 核心文件后才保存。
- 代码不发送 Webhook；文件路径由 Claw 作为当前聊天附件交付。
