# 情报源清单

> 注：标注 ⚡ 的需要 API Key

## 一、海外安全厂商

### 北美

| # | 源名 | URL | RSS/API | 标签 | 频率限制 |
|---|------|-----|---------|------|----------|
| 1 | Palo Alto Unit 42 | https://unit42.paloaltonetworks.com/ | https://unit42.paloaltonetworks.com/feed/ | apt,malware,research | 1req/30s |
| 2 | Cisco Talos | https://blog.talosintelligence.com/ | https://blog.talosintelligence.com/feed/ | apt,malware,threat-intel | 1req/30s |
| 3 | Mandiant (Google Cloud) | https://cloud.google.com/blog/products/identity-security | https://cloud.google.com/blog/products/identity-security/rss | apt,incident-response,research | 1req/30s |
| 4 | CrowdStrike Blog | https://www.crowdstrike.com/blog/ | https://www.crowdstrike.com/blog/feed/ | apt,edr,incident-response | 1req/30s |
| 5 | SentinelOne Blog | https://www.sentinelone.com/blog/ | https://www.sentinelone.com/blog/feed/ | edr,malware,research | 1req/30s |
| 6 | Microsoft Security Blog | https://www.microsoft.com/en-us/security/blog/ | https://www.microsoft.com/en-us/security/blog/feed/ | vulnerability,apt,cloud | 1req/30s |
| 7 | Proofpoint Blog | https://www.proofpoint.com/us/blog | https://www.proofpoint.com/us/rss.xml | phishing,email-security | 1req/30s |
| 8 | Zscaler Blog | https://www.zscaler.com/blogs | https://www.zscaler.com/blogs/feed | cloud,zero-trust,threat | 1req/30s |
| 9 | Trend Micro Research | https://www.trendmicro.com/en_us/research.html | https://www.trendmicro.com/en_us/research.html/rss | apt,malware,iot | 1req/30s |
| 10 | Fortinet Blog | https://www.fortinet.com/blog | https://www.fortinet.com/blog/feed | apt,network,threat-intel | 1req/30s |

### 欧洲

| # | 源名 | URL | RSS/API | 标签 | 频率限制 |
|---|------|-----|---------|------|----------|
| 11 | ESET Research | https://www.welivesecurity.com/ | https://www.welivesecurity.com/en/rss/ | apt,malware,research | 1req/30s |
| 12 | Kaspersky SecureList | https://securelist.com/ | https://securelist.com/feed/ | apt,malware,spam | 1req/30s |
| 13 | Sophos X-Ops | https://news.sophos.com/en-us/category/x-ops/ | https://news.sophos.com/en-us/category/x-ops/feed/ | apt,ransomware,research | 1req/30s |
| 14 | Avast/Gen Digital Blog | https://decoded.avast.io/ | https://decoded.avast.io/feed/ | malware,consumer | 1req/30s |

### 以色列

| # | 源名 | URL | RSS/API | 标签 | 频率限制 |
|---|------|-----|---------|------|----------|
| 15 | Check Point Research | https://research.checkpoint.com/ | https://research.checkpoint.com/feed/ | apt,malware,cloud | 1req/30s |

## 二、东南亚安全厂商

| # | 源名 | URL | RSS/API | 标签 | 频率限制 |
|---|------|-----|---------|------|----------|
| 16 | Ensign InfoSecurity (SG) | https://www.ensigninfosecurity.com/blog | 无RSS，需爬取HTML | apt,threat-intel,asia | 1req/60s |
| 17 | Group-IB (SG HQ) | https://www.group-ib.com/blog/ | https://www.group-ib.com/blog/feed/ | apt,fraud,threat-intel | 1req/30s |
| 18 | Horangi (SG) | https://www.horangi.com/blog | 无RSS，需爬取HTML | cloud,asia | 1req/60s |
| 19 | SecurityQuotient (IN) | https://securityquotient.io/blog/ | 无RSS，需爬取HTML | awareness,asia | 1req/60s |
| 20 | Kaspersky APAC Blog | https://www.kaspersky.com/blog/tag/apt/ | 使用标签页过滤 | apt,asia | 1req/30s |

## 三、安全机构/CSIRT

| # | 源名 | URL | RSS/API | 标签 | 频率限制 |
|---|------|-----|---------|------|----------|
| 21 | CISA Alerts (US) | https://www.cisa.gov/news-events/alerts | 无RSS，需爬取HTML | vulnerability,advisory,government | 1req/60s |
| 22 | NCSC UK | https://www.ncsc.gov.uk/information/rss-feeds | https://www.ncsc.gov.uk/api/1/services/v1/all-rss-feed.rss | advisory,government | 1req/30s |
| 23 | JPCERT/CC (JP) | https://www.jpcert.or.jp/english/rss/jpcert.rdf | https://www.jpcert.or.jp/english/rss/jpcert.rdf | apt,advisory,asia | 1req/30s |
| 24 | SANS ISC | https://isc.sans.edu/diary/rss | https://isc.sans.edu/diary/rss | threat-intel,diary | 1req/30s |
| 25 | CERT-EU | https://cert.europa.eu/publications/newsletter | 无RSS | advisory,government,eu | 1req/60s |
| 26 | FBI Cyber | https://www.fbi.gov/investigate/cyber | 无RSS | government,law-enforcement | 1req/60s |

## 四、独立安全博客/媒体

| # | 源名 | URL | RSS/API | 标签 | 频率限制 |
|---|------|-----|---------|------|----------|
| 27 | Krebs on Security | https://krebsonsecurity.com/ | https://krebsonsecurity.com/feed/ | cybercrime,investigation | 1req/30s |
| 28 | BleepingComputer | https://www.bleepingcomputer.com/ | https://www.bleepingcomputer.com/feed/ | malware,ransomware,news | 1req/30s |
| 29 | The Hacker News | https://thehackernews.com/ | https://feeds.feedburner.com/TheHackersNews | news,vulnerability,cybercrime | 1req/30s |
| 30 | Dark Reading | https://www.darkreading.com/ | https://www.darkreading.com/rss.xml | news,enterprise,threat | 1req/30s |
| 31 | Malwarebytes Blog | https://www.malwarebytes.com/blog | https://www.malwarebytes.com/blog/feed | malware,consumer,ransomware | 1req/30s |
| 32 | Recorded Future | https://www.recordedfuture.com/blog | https://www.recordedfuture.com/blog/rss.xml | threat-intel,research | 1req/30s |

## 五、技术深度源（需API）

| # | 源名 | URL/RSS | 认证方式 | 标签 | 说明 |
|---|------|---------|----------|------|------|
| 33 | VirusTotal API ⚡ | https://www.virustotal.com/api/v3/ | API Key | ioc,malware | IoC查询/批量 |
| 34 | Shodan API ⚡ | https://api.shodan.io/ | API Key | iot,exposure | 资产暴露 |
| 35 | AlienVault OTX ⚡ | https://otx.alienvault.com/api/v1/ | API Key | ioc,threat-intel | 威胁情报平台 |
| 36 | URLhaus API | https://urlhaus-api.abuse.ch/v1/ | 免费无Key | malware,phishing | 恶意URL |
| 37 | MalwareBazaar API | https://mb-api.abuse.ch/api/v1/ | 免费无Key | malware,sample | 恶意样本 |

## 六、厂商新闻/财报

| # | 源名 | URL | 类型 | 说明 |
|---|------|-----|------|------|
| 38 | Palo Alto Networks IR | https://investors.paloaltonetworks.com/ | 财报 | Press Releases RSS |
| 39 | CrowdStrike IR | https://ir.crowdstrike.com/ | 财报 | News & Events |
| 40 | Fortinet IR | https://investor.fortinet.com/ | 财报 | Press Releases |
| 41 | SentinelOne IR | https://investors.sentinelone.com/ | 财报 | News & Press Releases |
| 42 | Cisco Newsroom (Security) | https://newsroom.cisco.com/c/r/newsroom/en/us/tag/security.html | 新闻 | 大厂安全产品动态 |
