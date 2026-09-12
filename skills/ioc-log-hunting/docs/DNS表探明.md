# DNS(20) 表字段探明与检索映射

> 抽样来源：绝味食品(customer=97988530) 真实 DNS 明细（detail 全字段 83 个非空展示、表字典 85 个字段均已 dump 于本目录 json 备份）。
> 表字典全集见 `docs/dns_tableFields.json`；一条样例 detail 见 `docs/dns_detail_sample.json`。

## 恶意类型 → DNS 检索字段（定稿）

| 恶意内容 | DNS 字段 | 写法 | 说明 |
|---|---|---|---|
| **URL/域名** | **`queries`**（查询域名） | `filter queries="恶意URL"` | **精准匹配**（skill 实际唯一用） |
| IP（反查解析到它） | `answers`（响应/解析结果串） | `filter answers LIKE "%IP%"` | answers 为逗号串含解析 IP，需 LIKE；**skill 不深用，因 IP 走 TCP** |
| IP（发起主机） | `srcIp` | `filter srcIp="IP"` | 已知主机查它解析过什么 |
| IP（DNS 服务器） | `dstIp` | `filter dstIp="IP"` | 恶意/污染递归源 |
| **Hash** | **无**（DNS 无文件哈希字段） | — | **恶意 hash 不查 DNS**，走文件日志表 |

本 skill DNS 用例实际只取：`filter queries="<URL精确值>"` + 输出列 srcIp/recordTime。

## DNS 字段词典（关键 85 中挑业务相关）
- `queries` 查询域名（唯一存"被查域名"）
- `srcIp` / `srcPort`  发起查询的主机（**输出定位主机的核心**）
- `dstIp` / `dstPort`(常53) 查询发往的 DNS 服务器
- `answers` 响应/解析结果（逗号串，含解析到的 IP、CNAME 链）
- `srcIpTagCn` / `dstIpTagCn`  源/目的 内外网标签（值：内网/外网）
- `srcMac` / `hostName 类 主机指纹；`srcCity/srcCountry/srcProvince` 地理
- `recordTime` / `recordTimestamp` 记录时间（排序/时间窗依据）
- `customer` / `customerName`(客户全名) / `tenant`
- `productType`(上报设备, 绝味=SIP) / `originProductType`(采集, STA) / `originProductVer`
- `uuid` 日志主键（detail 用）
- `aTypes/qTypes/qClasses/rCode/aa/ad/rd/qr` 等 DNS 标志位（细节，一般不用）

## 数据观察
- 真实行 `queries=api3.qoder.sh / infogo.juewei.cn / hp-cms.qianwen.com` 等；answers 例如
  `"ga-...,47.57.243.249,8.212.124.35"`（含公网 IP）。
- 近3天真业务域名命中量极大（如 `qwen-agent-api.qianwen.com` → ckCount 4.7 万条、~35+ 台 srcIp 去重）—— 触发 >1万 "疑似非恶意" 提示是常态，勿误报。

## DNS skill 逻辑定稿（已端到端跑通）
```
输入: 客户 customer_id + 恶意URL
1) 时间窗 = 近3天 [now-3d, now]
2) ss = filter queries="<URL>"
3) total = ckCount(ss)
4) if total>10000: 提示"命中X条>1万,该域名访问量过大,可能非真恶意"
   拉取条数 fetch = min(total, 10000)
5) 按 recordTime desc 分页(pageSize 300)翻 fetch 条, fieldList=[recordTime, srcIp]
6) 对 srcIp 去重(不滤内网), 每台记录: 命中数 + 最早/最晚 recordTime(字符串比较 YYYY-MM-DD HH:mm:ss)
7) 输出: 主机IP清单(按命中数降序) + 每台 命中数/最早/最晚时间
```
