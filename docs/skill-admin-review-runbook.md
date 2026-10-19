# 管理员 review 用户 Skill Runbook

> 适用：管理员需要人工复核用户提交的 Private Skill 代码，再决定审批/驳回。
> 流程只复用既有下载、私有上传、删除端点，不修改原用户的 Skill 或工作区。

## 前置条件

- 管理员已登录 Console，持有 `Authorization: Bearer $TOKEN`。
- 管理员本人有一个状态正常、已绑定 Pod 的 Human User（`ADMIN_HUMAN_USER_ID`），
  用于临时安装待审 Skill。
- 待审 Skill 已由用户上传，状态为 `pending`，且 assets 源目录仍存在
  （下载端点直接打包 `skill_assets.source_path`）。
- 目标 Pod 的 Worker 镜像包含 `/opt/muad/private-skill-installer.mjs`，且
  reconcile/apply 链路可用（私有 Skill 安装走该链路，不在上传请求内同步）。

## 步骤

1. **定位待审 Skill**

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" \
     "$CONSOLE_URL/api/v1/skills?scope=private&status=pending"
   ```

   记录返回的 `skillId`、`name`、`humanUserId`，并确认 `humanUserId` 不是管理员本人。

2. **下载待审 bundle**

   ```bash
   curl -sS -H "Authorization: Bearer $TOKEN" \
     -o "$WORKDIR/${SKILL_NAME}.tar.gz" \
     "$CONSOLE_URL/api/v1/skills/$SKILL_ID/download"
   ```

   响应为 `.tar.gz` 原文件（`Content-Disposition: attachment`），不是 JSON 信封。

3. **临时安装到管理员自己的 Human User（Private）**

   ```bash
   curl -sS -H "Authorization: Bearer $TOKEN" \
     -F "expectedName=$SKILL_NAME" \
     -F "bundle=@$WORKDIR/${SKILL_NAME}.tar.gz" \
     "$CONSOLE_URL/api/v1/human-users/$ADMIN_HUMAN_USER_ID/skills/private"
   ```

   成功返回 `201`，响应 `data.skill` 中的 `skillId` 是本次临时副本 ID。
   同名校验沿用既有策略：管理员已有同名 Private Skill 时返回 `409`；
   与 Public Skill 同名默认 `409`，只有显式 `allowOverride=true` 才允许覆盖；
   System Skill 永远不可被覆盖（`400`）。
   若确实需要覆盖同名 Public Skill，追加表单字段 `-F "allowOverride=true"`。

4. **等待同步并确认管理员 Agent 可读**

   上传只标记 Pod pending 并入队 reconcile；apply 完成后：

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" \
     "$CONSOLE_URL/api/v1/human-users/$ADMIN_HUMAN_USER_ID/skills"
   ```

   确认目标 Skill 的 `effectiveSource` 为 `private`，并检查 Worker 内
   `/home/node/.openclaw/workspace-<admin-agent>/skills/$SKILL_NAME`。

5. **复核代码**

   在临时副本上执行 `self-skill-review` 或人工阅读；不要直接执行待审脚本。
   复核范围与结论记录到审批备注，随后回到原 Skill 执行 approve/reject。

6. **清理临时副本**

   ```bash
   curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" \
     "$CONSOLE_URL/api/v1/human-users/$ADMIN_HUMAN_USER_ID/skills/private/$TEMP_SKILL_ID"
   ```

   返回 `200` 后确认：
   - `_private/$ADMIN_HUMAN_USER_ID/$SKILL_NAME` 本机暂存目录已删除；
   - 管理员 Agent 的 `workspace-<agent>/skills/$SKILL_NAME` 经 reconcile 删除；
   - 原用户同名 Skill 仍为原状态，源目录与 `skill_assets` 记录未被修改。

## 反向检查

- 删除临时副本只能使用管理员自己的 `humanUserId`；用原用户的
  `humanUserId` 删除管理员副本会返回 `404`。
- 原用户的待审 Skill 在管理员复核期间保持 `pending`，不会被安装到任何
  Agent 工作区；管理员 Agent 的安装/删除调用不应出现在原用户 Agent 上。
- 删除临时副本不会级联删除原用户资产，也不会改变原用户的有效 Skill 视图。

## 备注

- 该流程不新增生产端点；行为验证见
  `console/backend/test/admin_skill_review_test.go`（`TestAdminSkillReviewFlow_S07`）。
- 全流程使用管理员自己的 Human User，避免跨用户复用工作区/浏览器 Profile。
