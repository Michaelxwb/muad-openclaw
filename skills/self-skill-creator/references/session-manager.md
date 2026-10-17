# 平台登录态：由 SDK 自动获取

Skill 访问受保护业务平台时，登录态与平台请求配置由 `muad_skill_http.platform_request` 内部通过 `session-manager` 获取，**Skill 脚本不需要直接调用 `session-manager`**。

## 脚本里只用平台名

```python
from muad_skill_http import platform_request

response = platform_request("smoke_platform", "GET", "/api/v1/items")
```

- `smoke_platform` 是 `muad.skill.json` 的 `platforms` 中的平台名，必须是字面量。
- SDK 从 Runtime Guard 注入的 `MUAD_SKILL_NAME` 与当前用户会话读取登录态，不需要 Skill 自报 skill 名。
- 平台未配置、登录态缺失或过期时，SDK 抛出 `PlatformSessionError`；脚本按 fail loud 处理（stderr + 非 0）。

## 为什么不再手工调用 session-manager

- 登录态文件、cookie 拼装、CSRF 提取与 `Traceid` 生成都属于平台请求实现细节，统一收口到 SDK。
- 手工调用 `session-manager get-state --skill-name` 容易把平台名当 skill 名传入，且会绕过执行 trace。
- 需要排查登录态时，优先看 SDK 的 `PlatformSessionError` 文案与 `[muad-skill-sdk][platform]` 诊断行，不要在 Skill 里复制一份登录逻辑。

## browser 能力

声明 `capabilities: ["browser"]` 的 Skill 仍走 `session_get_state` **模型工具**（不是脚本自助），因为只有插件工具能调用 `browser.request`。不要让模型直接调 `session_get_state`；SKILL.md 顶部直接列出脚本命令（如 `python3 scripts/run.py`），引导模型跑脚本而非调工具。

## 不需要在 SKILL.md 里做的事

- 不要让模型直接调 `session_get_state` 工具——该工具需要 `skillName` 参数，模型容易传成平台名。
- 不要指导用户手工保存 cookie 或 token。
