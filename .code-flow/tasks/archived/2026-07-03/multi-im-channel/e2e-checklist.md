# 多 IM 通道 — 手动端到端验收清单

> TASK-011 的最后一项「手动端到端验证」无法自动化，需人工在 dev 环境跑一遍。
> 验收人：______  日期：______

## 前置

- [ ] dev 后端跑在 :8080（`cd console/backend && go run ./cmd/console`）
- [ ] dev 前端跑在 :5173（`cd console/frontend && npm run dev`）
- [ ] 浏览器登录 admin
- [ ] 至少有一个 running 的容器（`kubectl get pods -n muad`）

## 创建（多通道同时启用）

- [ ] 创建容器时勾选「企业微信 + 微信」，填企微 botId/secret
- [ ] 提交后容器应起来（`kubectl get pods -n muad` 显示 Running）
- [ ] 容器列表的「消息通道」列显示两个 Tag，一个 🟢（连上）/ 🔴（未连）
- [ ] 进入容器，pod 内 `/home/node/.openclaw/openclaw.json` 含两个 channel 配置

## 编辑（追加 / 删减 / 凭证更新）

- [ ] 点「编辑通道」打开 EditChannelModal
- [ ] Modal 加载后回填已有 botId（明文），secret 显示「已配置」占位
- [ ] 修改 botId，secret 留空 → 提交，pod 内 openclaw.json 应保留旧 secret
- [ ] 修改 botId + secret → 提交，pod 内 openclaw.json 应有新 secret
- [ ] 取消勾选一个通道 → 二次确认弹窗 → 确认后容器内 openclaw.json 移除该通道

## 热更新无重启验证

- [ ] 编辑保存后，**pod 不重启**（`kubectl get pods -n muad` 的 RESTARTS 列不变）
- [ ] 容器内 `/home/node/.openclaw/openclaw.json` mtime 在 5s 内更新
- [ ] `openclaw channels status --json` 输出与新配置一致

## 多通道筛选

- [ ] 顶部工具栏「通道」筛选器是 multi-select（可勾选多个值）
- [ ] 勾选「微信」时，列表只显示包含微信的容器
- [ ] 同时勾选「企业微信」「微信」时，显示包含任一通道的容器
- [ ] 清空筛选时显示全部

## 批量操作

- [ ] 表头 checkbox 全选 / 全不选 / 半选三态正确
- [ ] 勾选至少 1 个时，「重载 Skill」「批量升级」「批量删除」按钮亮起
- [ ] 「批量删除」弹出二次确认框，列明受影响 userId
- [ ] 确认后批量删除成功（list 不再包含）

## 行内操作

- [ ] 每行 5 个按钮：日志 / 扫码 / 编辑通道 / 资源 / 更多▾
- [ ] 非微信容器不显示「扫码」按钮
- [ ] 「更多▾」下拉含 启动/停止/重启/回收/唤醒 5 项

## 异常路径

- [ ] 创建时 secret 留空 → 400 报错「secret 必填」
- [ ] 编辑时传入未知 channel → 400 报错
- [ ] 容器不存在时 GET/PUT → 404
- [ ] Pod exec 失败时 PUT 不写 DB（编辑后刷新页面，状态保持原样）

---

## 验收结论

- [ ] 全部通过 → 验收签字
- [ ] 有 fail → 列在下面，关联 issue

未通过项：

```
- [场景]：[复现步骤]：[实际行为]：[期望行为]
```