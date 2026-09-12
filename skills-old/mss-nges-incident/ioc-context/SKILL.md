---
name: ioc-context
description: "查询 IOC 的安全上下文信息（C2 情报关联）。MANDATORY to use when user asks to query IOC context, 查询IOC上下文, 上下文查询, 输入一个IOC(IP/域名/URL)获取它的关联情报、威胁上下文、C2信息。"
---

# IOC 上下文查询 Skill

输入一个 IOC（IP / 域名 / URL），返回它在深信服威胁情报平台上的上下文关联信息（C2 方向）。

## 工作流程

1. **获取 token**：
   - 请求 `https://auth.sangfor.com.cn/v1/auth`
   - 请求头：`Content-Type: application/json`
   - 请求体：
     ```json
     {
       "deviceId": "ti_file_agent",
       "apikey": "<见 scripts/run.mjs 内预置>",
       "source": "USERRPT",
       "deviceVersion": "v1.1.0"
     }
     ```
   - 从响应中提取 `token`。
   - ⚠️ 如果后续上下文查询请求因 token 失效失败（如返回未授权/401），先重新走本步获取新 token 再重试。

2. **查询 IOC 上下文**：
   - 请求 `https://analysis.sangfor.com.cn/v1/pn/context/interpret`
   - 请求头：
     - `Accept-Language: zh-CN`
     - `Content-Type: application/json`
   - 请求体：
     ```json
     {
       "token": "<上一步获取的token>",
       "source": "USERRPT",
       "deviceId": "ti_file_agent",
       "deviceVersion": "v1.1.0",
       "extend": {
         "contextType": "C2",
         "targetType": "<按IOC类型>",
         "target": "<用户输入的IOC>",
         "language": "ZH-CN"
       }
     }
     ```

3. **`targetType` 规则**（根据用户输入 IOC 的类型决定）：
   - 是 IP 地址 → `targetType: "IP"`
   - 是域名 → `targetType: "DOMAIN"`
   - 是 URL → `targetType: "URL"`

4. 将接口返回的 IOC 上下文信息整理后回复给用户。

## 执行脚本

运行 `scripts/run.mjs`，传入 IOC 作为参数：`node scripts/run.mjs "<ioc>"`。
脚本内部会自动识别 IOC 类型、获取 token 并发起查询，把结果输出到 stdout，失败时输出到 stderr 并 exit 非 0。
