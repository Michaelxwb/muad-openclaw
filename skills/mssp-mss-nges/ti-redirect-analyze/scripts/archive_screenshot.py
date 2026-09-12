#!/usr/bin/env python3
"""把 browser 生成的 TI 截图通过脚本归档到可写的事件目录。"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

from PIL import Image


CROP_BOXES = {
    "md5": (50, 90, 950, 430),
    "domain": (50, 90, 900, 268),
    "url": (50, 90, 900, 268),
    "ip": (50, 90, 900, 268),
}


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Archive one TI browser screenshot")
    parser.add_argument("--source", required=True, help="browser 截图路径或 MEDIA:<path>")
    parser.add_argument("--event-dir", required=True, help="run.py 返回的事件目录绝对路径或目录名")
    parser.add_argument("--type", choices=tuple(CROP_BOXES), required=True)
    parser.add_argument("--ioc", required=True)
    parser.add_argument("--label", default="-")
    parser.add_argument("--level", default="-")
    parser.add_argument("--reputation", default="-")
    parser.add_argument("--description", default="-")
    return parser.parse_args(argv)


def resolve_source(value):
    raw = value.strip()
    if raw.startswith("MEDIA:"):
        raw = raw[6:].strip()
    source = Path(raw).expanduser().resolve()
    if not source.is_file():
        raise ValueError("browser 截图文件不存在")
    return source


def resolve_event_dir(value):
    output = os.environ.get("SKILL_OUTPUT_DIR", "").strip()
    if not output:
        raise ValueError("缺少 SKILL_OUTPUT_DIR，无法确定受控归档根")
    archive_root = (Path(output).resolve() / "事件归档").resolve()
    supplied = Path(value).expanduser()
    event_dir = supplied.resolve() if supplied.is_absolute() else (archive_root / supplied).resolve()
    if event_dir != archive_root and archive_root not in event_dir.parents:
        raise ValueError("事件目录必须位于 SKILL_OUTPUT_DIR/事件归档 内")
    if not event_dir.is_dir():
        raise ValueError("事件目录不存在，请使用推送脚本返回的 event_dir")
    return event_dir


def safe_part(value):
    cleaned = re.sub(r"[^A-Za-z0-9._\u4e00-\u9fff-]+", "_", value.strip())
    return cleaned.strip("._-")[:80] or "ioc"


def next_stem(event_dir, ioc_type, ioc):
    base = f"TI_{ioc_type}_{safe_part(ioc)}"
    candidate = base
    index = 2
    while (event_dir / f"{candidate}_原始截图.png").exists() or (event_dir / f"{candidate}_摘要.png").exists():
        candidate = f"{base}_{index}"
        index += 1
    return candidate


def save_images(source, event_dir, stem, ioc_type):
    original_path = event_dir / f"{stem}_原始截图.png"
    summary_path = event_dir / f"{stem}_摘要.png"
    box = CROP_BOXES[ioc_type]
    with Image.open(source) as image:
        image.load()
        if image.width < box[2] or image.height < box[3]:
            raise ValueError(f"截图尺寸 {image.width}x{image.height} 小于裁剪范围 {box[2]}x{box[3]}")
        image.save(original_path, format="PNG")
        image.crop(box).save(summary_path, format="PNG")
    original_path.chmod(0o600)
    summary_path.chmod(0o600)
    return original_path, summary_path


def one_line(value):
    return " ".join(str(value or "-").split()) or "-"


def append_evidence(event_dir, args, original_path, summary_path):
    matches = sorted(event_dir.glob("*_情报截图证据.md"))
    evidence_path = matches[0] if matches else event_dir / "TI_情报截图证据.md"
    first_write = not evidence_path.exists()
    lines = []
    if first_write:
        lines.extend(["# TI 情报截图证据", ""])
    lines.extend([
        f"## {one_line(args.ioc)}", "",
        f"- 类型：{args.type}",
        f"- 标签：{one_line(args.label)}",
        f"- 威胁等级：{one_line(args.level)}",
        f"- 信誉：{one_line(args.reputation)}",
        f"- 危害描述：{one_line(args.description)}",
        f"- 原始截图：{original_path.name}",
        f"- 摘要截图：{summary_path.name}", "",
    ])
    with evidence_path.open("a", encoding="utf-8") as handle:
        handle.write("\n".join(lines))
    evidence_path.chmod(0o600)
    return evidence_path


def main(argv=None):
    args = parse_args(argv)
    source = resolve_source(args.source)
    event_dir = resolve_event_dir(args.event_dir)
    stem = next_stem(event_dir, args.type, args.ioc)
    original_path, summary_path = save_images(source, event_dir, stem, args.type)
    evidence_path = append_evidence(event_dir, args, original_path, summary_path)
    print(json.dumps({
        "status": "archived",
        "original_screenshot": str(original_path),
        "summary_screenshot": str(summary_path),
        "evidence_file": str(evidence_path),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as exc:
        print(f"归档失败: {exc}", file=sys.stderr)
        raise SystemExit(1)
