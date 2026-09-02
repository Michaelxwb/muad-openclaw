"""
Chapter 3 & 4 Crawler — Sangfor Security Wiki
===============================================
Uses Selenium + Chrome to extract vulnerability alerts from the list page.
Detail pages require login — we extract what's visible publicly.

Output: data/ch3_ch4_raw.json
This script is called by run_all.py as part of the unified pipeline.
"""
import json, time, re, os, sys
from datetime import datetime

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options

BASE_URL = "https://sec.sangfor.com.cn"
EVENTS_PAGE = f"{BASE_URL}/wiki-safe-events"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
os.makedirs(OUTPUT_DIR, exist_ok=True)


def create_driver():
    """Headless Chrome with anti-detection"""
    opts = Options()
    opts.add_argument('--headless=new')
    opts.add_argument('--no-sandbox')
    opts.add_argument('--disable-gpu')
    opts.add_argument('--disable-dev-shm-usage')
    opts.add_argument('--window-size=1920,1080')
    opts.add_argument('user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    opts.add_argument('--disable-blink-features=AutomationControlled')
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option('useAutomationExtension', False)
    driver = webdriver.Chrome(options=opts)
    driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
    return driver


def extract_articles_from_list(driver, max_articles=20):
    """Extract article metadata from the list page (publicly visible)"""
    print("  Scanning list page for articles...")
    time.sleep(3)

    articles = []
    links = driver.find_elements(By.TAG_NAME, 'a')
    article_links = []
    seen = set()

    for link in links:
        try:
            href = link.get_attribute('href')
            text = link.text.strip()
            if href and '/wiki-safe-event/' in href and href not in seen:
                seen.add(href)
                if any(kw in text.lower() for kw in ['cve', '漏洞', 'vuln', '补丁', 'patch', 'microsoft']):
                    article_links.append({'url': href, 'title': text})
                elif len(text) > 15 and any('\u4e00' <= c <= '\u9fff' for c in text):
                    article_links.append({'url': href, 'title': text})
        except:
            continue

    print(f"  Found {len(article_links)} candidate articles")

    cve_pattern = re.compile(r'CVE-\d{4}-\d{4,}', re.IGNORECASE)

    for i, al in enumerate(article_links[:max_articles]):
        title_cn = al['title']
        if not title_cn or len(title_cn) < 5:
            continue

        cves = cve_pattern.findall(title_cn)

        articles.append({
            "title_cn": title_cn,
            "cves": cves,
            "url": al['url'],
        })

        if i < len(article_links[:max_articles]) - 1:
            time.sleep(1)

    return articles


def find_ms_bulletin(articles):
    """Find Microsoft bulletin article from the extracted list"""
    for a in articles:
        if any(kw in a['title_cn'] for kw in ['微软补丁', 'Microsoft']):
            return a
    return None


def main():
    days = 15
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == '--days' and i + 1 < len(args):
            days = int(args[i + 1])

    print(f"Ch.3 & Ch.4 Crawler — Sangfor Wiki (Selenium)")
    print(f"Period: last {days} days | Target: {EVENTS_PAGE}")

    driver = create_driver()

    try:
        # Load events page
        print(f"[1/2] Loading events page...")
        driver.get(EVENTS_PAGE)
        time.sleep(5)
        print(f"  Title: {driver.title}")

        # Extract articles
        print(f"[2/2] Extracting articles...")
        articles = extract_articles_from_list(driver, max_articles=20)
        print(f"  Total articles found: {len(articles)}")
        for i, a in enumerate(articles):
            print(f"  {i + 1}. {a['title_cn'][:80]}")

        # Find MS bulletin
        ms_bulletin = find_ms_bulletin(articles)
        print(f"  MS Bulletin: {'Found' if ms_bulletin else 'Not found'}")

        # Save raw JSON
        raw_path = os.path.join(OUTPUT_DIR, "ch3_ch4_raw.json")
        with open(raw_path, 'w', encoding='utf-8') as f:
            json.dump({
                "chapter_3": articles,
                "chapter_4": ms_bulletin,
                "crawl_date": datetime.now().isoformat(),
                "source": EVENTS_PAGE,
                "note": "Detail content requires login. Titles/CVEs are publicly visible.",
            }, f, ensure_ascii=False, indent=2)
        print(f"  Saved: {raw_path}")
        print(f"  DONE — Ch.3: {len(articles)} articles | Ch.4: {'Found' if ms_bulletin else 'Not found'}")

        return raw_path

    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()
        return None
    finally:
        driver.quit()


if __name__ == '__main__':
    main()
