# 平台登录态：Skill 先调 session-manager get-state

Skill 访问受保护业务平台时，自己调用 `session-manager get-state --skill-name <skill>` 获取登录态，再把返回的 `sessionStateFile` 传给 `muad_skill_http.platform_request`。SDK 只负责构造请求头、发送请求和统计/trace，**不再内部解析登录态，也不执行 session-manager**。

## 脚本写法

```python
import json
import subprocess

from muad_skill_http import platform_request

SKILL_NAME = "my-skill"  # 必须与 muad.skill.json 的 name 一致


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


state_file = resolve_state_file()
response = platform_request(
    "smoke_platform", "GET", "/api/v1/items", state_file=state_file,
)
```

- `SKILL_NAME` 必须是硬编码字符串，且等于 `muad.skill.json` 的 `name`（`self-skill-review` 的 SS-R011 会检查）。
- `smoke_platform` 是 `muad.skill.json` 的 `platforms` 中的平台名，必须是字面量。
- 平台未配置、登录态缺失/过期、状态文件里没有对应平台时，`platform_request` 抛出 `PlatformSessionError`；脚本按 fail loud 处理（stderr + 非 0）。
- 401/403 不会由 SDK 自动刷新登录态；重新执行 `get-state` 后再发起请求。

## 为什么登录不再放进 SDK

- 登录态获取是 `session-manager` 的职责；SDK 只封装“带登录态调用平台接口 + 统计/trace”。
- 旧的 `requests` 写法也是先取登录态、再发请求；拆分后 Skill 的结构与之前一致，只把请求那一行换成 `platform_request`。
- 需要排查登录态时，先看 `session-manager get-state` 的 stderr/返回码，再看 SDK 的 `PlatformSessionError` 文案。

## browser 能力

声明 `capabilities: ["browser"]` 的 Skill 仍走 `session_get_state` **模型工具**（不是脚本自助），因为只有插件工具能调用 `browser.request`。不要让模型直接调 `session_get_state`；SKILL.md 顶部直接列出脚本命令（如 `python3 scripts/run.py`），引导模型跑脚本而非调工具。

## 不需要在 SKILL.md 里做的事

- 不要让模型直接调 `session_get_state` 工具——该工具需要 `skillName` 参数，模型容易传成平台名。
- 不要指导用户手工保存 cookie 或 token；登录态由 `session-manager` 管理。
