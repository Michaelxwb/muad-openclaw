"""
通用 HTML → Word 转换模块
========================
将 standalone HTML 报告（含 ECharts / iframe 动态内容）转换为 .docx 文档。

采用「混合保真」策略：
  - 标题 / 段落 / 表格 / 普通图片 → 结构化映射到 Word 原生元素（可编辑）
  - ECharts 图表 / iframe sketch 图 / JS 动态 SVG → 截图嵌入（保视觉）

入口：
  python -m html_to_word.html_to_word_export --input xxx.html --output xxx.docx
"""

from .html_to_word_export import HtmlToWordExporter, main

__all__ = ["HtmlToWordExporter", "main"]
