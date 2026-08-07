# 前端 i18n 迁移规范（子代理执行）

目标：把 `console/frontend/src` 下的硬编码中文字符串改为 i18next。本文档约束所有迁移文件的做法，保证一致性。

## 规则总览

1. **不改 `src/i18n/locales/zh.ts` / `en.ts`**。新增文案 key 写入你负责的 **manifest JSON**（见下）。
2. **不改其他组负责的文件、不改 test 文件、不改 `src/api.ts` / `src/i18n/*` / `src/utils/error.tsx` / `src/main.tsx`**（这些已完成或属于其他组）。
3. 语言切换由 `LanguageProvider` 全局管理，迁移中不新增任何语言状态代码。
4. 缩进 2 空格，匹配现有代码风格，不跑 lint/prettier/test。
5. 每处文案必须 `t(...)` 或 `i18n.t(...)`，不得残留硬编码中文（注释里的中文保留）。

## 可用基础设施

- `useTranslation` from `react-i18next`：组件内 `const { t } = useTranslation();`
- `i18n` default export from `../i18n`（或相对路径）：纯函数/模块/常量用 `i18n.t(...)`。
- `errorMessage(error, fallbackKey)` from `../utils/error`：catch 错误统一文案。`errorMessage` 优先返回后端本地化 message（`ApiError.message`），否则 `i18n.t(fallbackKey)`。
- `ErrorDetail` from `../utils/error`：`{ detail?: string }`，detail 存在时渲染 `<details>` 折叠技术详情。
  - Banner / 内联错误展示：`<ErrorDetail detail={caught instanceof ApiError ? caught.detail : undefined} />`
  - Toast（瞬态 `FeedbackBanner` 等）：只显示 message，不挂 ErrorDetail。
- `useLanguage` from `../i18n/LanguageProvider`：不要在迁移中新增使用（语言切换器已全局提供）。

## key 命名约定

- 点分命名空间：`<域>.<动作/名词>.<修饰>`，camelCase，例如 `pod.createTitle`、`skill.applyResult`、`user.statusFilter`。
- **优先复用已有共享 key**（见下方「共享 key 目录」），语义一致绝不新建重复 key。
- 插值用 i18next `{{name}}` 语法：`t("pod.deleteConfirm", { name })`，locale 值写 `"确认删除 {{name}}？"`。
- 数字/复数：`{{count}}`，locale 值可写 `"{{count}} 个 Pod"`。

## manifest 输出

把本组**新增**的 key 写到一个 JSON 文件：

```
docs/i18n/manifests/<group>.json
```

格式（key 用点分扁平，值含 zh/en）：

```json
{
  "pod.createTitle": { "zh": "创建 Pod", "en": "Create Pod" },
  "pod.deleteConfirm": { "zh": "确认删除 {{name}}？", "en": "Delete {{name}}?" }
}
```

- 每个 key 必须同时给 zh 和 en。
- 只列出**本组文件新增**的 key，共享 key 不重复列出。
- 若文件里两处文案完全相同，只建一个 key。

## 共享 key 目录（优先复用，不再新建）

```
common.save 保存/Save, common.saving 保存中…/Saving…, common.cancel 取消/Cancel,
common.confirm 确认/Confirm, common.delete 删除/Delete, common.close 关闭/Close,
common.retry 重试/Retry, common.edit 编辑/Edit, common.create 新建/Create,
common.search 搜索/Search, common.refresh 刷新/Refresh, common.loading 加载中…/Loading…,
common.empty 暂无数据/No data, common.all 全部/All, common.yes 是/Yes, common.no 否/No,
common.unknown 未知/Unknown, common.back 返回/Back, common.copy 复制/Copy,
common.copied 已复制/Copied, common.expand 展开/Expand, common.collapse 收起/Collapse,
common.viewDetail 查看详情/View details, common.confirmDelete 确认删除/Confirm delete,
common.actions 操作/Actions, common.status 状态/Status, common.name 名称/Name,
common.createdAt 创建时间/Created at, common.updatedAt 更新时间/Updated at,
common.ok 确定/OK, common.success 操作成功/Success, common.failed 操作失败/Failed,

nav.pods Pod 管理/Pods, nav.users 用户管理/Users, nav.skills Skill 管理/Skills,
nav.llm 模型配置/Models, nav.settings 系统配置/Settings, nav.audit 审计日志/Audit Log,
nav.console 控制台/Console, nav.logout 退出登录/Log out, nav.loadFailed 加载失败/Failed to load,

errors.default 操作失败，请稍后重试/Something went wrong, please try again later,
errors.network 网络异常，请检查连接后重试/Network error, please check your connection and retry,
errors.invalidResponse 服务端响应格式无效/Invalid server response,
errors.invalidJson 服务端返回了无效数据/The server returned invalid data,
errors.unauthorized 登录已失效，请重新登录/Your session has expired, please log in again,
errors.badCredentials 用户名或密码错误/Incorrect username or password,
errors.requestFailed 请求失败，请稍后重试/Request failed, please try again later,
errors.technicalDetail 技术详情/Technical details,

status.creating 创建中/Creating, status.running 运行中/Running, status.stopped 已停止/Stopped,
status.unhealthy 异常/Unhealthy, status.error 错误/Error, status.deleting 删除中/Deleting,
status.active 启用/Active, status.pending 待激活/Pending, status.disabled 停用/Disabled,
status.revoked 已撤销/Revoked, status.used 已使用/Used, status.expired 已过期/Expired,
status.private 私有/Private, status.public 公开/Public, status.synced 已同步/Synced,
status.pendingApply 待应用/Pending apply, status.succeeded 成功/Succeeded, status.failed 失败/Failed,
status.queued 排队中/Queued, status.inProgress 执行中/In progress,

channel.wecom 企业微信/WeCom, channel.wechat 个人微信/WeChat
```

## 常见迁移模式

**JSX 内联文本**：
```tsx
// before
<span>{pod.displayName || "未命名"}</span>
// after
<span>{pod.displayName || t("common.unknown")}</span>
```

**模块级配置数组/列工厂**（结构重构）：`SCOPE_OPTIONS`/`STATUS_OPTIONS`/`skillColumns`/`platformColumns` 等含 `label` 的模块级数组，移入组件内 `const options = useMemo(() => [...], [t])`，或工厂函数加 `t` 参数；`color`/`value` 保留代码里，`label` 走 `t(...)`。

**纯函数/模块（无 hook）**：直接 `i18n.t(...)`：
```ts
// model.ts / channels.ts / createPodModel.ts / memLimit.ts 等
import i18n from "../../i18n";  // 按相对路径
export const CHANNEL_DEFS = [ ... { label: () => i18n.t("channel.wecom") } ... ];
```

**错误处理 catch 收敛**：
```tsx
// before
setError(caught instanceof Error ? caught.message : "删除失败");
// after
setError(errorMessage(caught, "pod.deleteFailed"));
```
`ErrorDetail` 只在 Banner/内联错误展示处挂，Toast 不挂。

**动态状态标题**（如 `PodUpgradeDialog` 升级中标题、`PodDetailTabs` 动态 tab）：按状态拆独立 key。

**okText/cancelText/placeholder/title/aria-label/Tooltip content/empty**：全部 `t(...)`。

## 自检

迁移完读一遍你的每个文件：所有用户可见字符串都应来自 `t()`/`i18n.t()`，且 manifest 里给出了对应 key 的 zh/en。
