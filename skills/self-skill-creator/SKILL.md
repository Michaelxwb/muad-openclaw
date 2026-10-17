---
name: self-skill-creator
description: 指导用户写一个满足 muad claw 格式的自建 Skill。用户说"帮我写一个 skill / 创建一个 skill / 怎么写 skill"时调用。产出物写到 skill-staging/<name>/ 草稿目录，等用户明确说"上传"后再走 self-skill-upload。
---

# 自建 Skill 创作

指导用户在 `skill-staging/<name>/` 草稿目录里写一个满足 muad claw 格式的 Skill。**只写草稿，不上传**——上传走 `self-skill-upload`。

自建 Skill 统一使用 **Python**：脚本放 `scripts/*.py`，入口默认 `scripts/run.py`。不要生成其它语言的脚本。

## 何时使用

- 用户说"帮我写一个 skill / 创建一个 skill / 怎么写 skill / 我想要一个能 X 的 skill"时调用。
- 用户已有一份草稿想确认格式是否合规时也调用。

**不要自动上传**：写完草稿后只提示用户"草稿已写好，确认无误后告诉我上传"，**等用户明确说"上传"再调用 `self-skill-upload`**。

## claw 格式 Skill 的硬约束

每个自建 Skill 都要先确认这几件事，缺一项都要明确补上或明确不需要：

1. **`muad.skill.json` 清单文件**：所有自建 Skill 都要有，声明 name/platforms/runtime/version 等元数据。详见 [`references/skill-manifest.md`](references/skill-manifest.md)。
2. **对接平台 → 使用 `muad_skill_http.platform_request`**：Skill 访问受保护的业务平台时，脚本里调用 `muad_skill_http.platform_request("<平台名>", "<METHOD>", "<path>")`。Cookie、CSRF、Host、平台静态头与每请求新的 `Traceid` 都由 SDK 统一构造；不要手工拼装请求头，也不要直接调用 `session-manager` 或 `requests`。详见 [`references/http-headers.md`](references/http-headers.md) 与 [`references/session-manager.md`](references/session-manager.md)。
3. **有输出文件 → 接入 SKILL_OUTPUT_DIR**：Skill 若要写文件（报告、临时结果），必须写到环境变量 `SKILL_OUTPUT_DIR` 指向的目录，**不要写 Skill 根目录（只读）或 `/tmp`（不隔离不持久）**。详见 [`references/skill-output-dir.md`](references/skill-output-dir.md)。
4. **长耗时 → 主动进度通知**：脚本预计 >10s 或分多个阶段时，建议接入 `muad-progress`，让用户在 IM 里实时看到逐节点进度。见 [`references/progress-notify.md`](references/progress-notify.md)。

## 创作流程

### Step 1：确认 skill 的形态与边界

先问用户四件事（一次问完，不要挤牙膏）：

1. **skill 名**：小写字母、数字、`-` 或 `_`，必须以字母开头。建议与平台名**显式区分**（见 [`references/naming-pitfalls.md`](references/naming-pitfalls.md)）。
2. **是否要对接业务平台**：要的话问平台名（Console 里配置的自由字符串，如 `mssw`、`smoke_platform`）；可能对接多个平台（如 health-checkup-report 同时对接 `mssw` + `mssp`），每个平台各传各的平台名给 `platform_request`。
3. **是否有输出文件**：要写报告/临时文件的话，确认文件名与格式。
4. **是否长耗时**：脚本预计 >10s 或分多个阶段时，建议接入**主动进度通知**（`muad-progress`）。

实现语言固定 Python，不需要询问。

### Step 2：建草稿目录

在 `skill-staging/<skill名>/` 下建以下结构（按需，不必全建）：

```
skill-staging/<skill名>/
├── SKILL.md              # 必需：frontmatter + 指令
├── muad.skill.json       # 必需：managed 清单
├── scripts/              # 可选：Python 脚本（需对接平台或确定性逻辑时放这里）
└── references/           # 可选：参考资料（大段文档/规范，不放 SKILL.md）
```

> `skill-staging/` 位于 agent 工作区（`~/.openclaw/workspace-<agentId>/skill-staging/`）。直接在该目录下创建文件即可，无需额外脚本。

### Step 3：写 `muad.skill.json`

最小模板（按需删字段）：

```json
{
  "name": "<skill名>",
  "platforms": ["<平台名>"],
  "runtime": "script",
  "version": "0.1.0",
  "capabilities": ["browser"],
  "longTask": false,
  "entrypoint": "scripts/run.py"
}
```

字段含义、`longTask`、`capabilities`、`entrypoint` 详见 [`references/skill-manifest.md`](references/skill-manifest.md)。**不对接平台时 `platforms` 设为 `[]` 或省略**。

### Step 4：写 `SKILL.md`

frontmatter 只写 `name` 和 `description`：

```yaml
---
name: <skill名>
description: "MANDATORY before calling <工具/场景>. Trigger on: <触发场景>。"
---
```

body 用祈使句写指令，遵循"渐进式披露"——核心流程放 SKILL.md，大段规范放 `references/`。详见 [`references/skill-md.md`](references/skill-md.md)。

### Step 5：写 Python 脚本（按需）

若 Step 1 确认要对接平台或有确定性逻辑，在 `scripts/` 下写 Python 脚本（默认入口 `scripts/run.py`）。脚本里四件事必须做对：

1. **业务请求只走 SDK**：`from muad_skill_http import platform_request`，调用 `platform_request("<平台名>", "GET", "/api/...")`。平台名按字面量写，必须与 `muad.skill.json` 的 `platforms` 一致（不是 skill 名）。不要 `import requests` 直连，不要手工拼 `Cookie`/CSRF/`Traceid` 头，不要用 `subprocess` 调 `curl`/`wget` 发业务请求。
2. **写文件路径用 `os.environ.get("SKILL_OUTPUT_DIR")`**；为空时不要写文件。
3. **失败必须写 stderr 并 exit 非 0**（fail loud），成功 stdout 只保留一个机器可读结果；错误写 stdout 会导致 exec 失败日志转发不到。
4. **进度通知 best-effort**：需要时调用 `muad-progress stage|done|error`，封装必须吞错、不传收件人。

完整最小实现见 `skills/_templates/business-skill-python/scripts/run.py`。进度封装见 [`references/progress-notify.md`](references/progress-notify.md)。

### Step 6：自检

写完草稿后，逐条对照检查：

- [ ] `muad.skill.json` 存在且 JSON 合法，`name` 与 SKILL.md frontmatter `name`、目录名一致
- [ ] `entrypoint` 若声明，指向 `scripts/run.py` 等 `.py` 文件
- [ ] 若声明了 `platforms`：脚本调用 `muad_skill_http.platform_request`，平台名与 `platforms` 一致
- [ ] 脚本没有 `import requests`/`httpx`/`urllib.request` 直连，没有手工拼 `Cookie`/CSRF/`Traceid`，没有用 `subprocess` 调 `curl`/`wget`
- [ ] 若脚本要写文件：写到 `SKILL_OUTPUT_DIR`，不是 Skill 根目录或 `/tmp`
- [ ] 失败路径写 stderr 且 exit 非 0；成功 stdout 只有一个机器可读结果
- [ ] 若接入了主动进度通知：封装 best-effort 吞错（进度失败不误报业务失败），未传 `--channel`/`peerId`/凭据，业务失败同时走 `error` 节点 + stderr + exit 非 0
- [ ] SKILL.md frontmatter 只有 `name` 和 `description` 两个字段
- [ ] `description` 写清触发场景，不含密钥/内部 URL/业务数据

任一条不满足，回到对应 Step 修。也可以运行 `self-skill-review` 做一次只读检查。

### Step 7：交付草稿，等用户上传

写完后告知用户：

> 草稿已写到 `skill-staging/<skill名>/`，自检通过。确认无误后告诉我"上传"，我会调 `self-skill-upload` 提交到控制台审批。

**不要主动上传**。上传时机由用户决定。

## 不要做的事

- **不要**直接编辑 `workspace-<agent>/skills/`（平台托管的私有 skill，只读）。
- **不要**在草稿阶段就调用 `self-skill-upload`——那是用户明确说"上传"后才走的流程。
- **不要**写 README.md / INSTALLATION_GUIDE.md / CHANGELOG.md 等辅助文档，skill 目录只放 AI 干活必需的文件。
- **不要**在 `muad.skill.json` 里写密钥、Token、内部 URL。
- **不要**生成非 Python 脚本或手工拼装平台请求头。

## 参考

- [`references/http-headers.md`](references/http-headers.md) `platform_request` 请求头约束
- [`references/session-manager.md`](references/session-manager.md) 平台登录态由 SDK 自动获取
- [`references/progress-notify.md`](references/progress-notify.md) 主动进度通知（muad-progress）接入
- `skills/_templates/business-skill-python/` Python 完整模板
- `skills/_templates/README.md` 托管 Skill 开发规则全文
- 上传流程见 `self-skill-upload` skill
