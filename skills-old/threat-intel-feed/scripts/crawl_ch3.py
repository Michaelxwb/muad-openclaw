"""
Chapter 3: Vulnerability Intelligence Summary
=============================================
Crawls vulnerability alerts from Sangfor Security Wiki using Selenium.
Calls the detail API to get full event description + solution.
Merges both sections, strips chapters 6 & 7, applies numbering hierarchy.
"""
import json, time, re, os, sys
from datetime import datetime

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options

BASE_URL = "https://sec.sangfor.com.cn"
EVENTS_PAGE = f"{BASE_URL}/wiki-safe-events"
SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(SKILL_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)


def create_driver():
    opts = Options()
    opts.add_argument('--headless=new')
    opts.add_argument('--no-sandbox')
    opts.add_argument('--disable-gpu')
    opts.add_argument('--disable-dev-shm-usage')
    opts.add_argument('--window-size=1920,1080')
    opts.add_argument('user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    opts.add_argument('--disable-blink-features=AutomationControlled')
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option('useAutomationExtension', False)
    driver = webdriver.Chrome(options=opts)
    driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
    return driver


def extract_article_list(driver):
    """Get article links from the list page"""
    print("  Scanning article list...")
    time.sleep(3)
    links = driver.find_elements(By.TAG_NAME, 'a')
    article_links = []
    seen = set()

    for link in links:
        try:
            href = link.get_attribute('href')
            text = link.text.strip()
            if href and '/wiki-safe-event/' in href and href not in seen:
                seen.add(href)
                # Extract row_key from URL
                m = re.search(r'/wiki-safe-event/([a-zA-Z0-9+/=]+?)(?:/\d+|$)', href)
                if m and text and len(text) > 10:
                    article_links.append({
                        'url': href,
                        'title': text,
                        'row_key': m.group(1),
                    })
        except:
            continue

    # Remove MS bulletin entries from chapter 3
    vuln_articles = [a for a in article_links if not any(
        kw in a['title'] for kw in ['微软补丁', 'Microsoft', '补丁日', 'Patch Tuesday']
    )]
    print(f"  Found {len(vuln_articles)} vulnerability articles")
    return vuln_articles


def fetch_article_detail(driver, row_key):
    """Fetch full article detail via browser API call"""
    script = f"return fetch('/api/v1/wiki_events/query_one_wiki_event?row_key={row_key}').then(r => r.json());"
    try:
        result = driver.execute_script(script)
        if result.get('success') and result.get('data'):
            return result['data']
    except Exception as e:
        print(f"    API error: {e}")
    return None


def clean_article_html(detail_html, solution_html, article_num):
    """
    Merge detail + solution HTML, strip chapters 6 & 7,
    apply numbering hierarchy: 3.X for article, 3.X.Y for sections.
    """
    # Combine: detail has chapters 1-3, solution has 4-7
    # We want chapters 1-5, strip 6 and 7 from solution

    # Strip chapter 6 (参考链接) and 7 (了解更多) from solution
    sol_clean = solution_html
    # Remove everything from "六、参考链接" onwards
    sol_clean = re.sub(r'<h1[^>]*>六、参考链接.*$', '', sol_clean, flags=re.DOTALL)
    # Also try removing from <h1 that contains 六
    sol_clean = re.sub(r'<h1[^>]*>[^<]*六[、．.][^<]*参考[^<]*</h1>.*$', '', sol_clean, flags=re.DOTALL)

    # Combine
    combined = detail_html + sol_clean

    # Apply numbering: convert chapter headings
    # detail: 一、漏洞概要 → keep, 二、漏洞分析 → keep, etc
    # We need to adjust h1/h2 to the 3.X.Y hierarchy

    # Strategy: replace <h1 class="article-photo">X、Title</h1> with <h3>3.X.Y Title</h3>
    # Map: 一→1, 二→2, 三→3, 四→4, 五→5
    # Sub-sections under 二 (2.1, 2.2) become deeper sub-headings

    cn_num_map = {'一': '1', '二': '2', '三': '3', '四': '4', '五': '5'}

    def replace_h1(m):
        content = m.group(1)
        # Extract Chinese number
        for cn, num in cn_num_map.items():
            if content.startswith(cn):
                rest = content.replace(cn + '、', '', 1).replace(cn + '.', '', 1)
                return f'<h3>3.{article_num}.{num} {rest}</h3>'
        return m.group(0)

    combined = re.sub(r'<h1 class="article-photo">(.*?)</h1>', replace_h1, combined)

    # Handle h2 sub-sections: "2.1 组件介绍" → <p class="sub-title">• 组件介绍</p>
    def replace_h2(m):
        content = m.group(1)
        # Remove WPS bookmark anchors inside heading
        content = re.sub(r'<a\s+id="[^"]*_WPSOffice[^"]*"[^>]*></a>', '', content)
        content = re.sub(r'<a\s+id="[^"]*"[^>]*></a>', '', content)
        content = content.strip()
        # Strip the numeric prefix like "2.1", "4.1", "3.1.2.1"
        content = re.sub(r'^[\d]+(?:\.[\d]+)*\s*', '', content)
        return f'<p class="sub-title">• {content}</p>'

    combined = re.sub(r'<h2 class="article-photo">(.*?)</h2>', replace_h2, combined)

    # Clean WPS bookmark anchors
    combined = re.sub(r'<a\s+id="[^"]*_WPSOffice[^"]*"></a>', '', combined)

    # Fix image src (ensure absolute)
    combined = combined.replace('src="http://secimg', 'src="https://secimg')

    return combined


def build_chapter3_html(articles_data):
    """Build complete Chapter 3 HTML with merged articles"""
    now = datetime.now()
    date_str = now.strftime("%Y-%m-%d %H:%M")

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>第三章：漏洞情报摘要</title>
<style>
    body {{
        font-family: 'Segoe UI', 'Microsoft YaHei', Arial, sans-serif;
        max-width: 1000px;
        margin: 0 auto;
        padding: 20px;
        color: #333;
        line-height: 1.8;
    }}
    h1 {{ color: #1a3a5c; border-bottom: 3px solid #1a3a5c; padding-bottom: 12px; font-size: 1.8em; }}
    h2 {{ color: #2c5f8a; border-bottom: 2px solid #2c5f8a; padding-bottom: 8px; margin-top: 40px; font-size: 1.4em; }}
    h3 {{ color: #3a7ab5; margin-top: 30px; font-size: 1.15em; }}
    h4 {{ color: #555; margin-top: 20px; font-size: 1.05em; }}
    .sub-title {{
        font-weight: 600;
        color: #333;
        margin-top: 16px;
        margin-bottom: 6px;
        font-size: 1em;
    }}
    .meta {{ color: #666; font-size: 0.9em; margin-bottom: 30px; }}
    .article {{ background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px; padding: 25px; margin: 25px 0; }}
    .article-hd {{ border-bottom: 2px solid #3a7ab5; padding-bottom: 15px; margin-bottom: 20px; }}
    .article-hd h2 {{ margin: 0; border: none; color: #1a3a5c; font-size: 1.3em; }}
    .article-hd h2 a {{ color: #1a3a5c; text-decoration: none; }}
    .article-hd h2 a:hover {{ text-decoration: underline; }}
    .article-hd .cve-tag {{
        display: inline-block;
        background: #dc3545;
        color: white;
        padding: 2px 10px;
        border-radius: 3px;
        font-size: 0.85em;
        margin-right: 8px;
        font-family: monospace;
    }}
    .article-hd .pub-date {{ color: #888; font-size: 0.85em; margin-top: 5px; }}
    .article-body {{ }}
    .article-body table {{
        border-collapse: collapse;
        width: 100%;
        margin: 15px 0;
        font-size: 0.9em;
    }}
    .article-body table td {{
        border: 1px solid #dee2e6;
        padding: 8px 12px;
        vertical-align: top;
    }}
    .article-body table td:first-child {{
        background: #f1f3f5;
        font-weight: 600;
        width: 140px;
        white-space: nowrap;
    }}
    .article-body img {{
        max-width: 100%;
        height: auto;
        margin: 10px 0;
    }}
    .article-body p {{ margin: 8px 0; }}
    .footer {{
        margin-top: 50px;
        padding-top: 25px;
        border-top: 1px solid #dee2e6;
        color: #999;
        font-size: 0.85em;
        text-align: center;
    }}
</style>
</head>
<body>

<h1>第三章：漏洞情报摘要</h1>
<p class="meta">
    <strong>生成时间：</strong>{date_str}<br>
    <strong>数据来源：</strong>深信服安全Wiki (<a href="{EVENTS_PAGE}">sec.sangfor.com.cn</a>)<br>
    <strong>本期收录：</strong>{len(articles_data)} 篇漏洞预警
</p>
"""

    for idx, art in enumerate(articles_data, 1):
        title = art['title']
        cves = re.findall(r'CVE-\d{4}-\d{4,}', title)
        pub_time = art.get('edit_time', '')
        url = art.get('url', '#')
        body_html = art.get('body_html', '')

        cve_tags = ''.join(f'<span class="cve-tag">{c}</span>' for c in cves)

        html += f"""
<div class="article">
    <div class="article-hd">
        <h2>3.{idx} <a href="{url}" target="_blank">{title}</a></h2>
        <div class="pub-date">{cve_tags} 发布时间：{pub_time}</div>
    </div>
    <div class="article-body">
        {body_html}
    </div>
</div>
"""

    html += f"""
<div class="footer">
    <p>情报半月刊 — 第三章：漏洞情报摘要 | 自动生成于 {date_str}</p>
    <p>数据来源：深信服安全Wiki | 仅供内部参考</p>
</div>
</body>
</html>"""

    output_path = os.path.join(DATA_DIR, "chapter3_report.html")
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"\n  Report: {output_path} ({len(html)} bytes)")
    return output_path


def main():
    days = 15
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == '--days' and i + 1 < len(args):
            days = int(args[i + 1])

    print("=" * 60)
    print("  Chapter 3: Vulnerability Intelligence Summary")
    print(f"  Period: last {days} days")
    print("=" * 60)

    driver = create_driver()

    try:
        # 1. Load main page and get session
        print("\n[1/3] Loading events page...")
        driver.get(EVENTS_PAGE)
        time.sleep(5)
        print(f"  Title: {driver.title}")

        # 2. Extract article list
        print("\n[2/3] Extracting articles...")
        articles = extract_article_list(driver)
        print(f"  Total: {len(articles)} articles")

        # 3. Fetch each article detail
        print(f"\n[3/3] Fetching article details...")
        articles_data = []

        for i, art in enumerate(articles):
            print(f"  [{i+1}/{len(articles)}] {art['title'][:70]}...")
            detail = fetch_article_detail(driver, art['row_key'])

            if detail:
                detail_html = detail.get('detail', '')
                solution_html = detail.get('solution', '')
                body_html = clean_article_html(detail_html, solution_html, i + 1)

                articles_data.append({
                    'title': detail.get('title', art['title']),
                    'edit_time': detail.get('edit_time', ''),
                    'url': art['url'],
                    'body_html': body_html,
                })
                print(f"    OK ({len(detail_html)} + {len(solution_html)} chars → {len(body_html)} chars)")
            else:
                print(f"    FAILED - skipping")
                articles_data.append({
                    'title': art['title'],
                    'edit_time': '',
                    'url': art['url'],
                    'body_html': '<p>详情获取失败，请登录深信服社区查看原文。</p>',
                })

            time.sleep(1)

        # 4. Save JSON and build HTML
        json_path = os.path.join(DATA_DIR, "chapter3_data.json")
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(articles_data, f, ensure_ascii=False, indent=2)
        print(f"\n  JSON data: {json_path}")

        html_path = build_chapter3_html(articles_data)

        print(f"\n{'=' * 60}")
        print(f"  DONE — {len(articles_data)} articles")
        print(f"  Report: {html_path}")
        print("=" * 60)

        return html_path

    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback
        traceback.print_exc()
        return None
    finally:
        driver.quit()


if __name__ == '__main__':
    main()
