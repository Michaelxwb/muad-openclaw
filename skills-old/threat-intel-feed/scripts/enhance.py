"""
Enhance articles in classified.json with better summaries.
- Prioritizes explicit abstracts from article meta tags
- Cleans RSS boilerplate ("The post X appeared first on...")
- Cleans article header noise ("Key Points", "Research by:", etc.)
- Ensures summaries end at complete sentence boundaries
"""
import json, os, time, re, sys

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
import requests
try:
    from bs4 import BeautifulSoup
except ImportError:
    BeautifulSoup = None

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

# ── Boilerplate & noise patterns ──────────────────────────
RSS_BOILERPLATE = [
    re.compile(r'\s*The post\s+.*?appeared first on\s+.*?\.?\s*$', re.I),
    re.compile(r'\s*Read the (?:full\s+)?(?:analysis|article|post|blog)(?:\s+to learn more)?\.?\s*$', re.I),
    re.compile(r'\s*This (?:article|post|blog)\s+(?:is|was)\s+(?:originally\s+)?(?:posted|published)\s+(?:on|at)\s+.*?\.?\s*$', re.I),
    re.compile(r'\s*Check out\s+.*?\s+for more\s*\.?\s*$', re.I),
    re.compile(r'\s*Continue reading\s*\.?\s*$', re.I),
    re.compile(r'\s*Source:\s*\S+\s*$', re.I),
]

HEADER_NOISE = [
    re.compile(r'^(?:Research by|By)\s*:\s*.+', re.I),
    re.compile(r'^(?:Key\s*(?:Points|Takeaways|Findings))\s*$', re.I),
    re.compile(r'^(?:Introduction|Overview|Background|Summary|Abstract|Executive\s+Summary)\s*$', re.I),
]

ABSTRACT_SELECTORS = [
    '[property="og:description"]', '[name="description"]', '[name="twitter:description"]',
    '.article-abstract', '.post-abstract', '.abstract',
    '.article-excerpt', '.post-excerpt', '.excerpt',
    '.dek', '.subheadline', '.article__deck', '.entry-summary',
]


def fetch_article_content(url, timeout=15):
    """Fetch article page and extract readable text + abstract."""
    if not url or url.startswith('#'):
        return None
    try:
        resp = requests.get(url, headers=HEADERS, timeout=(5, timeout), allow_redirects=True)
        if resp.status_code != 200:
            return None

        if not BeautifulSoup:
            text = re.sub(r'<script[^>]*>.*?</script>', '', resp.text, flags=re.DOTALL | re.I)
            text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL | re.I)
            text = re.sub(r'<[^>]+>', ' ', text)
            text = re.sub(r'\s+', ' ', text).strip()
            return {'full_text': text[:5000], 'abstract': None}

        soup = BeautifulSoup(resp.text, 'html.parser')

        # 1. Try to find explicit abstract first
        abstract = None
        for sel in ABSTRACT_SELECTORS:
            el = soup.select_one(sel)
            if el:
                content = el.get('content', '') if sel.startswith('[') else el.get_text(strip=True)
                if content and len(content) > 60:
                    abstract = content.strip()
                    break

        # 2. Clean article body
        for tag in soup(['script', 'style', 'nav', 'header', 'footer', 'aside', 'noscript', 'iframe', 'form']):
            tag.decompose()

        content = None
        for selector in [
            'article', '[itemprop="articleBody"]', '.article-body', '.article-content',
            '.post-content', '.entry-content', '.blog-content', '.content-body',
            'main', '.main-content', '#content', '.post_body', '.rich_media_content',
            '[data-testid="article-body"]', '.story-body', '.article__body',
        ]:
            el = soup.select_one(selector)
            if el:
                content = el
                break

        if not content:
            content = soup.body or soup

        text = content.get_text(separator='\n', strip=True)
        text = re.sub(r'\n{3,}', '\n\n', text)
        if len(text) > 8000:
            text = text[:8000]

        return {'full_text': text.strip(), 'abstract': abstract}

    except Exception as e:
        print(f"    fetch error: {e}")
        return None


def clean_paragraph(para):
    """Remove boilerplate and header noise from a paragraph."""
    p = para.strip()
    if not p or len(p) < 25:
        return ''

    # Skip paragraphs that are entirely header noise
    for regex in HEADER_NOISE:
        if regex.match(p):
            return ''

    # Remove RSS boilerplate from end
    for regex in RSS_BOILERPLATE:
        p = regex.sub('', p).strip()

    return p


def fix_summary_ending(text, max_chars=600):
    """Ensure summary ends at a complete sentence, not mid-word."""
    if not text:
        return text
    text = text.strip()
    # Strip truncation markers
    text = re.sub(r'\s*\[\.\.\.\]\s*', '. ', text)
    text = re.sub(r'\s*\.\.\.\s*$', '', text)
    text = re.sub(r'\s*…\s*$', '', text)
    text = text.strip()

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

    # Ensure ends with sentence-ending punctuation
    if text and text[-1] not in '.!?。！？':
        text += '.'
    return text


def generate_summary(fetch_result, existing_summary, max_chars=600):
    """Generate clean summary.
    Priority:
      1. explicit abstract from page meta/og:description
      2. clean first paragraphs of article body
      3. existing RSS summary (cleaned)
    """
    if not fetch_result:
        # Fallback to RSS summary
        if existing_summary and len(existing_summary.strip()) > 10:
            s = clean_paragraph(existing_summary.strip())
            if s:
                return fix_summary_ending(s, max_chars)
        return ''

    abstract = fetch_result.get('abstract')
    if abstract:
        s = clean_paragraph(abstract)
        if s and len(s) > 60:
            return fix_summary_ending(s, max_chars)

    # Build from article body paragraphs
    full_text = fetch_result.get('full_text', '')
    if full_text and len(full_text) > 100:
        raw = [p.strip() for p in full_text.split('\n') if len(p.strip()) > 20]
        paragraphs = []
        for p in raw:
            cp = clean_paragraph(p)
            if cp:
                paragraphs.append(cp)

        if paragraphs:
            result = []
            total = 0
            for p in paragraphs[:8]:
                if total + len(p) > max_chars:
                    room = max_chars - total
                    if room > 50:
                        chunk = p[:room + 80]
                        last = -1
                        for ch in '.!?。！？':
                            pos = chunk.rfind(ch, 0, room)
                            if pos > last:
                                last = pos
                        if last > 30:
                            result.append(chunk[:last + 1])
                        elif room > 80:
                            result.append(p[:room])
                    break
                result.append(p)
                total += len(p) + 1

            if result:
                return fix_summary_ending(' '.join(result), max_chars)

    # Final fallback: cleaned RSS
    if existing_summary and len(existing_summary.strip()) > 10:
        s = clean_paragraph(existing_summary.strip())
        if s:
            return fix_summary_ending(s, max_chars)
    return ''


def enhance_classified(input_path, output_path=None, max_articles=60, delay=1.0):
    """Read classified.json, fetch article content, write enhanced version."""
    if output_path is None:
        output_path = input_path

    with open(input_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    total_fetched = 0
    total_enhanced = 0

    def walk_and_enhance(obj, depth=0):
        nonlocal total_fetched, total_enhanced
        if isinstance(obj, list):
            for article in obj:
                if not isinstance(article, dict):
                    continue
                if total_fetched >= max_articles:
                    return

                existing_summary = article.get('summary', '')
                url = article.get('link') or article.get('url', '')

                # Skip if summary is already good (>600 chars)
                if existing_summary and len(existing_summary.strip()) > 600:
                    continue

                title = article.get('title', '')[:80]
                print(f"  [{total_fetched+1}/{max_articles}] {title}", flush=True)

                total_fetched += 1
                if url and url.startswith('http'):
                    result = fetch_article_content(url, timeout=8)
                    new_summary = generate_summary(result, existing_summary)
                    if new_summary and len(new_summary) > max(len(existing_summary or ''), 20):
                        article['summary'] = new_summary
                        if 'link' not in article and url:
                            article['link'] = url
                        total_enhanced += 1
                        print(f"    enhanced: {len(existing_summary or '')} -> {len(new_summary)} chars")
                    else:
                        print(f"    no improvement")
                else:
                    print(f"    no URL")
                time.sleep(delay)

        elif isinstance(obj, dict):
            for k, v in obj.items():
                if k in ('generated_at', 'total_articles', 'kw_direct', 'ai_judged', 'stats',
                         'enhanced_at', 'enhanced_articles'):
                    continue
                walk_and_enhance(v, depth + 1)

    print("Enhancing article summaries...")
    cats = data.get('categories', {})
    walk_and_enhance(cats)

    data['enhanced_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
    data['enhanced_articles'] = total_enhanced

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\n  Enhanced: {total_enhanced}/{total_fetched} articles")
    print(f"  Output: {output_path}")
    return output_path


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', default=os.path.join(DATA_DIR, 'classified.json'))
    parser.add_argument('--output', default=os.path.join(DATA_DIR, 'classified_enhanced.json'))
    parser.add_argument('--max', type=int, default=60)
    parser.add_argument('--delay', type=float, default=1.0)
    args = parser.parse_args()
    enhance_classified(args.input, args.output, args.max, args.delay)
