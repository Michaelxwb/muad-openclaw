---
name: mss-report-bridge
description: 触发 MSS 海外客户周报/月报导出。通过 HTTP POST 调用 muad-automation-platform API，返回 workflow_id 供追踪。
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

直接用 `fetch` 或等效 HTTP 工具 POST 以下 JSON：

```
POST http://host.docker.internal:9000/api/v1/workflows/start
Authorization: Bearer demo-token
Content-Type: application/json

{
  "workflow_type": "mss.weekly_report",
  "parameters_json": "{\"company_name\":\"<客户名>\",\"report_type\":\"<weekly|monthly>\"}"
}
```

成功返回 `{"code":0,"data":{"workflow_id":"mss-...","status":"RUNNING"}}`。

## 回复用户

"已触发 {report_type} 报告导出，workflow_id: {workflow_id}"
