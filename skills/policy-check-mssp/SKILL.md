---
name: policy-check-mssp
description: 分步骤执行老平台 MSSP 策略检查，支持并发下发多个客户、按客户查询状态、导出 DOCX 报告或生成风险话术。仅用于 MSSP 或老平台，不用于 MSSW。
---

# MSSP 策略检查

本 Skill 是老平台 MSSP 专用能力。“MSSP 策略检查”和“老平台策略检查”均使用本 Skill；用户明确说 MSSW、新平台或使用 `policy-check` 时，不得调用本 Skill。

四个 Phase 都是短任务，按用户当前意图只执行其中一步。不得自动串联、持续轮询或在后台等待。每一步结束后立即把该步结果返回当前 Claw 聊天。

## 意图路由

| 用户意图 | 只执行 |
|---|---|
| 做、执行、发起、下发 MSSP/老平台策略检查 | Phase 1 |
| 查询状态、任务怎么样、完成了吗 | Phase 2 |
| 导出、下载策略检查报告 | Phase 3 |
| 查询结果、查看风险、生成话术 | Phase 4 |

用户明确要求某个 Phase 时，直接执行该 Phase。不要因为用户执行 Phase 1 就自动继续 Phase 2-4。

## 命令

在本 Skill 根目录执行。

### Phase 1：下发任务

```bash
python3 phase1/phase1_trigger.py --company "公司名称"
python3 phase1/phase1_trigger.py --company-id 12345678
python3 phase1/phase1_trigger.py --select 1
python3 phase1/phase1_trigger.py --companies '["客户A","客户B"]'
python3 phase1/phase1_trigger.py --company-ids '["12345678","87654321"]' --max-workers 4
```

Phase 1 通过 MSSP 客户搜索接口按用户输入查询 `company_name + company_id`，再获取 AF/SIP/EDR/STA 设备、记录下发前任务基线并创建任务。多候选时，把候选列表返回当前聊天；用户确认后用 `--select` 再执行一次 Phase 1。已知数字 `company_id` 时可用 `--company-id` 跳过客户搜索。

批量下发接受 JSON 数组或逗号分隔值。默认同时处理 4 个客户，最多 8 个；不同客户并发执行，同一客户仍串行。一个客户失败不会取消其他客户，stdout 的 `results` 按输入顺序分别返回成功或失败；存在任一失败时命令返回非零退出码。批量输入出现多候选时，该客户返回失败，其他客户继续；用户确认后再单独用 `--select` 下发。

批量下发完成后，查询状态、导出报告或查看结果时必须使用该客户返回的 `company_id`，不要用 `--latest` 猜测客户；`last_session.json` 只兼容单客户旅程。

### Phase 2：单次查询状态

```bash
python3 phase2/phase2_wait_check.py --latest
python3 phase2/phase2_wait_check.py --company-id 12345678 --task-id TASK_ID
```

默认读取最新业务上下文并查询 MSSP 一次，不 sleep、不轮询。可能返回 `not_found`、`running`、`completed` 或 `failed`；需要刷新时再次执行 Phase 2。`--local` 只读取本地状态，不调用 MSSP。

### Phase 3：导出 DOCX

```bash
python3 phase3/phase3_export_report.py
python3 phase3/phase3_export_report.py --task-id TASK_ID --company-id 12345678
```

默认使用 Phase 2 保存的 `task_id` 和 Phase 1 保存的 `company_id`。成功后把 stdout 中 `file_path` 指向的 DOCX 作为当前聊天附件发送。缺少任务 ID 时，先执行 Phase 2。

### Phase 4：生成结果话术

```bash
python3 phase4/phase4_generate_message.py
python3 phase4/phase4_generate_message.py --company-id 12345678 --dev-ids '[1,2,3]'
```

默认使用 Phase 1 保存的客户和设备。把 `message` 返回当前聊天；完整策略结果只保存到 `results_path`，无需作为聊天附件发送。

## 业务规则

- 设备范围保持 AF、SIP、EDR、STA。
- 客户解析使用 `/gateway/customer-mgr-service/order/v1/user?_method=GET`，`service_status=0`，只把平台返回的 `company_name + company_id` 交给现有精确、模糊和多候选匹配逻辑。
- Phase 2 任务完成条件保持 `assess_status == 40` 且 `report_status == "finish"`。
- Phase 3 报告导出入参保持 `_id + company_id`，下载后校验 DOCX 完整性。
- Phase 4 保持每页 100 条、`status=at_risk`、昨天 00:00 至明天 00:00 的东八区时间窗，以及“设备名 + 策略名 + 策略状态”去重规则。

## 状态与重试

每个客户的业务上下文独立保存在 `$SKILL_OUTPUT_DIR/policy-check-mssp/cache/companies/`；`last_session.json` 保留最近一次更新的客户上下文，用于兼容不传 `company_id` 的原有命令。`status` 表示 MSSP 业务任务状态；`execution` 只表示该客户最近一次短步骤的本地执行状态，两者不得混用。

- 不同客户使用独立文件锁，可以同时执行；同一客户同一时刻只允许一个 Phase，避免重复下发或状态覆盖。
- 某一步 `failed/interrupted` 后，文件锁释放，可以立即重试该步骤。
- Phase 1 重新下发前，只要旧状态可能对应一次已尝试的下发且存在任务上下文，就先查询 MSSP；只有平台任务确实仍在运行时才拒绝，失败、完成或已找不到时允许重新下发。
- Phase 2 可随时刷新并保存最新一次远端业务状态，不会启动其他 Phase。
- HTTP 500 不解释为登录失效，不自动重试。直接把 MSSP 返回的 HTTP 状态、Content-Type 和响应体作为该 Phase 的错误返回当前 Claw 聊天。
- MSSP 请求统一使用 `requests`，所有接口必须携带固定 `X-CSRFToken: [REDACTED_SECRET]` 和 `Timezone: +08:00`，请求头不得包含 `Origin`；客户搜索沿用 `monitor-mssp-events` 已验证的浏览器请求头组合。
- 所有接口固定请求 `http://soar-inner.sangfor.com.cn:30001`，不得通过环境变量切换回公网 `https://soar.sangfor.com.cn`；任务下发地址为 `/order/v1/policy_check/distribute_task`。
- 系统错误响应只做敏感字段脱敏和 4 KB 长度限制，不改写服务端错误含义。
- 401、403或明确的登录失效业务码可重新向 `session-manager` 获取会话；若会话没有变化，直接返回原系统错误。

## 安全与输出

登录态统一通过 `session-manager get-state --skill-name policy-check-mssp` 获取，只读取 `platforms.mssp.cookies`。当前 CLI 没有强制刷新参数。不得要求用户粘贴 Cookie，也不得把 Cookie、CSRF Token 或 session 内容写入日志、状态或产物。

Skill 根目录只读。状态、候选项、DOCX、话术和结果 JSON 全部写入 `$SKILL_OUTPUT_DIR/policy-check-mssp/`。不配置或调用 Webhook，不支持定时执行。

失败写 stderr 并返回非零退出码；成功时 stdout 只输出机器可读 JSON。

完整的新旧旅程差异和状态说明见 [docs/policy-check-mssp-muad-改造说明.md](docs/policy-check-mssp-muad-改造说明.md)。
