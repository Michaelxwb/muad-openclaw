# skills/

共享 skill 库（设计 FEAT-03 / 自研⑤）。管理员维护，所有用户实例**只读**挂载、热更新。

## 加载方式

- **本地/Docker**：把本目录只读挂进容器（compose 加 `- ./skills:/opt/openclaw-skills:ro`），并让 openclaw 从该路径加载（`OPENCLAW_BUNDLED_SKILLS_DIR=/opt/openclaw-skills` 或 skills 配置）。
- **k8s**：建一个 RWX(NFS/CephFS) PVC `muad-skills`，每用户 Pod RO 挂载（见 `k8s/user.template.yaml` 的 TODO-FEAT-03）。
- **热更新**：原子发布新版本（写新目录 + symlink 切换）；openclaw 短命会话/下一 turn 取最新，不打断在用用户。

> skill 兼容 [agentskills.io](https://agentskills.io) 开放标准，可在 openclaw / hermes 间迁移。

## 目录约定

```
skills/
  <skill-name>/
    SKILL.md          # 必需：frontmatter(name/description) + 指令正文
    scripts/          # 可选：skill 调用的脚本/工具
```

## ⚠️ mss-soar 是骨架

`mss-soar/SKILL.md` 只是结构占位。**真正的 soar 业务逻辑（接口、鉴权、操作步骤）需要你补**——
把原 platform-command 里 mss/soar 那套能力按下面模板填进 SKILL.md（指令）+ scripts/（实际调用）。
