# 主动进度通知（muad-progress）

Skill 脚本运行较久（约 >10s）或有多个关键节点时，可在节点处调 `muad-progress` CLI，让用户在企微/Mattermost 里**实时收到进度消息**，而不是等脚本跑完才看到最终回复。

## 何时接入

| 场景 | 建议 |
|------|------|
| 脚本 <10s、单步 | 不接，最终回复足够 |
| 脚本 >10s（外部平台查询、大文件生成、多阶段导出） | 接入，按阶段上报 |
| 长任务（`longTask: true`） | 接入，Runtime 会自动关联投递路由 |

## 最小用法

CLI 只有三个命令，节点数自己定（粗粒度，一般 2–4 个）：

```bash
muad-progress stage --stage query  --text "正在查询客户数据"
muad-progress done  --stage query  --text "已获取 128 条有效记录"
muad-progress error --stage query  --text "查询失败，请稍后重试" --code query_failed
```

- `--stage` 是节点 id（小写字母开头，`[a-z][a-z0-9_-]`，≤64 字符）；同一节点 `stage` → `done`/`error` 配对。
- `--text` 是用户直接看到的文案；换行、Emoji、Markdown 按文本原样渲染。
- 成功时 stdout 静默，不污染业务输出。

## 三种语言封装（务必吞错，best-effort）

进度失败**绝不能把成功的业务误报为失败**：

### Shell

```bash
progress() {
  if ! muad-progress "$@" >/dev/null 2>&1; then
    printf '[<skill名>] progress unavailable\n' >&2
  fi
}
progress stage --stage query --text "正在查询"
```

### Python

```python
import subprocess

def report_progress(command, text, stage="execute", code=None):
    args = ["muad-progress", command, "--stage", stage, "--text", text]
    if code:
        args.extend(["--code", code])
    try:
        subprocess.run(args, check=False, capture_output=True)
    except OSError:
        pass  # best-effort：进度不可用不影响业务结果
```

### TypeScript

```js
import { spawn } from "node:child_process";

function progress(command, stage, text) {
  const child = spawn("muad-progress", [command, "--stage", stage, "--text", text],
    { stdio: "ignore" });
  child.on("error", () => {}); // best-effort
}
```

现成完整实现直接抄：`skills/_templates/business-skill-{shell,python,ts}/scripts/run.*`。

## 关键约束

- **不传收件人**：禁止传 `--channel`、`peerId` 或任何凭据——Runtime Guard 从当前可信会话决定投递目标（自动适配企微/Mattermost）。
- **失败按 best-effort 吞掉**：`muad-progress` 非零退出（如无事件桥时）只记 stderr 日志，业务自身的成功/失败以脚本自身结果为准。
- **业务失败走 error 节点 + exit 非 0**：`error` 是给用户看的节点文案，真正的失败信号仍是脚本 stderr + 非零退出码。
- **`done` 只写结果摘要**：不要把完整报告塞进 `--text`（≤1000 字符）；完整结果仍走 OpenClaw 原生最终回复，恰好发送一次。
- **不要自动心跳**：Runtime 不自动补进度、不去重；节点由 Skill 自己在关键步骤显式上报。

## 与最终回复的关系

进度消息是**过程性**的（⏳/✅/❌ 逐节点推送到 IM）；最终结果仍由 Agent 的原生 final reply 发送。两者独立，进度失败不影响最终回复。

## 验证

接入后用 `skills/progress-notify-smoke/` 的方式自测：在 IM 会话里触发 skill，确认进度消息按节点顺序到达。排查链路看 openclaw 日志里 `[muad-runtime-guard][skill-progress]` 前缀的行（`enqueue`/`deliver` 会给出每条消息的投递结果与失败原因）。
