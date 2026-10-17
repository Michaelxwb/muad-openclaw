---
name: mssw-platform-smoke
description: "MANDATORY before claiming the MSSW platform request path works. Trigger on: 验证 mssw 会话/Cookie、Traceid、platform_request、请求限额（CSRF 需状态变更接口，不在本 Skill 范围）。"
---

# MSSW 平台冒烟

验证 `mssw` 平台经 `muad_skill_http.platform_request` 的会话与请求链路。Cookie、CSRF、Host、平台静态头和每请求 `Traceid` 都由 SDK 构造；单请求 GET 冒烟断言 HTTP 状态、用户、响应 `path` 与 `Traceid` 的 UUID 格式，`limit_probe.py` 进一步断言多次请求的 `Traceid` 互不相同。CSRF 的实际校验需要状态变更接口，GET 冒烟不对此下结论。

## 何时使用

- 修改了 `tools/muad-skill-sdk`、`tools/session-manager` 的 mssw/mssp 适配器后；
- 需要确认 fake MSSW 平台或真实 MSSW 平台的登录态是否可用；
- 需要验证 SDK 的请求限额会在第 N+1 次请求前终止执行。

## 前置条件

- 平台 `mssw` 已在 Console 配置，并给当前用户绑定凭据；
- 凭据 `baseUrl` 指向目标 MSSW（本地测试时指向 fake platform）；
- 运行时已安装 `muad_skill_http`（app 镜像构建时安装）。

本地 fake MSSW 启动方式（脚本路径仅在开发仓库内可用；运行时 Pod 不含 `tools/`）：

```bash
python3 tools/fake-business-platform/server.py --platform mssw --port 18080
```

凭据示例（管理员在 Console 平台配置中填写；`baseUrl` 填本地 fake MSSW 的实际地址，端口 18080）：

```json
{
  "baseUrl": "<fake-mssw-base-url>",
  "sessionEndpoint": "<session-endpoint>",
  "healthEndpoint": "<health-endpoint>",
  "ak": "test-ak",
  "sk": "test-sk",
  "csrfEnabled": true
}
```

`healthEndpoint` 供 session-manager 校验登录态；本 Skill 的业务请求使用下面的冒烟接口。

## 冒烟接口

默认请求 `GET /api/v1/ping`，fake MSSW 与 MSSW 测试网关提供该接口。响应应包含 `user`、UUID 格式的 `traceId` 和 `path`，且 `path` 必须等于请求路径。`limit_probe.py --path` 仅允许 `/api/v1/ping` 或 `/api/v1/targets`。

## 执行

本 Skill 必须在 Skill 执行上下文中运行：脚本启动时校验 guard 注入的 `MUAD_SKILL_NAME`，缺失或不等于 `mssw-platform-smoke` 时立即以退出码 `4` 终止并提示先激活 Skill。不要在普通 shell 里直接运行脚本；模型必须先读取 SKILL.md（或用户使用 `/skill:mssw-platform-smoke`）激活后再执行。

单请求冒烟：

```bash
python3 scripts/run.py
```

成功输出（stdout 只有这一行 JSON）：

```json
{"status":"MSSW_SMOKE_OK","httpStatus":200,"user":"demo","trace":"<uuid>","path":"/api/v1/ping"}
```

`SKILL_OUTPUT_DIR` 存在时会 best-effort 写入 `mssw-smoke.json`；写文件失败不影响 stdout 的成功结果。

限额探测（默认自动打满注入上限：`limit` 在 1–49 时发起 `limit+1` 次请求；未注入上限时默认 4 次）：

```bash
python3 scripts/limit_probe.py
```

需要验证未触发路径时显式给 `--count`（例如上限 3 时 `--count 2`）：

```bash
python3 scripts/limit_probe.py --count 2
```

- 上限由 guard 注入的 `MUAD_SKILL_REQUEST_LIMIT` 决定；脚本与 SDK 读取同一个变量，未注入（或配置为 0）时双方都按“不限”处理，脚本不做限额判断；
- 进度写 stderr；成功或限额触发路径的 stdout 只有一条汇总 JSON，参数错误/HTTP 失败/缺 Traceid 等失败路径只写 stderr；
- 每次响应的 `traceId` 会校验 UUID 格式并收集，断言互不相同，重复时退出码 3；
- 显式 `--count` 在 1–50 之间；不传时由脚本按 `min(limit+1, 50)` 自动选择，`limit` 在 1–49 时默认执行即触发上限；`limit` 为 0 或 ≥50 时不会触发，需显式指定次数或调整 Console 请求上限；
- 达到上限时，脚本会在第 N+1 次请求前先输出汇总，SDK 随后 `exit(86)`：

```json
{"status":"LIMIT_TRIGGERED","path":"/api/v1/ping","requested":4,"sent":3,"limit":3,"traceCount":3,"traceIdsUnique":true}
```

未达到上限时（`limit` 为 `0` 表示 guard 未注入上限，脚本不做限额判断）：

```json
{"status":"LIMIT_NOT_TRIGGERED","path":"/api/v1/ping","requested":4,"sent":4,"limit":0,"traceCount":4,"traceIdsUnique":true}
```

`--path` 只允许 `/api/v1/ping` 或 `/api/v1/targets`。若已到预期限额但 SDK 没有终止，脚本会写 stderr 并 exit 1，stdout 仍然只有一条 JSON。

## 退出码

| 退出码 | 适用 | 含义 |
| --- | --- | --- |
| `0` | `run.py` / `limit_probe.py` | 成功，或限额未触发 |
| `1` | `run.py` / `limit_probe.py` | 请求失败、响应缺字段、非 UUID `traceId`、`path` 与请求不一致，或运行时异常 |
| `2` | `limit_probe.py` | 参数错误 |
| `3` | `limit_probe.py` | 连续请求复用了同一个 Traceid |
| `4` | `run.py` / `limit_probe.py` | 未通过 Skill 执行（`MUAD_SKILL_NAME` 缺失或不匹配） |
| `86` | `limit_probe.py` | SDK 触发单接口请求上限，本次执行被终止 |

## 注意

- 不要手工拼 `Cookie`/CSRF/`Traceid`，全部由 SDK 构造；
- 不要把 cookie、CSRF、请求头写入 stdout 或日志；
- 失败必须写 stderr 并 exit 非 0；
- 限额终止是预期路径：退出码 `86` + abort spool，不是普通异常；此时 stderr 最多只有进度行，没有错误输出。
