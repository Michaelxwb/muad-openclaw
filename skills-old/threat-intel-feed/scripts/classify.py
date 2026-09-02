#!/usr/bin/env python3
"""
文章分类脚本 v3 — 关键词初筛 + AI 终判
- 关键词 score ≥ 3：高置信度，直接归类
- 关键词 score 1-2：模糊地带，交 AI 判定
- 关键词 score 0（未匹配）：交 AI 判定
- AI 返回"未分类"时保留为未分类
用法: python classify.py --input data/raw/ --output data/classified.json [--use-ai]
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# ============================================================
# 分类体系定义
# ============================================================
CATEGORIES = {
    "一、网络安全政策法律动态": {
        # ⚠️ 此分类不使用关键词，纯 AI 语义判断
        # 政策分类的本质是「意图」而非「词汇」：
        #   - "白宫发布新规" vs "白宫警告攻击" → 关键词无法区分
        #   - "欧盟通过CRA" → 没有 policy/regulation 等通用词，但AI能理解
        #   - "CISA发布指令" vs "CISA通报事件" → 词一样，意图不同
        # 因此关键词设为空，强制走 AI 判断
        "国内政策热点": {
            "keywords": [],  # 纯AI判断
        },
        "国际政策热点": {
            "keywords": [],  # 纯AI判断
        },
    },
    "二、热点安全事件": {
        # ⚠️ 纯 AI 意图判断，不使用关键词
        # 核心意图：安全厂商/研究机构对攻击活动、恶意软件、技战术、检测方法的深度分析
        # 区别于「三、安全风险通告」：后者是CVE/补丁/漏洞公告，前者是技术分析文章
        # 区别于「一、政策」：非法规政策
        # 区别于「未分类」的纯产品发布/市场/行业趋势/播客

        "AI对攻防趋势变化": {
            "keywords": [],  # 纯AI判断
        },
        "黑客组织攻击技战术更新": {
            "keywords": [],  # 纯AI判断
        },
        "病毒新变种": {
            "keywords": [],  # 纯AI判断
        },
        "安全检测技术更新": {
            "keywords": [],  # 纯AI判断
        },
    },
    "三、安全风险通告": {
        "安全风险通告": {
            "keywords": [
                "vulnerability", "cve-", "zero-day", "exploit", "poc",
                "proof of concept", "remote code execution", "rce",
                "privilege escalation", "authentication bypass",
                "information disclosure", "denial of service", "local privilege",
                "patch tuesday", "security update", "out-of-band",
                "emergency patch", "critical vulnerability",
                "cvss", "severity score", "affected versions",
                "actively exploited", "in the wild", "weaponized",
                "security patches", "security patch", "patches for",
                "released security", "apple patches", "apple security",
                "ios update", "macos update", "safari update",
                "chrome update", "browser security flaw",
            ],
        },
    },
    "四、微软安全通报": {
        "漏洞摘要": {
            "keywords": [
                "patch tuesday", "microsoft patches", "windows update",
                "microsoft security update", "msrc", "monthly security",
                "microsoft fixes", "windows vulnerability",
                "exchange server", "outlook vulnerability",
            ],
        },
        "漏洞数据分析": {
            "keywords": [
                "patch analysis", "patch diff", "patch reverse",
                "cve statistics", "vulnerability trends", "microsoft cve count",
            ],
        },
        "重要漏洞分析": {
            "keywords": [
                "microsoft critical", "exchange cve", "windows rce",
                "active directory vulnerability", "kerberos", "ntlm",
                "microsoft zero-day", "word macro", "office vulnerability",
            ],
        },
    },
}

# 分类体系描述，供 AI 判决使用
CATEGORY_DESC = """分类体系（宁缺毋滥，拿不准就归未分类）：

1. 一、网络安全政策法律动态 - 国际政策热点
   ⚠️ 仅限正式发布的网络安全/AI安全相关法规、政策、标准、行政令、备忘录。
   关键特征：有明确政策文件名称、发文机构、生效日期、具体条款。
   ✅ 正例：
     - "特朗普签署《推动先进人工智能创新与安全》行政令" (有行政令名称+签署日期+条款)
     - "美出台第11号国家安全总统备忘录(NSPM-11)，聚焦AI安全" (有备忘录编号+政策方向)
     - "欧盟通过Cyber Resilience Act"、"NIST发布新框架"、"CISA发布BOD 24-01指令"
   ❌ 反例（归未分类）：
     - 政府悬赏通缉黑客 (执法案件，非政策)
     - 司法部查封域名 (版权执法行动，非安全政策)
     - 某官员表示"将加强" (表态性新闻，无正式文件)
     - 地缘政治冲突报道

2. 一、网络安全政策法律动态 - 国内政策热点
   ⚠️ 仅限中国正式发布的网络安全/AI安全法规、标准、政策。
   ✅ 正例：
     - "网安标委下达3项网络安全推荐性国家标准计划" (有标准名称+归口单位)
     - "工信部印发《人工智能+信息通信创新发展实施意见》" (有文件名称+发文机构+具体任务)
     - "国家网信办、市场监管总局联合印发《网络测评活动规范》" (有发文机构+规范名称)
   ❌ 反例：国内企业安全事件、一般性产业动态

3. 二、热点安全事件 - AI对攻防趋势变化
   ⚠️ 战略/观点型！高屋建瓴讨论AI如何改变安全格局，不讲具体攻击技术细节。
   核心判断：文章落脚点是"趋势观点"还是"攻击者用AI做了什么"？后者属于「黑客组织攻击技战术更新」。
   ✅ 正例：
     - "Agentic AI Has an Identity Problem and Attackers Know It" (AI Agent身份治理的战略风险)
     - "Why Post-Quantum Cryptography Starts With Credentials" (后量子密码战略趋势)
     - "Dawn of the Apex Agentic Adversary" (对抗性AI时代展望)
   ❌ 反例：
     - "Threat Actors Abuse claude.ai for Malvertising" → 攻击技战术（落脚点是具体攻击链，不是趋势）
     - "Phantom Squatting: AI-Hallucinated Domains as Supply Chain Vector" → 攻击技战术（AI幻觉导致的具体攻击面分析）
     - "Clean GitHub repo tricks AI coding agents into running malware" → 攻击技战术（具体技战术细节，非观点）

4. 二、热点安全事件 - 黑客组织攻击技战术更新
   具体APT组织/攻击团伙的活动分析、攻击手法(TTPs)、攻击基础设施、攻击链剖析。
   ⚠️ 注意：攻击者利用AI发起的攻击也属于此类（如用AI平台做C2、用LLM幻觉投毒供应链）。
   ✅ 正例：
     - "Gamaredon in 2025: Leveraging tunnels, workers, dead drops" (APT组织工具演变)
     - "Mustang Panda Uses Zoho WorkDrive as Command Channel" (APT新TTP)
     - "Phantom Squatting: AI-Hallucinated Domains as Supply Chain Vector" (AI幻觉导致的攻击面，落脚点是攻击技术)
     - "Threat Actors Abuse claude.ai for ClickFix Malvertising" (攻击者利用AI平台，落脚点是攻击链)
   ❌ 反例：CVE漏洞公告（属于风险通告）、观点/趋势文章（属于AI趋势）

5. 二、热点安全事件 - 病毒新变种
   新型恶意软件/勒索软件/木马/RAT的技术特征分析、逆向、新变种。
   ⚠️ 核心是"病毒本身"而非"谁用了什么手法"（后者属于技战术）。
   ✅ 正例：
     - "TONResolver RAT Abuses TON Blockchain to Target Japan Hotels" (新RAT分析)
     - "Blackfield ransomware asks Nidec for $2 million" (新勒索软件)
     - "New STOCKSTAY backdoor deployed against government organizations" (新后门)
   ❌ 反例：通用钓鱼诈骗新闻（无技术分析）、安全产品功能发布

6. 二、热点安全事件 - 安全检测技术更新
   检测工程方法论、Sigma/Yara/EDR/NDR/XDR/SIEM技术、威胁狩猎方法、安全工具发布
   ✅ 正例：
     - "Threat Brief: Mitigating Large-Scale Credential Attacks" (检测与缓解指导)
     - "Kali Linux 2026.2 released with new tools" (安全工具发布)
   ❌ 反例：纯产品更新日志、云平台功能发布

7. 三、安全风险通告
   CVE漏洞通告、安全补丁公告、漏洞利用预警、PoC发布

8. 四、微软安全通报 - 漏洞摘要/数据分析/重要漏洞分析
   微软专项安全更新/补丁周二/Exchange/Windows漏洞分析

9. 未分类
   产品发布、市场报告、行业趋势、播客、编辑内容、执法新闻、版权盗版、一般IT新闻等
   宁可不分类，也不硬套。准确比覆盖率重要。"""


# ============================================================
# 关键词匹配
# ============================================================
def keyword_classify(article):
    """关键词匹配初筛"""
    title = (article.get("title") or "").lower()
    summary = (article.get("summary") or "").lower()
    source_id = (article.get("source_id") or "").lower()
    source_name = (article.get("source_name") or "").lower()
    # 标题权重加倍
    combined = title + " " + title + " " + summary + " " + source_name

    results = []
    for cat_main, subcats in CATEGORIES.items():
        for cat_sub, rules in subcats.items():
            score = 0
            matched = []
            for kw in rules.get("keywords", []):
                kw_lower = kw.lower()
                if kw_lower in combined:
                    score += 1
                    matched.append(kw)
            if source_id in rules.get("sources", []) or source_name in rules.get("sources", []):
                score += 2
                matched.append(f"source:{source_id}")
            if score > 0:
                results.append({
                    "main_category": cat_main,
                    "sub_category": cat_sub,
                    "score": score,
                    "matched_keywords": matched[:5],
                    "method": "keyword",
                })
    results.sort(key=lambda x: x["score"], reverse=True)
    return results


# ============================================================
# AI 判决 (通过 HTTP 调用 DeepSeek API)
# ============================================================
import urllib.request
import urllib.error

# API 配置（从 openclaw.json 读取）
API_BASE = "https://api.ai-native-x.site/v1"
API_KEY = "sk-aAWUz67mZvu2Xsnqlq8d3Ls0htgBoX3SDXmE16ql5JcO7aXX"
AI_MODEL = "deepseek-v4-pro"


def _extract_json(text):
    """从文本中提取 JSON，多层容错"""
    import re as _re
    # 清理 markdown 代码块
    if "```" in text:
        parts = text.split("```")
        for i in range(1, len(parts), 2):
            p = parts[i].strip()
            if p.startswith("json"):
                p = p[4:].strip()
            if p.startswith("{"):
                text = p
                break
    # 找 JSON 对象
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        candidate = text[start:end + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass
        # JSON 解析失败，尝试修复常见问题后重试
        try:
            # 修复未转义引号、换行等
            fixed = candidate.replace("\n", "\\n").replace("\r", "")
            return json.loads(fixed)
        except json.JSONDecodeError:
            pass
    # 回退：正则提取字段
    m = _re.search(r'"main"\s*:\s*"([^"]+)"', text)
    m2 = _re.search(r'"sub"\s*:\s*"([^"]+)"', text)
    r = _re.search(r'"reason"\s*:\s*"([^"]*?)"', text)
    if m:
        return {
            "main": m.group(1),
            "sub": m2.group(1) if m2 else "待审核",
            "reason": r.group(1) if r else ""
        }
    # 最后手段：从文本中推断分类
    for cat_name in ["一、网络安全政策法律动态", "二、热点安全事件",
                     "三、安全风险通告", "四、微软安全通报", "未分类"]:
        if cat_name[:6] in text:
            return {"main": cat_name, "sub": "待审核", "reason": "自动推断"}
    # 最终兜底：返回未分类
    print(f"  [WARN] 无法解析AI回复，归入未分类: {text[:100]}", file=sys.stderr)
    return {
        "main": "未分类",
        "sub": "待审核",
        "reason": "AI回复解析失败"
    }


def ai_classify(article, top_candidates):
    """用 AI 判断单篇文章的分类"""
    title = article.get("title", "")
    summary = (article.get("summary") or "")[:500]
    source = article.get("source_name", "")

    # 构建 prompt
    candidates_text = ""
    if top_candidates:
        candidates_text = "关键词初筛候选（仅供参考，不一定正确）：\n"
        for c in top_candidates[:3]:
            candidates_text += f"  - {c['main_category']} > {c['sub_category']} (匹配: {', '.join(c.get('matched_keywords', [])[:3])})\n"

    prompt = f"""你是威胁情报分析师。请判断以下安全文章的分类。
⚠️ 核心原则：准确优先于覆盖。拿不准就归「未分类」。不要硬套分类。

{candidates_text}文章信息：
- 标题: {title}
- 来源: {source}
- 摘要: {summary}

{CATEGORY_DESC}

请只返回一个JSON（不要markdown代码块），格式：{{"main":"主分类","sub":"子分类","reason":"一句话理由"}}
主分类和子分类必须严格使用上面分类体系中的名称。如有丝毫犹豫，返回 {{"main":"未分类","sub":"待审核","reason":"一句话"}}"""

    try:
        req_body = json.dumps({
            "model": AI_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 400,
            "temperature": 0.0,
        }).encode("utf-8")

        # 请求 + 最多1次重试
        content = ""
        for attempt in range(2):
            try:
                req = urllib.request.Request(
                    f"{API_BASE}/chat/completions",
                    data=req_body,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {API_KEY}",
                    },
                )
                with urllib.request.urlopen(req, timeout=45) as resp:
                    resp_data = json.loads(resp.read().decode("utf-8"))
                content = resp_data["choices"][0]["message"]["content"].strip()
                if content and "{" in content:
                    break
            except Exception:
                if attempt == 1:
                    raise
                time.sleep(1)  # 重试前短暂等待

        if not content:
            raise ValueError("AI返回空内容")
        # 清理可能的 markdown 代码块
        if content.startswith("```"):
            content = "\n".join(content.split("\n")[1:])
            if content.endswith("```"):
                content = content[:-3]
            content = content.strip()
        # 尝试提取 JSON（处理模型可能输出的解释性文字）
        ai_result = _extract_json(content)
        return {
            "main_category": ai_result.get("main", "未分类"),
            "sub_category": ai_result.get("sub", "待审核"),
            "score": 99,
            "matched_keywords": [f"AI: {ai_result.get('reason', '')}"],
            "method": "ai",
        }
    except Exception as e:
        print(f"  [WARN] AI 分类失败 ({title[:40]}...): {e}", file=sys.stderr)
        if top_candidates:
            return top_candidates[0]
        return {
            "main_category": "未分类",
            "sub_category": "待审核",
            "score": 0,
            "matched_keywords": [f"AI 错误: {str(e)[:80]}"],
            "method": "keyword_fallback",
        }


# ============================================================
# 混合分类
# ============================================================
def classify_article(article, use_ai=True):
    """混合分类：关键词初筛 + AI 兜底"""
    kw_results = keyword_classify(article)

    if not kw_results:
        # 完全未匹配关键词 → AI 判断
        if use_ai:
            return ai_classify(article, [])
        return {
            "main_category": "未分类",
            "sub_category": "待审核",
            "score": 0,
            "matched_keywords": [],
            "method": "keyword",
        }

    best = kw_results[0]
    if best["score"] >= 3:
        # 高置信度关键词匹配 → 直接采用
        return best

    # score 1-2: 模糊地带 → AI 判断
    if use_ai:
        return ai_classify(article, kw_results)

    return best


def classify_all(input_dir="data/raw", output_file="data/classified.json", use_ai=True):
    """批量分类"""
    input_path = Path(input_dir)
    classified = {}

    # 读取数据
    summary_file = input_path / "_all_articles.json"
    articles = []
    if summary_file.exists():
        with open(summary_file, "r", encoding="utf-8") as f:
            articles = json.load(f)
    else:
        for f in input_path.glob("*.json"):
            if f.name.startswith("_"):
                continue
            with open(f, "r", encoding="utf-8") as fp:
                articles.extend(json.load(fp))

    # 逐篇分类
    kw_direct = 0
    ai_judged = 0
    ai_total = 0

    for article in articles:
        article_id = article.get("id") or article.get("link", "")
        if article_id in classified:
            continue

        classification = classify_article(article, use_ai=use_ai)
        if classification["method"] == "keyword":
            kw_direct += 1
        else:
            ai_judged += 1

        classified[article_id] = {
            "article": article,
            "classification": classification,
        }
        ai_total = kw_direct + ai_judged

    # 按分类整理
    organized = {}
    for article_id, info in classified.items():
        article = info["article"]
        cat_main = info["classification"]["main_category"]
        cat_sub = info["classification"]["sub_category"]

        if cat_main not in organized:
            organized[cat_main] = {}
        if cat_sub not in organized[cat_main]:
            organized[cat_main][cat_sub] = []

        organized[cat_main][cat_sub].append({
            "title": article.get("title", ""),
            "link": article.get("link", ""),
            "summary": article.get("summary", ""),
            "source_name": article.get("source_name", ""),
            "published": article.get("published", ""),
            "score": info["classification"]["score"],
            "matched_keywords": info["classification"]["matched_keywords"],
            "method": info["classification"]["method"],
        })

    # 统计
    stats = {}
    for cat_main, subcats in organized.items():
        stats[cat_main] = {sub: len(items) for sub, items in subcats.items()}

    output = {
        "generated_at": __import__("datetime").datetime.now().isoformat(),
        "total_articles": len(classified),
        "kw_direct": kw_direct,
        "ai_judged": ai_judged,
        "stats": stats,
        "categories": organized,
    }

    Path(output_file).parent.mkdir(parents=True, exist_ok=True)
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"分类完成: {len(classified)} 篇文章")
    print(f"  关键词直判: {kw_direct} 篇 | AI 复核: {ai_judged} 篇")
    for cat, sub in stats.items():
        total = sum(sub.values())
        print(f"  {cat}: {total} 篇")
    return output


def main():
    parser = argparse.ArgumentParser(description="文章分类 — 关键词初筛 + AI终判")
    parser.add_argument("--input", default="data/raw", help="爬取结果目录")
    parser.add_argument("--output", default="data/classified.json", help="分类结果文件")
    parser.add_argument("--no-ai", action="store_true", help="禁用 AI 兜底（仅关键词）")
    args = parser.parse_args()

    use_ai = not args.no_ai
    classify_all(args.input, args.output, use_ai=use_ai)


if __name__ == "__main__":
    main()
