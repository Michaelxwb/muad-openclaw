---
name: mssw-platform-smoke
description: "MANDATORY before claiming the MSSW platform request path works. Trigger on: 验证 mssw 平台登录态、CSRF、Traceid、platform_request 或请求限额。"
---

# MSSW 平台冒烟

验证 `mssw` 平台经 `muad_skill_http.platform_request` 的完整请求链路：Cookie、CSRF、Host、平台静态头、每请求 `Traceid`，以及可选的单接口限额终止。

## 何时使用

- 修改了 `tools/muad-skill-sdk`、`tools/session-manager` 的 mssw/mssp 适配器后；
- 需要确认 fake MSSW 平台或真实 MSSW 平台的登录态/CSRF 是否可用；
- 需要验证 SDK 的请求限额会在第 N+1 次请求前终止执行。

## 前置条件

- 平台 `mssw` 已在 Console 配置，并给当前用户绑定凭据；
- 凭据 `baseUrl` 指向目标 MSSW（本地测试时指向 fake platform）；
- 运行时已安装 `muad_skill_http`（app 镜像构建时安装）。

本地 fake MSSW 启动方式：

```bash
python3 tools/fake-business-platform/server.py --platform mssw --port 18080
```

凭据示例（管理员在 Console 平台配置中填写；`baseUrl` 填本地 fake MSSW 的实际地址，端口 18080）：

```json
{
  "baseUrl": "<fake-mssw-base-url>",
  "sessionEndpoint": "/gateway/mss-auth-acl-service/v1/certification/login_agent",
  "healthEndpoint": "/v1/rtt",
  "ak": "test-ak",
  "sk": "test-sk",
  "csrfEnabled": true
}
```

## 执行

单请求冒烟：

```bash
python3 scripts/run.py
```

成功输出：

```json
{"status":"MSSW_SMOKE_OK","httpStatus":200,"user":"demo","trace":"<uuid>"}
```

限额探测（默认 4 次；上限由 guard 注入的 `MUAD_SKILL_REQUEST_LIMIT` 决定）：

```bash
python3 scripts/limit_probe.py --count 4
```

达到上限时 SDK 会在第 N+1 次请求发出前 `exit(86)`，并写入 abort spool；未达到时输出 `LIMIT_NOT_TRIGGERED`。

## 注意

- 不要手工拼 `Cookie`/CSRF/`Traceid`，全部由 SDK 构造；
- 不要把 cookie、CSRF、请求头写入 stdout 或日志；
- 失败必须写 stderr 并 exit 非 0。
