---
name: ti-redirect-analyze
description: "根据一个 IOC 生成深信服威胁情报平台（TI）的分析页重定向 URL。输入一个 IOC（域名/URL/IP/MD5 四类之一），返回可在浏览器打开分析页面的重定向链接。MANDATORY to use when user asks 生成深信服重定向url, 生成重定向链接, 生成分析页链接, 深信服威胁情报分析页, 或输入一个IOC(domain/url/ip/md5)要生成其TI分析页URL。"
---

# TI 分析页重定向 URL 生成 Skill

输入一个 IOC（`domain` / `url` / `ip` / `md5` 四类之一），生成深信服威胁情报 TI 平台分析页的重定向 URL。打开该 URL 可跳转到对应 IOC 的分析报告页。

## 用法

```bash
python scripts/run.py --type <domain|url|ip|md5> --ioc <IOC值>
```

- `--type`：IOC 类型，取值 `domain` / `url` / `ip` / `md5`
- `--ioc`：IOC 值
- `--config`（可选）：`ti_redirect` 配置文件路径；省略时使用脚本内置默认配置

## 输出

stdout 打印重定向 URL，形如：

```
https://ti.sangfor.com.cn/api/v1/rest/redirect/page/<RSA密文>?l=ZH-CN
```

浏览器打开后，重定向到对应 IOC 的分析报告页（如 `/analysis-platform/dns_report/<b64 IOC>?lang=ZH-CN`）。未登录也可看到报告摘要。

## IOC 类型判定规则

用户输入需要判定为以下四类之一：

- 域名（无 scheme、含点、无路径）→ `domain`
- URL（以 http/https 开头）→ `url`
- IP 地址（IPv4/IPv6）→ `ip`
- MD5（32 位十六进制）→ `md5`

如果用户实际输入与要求不符，由用户提供 `--type`；若用户只给 IOC 值未给类型，脚本无法自动判四类（domain/url/ip/md5 有歧义），需先用上述规则在回复中给用户说明判定结果。

## 完整工作流程（生成 URL + 截图）

skill 的完整能力是：**输入 IOC → 生成重定向 URL → 浏览器打开分析页 → 只截屏报告摘要区 → 把截图发给用户**。

1. **生成重定向 URL**：运行 `python scripts/run.py --type <type> --ioc <ioc>`，得到重定向链接。
2. **浏览器打开**：用 browser 工具打开该 URL，页面会 302 重定向到 `https://ti.sangfor.com.cn/analysis-platform/<report_path>/<b64 IOC>?lang=ZH-CN`。
3. **等待页面渲染**：页面是 SPA，需等待一段时间（约 8 秒）让报告摘要异步加载完成。未登录也能看到报告摘要。
4. **整页截图 + 裁剪**：对当前页做 fullPage 截图（窗口宽度设为 1400，高 500，DPR=1），然后用 PIL 把截图裁剪为报告摘要区。裁剪参数**按 IOC 类型区分**：
   - **md5 类型**：`left=50, top=90, right=950, bottom=430`（即 `im.crop((50, 90, 950, 430))`）
   - **domain / url / ip 类型**：`left=50, top=90, right=900, bottom=268`（即 `im.crop((50, 90, 900, 268))`）
   得到 `uery.top 标题 + SANGFOR标签卡片(含可疑) + 威胁等级/发现时间字段` 的摘要图（不包含顶部搜索栏、左侧安全等级大图标、下方的"情报分析"tab 区）。
5. **发送截图**：把裁剪后的图片用 `MEDIA:<path>` 发给用户。

> 说明：裁剪坐标基于窗口宽 1400、整页截图尺寸的视口坐标系。若页面布局变化导致坐标偏移，按摘要区元素（`.report-info-right`、`.info-detail`、`uaery.top` 标题、`safety-level` 图标）的实际 `getBoundingClientRect()` 重新取坐标微调。

## 工作原理

1. `validate_ioc`：按 IOC 类型做格式校验/归一化。
2. 请求 key 接口 `POST {key_url}`，body `{"di": device_id, "s": source}`，返回临时 `token`（去掉 `&` 签名部分）和 RSA 公钥（PEM，base64 url-safe 编码）。
3. 构造明文负载 `{"t": token, "i": b64url(ioc), "p":"ti", "di":…, "s":…, "dv":…, "ak":…}`。
4. 用 RSA（PKCS#1 v1.5，200 字节分块）加密负载。
5. 拼 URL：`{page_base_url}/{b64url(密文)}?l={language}`。

实现仅依赖 Python 标准库 + `requests` + `pyyaml`（RSA 加密与 DER 公钥解析为纯标准库实现，无需 pycryptodome）。

## 执行脚本

`scripts/run.py`。脚本失败时打印错误到 stderr 并 exit 非 0。
