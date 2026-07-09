---
name: mss-soar
description: 【骨架·待补】MSS/SOAR 平台操作能力。用户需要在 SOAR/安全运营平台上查询、执行剧本、处置告警等操作时使用本 skill。⚠️ 真实业务逻辑（接口/鉴权/步骤）需管理员补全。
---

# MSS / SOAR 操作 skill（骨架）

> 本文件是结构占位。请把原 platform-command 中 mss/soar 的实际能力填入下列各节。
> 填好后，所有用户实例只读挂载本 skill，agent 命中相关任务时自动加载。

## 何时使用

当用户的请求涉及 SOAR / 安全运营平台时（如：查询告警、执行处置剧本、拉取事件、批量操作…），使用本 skill。
〔TODO：列出触发场景关键词，越具体命中越准〕

## 前置 / 凭证

本 skill 绑定 `platform=soar`。需要访问 SOAR/MSS 时，先通过 session-manager 获取或复用
`/home/node/.openclaw/session-store/soar/cookies.json` 中的 Cookie；Cookie 不写入 skill 文件、不走
Console 凭证管理，也不从 `SOAR_TOKEN` 这类 env 读取。

当前为 mock skill：真实业务脚本补齐前，只描述“读取 Cookie -> 调 SOAR/MSS API 或浏览器操作”的流程。

## 操作步骤

〔TODO：把 mss/soar 的核心操作写成可执行步骤。优先用 scripts/ 里的脚本封装真实 API 调用，
脚本先调用 session-manager 或读取已复用的 cookie.json，再访问平台 API。SKILL.md 负责"何时调哪个脚本、
参数怎么给、结果怎么解读"。〕

长耗时操作必须通过 `muad-progress` 上报用户可见进度，避免企微/微信用户长时间无反馈。建议阶段：

1. `accepted`：已收到请求，开始处理
2. `auth`：正在检查 SOAR/MSS 登录态
3. `query`：正在查询 SOAR/MSS 数据
4. `analysis`：正在分析结果
5. `done` / `error`：处理完成或返回用户可理解错误

进度文案不得包含 Cookie、token、内部 URL、SQL、堆栈或原始 SDK 错误。

示例结构（占位）：
1. 查询类：`scripts/soar_query.<sh|py|mjs> <type> <args>` → 返回 JSON
2. 处置类：`scripts/soar_action.<...> <playbook> <target>` → 需二次确认的标注清楚

## 浏览器 / 反爬

涉及网页操作时，用 openclaw 的 browser 工具（镜像已配好本地 Chromium，`browser.mode=off` 本地启动）；
不要让 agent 自己写裸 playwright 脚本（无指纹会被反爬拦）。

## 边界

〔TODO：哪些操作禁止/需确认（不可逆/批量/生产处置），哪些只读安全。〕

---

<!-- scripts/ 放真实调用脚本；本 skill 仅当 scripts 填好后才有实际能力 -->
