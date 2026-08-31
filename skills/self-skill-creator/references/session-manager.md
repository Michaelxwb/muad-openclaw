# session-manager 对接

Skill 要访问受保护的业务平台（需登录态）时，脚本里调 `session-manager` 取当前用户登录态。

## 脚本自助模式

`scripts/` 里的脚本直接调用 `session-manager` CLI，**不依赖 env 注入**：

```bash
session-manager get-state --skill-name <skill名>
```

- agent 身份由 Runtime Guard 注入的 `MUAD_SESSION_KEY` 决定，脚本不自报身份
- CLI 保证状态新鲜（缓存过期/缺失时自动登录并落盘）
- 返回按 Skill 裁剪的 `sessionStateFile`，脚本再读该文件取当前 Skill 声明的 `<platform>` section 拿 cookies 使用
- 文件只含当前 Skill 声明的平台，cookie 不进入 CLI stdout、不进入模型上下文

## 三种语言最小用法

### TypeScript

```js
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const skillName = "<skill名>";  // 硬编码，不要从参数或模型动态取

const { stdout } = await execFileAsync(
  "session-manager",
  ["get-state", "--skill-name", skillName],
  { timeout: 30000 },
);
const state = JSON.parse(stdout);
// state.sessionStateFile 指向按 Skill 裁剪的会话状态文件，读对应 <platform> section 拿 cookies
```

### Python

```python
import json
import subprocess

SKILL_NAME = "<skill名>"  # 硬编码

result = subprocess.run(
    ["session-manager", "get-state", "--skill-name", SKILL_NAME],
    check=True,
    capture_output=True,
    text=True,
    timeout=30,
)
state = json.loads(result.stdout)
# state["sessionStateFile"] 指向按 Skill 裁剪的会话状态文件
```

### Shell

```bash
session-manager get-state --skill-name "<skill名>" >"$(mktemp)"
```

## 返回的数据结构 & cookie 提取

`get-state` CLI 输出一个 JSON，其中 `sessionStateFile` 指向按 Skill 裁剪的会话状态文件（文件里只含本 Skill 声明的平台）。登录态文件的 cookies 结构：

```js
// sessionStateFile 的内容（示意）
{
  "platforms": {
    "mssw": { "cookies": [{ "name": "x-csrf-token", "value": "..." }, ...] },
    "mssp": { "cookies": [{ "name": "csrf_token", "value": "..." }, ...] }
  }
}
```

脚本从这个文件里**按平台取 cookie 数组拼 cookie 串**（`name=value; name2=value2`），随后按 [`http-headers.md`](http-headers.md) 的规则从中提取 CSRF token 组装请求头。

```js
// Node：从 session 文件取某平台 cookie 串
const section = session.platforms?.[platform];
const cookieStr = (section?.cookies || [])
  .filter(c => c?.name && c?.value)
  .map(c => `${c.name}=${c.value}`)
  .join('; ');
```

**cookie / CSRF token 只用于请求头，绝不写进 stdout / 日志 / 错误信息。**

## 关键约束

### skill 名硬编码

### 失败 fail loud

脚本失败必须写 **stderr** 并 **exit 非 0**。错误写 stdout 会导致 exec 失败日志转发不到，排查链路断掉。

### browser 能力走模型工具

声明 `capabilities: ["browser"]` 的 Skill 仍走 `session_get_state` **模型工具**（不是脚本自助），因为只有插件工具能调用 `browser.request`。脚本自助只用于不需要 browser 的场景。

## 不需要在 SKILL.md 里做的事

- 不要让模型直接调 `session_get_state` 工具——该工具需要 `skillName` 参数，模型容易传成平台名。SKILL.md 顶部用「快速调用速查」直接列出脚本命令（如 `node scripts/run.mjs`），引导模型跑脚本而非调工具。
