---
name: soar-download-bridge
description: 触发深信服 SOAR 原始数据下载。通过 HTTP POST 调用 muad-automation-platform API，支持按类型过滤。
---

# 深信服数据下载桥接

## 何时使用

用户请求下载深信服数据或 Excel 报告时："下载 XX 客户 7 月数据"、"只要 XX 的事件表"。

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| company_name | ✅ | 客户名称 |
| start_date | ✅ | YYYY-MM-DD |
| end_date | ✅ | YYYY-MM-DD |
| type | ❌ | `all`(默认) `asset` `event` `alarm` `vuln` `exposed` |

## 执行方式

直接用 `fetch` 或等效 HTTP 工具 POST：

```
POST http://host.docker.internal:9000/api/v1/workflows/start
Authorization: Bearer demo-token
Content-Type: application/json

{
  "workflow_type": "soar.download_report",
  "parameters_json": "{\"company_name\":\"<客户名>\",\"start_date\":\"<YYYY-MM-DD>\",\"end_date\":\"<YYYY-MM-DD>\",\"type\":\"<all|event|...>\"}"
}
```

成功返回 `{"code":0,"data":{"workflow_id":"soar-...","status":"RUNNING"}}`。

## 部分失败

单个表下载失败不影响整体，Excel 中标注"未获取"。

## 回复用户

"已触发数据下载，workflow_id: {workflow_id}"
