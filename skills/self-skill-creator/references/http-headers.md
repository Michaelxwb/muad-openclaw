# 对接平台的请求头组装

Skill 脚本请求业务平台 API 时，请求头必须按平台规则正确组装。以下以线上 `health-checkup-report` skill（同时对接 `mssw` + `mssp`）的**实际实现**为准整理。

## 核心原则

1. **Cookie 从 session-manager 拿，CSRF token 从 cookie 串里按平台规则提取**。session-manager 返回的登录态文件里只有 cookies，**没有**现成的 CSRF 头值——必须从 cookie 串里找对应 cookie 再塞进 header。
2. **`host` / `Host` 用统一 Host 头**（`inner.sangfor.com.cn`），nginx 靠 Host 路由，连接走 origin 的 `http://` + 端口。
3. **不要带 `Source` 请求头**——请求头里出现 `Source` 会触发平台校验失败。
4. **平台 origin / host / referer_path / endpoint 集中管理**（`config/api_config.json`），支持 env 覆盖，不散落在业务代码。

不同平台**声明的平台无关**：同一 skill 里多平台共用一套 cookie 提取逻辑，但具体塞哪些头、从哪个 cookie 取 CSRF，由**目标平台**决定。

## 通用浏览器头（两平台都带的基底）

```python
{
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  "Content-Type": "application/json",
  "Host": "<统一 Host 头，如 inner.sangfor.com.cn>",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "X-Requested-With": "XMLHttpRequest",
  "Referer": "<平台 origin>/index.html",
  "Cookie": "<从 session-manager 取的 cookie 串>"
}
```

> mssw 的 Node 侧（`buildMsswHeaders`）还会带 `sec-ch-ua` / `sec-ch-ua-mobile` / `sec-ch-ua-platform` / `sec-fetch-dest` / `sec-fetch-mode` / `sec-fetch-site` 等浏览器安全头。这组是 mssw 的前端浏览器发请求会带的头，mssp 的 Python 脚本没带——**照抄目标平台的 src 即可，不必刻意加或删**。

## 按平台额外组装（实际实现）

### mssw（XDR/MSSW 平台）

Node 侧 `buildMsswExportHeaders`（`src/mssw_client.js`）：

```js
const csrfToken = cookieInfo.cookies['csrf_token'];   // 从 cookiek 里取 csrf_token
return buildMsswHeaders(cookieInfo.cookieString, msswBaseUrl, {
  'x-mssw-company-id': String(companyId || ''),        // 多租户：公司 ID
  'x-csrf-token': csrfToken,                            // 头名小写 x-csrf-token
});
```

Python 侧 `mssw_asset_paged_export.py` `build_headers` 同样：从 cookie `csrf_token` 提取 → 头 `x-csrf-token`，另加 `x-mssw-company-id`。

部分 mssw 接口（日志检索，`buildMsswLogSearchCountHeaders`）用的是**小写 `x-csrftoken`** 且 `Referer` 指向 `/ui-analyze/index.html`：

```js
'x-csrftoken': csrfToken,   // 小写，仅日志检索类接口
```

> **结论**：mssw 主链路 cookie 名用 `csrf_token` 提取，目标头名是 `x-csrf-token`；个别接口用 `x-csrftoken`（小写）。以你要对接的具体 endpooint 的现成实现为准。

### mssp（SOAR/EASM 平台）

Python 侧 `weak_report.py` / `vuln_report.py` / `exposuer_report.py`。mssp 三类脚本在通用浏览器头之外：

#### weak_report.py / vuln_report.py 的 `request_with_retry`（mssw+mssp 共用一套）

```python
if cookie_str:                                   # 有 cookie 就无条件提取（不分 mssw/mssp）
    headers["Cookie"] = cookie_str
    csrf_token = extract_cookie_value(cookie_str, "csrf_token")      # → X-Csrftoken
    if csrf_token: headers["X-Csrftoken"] = csrf_token
    mssw_csrf  = extract_cookie_value(cookie_str, "x-csrf-token")    # → x-csrf-token
    if mssw_csrf:  headers["x-csrf-token"] = mssw_csrf
if base_url == SOAR_BASE_URL:                    # 仅 mssp 请求加（固定值 + 时区）
    headers["X-CSRFToken"] = MSSP_CSRF_TOKEN     # 固定值常数
    headers["timezone"] = "+08:00"               # 东八区
```

**要点**：`X-Csrftoken` 是**从 cookie 提取**的动态值，`request_with_retry` 只要有 cookie 就调用 `extract_cookie_value` —— **mssp 请求也会走到**（weak 的 mssp 接口 `easm_api7_*`/`weak_pwd_detail`、vuln 的 `easm_api5_*`/`easm_download_file` 都传了 cookie）。所以 weak/vuln 的 **mssp 请求同样带 `X-Csrftoken`**。

> **真正"按固定值约束"的只有 `X-CSRFToken`（全大写）**，靠 `base_url == SOAR_BASE_URL` 分支单独加，只在 mssp 请求出现，值来自常量 `MSSP_CSRF_TOKEN`。`X-Csrftoken` 不是固定值，是 cookie 提取的动态值。

#### exposuer_report.py（纯 mssp）不走 cookie 提取

请求头用独立 `_build_headers(cookie_str)` 构建，只把 cookie 塞进 `DEFAULT_HEADERS`（固定 `X-CSRFToken` + `timezone`），**不调用 `extract_cookie_value`**：

```python
def _build_headers(cookie_str): 
    headers = DEFAULT_HEADERS.copy()   # 含固定 X-CSRFToken + timezone
    headers["Cookie"] = cookie_str     # 只加 Cookie，不提取 CSRF
    return headers
```

#### 三者差异（按实际代码）

| 脚本 | 平台 | `X-Csrftoken`(cookie提取) | `x-csrf-token`(cookie提取) | `X-CSRFToken`(固定) | `timezone` |
|------|------|---------------------------|----------------------------|---------------------|-----------|
| weak_report.py | mssw+mssp | ✅ | ✅ | ✅ | ✅ |
| vuln_report.py | mssw+mssp | ✅ | ✅ | ✅ | ✅ |
| exposuer_report.py | mssp | ❌ | ❌ | ✅ | ✅ |

> 所以 `X-Csrftoken` 是否出现在请求头里，取决于该脚本走哪条请求封装：weak/vuln 的 mssp 请求**带**（cookie 提取）；pure-mssp 的 exposure **不带**（不走提取函数）。**mssp 平台稳定的身份标识始终是固定的 `X-CSRFToken` + `timezone`**。

> **`X-CSRFToken` 是固定值常数**（三个脚本值相同），与平台部署相关。写新 skill 时不要凭空编造——它跟 mssp 网关绑定，需从线上接口/平台方确认是否仍有效。

## 组装顺序

1. 从集中配置（`config/api_config.json`）取平台 origin / host / referer_path。
2. 调 `session-manager get-state` 取登录态文件，读 `session.platforms.<平台>.cookies` 拼 cookie 串（见 `session-manager.md`）。
3. 从 cookie 串按目标平台提取 CSRF cookie（mssw 用 `csrf_token`；mssp 用 `csrf_token` 和/或 `x-csrf-token`）。
4. 组通用浏览器头 + 平台特有头 + cookie 串。
5. 发送请求；失败写 stderr 并 exit 非 0。

## 不要做的事

- **不要凭空造 CSRF token**：都要从 session-manager 的 cookie 串里提取，不能编一个，也不能从登录态文件里读一个不存在的字段。
- **不要带 `Source` 请求头**：平台会校验拒绝。
- **不要把固定值（`X-CSRFToken`、Host、origin）硬编码散落**：集中在 `config/api_config.json` + 常量文件管理。
- **不要把 cookie / CSRF token 写进 stdout / 日志 / 错误信息**（凭据不外泄）。
- **不同平台的头不要混**：mssp 特有的 `X-CSRFToken` + `timezone` 不要加到 mssw 请求上；mssw 的 `x-mssw-company-id` 不要加到 mssp 请求上。
