#!/usr/bin/env python3
"""CLI entry point for excel-beautifier — apply visual style templates to Excel files."""

import argparse
import sys
from pathlib import Path

# Allow running from project root without installing
sys.path.insert(0, str(Path(__file__).parent))

from excel_beautifier import process


def main():
    parser = argparse.ArgumentParser(
        prog="excel-beautifier",
        description="为 Excel 表格套用统一视觉规范（classic 经典清单 / modern 现代汇报）",
    )
    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # style command (the only command)
    style_parser = subparsers.add_parser("style", help="为 Excel/CSV 表格套用视觉规范")
    style_parser.add_argument("input", help="输入的 .xlsx / .csv 文件路径")
    style_parser.add_argument(
        "-t", "--theme", default="classic", choices=["classic", "modern"],
        help="主题：classic 经典清单（宋体浅蓝底）/ modern 现代汇报（雅黑斑马纹）。默认 classic",
    )
    style_parser.add_argument(
        "-o", "--output", default=None,
        help="输出 .xlsx 文件路径（默认：xlsx 输入覆盖原文件；csv 输入生成同名 .xlsx）",
    )
    style_parser.add_argument(
        "--watermark", default=None,
        help="水印文字（传入后自动启用水印，样式取主题配置）",
    )

    args = parser.parse_args()
    if args.command != "style":
        parser.print_help()
        sys.exit(1)

    if not Path(args.input).exists():
        sys.exit(f"错误：输入文件不存在：{args.input}")
    if not args.input.lower().endswith((".xlsx", ".csv")):
        sys.exit("错误：仅支持 .xlsx / .csv 格式。.xls 文件请先另存为 .xlsx 再处理")
    if args.output and not args.output.lower().endswith(".xlsx"):
        sys.exit("错误：输出文件必须为 .xlsx 格式")

    try:
        output = process(
            input_path=args.input,
            output_path=args.output,
            theme=args.theme,
            watermark_text=args.watermark,
        )
    except ImportError as e:
        if "PIL" in str(e) or "Pillow" in str(e):
            sys.exit("错误：水印功能需要 Pillow，请先安装：pip install Pillow")
        raise
    print(f"完成：{output}")


if __name__ == "__main__":
    main()
