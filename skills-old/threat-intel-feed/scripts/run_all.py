"""
情报半月刊 — 主流程
===============
流程：爬取各章节 → 翻译(可选) → 合并HTML → 企微群Webhook发送

用法：
    python run_all.py --days 15 --lang zh --chapters 3,4
    python run_all.py --days 15 --lang en           # 全章节
"""
import os, sys, json, argparse, subprocess, time, requests, re
from datetime import datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(SKILL_DIR, "data")
REFERENCES_DIR = os.path.join(SKILL_DIR, "references")
os.makedirs(DATA_DIR, exist_ok=True)

# ── Translation ─────────────────────────────────────────────
TR_TERMS = {
    "漏洞预警": "Vulnerability Alert",
    "漏洞情报摘要": "Vulnerability Intelligence Summary",
    "微软安全通告": "Microsoft Security Bulletin",
    "微软补丁日安全通告": "Microsoft Patch Tuesday Security Bulletin",
    "事件描述": "Event Description",
    "漏洞描述": "Vulnerability Description",
    "漏洞概要": "Vulnerability Overview",
    "漏洞分析": "Vulnerability Analysis",
    "漏洞数据分析": "Vulnerability Data Analysis",
    "重要漏洞分析": "Critical Vulnerability Analysis",
    "组件介绍": "Component Introduction",
    "影响范围": "Affected Scope",
    "影响版本": "Affected Versions",
    "解决方案": "Solution / Mitigation",
    "修复建议": "Remediation",
    "深信服解决方案": "Sangfor Solution",
    "处置建议": "Handling Recommendations",
    "漏洞摘要": "Vulnerability Summary",
    "危害等级": "Severity Level",
    "严重": "Critical", "高危": "High", "中危": "Medium", "低危": "Low",
    "发布时间": "Published", "更新时间": "Updated",
    "漏洞编号": "Vulnerability ID",
    "参考链接": "References",
    "安全更新": "Security Update",
    "补丁": "Patch",
    "权限提升": "Privilege Escalation",
    "远程代码执行": "Remote Code Execution",
    "拒绝服务": "Denial of Service",
    "信息泄露": "Information Disclosure",
    "堆越界写入": "Heap Out-of-Bounds Write",
    "越界读写": "Out-of-Bounds Read/Write",
    "目录遍历": "Directory Traversal",
    "文件上传": "File Upload",
    "服务器端伪造请求": "Server-Side Request Forgery",
    "预认证": "Pre-Authentication",
    "硬编码凭据": "Hardcoded Credentials",
    "解码器": "Decoder",
    "发布于": "Published",
    "网络安全政策法律动态": "Cybersecurity Policy & Legal Developments",
    "国内政策热点": "Domestic Policy Highlights",
    "国际政策热点": "International Policy Highlights",
    "热点安全事件": "Hot Security Events",
    "安全风险通告": "Security Risk Advisory",
    "时间轴": "Timeline",
    "了解更多": "Learn More",
    "利用条件": "Exploitation Conditions",
    "用户认证": "Authentication Required",
    "触发方式": "Attack Vector",
    "综合评价": "Overall Assessment",
    "官方解决方案": "Official Solution",
    "已发布": "Released",
    "漏洞名称": "Vulnerability Name",
    "组件名称": "Component Name",
    "漏洞类型": "Vulnerability Type",
    "历史微软补丁日": "Historical Microsoft Patch Tuesday",
    "漏洞对比": "Vulnerability Comparison",
    "漏洞数量趋势": "Vulnerability Count Trend",
    "近一年微软补丁漏洞修复情况": "Microsoft Patch Fixes in Past Year",
    "漏洞危险等级对比": "Vulnerability Severity Comparison",
}


def translate_text(text):
    if not text:
        return ""
    result = text
    for cn, en in sorted(TR_TERMS.items(), key=lambda x: -len(x[0])):
        result = result.replace(cn, en)
    return result


# ── Chapter Crawlers ─────────────────────────────────────────

def run_chapter12(days, force_crawl=False):
    """Chapter 1 & 2: Traditional crawler from 42 threat intel sources.
    If classified.json already exists and is recent, reuse it unless force_crawl=True.
    """
    classified_path = os.path.join(DATA_DIR, "classified.json")

    # Reuse existing if available and not forced
    if not force_crawl and os.path.exists(classified_path):
        mtime = os.path.getmtime(classified_path)
        age_hours = (time.time() - mtime) / 3600
        if age_hours < 720:  # less than 30 days old - use cache
            print(f"  Using existing classified.json ({age_hours:.1f}h old)")
            with open(classified_path, "r", encoding="utf-8") as f:
                return json.load(f)
        else:
            print(f"  classified.json is {age_hours:.1f}h old, re-crawling...")
    print("\n" + "=" * 60)
    print("  CHAPTER 1 & 2: Traditional Threat Intel Crawler")
    print("=" * 60)

    crawl_script = os.path.join(SCRIPT_DIR, "crawl.py")
    classify_script = os.path.join(SCRIPT_DIR, "classify.py")
    raw_dir = os.path.join(DATA_DIR, "raw")
    classified_path = os.path.join(DATA_DIR, "classified.json")

    print(f"  [1/2] Crawling {days} days of intel from 42 sources...")
    result = subprocess.run(
        [sys.executable, crawl_script, "--days", str(days), "--output", raw_dir],
        capture_output=True, text=True, cwd=SCRIPT_DIR,
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        encoding="utf-8", errors="replace"
    )
    if result.returncode != 0:
        print(f"  Crawl warning: {result.stderr[:500]}")
    else:
        print(f"  Crawl completed.")

    print(f"  [2/2] Classifying articles...")
    result = subprocess.run(
        [sys.executable, classify_script, "--input", raw_dir, "--output", classified_path],
        capture_output=True, text=True, cwd=SCRIPT_DIR,
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        encoding="utf-8", errors="replace"
    )
    if result.returncode != 0:
        print(f"  Classify warning: {result.stderr[:500]}")

    data = {}
    if os.path.exists(classified_path):
        with open(classified_path, "r", encoding="utf-8") as f:
            data = json.load(f)

    print(f"  Chapter 1&2 done. Articles classified: {len(data)}")
    return data


def run_chapter3(days):
    """Chapter 3: Vulnerability alerts with full detail via API."""
    print("\n" + "=" * 60)
    print("  CHAPTER 3: Vulnerability Alerts (Selenium + Detail API)")
    print("=" * 60)

    script = os.path.join(SCRIPT_DIR, "crawl_ch3.py")
    result = subprocess.run(
        [sys.executable, script, "--days", str(days)],
        capture_output=True, text=True, cwd=SCRIPT_DIR,
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        encoding="utf-8", errors="replace"
    )
    if result.stdout:
        print(result.stdout[-2000:] if len(result.stdout) > 2000 else result.stdout)
    if result.returncode != 0:
        print(f"  Ch3 error: {result.stderr[:500]}")

    data_path = os.path.join(DATA_DIR, "chapter3_data.json")
    if os.path.exists(data_path):
        with open(data_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def run_chapter4():
    """Chapter 4: Microsoft bulletin with full detail via API."""
    print("\n" + "=" * 60)
    print("  CHAPTER 4: Microsoft Bulletin (Selenium + Detail API)")
    print("=" * 60)

    script = os.path.join(SCRIPT_DIR, "crawl_ch4.py")
    result = subprocess.run(
        [sys.executable, script],
        capture_output=True, text=True, cwd=SCRIPT_DIR,
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        encoding="utf-8", errors="replace"
    )
    if result.stdout:
        print(result.stdout[-2000:] if len(result.stdout) > 2000 else result.stdout)
    if result.returncode != 0:
        print(f"  Ch4 error: {result.stderr[:500]}")

    data_path = os.path.join(DATA_DIR, "chapter4_data.json")
    if os.path.exists(data_path):
        with open(data_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


# ── HTML Builder ──────────────────────────────────────────────

COMMON_CSS = """
    body { font-family: 'Segoe UI', 'Microsoft YaHei', Arial, sans-serif; max-width: 1000px; margin: 0 auto; padding: 20px; color: #333; line-height: 1.8; }
    h1 { color: #1a3a5c; border-bottom: 3px solid #1a3a5c; padding-bottom: 12px; font-size: 1.8em; }
    h2 { color: #2c5f8a; border-bottom: 2px solid #2c5f8a; padding-bottom: 8px; margin-top: 40px; font-size: 1.4em; }
    h3 { color: #3a7ab5; margin-top: 28px; font-size: 1.15em; }
    h4 { color: #555; margin-top: 20px; font-size: 1.05em; }
    .sub-title { font-weight: 600; color: #333; margin-top: 16px; margin-bottom: 6px; font-size: 1em; }
    .meta { color: #666; font-size: 0.9em; margin-bottom: 30px; }
    .article { background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px; padding: 25px; margin: 25px 0; }
    .article-hd { border-bottom: 2px solid #3a7ab5; padding-bottom: 15px; margin-bottom: 20px; }
    .article-hd h2 { margin: 0; border: none; color: #1a3a5c; font-size: 1.3em; }
    .article-hd h2 a { color: #1a3a5c; text-decoration: none; }
    .article-hd .pub-date { color: #888; font-size: 0.85em; margin-top: 5px; }
    .article-body { }
    .article-body table { border-collapse: collapse; width: 100%; margin: 15px 0; font-size: 0.9em; }
    .article-body table td, .article-body table th { border: 1px solid #dee2e6; padding: 8px 12px; vertical-align: top; }
    .article-body table td:first-child { background: #f1f3f5; font-weight: 600; width: 140px; white-space: nowrap; }
    .article-body img { max-width: 100%; height: auto; margin: 10px 0; }
    .article-body p { margin: 8px 0; }
    .cve-tag { display: inline-block; background: #dc3545; color: white; padding: 2px 10px; border-radius: 3px; font-size: 0.85em; margin-right: 8px; font-family: monospace; }
    .info-box { background: #d1ecf1; border: 1px solid #bee5eb; border-radius: 5px; padding: 15px; margin: 12px 0; color: #0c5460; }
    .highlight-box { background: #fff3cd; border: 1px solid #ffc107; border-radius: 5px; padding: 15px; margin: 12px 0; }
    .footer { margin-top: 50px; padding-top: 25px; border-top: 1px solid #dee2e6; color: #999; font-size: 0.85em; text-align: center; }
    .toc { background: #f1f3f5; padding: 15px 20px; border-radius: 5px; margin: 20px 0; }
    .toc a { color: #3a7ab5; text-decoration: none; }
"""


def build_html(ch12_data, ch3_data, ch4_data, lang, output_path):
    """Build complete HTML report from all chapters."""
    print(f"\n  Building HTML report (lang={lang})...")

    now = datetime.now()
    date_str = now.strftime("%Y-%m-%d %H:%M")
    translate = (lang == "en")

    def t(text):
        return translate_text(text) if translate else (text or "")

    def esc(text):
        return (text or "").replace('<', '&lt;').replace('>', '&gt;')

    # ── TITLE ──
    html = f"""<!DOCTYPE html>
<html lang="{lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{t('情报半月刊')} — {date_str}</title>
<style>{COMMON_CSS}</style>
</head>
<body>
<h1>{t('情报半月刊')}</h1>
<p class="meta">
    <strong>{t('生成时间')}:</strong> {date_str}<br>
    <strong>{t('数据来源')}:</strong> {t('全球安全厂商/机构技术博客')} + {t('深信服安全Wiki')}
</p>
<div class="toc">
    <strong>{t('目录')}</strong><br>
    <a href="#ch1">{t('第1章：网络安全政策法律动态')}</a><br>
    <a href="#ch2">{t('第2章：热点安全事件')}</a><br>
    <a href="#ch3">{t('第3章：漏洞情报摘要')}</a> ({len(ch3_data) if isinstance(ch3_data, list) else 0} {t('条')})<br>
    <a href="#ch4">{t('第4章：微软安全通告')}</a>
</div>
"""

    # ── Chapter 1 ──
    html += f'<h2 id="ch1">{t("第1章：网络安全政策法律动态")}</h2>\n'
    html += f'<p>{t("本章涵盖近期国内外网络安全政策、法规、标准动态。")}</p>\n'
    if ch12_data:
        cats = ch12_data.get('categories', {})
        # ── 1.1 国内政策热点 ──
        domestic = flatten_categories(cats, '一、网络安全政策法律动态', '国内政策热点')
        if not domestic:
            domestic = flatten_categories(cats, t('一、网络安全政策法律动态'), t('国内政策热点'))
        html = render_article_list(domestic, '1.1 国内政策热点', html, t, esc, max_items=15)

        # ── 1.2 国际政策热点 ──
        intl = flatten_categories(cats, '一、网络安全政策法律动态', '国际政策热点')
        if not intl:
            intl = flatten_categories(cats, t('一、网络安全政策法律动态'), t('国际政策热点'))
        html = render_article_list(intl, '1.2 国际政策热点', html, t, esc, max_items=15)
    else:
        html += '<div class="info-box"><p>第1章未生成。使用 --chapters 1,2,3,4 包含全部章节。</p></div>\n'

    # ── Chapter 2 ──
    html += f'<h2 id="ch2">{t("第2章：热点安全事件")}</h2>\n'
    html += f'<p>{t("本章涵盖近期AI攻防趋势、APT组织攻击技战术、病毒新变种、安全检测技术更新。")}</p>\n'
    if ch12_data:
        cats = ch12_data.get('categories', {})

        # ── 2.1 AI对攻防趋势变化 ──
        ai_trends = flatten_categories(cats, t('二、热点安全事件'), t('AI对攻防趋势变化'))
        if not ai_trends:
            ai_trends = flatten_categories(cats, '二、热点安全事件', 'AI对攻防趋势变化')
        html = render_article_list(ai_trends, '2.1 AI对攻防趋势变化', html, t, esc, max_items=15)

        # ── 2.2 黑客组织攻击技战术更新 ──
        tactics = flatten_categories(cats, t('二、热点安全事件'), t('黑客组织攻击技战术更新'))
        if not tactics:
            tactics = flatten_categories(cats, '二、热点安全事件', '黑客组织攻击技战术更新')
        html = render_article_list(tactics, '2.2 黑客组织攻击技战术更新', html, t, esc, max_items=20)

        # ── 2.3 病毒新变种 ──
        malware = flatten_categories(cats, t('二、热点安全事件'), t('病毒新变种'))
        if not malware:
            malware = flatten_categories(cats, '二、热点安全事件', '病毒新变种')
        html = render_article_list(malware, '2.3 病毒新变种', html, t, esc, max_items=15)

        # ── 2.4 安全检测技术更新 ──
        detection = flatten_categories(cats, t('二、热点安全事件'), t('安全检测技术更新'))
        if not detection:
            detection = flatten_categories(cats, '二、热点安全事件', '安全检测技术更新')
        html = render_article_list(detection, '2.4 安全检测技术更新', html, t, esc, max_items=10)
    else:
        html += '<div class="info-box"><p>第2章未生成。</p></div>\n'

    # ── Chapter 3 ──
    html += f'<h2 id="ch3">{t("第3章：漏洞情报摘要")}</h2>\n'
    html += f'<p>{t("本章汇总近半月深信服安全Wiki发布的漏洞预警文章，包含事件描述与解决方案。")}</p>\n'

    if ch3_data and isinstance(ch3_data, list) and len(ch3_data) > 0:
        for idx, art in enumerate(ch3_data, 1):
            title = art.get('title', '')
            pub_time = art.get('edit_time', '')
            url = art.get('url', '#')
            body_html = art.get('body_html', '')
            cves = re.findall(r'CVE-\d{4}-\d{4,}', title)
            cve_tags = ''.join(f'<span class="cve-tag">{c}</span>' for c in cves)

            if translate:
                title = t(title)
                body_html = translate_body_html(body_html)

            html += f"""
<div class="article">
    <div class="article-hd">
        <h2>3.{idx} <a href="{url}" target="_blank">{esc(title)}</a></h2>
        <div class="pub-date">{cve_tags} {t('发布时间')}: {pub_time}</div>
    </div>
    <div class="article-body">
        {body_html}
    </div>
</div>
"""
    else:
        html += '<div class="info-box"><p>Chapter 3 data not available. Use --chapters 3 to crawl.</p></div>\n'

    # ── Chapter 4 ──
    html += f'<h2 id="ch4">{t("第4章：微软安全通告")}</h2>\n'
    html += f'<p>{t("本章涵盖最新微软补丁日安全通告，包含漏洞概要、漏洞数据分析、重要漏洞分析及解决方案。")}</p>\n'

    if ch4_data:
        title = ch4_data.get('title', '')
        pub_time = ch4_data.get('edit_time', '')
        url = ch4_data.get('url', '#')
        body_html = ch4_data.get('body_html', '')

        if translate:
            title = t(title)
            body_html = translate_body_html(body_html)

        html += f"""
<div class="article">
    <div class="article-hd">
        <h2><a href="{url}" target="_blank">{esc(title)}</a></h2>
        <div class="pub-date">{t('发布时间')}: {pub_time}</div>
    </div>
    <div class="article-body">
        {body_html}
    </div>
</div>
"""
    else:
        html += '<div class="info-box"><p>Chapter 4 data not available. Use --chapters 4 to crawl.</p></div>\n'

    html += f"""
<div class="footer">
    <p><strong>{t('情报半月刊')}</strong> — {t('自动生成于')} {date_str}</p>
    <p>{t('数据来源：深信服安全Wiki + 全球安全情报源')} | {t('仅供内部参考')}</p>
</div>
</body>
</html>"""

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(html)

    print(f"  HTML report: {output_path} ({len(html)} bytes)")
    return output_path


def translate_body_html(html):
    """Translate heading text and Chinese terms within the body HTML."""
    # Translate h3 headings
    def translate_h3(m):
        content = m.group(1)
        inner = re.sub(r'<[^>]+>', '', content)
        translated = translate_text(inner)
        return f'<h3>{translated}</h3>'

    html = re.sub(r'<h3>(.*?)</h3>', translate_h3, html)

    # Translate sub-title paragraphs
    def translate_sub(m):
        content = m.group(1)
        inner = re.sub(r'<[^>]+>', '', content)
        # Strip bullet prefix
        inner = inner.lstrip('• ')
        translated = translate_text(inner)
        return f'<p class="sub-title">• {translated}</p>'

    html = re.sub(r'<p class="sub-title">(.*?)</p>', translate_sub, html)

    # Translate article-content paragraphs (only text content, preserve HTML tags)
    def translate_p(m):
        content = m.group(1)
        # Extract text, translate, and put back with tags preserved
        text = re.sub(r'<[^>]+>', '', content)
        translated = translate_text(text)
        # Replace inner text while preserving <a>, <strong>, <img> tags
        # Simple approach: just do full text replacement
        if text.strip() and text != translated:
            return f'<p class="article-content">{translated}</p>'
        return m.group(0)

    # Only translate simple <p> tags, skip those with complex HTML
    for ptn in [r'(图\s*\d+)', r'(Table\s*\d+)']:
        html = re.sub(ptn, lambda m: translate_text(m.group(1)), html)

    # Translate bullet <li> items
    def translate_li(m):
        content = m.group(1)
        text = re.sub(r'<[^>]+>', '', content)
        translated = translate_text(text)
        if text.strip() and text != translated:
            return f'<li>{translated}</li>'
        return m.group(0)

    html = re.sub(r'<li>(.*?)</li>', translate_li, html)

    # Translate strong tags
    def translate_strong(m):
        content = m.group(1)
        text = re.sub(r'<[^>]+>', '', content)
        translated = translate_text(text)
        return f'<strong>{translated}</strong>'

    html = re.sub(r'<strong>(.*?)</strong>', translate_strong, html)

    return html


# ── Webhook Sender ────────────────────────────────────────────

def load_classified_data():
    """Load classified.json and flatten into ch1/ch2 article lists."""
    path = os.path.join(DATA_DIR, "classified.json")
    if not os.path.exists(path):
        return None
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    return data


def flatten_categories(categories, target_parent, target_child=None):
    """
    Flatten classified.json nested dict into a list of articles.
    
    target_parent: top-level key like '一、网络安全政策法律动态'
    target_child: optional sub-key like '国内政策热点', or None to collect all children
    """
    parent = categories.get(target_parent, {})
    if not isinstance(parent, dict):
        return []

    result = []
    for child_name, articles in parent.items():
        if not isinstance(articles, list):
            continue
        if target_child and child_name != target_child:
            continue
        for a in articles:
            if isinstance(a, dict):
                a = dict(a)
                a['_sub_category'] = child_name
                result.append(a)
    return result


def render_article_list(articles, section_title, html, t, esc, max_items=20):
    """Render a list of articles with filtering for empty summaries."""
    total = len(articles) if articles else 0
    filtered = []
    for item in (articles or []):
        summary = esc(t(item.get('summary', '')))
        if summary.strip() and len(summary.strip()) > 10:
            filtered.append(item)
    if filtered:
        html += f'<h3>{section_title}</h3>\n'
        for i, item in enumerate(filtered[:max_items], 1):
            title = esc(t(item.get('title', 'Untitled')))
            raw_summary = esc(t(item.get('summary', '')))
            summary = fix_summary_ending(raw_summary)
            source = item.get('source_name', item.get('source', ''))
            url = item.get('link', item.get('url', '#'))
            date = item.get('published', '') or ''
            html += f'<div class="article"><h4><a href="{url}" target="_blank">{title}</a></h4><p>{summary}</p><p class="meta"><a href="{url}" target="_blank">{t("原文链接")}</a> | {source} | {date[:10]}</p></div>\n'
    else:
        html += f'<h3>{section_title}</h3>\n'
        html += '<div class="info-box"><p>No articles found in this category.</p></div>\n'
    return html


# ── Summary Cleaning Patterns ───────────────────────────
_SUMMARY_BOILERPLATE = [
    re.compile(r'\s*The post\s+.*?appeared first on\s+.*?\.?\s*$', re.I),
    # Also handle truncated boilerplate ("The post" without "appeared first on")
    re.compile(r'\s*\.?\s*The post\s+[A-Z][\w\s\-:]+(?:\s+(?:article|blog|post|analysis))?\s*$', re.I),
    re.compile(r'\s*Read the (?:full\s+)?(?:analysis|article|post|blog)(?:\s+to learn more)?\.?\s*$', re.I),
    re.compile(r'\s*This (?:article|post|blog)\s+(?:is|was)\s+(?:originally\s+)?(?:posted|published)\s+(?:on|at)\s+.*?\.?\s*$', re.I),
    re.compile(r'\s*Check out\s+.*?\s+for more\s*\.?\s*$', re.I),
    re.compile(r'\s*Continue reading\s*\.?\s*$', re.I),
    # Clean [...] that survived the main regex
    re.compile(r'\s*\.?\s*\[\.\.\.\]\s*\.?\s*$', re.I),
]
_SUMMARY_HEADER_NOISE = [
    # Match header noise patterns anywhere in text (not just line-start)
    re.compile(r'Research by\s*:\s*[A-Z][^.]+\.\s*', re.I),
    re.compile(r'\bKey\s*(?:Points|Takeaways|Findings)\s*\b', re.I),
    re.compile(r'\b(?:Introduction|Overview|Executive\s+Summary)\s*\b', re.I),
]


def fix_summary_ending(text, max_chars=600):
    """Clean summary: strip boilerplate, header noise, [...], and trim to last complete sentence."""
    if not text:
        return text
    text = text.strip()
    # Remove header noise
    for regex in _SUMMARY_HEADER_NOISE:
        text = regex.sub('', text).strip()
    # Remove RSS boilerplate
    for regex in _SUMMARY_BOILERPLATE:
        text = regex.sub('', text).strip()
    # Remove truncation markers
    text = re.sub(r'\s*\[\.\.\.\]\s*', '. ', text)
    text = re.sub(r'\s*\.\.\.\s*$', '', text)
    text = re.sub(r'\s*…\s*$', '', text)
    text = text.strip()
    # Find the last sentence-ending punctuation within max_chars
    if len(text) > max_chars:
        within = text[:max_chars + 100]
        last = -1
        for ch in '.!?。！？':
            pos = within.rfind(ch, 0, max_chars + 50)
            if pos > last:
                last = pos
        if last >= 40:
            return text[:last + 1].strip()
        else:
            return text[:max_chars] + '.'
    # Ensure ends with punctuation (but not double-punct)
    if text:
        text = re.sub(r'([.!?。！？])\1+$', r'\1', text)
        if text[-1] not in '.!?。！？':
            text += '.'
    return text


def load_webhook_config():
    config_path = os.path.join(REFERENCES_DIR, "webhook_config.json")
    if not os.path.exists(config_path):
        return None
    with open(config_path, "r", encoding="utf-8") as f:
        return json.load(f).get("webhook_url")


def send_via_webhook(file_path, webhook_url):
    key = webhook_url.split("key=")[-1] if "key=" in webhook_url else ""
    upload_url = f"https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media?key={key}&type=file"
    filename = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)

    if file_size > 20 * 1024 * 1024:
        print(f"  File too large ({file_size / 1024 / 1024:.1f} MB > 20 MB)")
        return False

    print(f"  Uploading {filename} ({file_size / 1024:.1f} KB)...")
    with open(file_path, 'rb') as f:
        r = requests.post(upload_url, files={'media': (filename, f, 'text/html')}, timeout=30)
    result = r.json()
    if result.get('errcode') != 0:
        print(f"  Upload failed: {result}")
        return False

    media_id = result['media_id']
    print(f"  Uploaded, media_id: {media_id}")

    msg = {"msgtype": "file", "file": {"media_id": media_id}}
    r2 = requests.post(webhook_url, json=msg, timeout=15)
    if r2.json().get('errcode') == 0:
        print(f"  Sent to WeCom group!")
        return True
    else:
        print(f"  Send failed: {r2.json()}")
        return False


# ── Main ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="情报半月刊 — 一键生成并发送")
    parser.add_argument("--days", type=int, default=15, help="爬取最近N天")
    parser.add_argument("--lang", type=str, default="en", choices=["zh", "en"], help="报告语言 (zh=中文, en=英文)")
    parser.add_argument("--chapters", type=str, default="1,2,3,4", help="章节选择（逗号分隔）")
    parser.add_argument("--output", type=str, default="biweekly_threat_report", help="输出文件名基础")
    parser.add_argument("--skip-send", action="store_true", help="跳过企微发送")
    args = parser.parse_args()

    chapters = [c.strip() for c in args.chapters.split(",")]

    print("=" * 60)
    print("  情报半月刊 — Bi-weekly Threat Intelligence Report")
    print(f"  Days: {args.days} | Lang: {args.lang} | Chapters: {args.chapters}")
    print("=" * 60)

    ch12_data = {}
    ch3_data = []
    ch4_data = None

    # Phase 1: Ch1&2
    if "1" in chapters or "2" in chapters:
        print("\nPHASE 1: Chapters 1 & 2")
        ch12_data = run_chapter12(args.days)
        # Enhance summaries by fetching article content
        if ch12_data and os.path.exists(os.path.join(DATA_DIR, "classified.json")):
            enhanced_path = os.path.join(DATA_DIR, "classified_enhanced.json")
            if os.path.exists(enhanced_path):
                e_age = (time.time() - os.path.getmtime(enhanced_path)) / 3600
                if e_age < 720:
                    print(f"  Using existing enhanced.json ({e_age:.1f}h old)")
                    with open(enhanced_path, 'r', encoding='utf-8') as f:
                        ch12_data = json.load(f)
                else:
                    print("  Enhanced data stale, skipping...")
            else:
                print("\nPHASE 1b: Enhancing article summaries...")
                enhance_script = os.path.join(SCRIPT_DIR, "enhance.py")
                subprocess.run(
                    [sys.executable, enhance_script, "--input", os.path.join(DATA_DIR, "classified.json"),
                     "--output", enhanced_path, "--max", "60", "--delay", "1.5"],
                    cwd=SCRIPT_DIR,
                    env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                    encoding="utf-8", errors="replace"
                )
                if os.path.exists(enhanced_path):
                    with open(enhanced_path, 'r', encoding='utf-8') as f:
                        ch12_data = json.load(f)

    # Phase 2: Ch3
    if "3" in chapters:
        print("\nPHASE 2: Chapter 3")
        ch3_data = run_chapter3(args.days)

    # Phase 3: Ch4
    if "4" in chapters:
        print("\nPHASE 3: Chapter 4")
        ch4_data = run_chapter4()

    # Phase 4: Build HTML
    print("\nPHASE 4: Building HTML Report...")
    output_path = os.path.join(DATA_DIR, f"{args.output}.html")
    build_html(ch12_data, ch3_data, ch4_data, args.lang, output_path)

    # Phase 5: Send
    if not args.skip_send:
        print("\nPHASE 5: Sending via WeCom Webhook...")
        webhook_url = load_webhook_config()
        if webhook_url:
            send_via_webhook(output_path, webhook_url)
        else:
            print("  Skipped — no webhook configured.")
    else:
        print("\n  Skipped sending (--skip-send).")

    print("\n" + "=" * 60)
    print(f"  DONE! Report: {output_path}")
    print("=" * 60)


if __name__ == "__main__":
    main()
