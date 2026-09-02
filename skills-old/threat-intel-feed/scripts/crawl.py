#!/usr/bin/env python3
"""
威胁情报爬取脚本
从配置的 RSS/HTML 源爬取最新文章
用法: python crawl.py --days 7 --output data/raw/ [--tags apt,malware]
"""
import argparse
import json
import os
import sys
import time
import random
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

import requests
import feedparser

try:
    from bs4 import BeautifulSoup
except ImportError:
    BeautifulSoup = None

DEFAULT_HEADERS = {
    "User-Agent": "ThreatIntelBot/1.0 (Research; +https://example.com/bot)",
    "Accept": "text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

# 源定义（与 references/sources.md 保持一致）
SOURCES = {
    # 海外安全厂商 - 北美
    "unit42": {
        "name": "Palo Alto Unit 42",
        "rss": "https://unit42.paloaltonetworks.com/feed/",
        "type": "rss",
        "tags": ["apt", "malware", "research"],
        "delay": 30,
    },
    "talos": {
        "name": "Cisco Talos",
        "rss": "https://blog.talosintelligence.com/feed/",
        "type": "rss",
        "tags": ["apt", "malware", "threat-intel"],
        "delay": 30,
    },
    "mandiant": {
        "name": "Mandiant (Google Cloud)",
        "rss": "https://cloud.google.com/blog/products/identity-security/rss",
        "type": "rss",
        "tags": ["apt", "incident-response", "research"],
        "delay": 30,
    },
    "crowdstrike": {
        "name": "CrowdStrike",
        "rss": "https://www.crowdstrike.com/blog/feed/",
        "type": "rss",
        "tags": ["apt", "edr", "incident-response"],
        "delay": 30,
    },
    "sentinelone": {
        "name": "SentinelOne",
        "rss": "https://www.sentinelone.com/blog/feed/",
        "type": "rss",
        "tags": ["edr", "malware", "research"],
        "delay": 30,
    },
    "microsoft_security": {
        "name": "Microsoft Security",
        "rss": "https://www.microsoft.com/en-us/security/blog/feed/",
        "type": "rss",
        "tags": ["vulnerability", "apt", "cloud"],
        "delay": 30,
    },
    "proofpoint": {
        "name": "Proofpoint",
        "rss": "https://www.proofpoint.com/us/rss.xml",
        "type": "rss",
        "tags": ["phishing", "email-security"],
        "delay": 30,
    },
    "zscaler": {
        "name": "Zscaler",
        "rss": "https://www.zscaler.com/blogs/feed",
        "type": "rss",
        "tags": ["cloud", "zero-trust", "threat"],
        "delay": 30,
    },
    "trendmicro": {
        "name": "Trend Micro Research",
        "rss": "https://www.trendmicro.com/en_us/research.html/rss",
        "type": "rss",
        "tags": ["apt", "malware", "iot"],
        "delay": 30,
    },
    "fortinet": {
        "name": "Fortinet",
        "rss": "https://www.fortinet.com/blog/feed",
        "type": "rss",
        "tags": ["apt", "network", "threat-intel"],
        "delay": 30,
    },
    # 海外安全厂商 - 欧洲
    "eset": {
        "name": "ESET Research",
        "rss": "https://www.welivesecurity.com/en/rss/",
        "type": "rss",
        "tags": ["apt", "malware", "research"],
        "delay": 30,
    },
    "kaspersky": {
        "name": "Kaspersky SecureList",
        "rss": "https://securelist.com/feed/",
        "type": "rss",
        "tags": ["apt", "malware", "spam"],
        "delay": 30,
    },
    "sophos": {
        "name": "Sophos X-Ops",
        "rss": "https://news.sophos.com/en-us/category/x-ops/feed/",
        "type": "rss",
        "tags": ["apt", "ransomware", "research"],
        "delay": 30,
    },
    "checkpoint": {
        "name": "Check Point Research",
        "rss": "https://research.checkpoint.com/feed/",
        "type": "rss",
        "tags": ["apt", "malware", "cloud"],
        "delay": 30,
    },
    # 东南亚安全厂商
    "groupib": {
        "name": "Group-IB",
        "rss": "https://www.group-ib.com/blog/feed/",
        "type": "rss",
        "tags": ["apt", "fraud", "threat-intel", "asia"],
        "delay": 30,
    },
    # 安全机构
    "ncsc_uk": {
        "name": "NCSC UK",
        "rss": "https://www.ncsc.gov.uk/api/1/services/v1/all-rss-feed.rss",
        "type": "rss",
        "tags": ["advisory", "government"],
        "delay": 30,
    },
    "jpcert": {
        "name": "JPCERT/CC",
        "rss": "https://www.jpcert.or.jp/english/rss/jpcert.rdf",
        "type": "rss",
        "tags": ["apt", "advisory", "asia"],
        "delay": 30,
    },
    "sans_isc": {
        "name": "SANS ISC",
        "rss": "https://isc.sans.edu/diary/rss",
        "type": "rss",
        "tags": ["threat-intel", "diary"],
        "delay": 30,
    },
    # 独立安全博客/媒体
    "krebs": {
        "name": "Krebs on Security",
        "rss": "https://krebsonsecurity.com/feed/",
        "type": "rss",
        "tags": ["cybercrime", "investigation"],
        "delay": 30,
    },
    "bleepingcomputer": {
        "name": "BleepingComputer",
        "rss": "https://www.bleepingcomputer.com/feed/",
        "type": "rss",
        "tags": ["malware", "ransomware", "news"],
        "delay": 30,
    },
    "thehackernews": {
        "name": "The Hacker News",
        "rss": "https://feeds.feedburner.com/TheHackersNews",
        "type": "rss",
        "tags": ["news", "vulnerability", "cybercrime"],
        "delay": 30,
    },
    "darkreading": {
        "name": "Dark Reading",
        "rss": "https://www.darkreading.com/rss.xml",
        "type": "rss",
        "tags": ["news", "enterprise", "threat"],
        "delay": 30,
    },
    "malwarebytes": {
        "name": "Malwarebytes",
        "rss": "https://www.malwarebytes.com/blog/feed",
        "type": "rss",
        "tags": ["malware", "consumer", "ransomware"],
        "delay": 30,
    },
    "recordedfuture": {
        "name": "Recorded Future",
        "rss": "https://www.recordedfuture.com/blog/rss.xml",
        "type": "rss",
        "tags": ["threat-intel", "research"],
        "delay": 30,
    },
    # 厂商新闻
    "paloalto_ir": {
        "name": "Palo Alto Networks IR",
        "url": "https://investors.paloaltonetworks.com/",
        "type": "html",
        "tags": ["business", "financial"],
        "delay": 60,
    },
    "crowdstrike_ir": {
        "name": "CrowdStrike IR",
        "url": "https://ir.crowdstrike.com/",
        "type": "html",
        "tags": ["business", "financial"],
        "delay": 60,
    },
}


def fetch_rss(source_id, source_conf, days_back=7):
    """拉取 RSS 源文章"""
    import sys
    url = source_conf.get("rss") or source_conf.get("feed")
    if not url:
        print(f"  [SKIP] {source_id}: 无 RSS URL")
        sys.stdout.flush()
        return []

    try:
        resp = requests.get(url, headers=DEFAULT_HEADERS, timeout=20)

        # 处理 feedburner 重定向等
        if resp.status_code != 200:
            print(f"  [WARN] {source_id}: HTTP {resp.status_code}"); sys.stdout.flush()
            return []

        # 检测内容类型
        content_type = resp.headers.get("content-type", "").lower()
        if "html" in content_type and "xml" not in content_type:
            if BeautifulSoup:
                return _parse_html_feed(source_id, source_conf, resp.text, days_back)
            else:
                print(f"  [WARN] {source_id}: HTML response but no bs4 available"); sys.stdout.flush()
                return []

        feed = feedparser.parse(resp.content)
        cutoff = datetime.now() - timedelta(days=days_back)
        articles = []

        for entry in feed.entries:
            pub_date = _parse_date(entry)
            if pub_date and pub_date < cutoff:
                continue

            articles.append({
                "id": entry.get("id", entry.get("link", "")),
                "title": entry.get("title", "No Title").strip(),
                "summary": _clean_html(entry.get("summary", entry.get("description", "")))[:500],
                "link": entry.get("link", ""),
                "published": pub_date.isoformat() if pub_date else None,
                "source_id": source_id,
                "source_name": source_conf["name"],
                "tags": source_conf.get("tags", []),
                "fetched_at": datetime.now().isoformat(),
            })

        print(f"  [OK] {source_id}: {len(articles)} 篇"); sys.stdout.flush()
        return articles

    except requests.RequestException as e:
        print(f"  [ERR] {source_id}: {e}"); sys.stdout.flush()
        return []
    except Exception as e:
        print(f"  [ERR] {source_id}: {e}"); sys.stdout.flush()
        return []


def _parse_date(entry):
    """解析各种 RSS 日期格式"""
    for field in ["published_parsed", "updated_parsed"]:
        tp = getattr(entry, field, None)
        if tp:
            try:
                return datetime(*tp[:6])
            except Exception:
                pass

    for field in ["published", "updated"]:
        val = getattr(entry, field, None)
        if isinstance(val, str):
            for fmt in [
                "%a, %d %b %Y %H:%M:%S %z",
                "%a, %d %b %Y %H:%M:%S %Z",
                "%Y-%m-%dT%H:%M:%S%z",
                "%Y-%m-%dT%H:%M:%S",
                "%Y-%m-%d %H:%M:%S",
            ]:
                try:
                    from datetime import timezone
                    return datetime.strptime(val, fmt).replace(tzinfo=timezone.utc)
                except Exception:
                    continue
    return None


def _clean_html(html_text):
    """去除 HTML 标签"""
    if not html_text:
        return ""
    if BeautifulSoup:
        return BeautifulSoup(html_text, "html.parser").get_text(separator=" ", strip=True)
    # 简易清理
    import re
    return re.sub(r"<[^>]+>", " ", html_text).strip()


def _parse_html_feed(source_id, source_conf, html, days_back):
    """HTML 页面提取文章列表（备用）"""
    soup = BeautifulSoup(html, "html.parser")
    articles = []
    cutoff = datetime.now() - timedelta(days=days_back)

    for container in soup.select("article, .post, .entry, .blog-post, .news-item"):
        try:
            title_el = container.select_one("h1, h2, h3, .title, .headline")
            link_el = container.select_one("a[href]")
            date_el = container.select_one("time, .date, .published")
            summary_el = container.select_one("p, .excerpt, .summary")

            title = title_el.get_text(strip=True) if title_el else None
            if not title:
                continue

            articles.append({
                "id": link_el.get("href", "") if link_el else title,
                "title": title[:200],
                "summary": summary_el.get_text(strip=True)[:500] if summary_el else "",
                "link": _resolve_url(source_conf.get("url", ""), link_el.get("href", "")) if link_el else "",
                "published": date_el.get("datetime", None) if date_el else None,
                "source_id": source_id,
                "source_name": source_conf["name"],
                "tags": source_conf.get("tags", []),
                "fetched_at": datetime.now().isoformat(),
            })
        except Exception:
            continue

    print(f"  [OK] {source_id} (HTML): {len(articles)} 篇")
    return articles


def _resolve_url(base_url, path):
    """相对 URL 转绝对 URL"""
    if not path:
        return ""
    if path.startswith("http"):
        return path
    parsed = urlparse(base_url)
    base = f"{parsed.scheme}://{parsed.netloc}"
    if path.startswith("/"):
        return base + path
    return base + "/" + path


def crawl_sources(sources_filter=None, tags_filter=None, days_back=7, output_dir="data/raw"):
    """批量爬取源"""
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    all_articles = []

    source_ids = sources_filter or list(SOURCES.keys())

    for i, source_id in enumerate(source_ids):
        if source_id not in SOURCES:
            print(f"[SKIP] 未知源: {source_id}")
            continue

        source_conf = SOURCES[source_id]

        # 标签过滤
        if tags_filter:
            source_tags = set(source_conf.get("tags", []))
            if not source_tags & set(tags_filter):
                continue

        print(f"[{i+1}/{len(source_ids)}] {source_id} ({source_conf['name']})")

        articles = fetch_rss(source_id, source_conf, days_back=days_back)

        # 保存每源的结果
        out_file = Path(output_dir) / f"{source_id}.json"
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump(articles, f, ensure_ascii=False, indent=2)

        all_articles.extend(articles)

        # 频率控制
        delay = source_conf.get("delay", 30)
        time.sleep(delay + random.uniform(0, 5))

    # 保存汇总
    summary_file = Path(output_dir) / "_all_articles.json"
    with open(summary_file, "w", encoding="utf-8") as f:
        json.dump(all_articles, f, ensure_ascii=False, indent=2)

    print(f"\n总计: {len(all_articles)} 篇文章来自 {len(source_ids)} 个源")
    return all_articles


def main():
    parser = argparse.ArgumentParser(description="威胁情报爬取")
    parser.add_argument("--days", type=int, default=7, help="爬取最近N天 (默认7)")
    parser.add_argument("--output", default="data/raw", help="输出目录")
    parser.add_argument("--sources", help="指定源ID，逗号分隔")
    parser.add_argument("--tags", help="按标签过滤，逗号分隔")
    parser.add_argument("--list-sources", action="store_true", help="列出所有可用源")
    args = parser.parse_args()

    if args.list_sources:
        for sid, conf in SOURCES.items():
            tags_str = ", ".join(conf.get("tags", []))
            print(f"  {sid:25s} | {conf['name']:30s} | {tags_str}")
        return

    sources = args.sources.split(",") if args.sources else None
    tags = args.tags.split(",") if args.tags else None

    crawl_sources(
        sources_filter=sources,
        tags_filter=tags,
        days_back=args.days,
        output_dir=args.output,
    )


if __name__ == "__main__":
    main()
