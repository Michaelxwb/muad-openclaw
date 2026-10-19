# 对接平台的请求头：requests + Runtime Guard

自建 Skill 访问受保护业务平台时，继续使用 `requests` 发请求。Skill 只负责两件事：

1. 用 `session-manager get-state --skill-name <skill>` 取登录态文件；
2. 从状态文件读 `platforms.<平台名>.cookies` 拼 `Cookie` 头，读 `requestProfile.baseUrl` 作为 URL 前缀。

`TraceId` 与 `X-Csrftoken` 不需要 Skill 处理：镜像启动钩子会加载
`muad_skill_http.compat`，Runtime Guard 注入 `MUAD_REQUESTS_COMPAT=1` 与本 Pod
所有启用平台的 `host:port` 白名单后，发往白名单主机的 `requests` 请求会被自动
覆盖为新的 UUID v4，并计入执行级请求统计与限额。非白名单主机原样放行。

```python
import json
import subprocess

import requests

SKILL_NAME = "my-skill"  # 必须与 muad.skill.json 的 name 一致
PLATFORM = "mssw"        # 必须与 muad.skill.json 的 platforms 一致


def resolve_state_file():
    completed = subprocess.run(
        ["session-manager", "get-state", "--skill-name", SKILL_NAME],
        check=False, capture_output=True, text=True, timeout=30,
    )
    if completed.returncode != 0:
        raise RuntimeError("session-manager get-state failed")
    return json.loads(completed.stdout)["sessionStateFile"]


with open(resolve_state_file(), "r", encoding="utf-8") as handle:
    state = json.load(handle)
section = state["platforms"][PLATFORM]
base_url = section["requestProfile"]["baseUrl"].rstrip("/")
cookie = "; ".join(
    "%s=%s" % (item["name"], item["value"])
    for item in section.get("cookies") or []
)

response = requests.get(
    base_url + "/api/v1/targets",
    headers={"Cookie": cookie},
    timeout=30,
)
```

## Runtime Guard 负责什么

对白名单主机上的每个 `requests` 请求：

1. `TraceId`：覆盖为新的 UUID v4；
2. `X-Csrftoken`：覆盖为新的 UUID v4（MSSW/SOAR 只校验 header 存在）；
3. 按归一化接口计数，超过 `MUAD_SKILL_REQUEST_LIMIT` 时拒绝发出下一个请求并以
   86 退出；
4. 写 trace spool 供 Console 审计展示。

Cookie 值不进入 trace spool。

## Skill 不应做的事

- 不要手工从 cookie 提取 CSRF 再写 header——Guard 会覆盖，且平台只要求 header 存在。
- 不要硬编码 `TraceId`；每次请求必须不同。
- 不要用 `httpx` / `urllib.request` / `http.client` 直连业务接口（不会被注入和统计）。
- 不要用 `subprocess` 调 `curl`/`wget` 发业务请求——既不计入执行 trace，也不受请求上限约束。
- 不要把 cookie / CSRF token 写进 stdout、日志或错误信息。

## 平台差异放哪里

平台 `baseUrl` 在 Console 的平台设置里配置，决定白名单主机。Cookie / CSRF
的 cookie 名、Host、静态头等平台差异仍由登录态（session-manager 输出）表达，
不写进 Skill 代码。
