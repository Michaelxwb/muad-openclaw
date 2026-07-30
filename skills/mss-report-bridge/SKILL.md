---
name: mss-report-bridge
description: 触发 MSS 海外客户周报/月报导出。通过 session-manager 获取当前用户平台会话后调用业务平台 API，返回 workflow_id 供追踪。
---

# MSS 报告导出桥接

## 何时使用

用户请求导出 MSS 周报或月报时："导出 XX 本周周报"、"生成 XX 月报"。

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| company_name | ✅ | 客户名称 |
| report_type | ✅ | `weekly` 或 `monthly` |

## 执行方式

先获取当前用户的业务平台会话：

```bash
session-manager get-state --skill-name mss-report-bridge
```

再用返回的非敏感 session state/path/handle 调用管理员配置的平台 API。请求体示例：

```json
{
  "workflow_type": "mss.weekly_report",
  "parameters_json": "{\"company_name\":\"<客户名>\",\"report_type\":\"<weekly|monthly>\"}"
}
```

成功返回 `{"code":0,"data":{"workflow_id":"mss-...","status":"RUNNING"}}`。

## 回复用户

"已触发 {report_type} 报告导出，workflow_id: {workflow_id}"
