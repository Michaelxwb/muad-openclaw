---
name: threat-intel-feed
description: "情报半月刊：爬取全球安全厂商/机构的技术博客和威胁情报，提取IoC，按分类生成HTML报告并通过企微群机器人发送"
---

# 情报半月刊

从内置安全厂商/机构源爬取最新技术博客和安全资讯，分类整理，提取 IoC，生成 HTML 报告并通过企微群机器人 Webhook 发送。

## 运行方式

### ⚡ 一键运行

```bash
cd C:\Users\User\.openclaw\workspace\skills\threat-intel-feed\scripts && python run_all.py
```

一键完成：爬取（第1~4章）→ 翻译 → HTML报告 → 企微群发送

### 指定参数

```bash
python scripts/run_all.py --days 15 --lang zh --chapters 1,2,3,4
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--days N` | 爬取最近N天 | 15 |
| `--lang zh/en` | 报告语言：zh=中文, en=英文 | en |
| `--chapters 1,2,3,4` | 要生成的章节（逗号分隔） | 1,2,3,4 |
| `--output name` | 输出文件名基础 | biweekly_threat_report |

## 完整工作流

```
第1章爬取 ─┐
第2章爬取 ─┤
第3章爬取 ─┼─→ 翻译（根据--lang开关）→ 合并HTML → 打包 → 企微群Webhook发送
第4章爬取 ─┘
```

### 分步运行

```bash
# 第1章 & 第2章（传统爬虫，42个情报源）
python scripts/crawl.py --days 15 --output data/raw/
python scripts/classify.py --input data/raw/ --output data/classified.json

# 第3章 & 第4章（深信服安全Wiki SPA爬虫）
python scripts/crawl_ch34.py --days 15

# 生成完整报告
python scripts/build_report.py --lang en --output report.html

# 通过企微群Webhook发送
python scripts/send_webhook.py --file report.html
```

## 企微群发送

通过群机器人 Webhook 自动发送。

配置文件：`references/webhook_config.json`

```json
{
  "webhook_url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=YOUR_KEY"
}
```

流程：
1. 调用 `upload_media` API 上传文件获取 `media_id`
2. 调用 `webhook/send` API 发送文件消息

## 报告章节

| 章节 | 标题 | 数据源 | 说明 |
|------|------|--------|------|
| 第1章 | 网络安全政策法律动态 | 42个情报源 | 国内/国际政策热点 |
| 第2章 | 热点安全事件 | 42个情报源 | AI攻防、APT技战术、病毒变种、检测技术 |
| 第3章 | 漏洞情报摘要 | 深信服安全Wiki | 近半月漏洞预警文章、事件描述+解决方案 |
| 第4章 | 微软安全通告 | 深信服安全Wiki | 最新微软补丁日安全通告 |

> 章节可扩展，添加新爬虫模块即可。

## 翻译

- 默认 `--lang en`，将中文内容翻译为英文
- `--lang zh` 保持中文原文
- 翻译在章节数据合并后统一执行

## 内置情报源

42个源，详见 `references/sources.md`：
- **海外厂商**：Unit42、Talos、Mandiant、CrowdStrike、SentinelOne、ESET、Kaspersky 等
- **东南亚**：Ensign InfoSecurity、Group-IB、Horangi
- **安全机构**：CISA、NCSC、JPCERT/CC、SANS ISC
- **独立媒体**：Krebs、BleepingComputer、The Hacker News、Dark Reading

## 分类体系

详见 [`references/classification-guide.md`](references/classification-guide.md)

```
一、网络安全政策法律动态
  （一）国内政策热点
  （二）国际政策热点
二、热点安全事件
  （一）AI对攻防趋势变化
  （二）黑客组织攻击技战术更新
  （三）病毒新变种
  （四）安全检测技术更新
三、安全风险通告
四、微软安全通报
  （一）漏洞摘要
  （二）漏洞数据分析
  （三）重要漏洞分析
```

## 依赖

- Python 3.8+
- `pip install requests beautifulsoup4 feedparser lxml selenium`
- Chrome 浏览器（Selenium 驱动）

## 注意事项

- 遵守各站点 robots.txt 和爬取频率限制
- 部分站点需要 API Key（参考 `references/sources.md` 中注明）
- 企微文件发送上限 20MB
- 深信服安全Wiki需要登录才能查看详情内容
