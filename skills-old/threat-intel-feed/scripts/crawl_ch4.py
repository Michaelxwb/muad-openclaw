"""
Chapter 4: Microsoft Security Bulletin
======================================
Crawls the latest Microsoft Patch Tuesday bulletin from Sangfor Security Wiki.
Merges detail + solution, strips chapters 5/6/7, applies 4.X.Y numbering.
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


def find_ms_bulletin(driver):
    """Find the Microsoft Patch Tuesday bulletin link on the page"""
    print("  Searching for Microsoft bulletin...")
    time.sleep(3)
    links = driver.find_elements(By.TAG_NAME, 'a')
    for link in links:
        try:
            href = link.get_attribute('href')
            text = link.text.strip()
            if href and '/wiki-safe-event/' in href:
                if any(kw in text for kw in ['微软补丁', 'Microsoft', '补丁日', 'Patch Tuesday']):
                    m = re.search(r'/wiki-safe-event/([a-zA-Z0-9+/=]+?)(?:/\d+|$)', href)
                    if m:
                        return {'url': href, 'title': text, 'row_key': m.group(1)}
        except:
            continue
    return None


def fetch_article_detail(driver, row_key):
    """Fetch full article detail via browser API"""
    script = f"return fetch('/api/v1/wiki_events/query_one_wiki_event?row_key={row_key}').then(r => r.json());"
    try:
        result = driver.execute_script(script)
        if result.get('success') and result.get('data'):
            return result['data']
    except Exception as e:
        print(f"    API error: {e}")
    return None


def clean_chapter4_html(detail_html, solution_html):
    """
    Merge detail + solution, strip chapters 5-7, apply chapter 4 numbering:
    Original:
      detail: 一、漏洞概要 / 二、漏洞数据分析 / 2.1 / 2.2 / 三、重要漏洞分析 / 3.1 / 3.2
      solution: 四、解决方案 / 4.1 / 五、参考链接 / 六、时间轴 / 七、了解更多

    Remove: 五、参考链接, 六、时间轴, 七、了解更多
    Renumber:
      一 → 4.1
      二 → 4.2
        2.1 → 4.2.1
        2.2 → 4.2.2
      三 → 4.3
        3.1 → 4.3.1
        3.2 → 4.3.2
      四 → 4.4
        4.1 → 4.4.1
    """
    # Strip chapters 5, 6, 7 from solution
    sol_clean = solution_html
    sol_clean = re.sub(r'<h1[^>]*>五[、．.].*$', '', sol_clean, flags=re.DOTALL)

    # Combine
    combined = detail_html + sol_clean

    # Map original h1 headings by order (they have no Chinese number prefix in Ch4)
    # Order: 漏洞概要 → 4.1, 漏洞数据分析 → 4.2, 重要漏洞分析 → 4.3, 四、解决方案 → 4.4
    h1_order = 0

    def replace_h1(m):
        nonlocal h1_order
        content = m.group(1)
        # Clean internal anchors
        content = re.sub(r'<a\s+id="[^"]*"[^>]*></a>', '', content)
        content = content.strip()
        # Skip empty/nbsp
        if not content or content in ('&nbsp;', '&nbsp;'):
            return ''
        h1_order += 1
        # Strip any leading Chinese number prefix if present (like "四、")
        content = re.sub(r'^[一二三四五六七八九十]+[、．.]\s*', '', content)
        return f'<h3>4.{h1_order} {content}</h3>'

    combined = re.sub(r'<h1 class="article-photo">(.*?)</h1>', replace_h1, combined)

    # Handle h2 sub-sections: strip numeric prefix, use bullet
    def replace_h2(m):
        content = m.group(1)
        content = re.sub(r'<a\s+id="[^"]*"[^>]*></a>', '', content)
        content = content.strip()
        # Skip empty/nbsp
        if not content or content in ('&nbsp;', '&nbsp;'):
            return ''
        # Strip numeric prefix like "2.1", "3.1", "4.1"
        content = re.sub(r'^[\d]+(?:\.[\d]+)*\s*', '', content)
        return f'<p class="sub-title">• {content}</p>'

    combined = re.sub(r'<h2 class="article-photo">(.*?)</h2>', replace_h2, combined)

    # Clean WPS anchors globally
    combined = re.sub(r'<a\s+id="[^"]*_WPSOffice[^"]*"></a>', '', combined)
    combined = re.sub(r'<a\s+id="[^"]*_Toc\d+[^"]*"></a>', '', combined)

    # Fix image URLs
    combined = combined.replace('src="http://secimg', 'src="https://secimg')

    return combined


def build_html(ch4_data, output_path):
    """Build standalone Chapter 4 HTML"""
    now = datetime.now()
    date_str = now.strftime("%Y-%m-%d %H:%M")

    title = ch4_data['title']
    pub_time = ch4_data.get('edit_time', '')
    url = ch4_data.get('url', '#')
    body = ch4_data.get('body_html', '')

    # Extract month info from title
    month_match = re.search(r'(\d+)月份', title)
    month = month_match.group(1) if month_match else '?'

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>第四章：微软安全通告</title>
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
    h3 {{ color: #3a7ab5; margin-top: 28px; font-size: 1.15em; }}
    h4 {{ color: #555; margin-top: 20px; font-size: 1.05em; }}
    .sub-title {{
        font-weight: 600;
        color: #333;
        margin-top: 16px;
        margin-bottom: 6px;
        font-size: 1em;
    }}
    .meta {{ color: #666; font-size: 0.9em; margin-bottom: 30px; }}
    .article {{
        background: #f8f9fa;
        border: 1px solid #dee2e6;
        border-radius: 8px;
        padding: 25px;
        margin: 25px 0;
    }}
    .article-hd {{
        border-bottom: 2px solid #3a7ab5;
        padding-bottom: 15px;
        margin-bottom: 20px;
    }}
    .article-hd h2 {{ margin: 0; border: none; color: #1a3a5c; font-size: 1.3em; }}
    .article-hd h2 a {{ color: #1a3a5c; text-decoration: none; }}
    .article-hd .pub-date {{ color: #888; font-size: 0.85em; margin-top: 5px; }}
    .article-body {{ }}
    .article-body table {{
        border-collapse: collapse;
        width: 100%;
        margin: 15px 0;
        font-size: 0.9em;
    }}
    .article-body table td, .article-body table th {{
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

<h1>第四章：微软安全通告</h1>
<p class="meta">
    <strong>生成时间：</strong>{date_str}<br>
    <strong>数据来源：</strong>深信服安全Wiki (<a href="{EVENTS_PAGE}">sec.sangfor.com.cn</a>)<br>
    <strong>本期通告：</strong>微软{month}月补丁日安全通告
</p>

<div class="article">
    <div class="article-hd">
        <h2><a href="{url}" target="_blank">{title}</a></h2>
        <div class="pub-date">发布时间：{pub_time}</div>
    </div>
    <div class="article-body">
        {body}
    </div>
</div>

<div class="footer">
    <p>情报半月刊 — 第四章：微软安全通告 | 自动生成于 {date_str}</p>
    <p>数据来源：深信服安全Wiki | 仅供内部参考</p>
</div>
</body>
</html>"""

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"\n  Report: {output_path} ({len(html)} bytes)")
    return output_path


def main():
    print("=" * 60)
    print("  Chapter 4: Microsoft Security Bulletin")
    print("=" * 60)

    driver = create_driver()

    try:
        print("\n[1/3] Loading events page...")
        driver.get(EVENTS_PAGE)
        time.sleep(5)
        print(f"  Title: {driver.title}")

        print("\n[2/3] Finding Microsoft bulletin...")
        ms = find_ms_bulletin(driver)
        if not ms:
            print("  NOT FOUND — no Microsoft bulletin on page")
            return None
        print(f"  Found: {ms['title'][:80]}")
        print(f"  row_key: {ms['row_key']}")

        print("\n[3/3] Fetching bulletin detail...")
        detail = fetch_article_detail(driver, ms['row_key'])

        if not detail:
            print("  FAILED to fetch detail")
            return None

        detail_html = detail.get('detail', '')
        solution_html = detail.get('solution', '')
        print(f"  detail: {len(detail_html)} chars, solution: {len(solution_html)} chars")

        body_html = clean_chapter4_html(detail_html, solution_html)
        print(f"  cleaned body: {len(body_html)} chars")

        ch4_data = {
            'title': detail.get('title', ms['title']),
            'edit_time': detail.get('edit_time', ''),
            'url': ms['url'],
            'body_html': body_html,
        }

        json_path = os.path.join(DATA_DIR, "chapter4_data.json")
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(ch4_data, f, ensure_ascii=False, indent=2)
        print(f"  JSON: {json_path}")

        output_path = os.path.join(DATA_DIR, "chapter4_report.html")
        build_html(ch4_data, output_path)

        print(f"\n{'=' * 60}")
        print(f"  DONE — Chapter 4: {detail.get('title', '')[:60]}")
        print(f"  Report: {output_path}")
        print("=" * 60)

        return output_path

    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback
        traceback.print_exc()
        return None
    finally:
        driver.quit()


if __name__ == '__main__':
    main()
