---
name: skill-upload
description: 将用户写在 skill-staging/<name>/ 草稿目录中的自建 Skill 上传到控制台，使其成为平台托管的私有 Skill 并正式可调用。上传前 skill 不会对 agent 生效。
---

# Skill 上传

## 何时使用

**用户明确要求上传 / 提交 / 生效一个 skill 时调用**，包括：用户表示"上传我的 skill / 把写的 skill 生效 / 提交我写的技能"。

**不要自动上传**：用户说"写/创建/帮我写一个 skill"时，只把草稿写到 `skill-staging/<name>/` 并提示可修改；**等用户明确说"上传"后再调用本 skill**。上传时机由用户决定。

> 修改/更新已上传 skill 的约束见 AGENTS.md「用户自建 Skill」：走本 skill 的重传流程；若返回 `skill already exists`，告知用户联系管理员删除旧 skill 后重传，不要直接编辑 `workspace/skills/`。

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| skill_name | ✅ | staging 目录中的 skill 名（`skill-staging/<name>/SKILL.md` 存在） |

## 执行方式

1. 确认 staging 目录存在 `skill-staging/<skill_name>/SKILL.md`；不存在则告知用户先写好。
2. 调用上传脚本（**用 `bash` 工具执行，不要用 `shell`**——openclaw 没有 `shell` 工具，用 `shell` 会报 Exec failed）：

```bash
bash -c 'node /opt/openclaw-skills/skill-upload/scripts/upload-skill.mjs "<skill_name>"'
```

3. 脚本会：预检 → 打包 tar.gz → 上传到控制台 ingest 端点。
4. 输出"上传成功，已清理草稿目录"即完成；**成功后脚本会删除 `skill-staging/<skill_name>/` 草稿**，避免新会话误判为"还没上传"。输出"上传失败：<原因>"时，**原样转述原因**给用户（如缺 SKILL.md、skill 名不合法、控制台校验失败、skill 已存在等），不要自行改写或吞掉。

## 注意

- **不要**直接编辑 `workspace-<agent>/skills/`（平台托管的私有 skill，只读）。
- 上传后 skill 成为平台私有 skill，随 Pod 持久，草稿目录自动清理。
- 若用户要**修改已上传**的 skill：当前同名 skill 已存在时重传会被控制台拒绝（"skill already exists"），需先告知用户在控制台删除旧 skill 后再上传，或走控制台编辑。
- 若用户要删除已上传的 skill，走控制台删除，不要直接删文件。
