#!/usr/bin/env python3
"""
PDF 报告生成脚本
将 Markdown 报告转换为 PDF
用法: python to_pdf.py --md report.md --output report.pdf

降级策略: WeasyPrint(GTK) → markdown-pdf → HTML fallback
"""
import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

# Windows GBK 兼容
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

try:
    from weasyprint import HTML
    WEASYPRINT_OK = True
except (ImportError, OSError):
    WEASYPRINT_OK = False


CSS_STYLE = """
<style>
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap');
  body {
    font-family: 'Noto Sans SC', 'Microsoft YaHei', 'Segoe UI', Arial, sans-serif;
    font-size: 13px;
    line-height: 1.7;
    color: #1a1a1a;
    max-width: 800px;
    margin: 0 auto;
    padding: 30px 20px;
  }
  h1 {
    font-size: 24px;
    color: #c0392b;
    border-bottom: 3px solid #c0392b;
    padding-bottom: 12px;
    margin-bottom: 8px;
  }
  h2 {
    font-size: 18px;
    color: #2c3e50;
    border-bottom: 2px solid #3498db;
    padding-bottom: 6px;
    margin-top: 28px;
  }
  h3 {
    font-size: 15px;
    color: #34495e;
    margin-top: 20px;
  }
  h4 {
    font-size: 13.5px;
    color: #2c3e50;
    margin-top: 16px;
    margin-bottom: 4px;
    padding: 6px 10px;
    background: #f0f4f8;
    border-left: 4px solid #3498db;
    border-radius: 0 4px 4px 0;
  }
  blockquote {
    border-left: 3px solid #bdc3c7;
    padding: 4px 14px;
    color: #666;
    margin: 8px 0;
    background: #fafafa;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 10px 0;
    font-size: 12px;
  }
  th {
    background: #2c3e50;
    color: white;
    padding: 8px 12px;
    text-align: left;
  }
  td {
    padding: 6px 12px;
    border-bottom: 1px solid #e0e0e0;
  }
  tr:nth-child(even) td {
    background: #f9f9f9;
  }
  a {
    color: #2980b9;
    text-decoration: none;
    word-break: break-all;
  }
  a:hover { text-decoration: underline; }
  strong { color: #2c3e50; }
  code {
    background: #f4f4f4;
    padding: 1px 5px;
    border-radius: 3px;
    font-family: 'Consolas', 'Courier New', monospace;
    font-size: 11px;
  }
  hr { border: none; border-top: 1px solid #ddd; margin: 20px 0; }
  .page-break { page-break-before: always; }
  @media print {
    body { padding: 0; }
    h1 { font-size: 22px; }
    h2 { font-size: 16px; }
  }
</style>
"""


def md_to_html(md_text):
    """简易 Markdown → HTML 转换（处理情报报告结构）"""
    lines = md_text.split("\n")
    html_lines = []
    in_table = False
    in_code_block = False

    for line in lines:
        # 代码块
        if line.strip().startswith("```"):
            if in_code_block:
                html_lines.append("</pre>")
                in_code_block = False
            else:
                html_lines.append("<pre>")
                in_code_block = True
            continue

        if in_code_block:
            html_lines.append(html_escape(line))
            continue

        # 表格
        if "|" in line and line.strip().startswith("|"):
            if not in_table:
                html_lines.append('<table style="width:100%;font-size:11px;border-collapse:collapse;">')
                in_table = True

            cells = line.strip().strip("|").split("|")
            cells = [c.strip() for c in cells]

            # 跳过分隔行
            if all(re.match(r"^[-:\s]+$", c) for c in cells):
                continue

            # 判断是表头还是数据行
            tag = "th" if ("---" in "".join([l for l in lines[:lines.index(line)]] if line in lines else [])) or all(
                re.match(r"^[-:\s]+$", c) for c in [x.strip() for x in (lines[lines.index(line)+1] if lines.index(line)+1 < len(lines) else "").strip().strip("|").split("|")]
            ) else "td"

            # 更简单的判断：如果下一行是分隔行则为表头
            try:
                current_idx = lines.index(line)
                next_line = lines[current_idx + 1].strip() if current_idx + 1 < len(lines) else ""
                is_header = bool(re.match(r"^\|[-:\s|]+\|$", next_line))
            except Exception:
                is_header = False

            tag = "th" if is_header else "td"

            html_lines.append("<tr>")
            for cell in cells:
                html_lines.append(f"<{tag}>{cell}</{tag}>")
            html_lines.append("</tr>")
            continue
        elif in_table:
            html_lines.append("</table>")
            in_table = False

        # 标题
        if line.startswith("#### "):
            html_lines.append(f'<h4>{html_escape(line[5:])}</h4>')
        elif line.startswith("### "):
            html_lines.append(f"<h3>{html_escape(line[4:])}</h3>")
        elif line.startswith("## "):
            html_lines.append('<div class="page-break"></div>')
            html_lines.append(f"<h2>{html_escape(line[3:])}</h2>")
        elif line.startswith("# "):
            html_lines.append(f"<h1>{html_escape(line[2:])}</h1>")
        # 引用
        elif line.startswith("> "):
            html_lines.append(f"<blockquote>{html_escape(line[2:])}</blockquote>")
        # 分隔线
        elif line.strip() == "---":
            html_lines.append("<hr>")
        # 列表项
        elif line.strip().startswith("- "):
            html_lines.append(f'<li style="margin-left:20px;">{html_escape(line.strip()[2:])}</li>')
        # 空行
        elif line.strip() == "":
            html_lines.append("<br>")
        # 普通段落
        else:
            # 处理行内粗体
            text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", html_escape(line))
            # 处理行内代码
            text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
            # 处理链接 [text](url)
            text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
            html_lines.append(f"<p>{text}</p>")

    if in_table:
        html_lines.append("</table>")

    body = "\n    ".join(html_lines)
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>威胁情报报告</title>
{CSS_STYLE}
</head>
<body>
    {body}
</body>
</html>"""


def html_escape(text):
    """HTML 转义"""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def build_html_report(md_content):
    """一步完成 MD→HTML"""
    return md_to_html(md_content)


def to_pdf(html_content, md_path, output_path):
    """尝试多种方式转 PDF"""
    # 方案1: WeasyPrint
    if WEASYPRINT_OK:
        try:
            HTML(string=html_content).write_pdf(output_path)
            return "weasyprint"
        except Exception as e:
            print(f"  WeasyPrint 失败: {e}")

    # 方案2: pdfkit (wkhtmltopdf)
    try:
        import pdfkit
        # 保存 HTML 临时文件给 pdfkit
        html_path = Path(output_path).with_suffix(".temp.html")
        html_path.write_text(html_content, encoding="utf-8")
        pdfkit.from_file(str(html_path), str(output_path), options={
            "encoding": "UTF-8",
            "no-outline": None,
            "margin-top": "15mm",
            "margin-bottom": "15mm",
        })
        html_path.unlink()
        return "pdfkit"
    except ImportError:
        print(f"  pdfkit 未安装")
    except Exception as e:
        print(f"  pdfkit 失败: {e}")

    # 方案3: 无法生成 PDF，保留 HTML
    return None


def main():
    parser = argparse.ArgumentParser(description="Markdown → PDF 报告")
    parser.add_argument("--md", required=True, help="Markdown 文件路径")
    parser.add_argument("--output", default=None, help="PDF 输出路径（默认同目录同名.pdf）")
    args = parser.parse_args()

    md_path = Path(args.md)
    if not md_path.exists():
        print(f"[ERR] 找不到文件: {md_path}")
        return

    output = Path(args.output) if args.output else md_path.with_suffix(".pdf")

    with open(md_path, "r", encoding="utf-8") as f:
        md_content = f.read()

    print(f"生成 HTML ...")
    html = build_html_report(md_content)

    # 保存中间 html
    html_path = output.with_suffix(".html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"生成 PDF: {output}")
    try:
        method = to_pdf(html, md_path, str(output))
        if method:
            print(f"[OK] PDF 已生成 ({method}): {output}")
        else:
            print(f"[WARN] PDF 生成失败，已保留 HTML: {html_path}")
            print(f"       安装 WeasyPrint: pip install weasyprint")
            print(f"       或安装 markdown-pdf: npm i -g markdown-pdf")
    except Exception as e:
        print(f"[ERR] PDF 生成失败: {e}")
        print(f"      HTML 已保存: {html_path}")


if __name__ == "__main__":
    main()
