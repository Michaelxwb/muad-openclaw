# 平台登录态：Skill 先调 session-manager get-state

Skill 访问受保护业务平台时，自己调用 `session-manager get-state --skill-name <skill>` 获取登录态文件，然后直接读该文件发 `requests` 请求。`muad_skill_http` 不再解析登录态，也不执行 session-manager。

## 脚本写法

```python
import json
import subprocess

import requests

SKILL_NAME = "my-skill"  # 必须与 muad.skill.json 的 name 一致
PLATFORM = "smoke_platform"


def resolve_state_file():
    completed = subprocess.run(
        ["session-manager", "get-state", "--skill-name", SKILL_NAME],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
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
response = requests.get(base_url + "/api/v1/items", headers={"Cookie": cookie}, timeout=30)
```

- `SKILL_NAME` 必须是硬编码字符串，且等于 `muad.skill.json` 的 `name`（`self-skill-review` 的 SS-R011 会检查）。
- `PLATFORM` 是 `muad.skill.json` 的 `platforms` 中的平台名，必须是字面量。
- 状态文件缺少对应平台、`baseUrl` 为空时 fail loud（stderr + 非 0）。
- 401/403 不会自动刷新登录态；重新执行 `get-state` 后再发起请求。

## 本地开发

本地没有 session-manager。模板在 `MUAD_SESSION_KEY` 不存在时直接读
`~/.muad-local/session-state.json`。用 SDK 的 `build_local_state` /
`merge_local_states` 从浏览器复制的 Cookie 生成该文件即可；不要提交填好的状态文件。

## browser 能力

声明 `capabilities: ["browser"]` 的 Skill 仍走 `session_get_state` **模型工具**（不是脚本自助），因为只有插件工具能调用 `browser.request`。不要让模型直接调 `session_get_state`；SKILL.md 顶部直接列出脚本命令（如 `python3 scripts/run.py`），引导模型跑脚本而非调工具。

## 不需要在 SKILL.md 里做的事

- 不要让模型直接调 `session_get_state` 工具——该工具需要 `skillName` 参数，模型容易传成平台名。
- 不要指导用户手工保存 cookie 或 token；登录态由 `session-manager` 管理（本地开发文档除外）。
