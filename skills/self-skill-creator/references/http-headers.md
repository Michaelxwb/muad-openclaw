# 对接平台的请求头：统一使用 SDK

自建 Skill 访问受保护业务平台时，**不得手工拼装请求头**。所有平台请求必须经 `muad_skill_http.platform_request`：

```python
from muad_skill_http import platform_request

response = platform_request("mssw", "GET", "/api/v1/targets")
```

## SDK 负责什么

`platform_request` 从 session-manager 的登录态与平台 request profile 中构造请求头，顺序固定：

1. 浏览器默认头（Accept / Accept-Language / Content-Type / User-Agent / X-Requested-With / Referer）。
2. 平台 `hostHeader`（nginx 按 Host 路由）。
3. 平台 `staticHeaders`（平台级固定头，如 timezone）。
4. Skill 传入的 `headers` / `extra_headers`（**不得覆盖敏感头**）。
5. `Cookie`：由登录态 cookies 拼装。
6. CSRF：按 profile 的 `csrf` 映射从 cookie 提取到对应 header。
7. `Traceid`：每个请求生成新的 UUID v4。
8. 最后重写一次 Cookie / CSRF / Traceid，确保前面传入的头无法覆盖。

因此 Skill 代码里**不需要也不允许**出现：

- 手工读取登录态文件拼 cookie；
- 手工从 cookie 提取 CSRF 并写 header；
- 硬编码 `Host`、`Traceid`、平台固定 token；
- `Source` 请求头（平台会校验失败）。

## 平台差异放哪里

平台之间的 Host、referer、CSRF cookie 名、静态头差异由 session-manager 输出的 `requestProfile` 描述，属于平台配置，不写进 Skill 代码。Skill 只传平台名和业务 path。

## extra_headers 逃生口

个别接口需要额外非敏感头时：

```python
response = platform_request(
    "mssp",
    "POST",
    "/api/v1/query",
    json={"keyword": "demo"},
    extra_headers={"X-Biz-Tag": "weekly-report"},
)
```

约束：

- 只放业务自定义头，不放 Cookie、CSRF、Host、Traceid、Authorization 等敏感头。
- 不要放凭据或内部 URL。
- 平台 `extraAllowed: false` 时 SDK 会忽略这些头。

## 不要做的事

- **不要**手工拼装 Cookie/CSRF/Traceid，也不要复制平台前端的请求头代码。
- **不要**用 `requests`、`httpx`、`urllib.request` 直连业务接口。
- **不要**用 `subprocess` 调 `curl`/`wget` 发业务请求——既不计入执行 trace，也不受请求上限约束。
- **不要**把 cookie / CSRF token 写进 stdout、日志或错误信息。
