#!/usr/bin/env python3
"""
IoC 提取脚本
从文章标题/摘要/全文提取各类 IoC
用法: python extract_ioc.py --input data/classified.json --output data/ioc.json
"""
import argparse
import hashlib
import ipaddress
import json
import re
import sys
from pathlib import Path

def _noop(x):
    return True


# IoC 正则模式
IOC_PATTERNS = {
    "ipv4": {
        "pattern": re.compile(
            r"\b(?<![-.\d])(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)"
            r"\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)"
            r"\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)"
            r"\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)"
            r"(?![-.\d])"
        ),
        "validator": lambda x: not ipaddress.ip_address(x).is_private,
        "label": "IP",
    },
    "domain": {
        "pattern": re.compile(
            r"\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+"
            r"[a-zA-Z]{2,63}(?![\w.-])"
        ),
        "validator": _noop,
        "label": "DOMAIN",
    },
    "url": {
        "pattern": re.compile(
            r"https?://(?:[-\w.]|(?:%[\da-fA-F]{2}))+(?::\d+)?"
            r"(?:/[-\w%!$&'()*+,./:;=?@~#\[\]]*)?"
        ),
        "validator": _noop,
        "label": "URL",
    },
    "md5": {
        "pattern": re.compile(r"\b[a-fA-F0-9]{32}\b"),
        "validator": _noop,
        "label": "MD5",
    },
    "sha1": {
        "pattern": re.compile(r"\b[a-fA-F0-9]{40}\b"),
        "validator": _noop,
        "label": "SHA1",
    },
    "sha256": {
        "pattern": re.compile(r"\b[a-fA-F0-9]{64}\b"),
        "validator": _noop,
        "label": "SHA256",
    },
    "cve": {
        "pattern": re.compile(r"\bCVE-\d{4}-\d{4,}\b", re.IGNORECASE),
        "validator": _noop,
        "label": "CVE",
    },
    "email": {
        "pattern": re.compile(
            r"\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b"
        ),
        "validator": _noop,
        "label": "EMAIL",
    },
    "registry": {
        "pattern": re.compile(
            r"HKEY_(?:LOCAL_MACHINE|CURRENT_USER|CLASSES_ROOT|USERS|CURRENT_CONFIG)"
            r"\\[^\s,;\[\]]+",
            re.IGNORECASE,
        ),
        "validator": _noop,
        "label": "REGISTRY",
    },
    "filepath": {
        "pattern": re.compile(
            r"(?:[A-Za-z]:\\(?:[^<>:\"/\\|?*\x00-\x1f]+\\)*[^<>:\"/\\|?*\x00-\x1f]*\.(?:exe|dll|sys|vbs|ps1|bat|cmd|js|vbe|hta|scr|com|drv))"
        ),
        "validator": _noop,
        "label": "FILEPATH",
    },
}

# 排除列表（常见无关匹配）
EXCLUDE_VALUES = {
    "example.com", "example.org", "test.com", "localhost", "127.0.0.1",
    "0.0.0.0", "255.255.255.255", "1.2.3.4",
    "microsoft.com", "google.com", "github.com", "twitter.com",
    "x.com", "linkedin.com", "facebook.com",
    "bleepingcomputer.com", "thehackernews.com", "krebsonsecurity.com",
}

EXCLUDE_DOMAIN_PARTS = {
    "microsoft.com", "google.com", "apple.com", "amazon.com",
    "facebook.com", "twitter.com", "linkedin.com", "github.com",
    "wikipedia.org", "youtube.com", "reddit.com",
}

EXCLUDE_HASH = {
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",  # sha256 of empty
    "d41d8cd98f00b204e9800998ecf8427e",  # md5 of empty
    "da39a3ee5e6b4b0d3255bfef95601890afd80709",  # sha1 of empty
}


def extract_from_text(text, source_info=None):
    """从文本中提取 IoC"""
    results = []

    for ioc_type, config in IOC_PATTERNS.items():
        matches = config["pattern"].findall(text)
        seen = set()

        for match in matches:
            m_clean = match.strip().strip("'\"").rstrip(".")

            # 去重
            if m_clean.lower() in seen:
                continue
            seen.add(m_clean.lower())

            # 排除
            if m_clean.lower() in {e.lower() for e in EXCLUDE_VALUES}:
                continue

            # Domain 排除
            if ioc_type == "domain":
                parts = m_clean.lower().split(".")
                for i in range(len(parts) - 1):
                    parent = ".".join(parts[i:])
                    if parent in EXCLUDE_DOMAIN_PARTS:
                        seen.add(m_clean.lower())  # 触达此处前已排除，直接 skip
                        continue

            # Hash 排除
            if ioc_type in ("md5", "sha1", "sha256") and m_clean.lower() in EXCLUDE_HASH:
                continue

            # 验证
            if not config["validator"](m_clean):
                continue

            results.append({
                "type": ioc_type,
                "value": m_clean,
                "source": source_info or {},
            })

    return results


def extract_from_articles(classified_data, output_file="data/ioc.json"):
    """从分类文章批量提取 IoC"""
    all_iocs = {}
    stats = {}

    categories = classified_data.get("categories", {})
    for cat_main, subcats in categories.items():
        for cat_sub, articles in subcats.items():
            for article in articles:
                text_parts = [
                    article.get("title", ""),
                    article.get("summary", ""),
                ]
                combined = " ".join(t for t in text_parts if t)

                source_info = {
                    "article_title": article.get("title", ""),
                    "article_link": article.get("link", ""),
                    "source_name": article.get("source_name", ""),
                    "category": f"{cat_main} > {cat_sub}",
                }

                iocs = extract_from_text(combined, source_info)

                for ioc in iocs:
                    key = f"{ioc['type']}:{ioc['value'].lower()}"
                    if key not in all_iocs:
                        all_iocs[key] = ioc
                    else:
                        # 追加来源
                        existing_src = all_iocs[key].get("source", {})
                        if isinstance(existing_src, dict):
                            all_iocs[key]["source"] = [existing_src, ioc["source"]]

    # 按类型分组
    organized = {}
    for key, ioc in all_iocs.items():
        ioc_type = ioc["type"]
        if ioc_type not in organized:
            organized[ioc_type] = []
        organized[ioc_type].append(ioc)
        stats[ioc_type] = stats.get(ioc_type, 0) + 1

    output = {
        "generated_at": __import__("datetime").datetime.now().isoformat(),
        "total_iocs": sum(stats.values()),
        "stats": stats,
        "iocs": organized,
    }

    Path(output_file).parent.mkdir(parents=True, exist_ok=True)
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"IoC 提取完成: {sum(stats.values())} 个")
    for ioc_type, count in sorted(stats.items()):
        print(f"  {ioc_type}: {count}")

    return output


def main():
    parser = argparse.ArgumentParser(description="IoC 提取")
    parser.add_argument("--input", default="data/classified.json", help="分类结果")
    parser.add_argument("--output", default="data/ioc.json", help="IoC 输出")
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        classified = json.load(f)

    extract_from_articles(classified, args.output)


if __name__ == "__main__":
    main()
