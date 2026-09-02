#!/usr/bin/env python3
"""
Report Generator
Generates an English Markdown threat intelligence report from classified articles and IoCs.
Usage: python report.py --classified data/classified.json --ioc data/ioc.json --output report.md
"""
import argparse
import json
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path

TZ_UTC = timezone.utc


def generate_report(classified_data, ioc_data=None, output_file="report.md"):
    categories = classified_data.get("categories", {})
    stats = classified_data.get("stats", {})
    total = classified_data.get("total_articles", 0)

    now = datetime.now(TZ_UTC)
    date_str = now.strftime("%Y-%m-%d")

    cat_order = [
        "I. Cybersecurity Policy & Legal Developments",
        "II. Breaking Security Events",
        "III. Security Risk Advisories",
        "IV. Microsoft Security Bulletin",
        "Uncategorized",
    ]
    cat_map = {
        "一、网络安全政策法律动态": "I. Cybersecurity Policy & Legal Developments",
        "二、热点安全事件": "II. Breaking Security Events",
        "三、安全风险通告": "III. Security Risk Advisories",
        "四、微软安全通报": "IV. Microsoft Security Bulletin",
        "未分类": "Uncategorized",
    }
    sub_map = {
        "国内政策热点": "Domestic Policy",
        "国际政策热点": "International Policy",
        "AI对攻防趋势变化": "AI & Offense/Defense Trends",
        "黑客组织攻击技战术更新": "Threat Actor TTPs",
        "病毒新变种": "New Malware Variants",
        "安全检测技术更新": "Detection Technology",
        "安全风险通告": "Risk Advisory",
        "漏洞摘要": "Vulnerability Summary",
        "漏洞数据分析": "Vulnerability Analysis",
        "重要漏洞分析": "Critical Vulnerability Analysis",
        "待审核": "Pending Review",
    }
    sub_order = {
        "I. Cybersecurity Policy & Legal Developments": ["Domestic Policy", "International Policy"],
        "II. Breaking Security Events": ["AI & Offense/Defense Trends", "Threat Actor TTPs", "New Malware Variants", "Detection Technology"],
        "IV. Microsoft Security Bulletin": ["Vulnerability Summary", "Vulnerability Analysis", "Critical Vulnerability Analysis"],
    }

    lines = []
    lines.append(f"# Threat Intelligence Daily | {date_str}")
    lines.append("")
    lines.append(f"> Generated: {now.strftime('%Y-%m-%d %H:%M UTC')}")
    lines.append(f"> Sources: 14 security vendors/agencies")
    lines.append(f"> Articles: {total}")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## Overview")
    lines.append("")
    lines.append("| Category | Count | Share |")
    lines.append("|----------|-------|-------|")
    for cat in cat_order:
        # find original key
        orig = [k for k, v in cat_map.items() if v == cat]
        orig_key = orig[0] if orig else cat
        if orig_key in stats:
            n = sum(stats[orig_key].values())
            pct = round(n / total * 100, 1) if total > 0 else 0
            lines.append(f"| {cat} | {n} | {pct}% |")
    lines.append("")

    for cat_en in cat_order:
        orig_key = [k for k, v in cat_map.items() if v == cat_en]
        orig_key = orig_key[0] if orig_key else cat_en
        if orig_key not in categories:
            continue
        subcats = categories[orig_key]
        if not subcats:
            continue

        # filter out empty subcats
        non_empty = {k: v for k, v in subcats.items() if v}
        if not non_empty:
            continue

        lines.append("---")
        lines.append("")
        lines.append(f"## {cat_en}")
        lines.append("")

        if cat_en in sub_order:
            subcat_keys = [s for s in sub_order[cat_en] if s in non_empty]
            subcat_keys += [s for s in sorted(non_empty.keys()) if s not in subcat_keys]
        else:
            subcat_keys = sorted(non_empty.keys())

        for sub_key in subcat_keys:
            articles = non_empty[sub_key]
            if not articles:
                continue
            sub_en = sub_map.get(sub_key, sub_key)
            lines.append(f"### {sub_en} ({len(articles)})")
            lines.append("")

            for article in articles:
                title = article.get("title", "Untitled")
                link = article.get("link", "")
                summary = (article.get("summary") or "")[:300].strip()
                source = article.get("source_name", "")

                # clean summary
                clean = (summary
                    .replace("&#8211;", "-").replace("&#8212;", "—")
                    .replace("&#8216;", "'").replace("&#8217;", "'")
                    .replace("&#8220;", '"').replace("&#8221;", '"')
                    .replace("[...]", ""))

                lines.append(f"- **[{title}]({link})**")
                if clean:
                    lines.append(f"  {clean}")
                if source:
                    lines.append(f"  *Source: {source}*")
                lines.append("")

    # IoC appendix
    if ioc_data and ioc_data.get("iocs"):
        iocs = ioc_data["iocs"]
        lines.append("---")
        lines.append("")
        lines.append("## Appendix: Extracted IoCs")
        lines.append("")
        lines.append(f"Total: **{ioc_data.get('total_iocs', 0)}** IoCs")
        lines.append("")

        ioc_labels = {
            "ipv4": "IPv4", "domain": "Domain", "url": "URL",
            "md5": "MD5", "sha1": "SHA1", "sha256": "SHA256",
            "cve": "CVE", "email": "Email", "registry": "Registry",
            "filepath": "File Path",
        }
        priority = ["cve", "ipv4", "domain", "url", "sha256", "md5", "sha1"]

        for ioc_type in priority:
            if ioc_type not in iocs: continue
            items = iocs[ioc_type]
            label = ioc_labels.get(ioc_type, ioc_type.upper())
            lines.append(f"### {label} ({len(items)})")
            lines.append("")
            lines.append("| Value | Source |")
            lines.append("|-------|--------|")
            for item in items[:50]:
                v = item.get("value", "")
                s = item.get("source", {})
                sn = ""
                if isinstance(s, dict):
                    sn = s.get("source_name", "")
                elif isinstance(s, list):
                    sn = ", ".join(x.get("source_name", "") for x in s[:3] if isinstance(x, dict))
                lines.append(f"| `{v}` | {sn[:60]} |")
            if len(items) > 50:
                lines.append(f"| ... | +{len(items)-50} more |")
            lines.append("")

        for ioc_type in sorted(iocs.keys()):
            if ioc_type in priority: continue
            items = iocs[ioc_type]
            label = ioc_labels.get(ioc_type, ioc_type.upper())
            lines.append(f"### {label} ({len(items)})")
            lines.append("")
            lines.append("| Value | Source |")
            lines.append("|-------|--------|")
            for item in items[:30]:
                v = item.get("value", "")
                s = item.get("source", {})
                sn = s.get("source_name", "") if isinstance(s, dict) else ""
                lines.append(f"| `{v}` | {sn[:60]} |")
            lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("> Generated by Threat Intel Auto Collector")

    content = "\n".join(lines)
    Path(output_file).parent.mkdir(parents=True, exist_ok=True)
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(content)

    print(f"Report generated: {output_file}")
    return content


def main():
    parser = argparse.ArgumentParser(description="Generate Markdown report")
    parser.add_argument("--classified", default="data/classified.json", help="Classified JSON")
    parser.add_argument("--ioc", default="data/ioc.json", help="IoC JSON")
    parser.add_argument("--output", default="report.md", help="Output Markdown file")
    args = parser.parse_args()

    with open(args.classified, "r", encoding="utf-8") as f:
        classified = json.load(f)

    ioc_data = None
    if os.path.exists(args.ioc):
        with open(args.ioc, "r", encoding="utf-8") as f:
            ioc_data = json.load(f)

    generate_report(classified, ioc_data, args.output)


if __name__ == "__main__":
    main()
