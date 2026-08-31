# `muad.skill.json` 清单文件

每个自建 Skill 必须有 `muad.skill.json`，声明 name/platforms/runtime/version 等元数据。Console 上传时按本文件校验。

## 最小模板

```json
{
  "name": "<skill名>",
  "platforms": ["<平台名>"],
  "runtime": "script",
  "version": "0.1.0"
}
```

不对接业务平台时 `platforms` 设为 `[]` 或省略该字段。

## 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | skill 名，必须与 SKILL.md frontmatter 的 `name` 一致，必须与目录名一致 |
| `platforms` | ❌ | 平台名数组（Console 里配置的自由字符串，如 `mssw`、`smoke_platform`）。声明后，`session-manager get-state --skill-name <skill>` 一次返回该 Skill 声明的全部平台凭证；任一平台未配置时调用失败（不做部分降级） |
| `runtime` | ✅ | 固定 `script`（当前只支持脚本类 Skill） |
| `version` | ✅ | 语义化版本号，如 `0.1.0` |
| `capabilities` | ❌ | 能力声明数组。需要浏览器能力时填 `["browser"]`。**注意：声明 `browser` 的 Skill 仍走 `session_get_state` 模型工具（因为只有插件工具能调用 `browser.request`），不是脚本自助** |
| `longTask` | ❌ | `true` = 后台任务：installer 自动生成提交桩，运行时自动处理后台执行/递归防护/状态机。把普通 Skill 改成长任务只需加这一行，其余不用改。缺省 `false` |
| `entrypoint` | ❌ | 显式声明主入口脚本；脚本放 `scripts/` 会被自动扫描，调用方式由 `SKILL.md` 描述，不依赖 `entrypoint` |

## 命名要求

- `name`：小写字母、数字、`-` 或 `_`，必须以字母开头，长度 ≤ 63
- `name` 必须与目录名、SKILL.md frontmatter `name` 三者一致
- **`name`（skill 名）≠ `platforms`（平台名）**，两者不要长得像，详见 [`naming-pitfalls.md`](naming-pitfalls.md)

## 禁止写入的字段

- 密钥、Token、密码
- 内部 URL
- 业务数据
- SQL

## 上传校验

Console 上传时对 `muad.skill.json` 做以下校验（任一失败返回"上传失败：<原因>"，原样转述给用户）：

- 文件存在且 JSON 合法
- `name` 合法且与 SKILL.md frontmatter `name` 一致
- 声明的非空 `platforms` 都已在 Console 配置存在
- `runtime` 取值合法
