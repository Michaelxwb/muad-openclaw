# 威胁情报分类原则

> 本文档定义威胁情报文章的分类标准。分类采用 AI 意图判断，不使用关键词匹配。
> 核心原则：**准确优先于覆盖。拿不准就归「未分类」。不要硬套。**

---

## 分类体系总览

```
一、网络安全政策法律动态
  ├── 国内政策热点
  └── 国际政策热点
二、热点安全事件
  ├── AI对攻防趋势变化
  ├── 黑客组织攻击技战术更新
  ├── 病毒新变种
  └── 安全检测技术更新
三、安全风险通告
四、微软安全通报
未分类
```

---

## 一、网络安全政策法律动态

**意图：** 各国政府正式发布的网络安全/AI安全相关法规、政策、标准、行政令。

**判断标准（必须同时满足）：**
1. 有明确的政策文件名称（如"行政令第XX号"、"实施意见"、"法案名称"）
2. 有发文机构（如"工信部"、"白宫"、"欧盟委员会"）
3. 内容是制度性规范（条款、要求、时限、合规标准）

**不是政策热点的：**
- 政府悬赏通缉黑客 → 执法案件报道
- 司法部查封域名 → 版权执法行动
- 某官员表态"将加强" → 无正式文件
- 地缘政治冲突报道 → 非安全政策
- 情报机构威胁通报（FBI/CISA警示某APT） → 属于安全事件或风险通告

### 正例
- "Trump签署《推动先进人工智能创新与安全》行政令"（有名称+签署日期+条款）
- "美出台第11号国家安全总统备忘录(NSPM-11)"（有编号+政策方向）
- "网安标委下达3项网络安全推荐性国家标准计划"（有标准名称+归口单位）
- "工信部印发《人工智能+信息通信创新发展实施意见》"（有文件名称+发文机构+任务）

### 反例
- "美国悬赏1000万美元通缉黑客" → 未分类
- "美国司法部查封FIFA盗版域名" → 未分类
- "FBI/CISA警示俄罗斯情报机构攻击Signal" → 安全事件

---

## 二、热点安全事件

**意图：** 安全厂商/研究机构对攻击活动、恶意软件、技战术、检测方法的深度技术分析。

**与「三、安全风险通告」的区别：**
- 风险通告 = CVE漏洞公告/补丁通知/漏洞利用预警（短平快通告）
- 热点安全事件 = 技术分析文章（深度剖析、TTPs解读、样本逆向）

### 子分类原则

#### （一）AI对攻防趋势变化

**意图：战略/观点型。** 高屋建瓴地讨论 AI 如何改变安全攻防格局，讲的是趋势、格局、战略，不涉及具体攻击技术细节。

**判断标准：**
- 文章核心是"AI会带来什么变化"而非"攻击者用AI做了什么"
- 观点驱动，非技战术驱动
- 常见的：行业分析、战略报告、趋势预测

**⚠️ 关键区分：**
- 文章讲攻击者利用AI做了什么具体攻击 → 属于「黑客组织攻击技战术更新」
- 文章讲AI幻觉、AI平台被滥用、AI Agent被利用的具体攻击链 → 落脚点是攻击技术，不是趋势
- 不是有"AI"两个字就是AI趋势

**正例：**
- "Agentic AI Has an Identity Problem and Attackers Know It" — 讨论AI Agent身份治理的战略风险，观点型
- "Why Post-Quantum Cryptography Starts With Credentials" — 后量子密码的战略趋势分析
- "Dawn of the Apex Agentic Adversary" — 对抗性AI时代的战略展望

**反例（应归入攻击技战术）：**
- "Threat Actors Abuse claude.ai for ClickFix Malvertising" — 攻击者利用AI平台的具体攻击，落脚点是攻击技术
- "Clean GitHub repo tricks AI coding agents into running malware" — AI Agent被利用的技战术细节
- "Phantom Squatting: AI-Hallucinated Domains as Supply Chain Vector" — AI幻觉导致的攻击面，是攻击技术分析

#### （二）黑客组织攻击技战术更新

**意图：技术分析型。** 具体APT组织/攻击团伙的活动分析、攻击手法(TTPs)、攻击基础设施、攻击链剖析。

**判断标准：**
- 有具体组织名称（APT29/Lazarus/Gamaredon等）或具体攻击行动代号
- 分析攻击链、恶意软件功能、C2基础设施
- 落脚点是"他们怎么攻击的"

**正例：**
- "Gamaredon in 2025: Leveraging tunnels, workers, dead drops" — APT组织TTPs演变
- "Mustang Panda Uses Zoho WorkDrive as Command Channel" — APT新攻击手法
- "StrikeShark: delivering Cobalt Strike through SharkLoader" — 攻击链分析
- "Threat Actors Abuse claude.ai Shared Chat for ClickFix Malvertising" — 攻击者利用AI平台的攻击链（落脚点是攻击技术）

#### （三）病毒新变种

**意图：恶意软件本体分析。** 新型恶意软件/勒索软件/木马/RAT的技术特征、逆向分析、新变种。

**判断标准：**
- 文章核心对象是一个具体的恶意软件样本/家族
- 分析其特征（加密方式、传播机制、持久化、规避检测）

**与（二）的区别：**（二）关注"谁用了什么手法"，（三）关注"这个病毒本身是什么"

**正例：**
- "TONResolver RAT Abuses TON Blockchain to Target Japan Hotels" — 新RAT技术分析
- "Blackfield ransomware asks Nidec for $2 million" — 新勒索软件分析
- "Google Details Turla's New STOCKSTAY Backdoor" — 新后门分析

#### （四）安全检测技术更新

**意图：防守方法论。** 检测工程、威胁狩猎方法、安全工具、EDR/NDR/XDR/SIEM技术。

**正例：**
- "Threat Brief: Mitigating Large-Scale Credential Attacks" — 检测与缓解指导
- "Kali Linux 2026.2 released with 9 new tools" — 安全工具发布
- Sigma/Yara规则发布、检测方法论文章

---

## 三、安全风险通告

**意图：** CVE漏洞通告、安全补丁公告、漏洞利用预警、PoC发布。

**与「二」的区别：** 短平快的告警而非深度分析。

---

## 四、微软安全通报

**意图：** 微软专项：补丁周二、Exchange/Windows漏洞分析。

---

## 未分类

以下内容不应归入任何安全分类：
- 产品发布/功能更新
- 市场报告（Gartner魔力象限等）
- 行业职业趋势
- 播客/编辑内容
- 政府执法新闻（非安全政策）
- 版权/盗版新闻
- 一般IT产品新闻

**宁可不分类，也不硬靠。**
