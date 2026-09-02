# -*- coding: utf-8 -*-
"""独立客户解析步骤：搜索简称/名称，只展示候选，不启动事件监控。"""

import argparse
import sys

import shared


def non_empty_selector(value: str) -> str:
    selector = str(value or "").strip()
    if not selector:
        raise argparse.ArgumentTypeError("客户简称或名称不能为空")
    return selector


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="解析 MSSP 客户并返回平台完整名称和 company_id")
    parser.add_argument("--company", required=True, type=non_empty_selector,
                        help="必填：客户简称或完整名称；只搜索，不启动监控")
    return parser.parse_args(argv)


def format_result(selector: str, candidates: list) -> str:
    valid = []
    seen = set()
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        name = str(candidate.get("company_name") or "").strip()
        company_id = str(candidate.get("company_id") or "").strip()
        key = (name, company_id)
        if name and company_id.isdigit() and key not in seen:
            valid.append((name, company_id))
            seen.add(key)
    lines = [
        "MSSP客户解析结果",
        "=" * 56,
        f"搜索关键词            : {selector}",
        f"候选客户数量          : {len(valid)}个",
    ]
    if not valid:
        lines.append("结论                  : 未找到包含有效完整名称和数字 company_id 的客户。")
        return "\n".join(lines)
    lines.append("候选客户")
    for index, (name, company_id) in enumerate(valid, 1):
        if index > 1:
            lines.append("-" * 56)
        lines.extend([
            f"候选 {index}",
            f"客户名称              : {name}",
            f"company_id             : {company_id}",
        ])
    lines.append("结论                  : 请确认客户名称和 company_id 后，再使用 company_id 启动监控。")
    return "\n".join(lines)


def main(argv=None) -> int:
    args = parse_args(argv)
    try:
        cookie = shared.get_cookie()
        candidates = shared.search_customers(cookie, args.company)
    except Exception as exc:
        shared.log(f"客户解析失败: {exc}", "ERROR")
        return 1
    print(f"```\n{format_result(args.company, candidates)}\n```")
    return 0


if __name__ == "__main__":
    sys.exit(main())
