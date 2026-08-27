#!/usr/bin/env python3
"""MCP Server for excel-beautifier — exposes Excel styling as MCP tools.

Compliant with MCP spec 2024-11-05 (JSON-RPC 2.0 over stdio).
Runs as a subprocess — any MCP-compatible AI tool can connect.
"""

import json
import sys
from pathlib import Path

# Allow running from project root without installing
sys.path.insert(0, str(Path(__file__).parent))

from excel_beautifier import process, load_template, __version__
from excel_beautifier.core import THEMES_DIR


SERVER_INFO = {
    "name": "excel-beautifier",
    "version": __version__,
}

TOOLS = [
    {
        "name": "beautify_excel",
        "description": (
            "为 Excel (.xlsx) / CSV (.csv) 文件套用统一视觉规范：字体、表头色、"
            "底色/斑马纹、边框、数字格式、语义色（等级/状态文字着色）、行高自适应、"
            "页面设置，可选水印。CSV 输入时直出规范 .xlsx（编码自动识别 utf-8/gbk）。"
            "内置主题：classic 经典清单（宋体浅蓝底，适合安全/合规清单）、"
            "modern 现代汇报（雅黑斑马纹，适合汇报/对外）。"
            "默认覆盖原文件（CSV 输入默认生成同名 .xlsx），指定 output_path 则输出新文件。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "输入 .xlsx / .csv 文件的绝对路径",
                },
                "theme": {
                    "type": "string",
                    "description": "主题：classic（默认）或 modern",
                    "default": "classic",
                },
                "output_path": {
                    "type": "string",
                    "description": "输出路径；不传则覆盖输入文件",
                },
                "watermark": {
                    "type": "string",
                    "description": "水印文字；传入后自动启用水印",
                },
            },
            "required": ["file_path"],
        },
    },
    {
        "name": "list_templates",
        "description": "列出所有内置主题及其说明。",
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "show_template",
        "description": "查看某个主题的完整 JSON 配置。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "theme": {
                    "type": "string",
                    "description": "主题：classic（默认）或 modern",
                    "default": "classic",
                },
            },
        },
    },
]


def _send_response(id_, result):
    """Send a JSON-RPC response to stdout."""
    response = {"jsonrpc": "2.0", "id": id_, "result": result}
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _send_error(id_, code, message):
    """Send a JSON-RPC error to stdout."""
    response = {
        "jsonrpc": "2.0",
        "id": id_,
        "error": {"code": code, "message": message},
    }
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _text_result(text):
    """Wrap a plain text string as MCP tool result content."""
    return {"content": [{"type": "text", "text": text}]}


def _default_watermark(theme):
    """Get the theme's default watermark text."""
    try:
        t = load_template(theme)
        return t.get("watermark", {}).get("text", "机密")
    except Exception:
        return "机密"


def handle_request(request):
    """Route an incoming JSON-RPC request to the appropriate handler."""
    method = request.get("method", "")
    params = request.get("params", {})
    req_id = request.get("id")

    try:
        if method == "initialize":
            return _send_response(req_id, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            })

        elif method == "tools/list":
            return _send_response(req_id, {"tools": TOOLS})

        elif method == "tools/call":
            tool_name = params.get("name", "")
            arguments = params.get("arguments", {})

            if tool_name == "beautify_excel":
                file_path = arguments.get("file_path")
                if not file_path:
                    return _send_error(req_id, -32602, "Missing required param: file_path")
                if not Path(file_path).exists():
                    return _send_error(req_id, -32602, f"File not found: {file_path}")
                if not file_path.lower().endswith((".xlsx", ".csv")):
                    return _send_error(req_id, -32602,
                                       "仅支持 .xlsx / .csv 格式。.xls 请先另存为 .xlsx")

                theme = arguments.get("theme", "classic")
                output = process(
                    input_path=file_path,
                    output_path=arguments.get("output_path"),
                    theme=theme,
                    watermark_text=arguments.get("watermark"),
                )
                return _send_response(req_id, _text_result(
                    f"样式处理完成。\n"
                    f"主题: {theme}\n"
                    f"输出: {output}\n"
                    f"应用: 字体/表头/底色·斑马纹/边框/数字格式/语义色/行高自适应/页面设置"
                    + (f"\n水印: {arguments.get('watermark', _default_watermark(theme))}"
                       if arguments.get("watermark") else "")
                ))

            elif tool_name == "list_templates":
                themes = []
                for p in sorted(THEMES_DIR.glob("*.json")):
                    if p.stem == "shared_semantic":
                        continue
                    t = load_template(p.stem)
                    meta = t.get("_meta", {})
                    themes.append(f"- {p.stem}: {meta.get('label', '')} — {meta.get('description', '')}")
                return _send_response(req_id, _text_result(
                    "内置主题：\n" + "\n".join(themes)
                ))

            elif tool_name == "show_template":
                theme = arguments.get("theme", "classic")
                t = load_template(theme)
                return _send_response(req_id, _text_result(
                    f"主题: {theme}\n" + json.dumps(t, indent=2, ensure_ascii=False)
                ))

            else:
                return _send_error(req_id, -32601, f"Unknown tool: {tool_name}")

        elif method == "notifications/initialized":
            # No response needed for notifications
            pass

        else:
            return _send_error(req_id, -32601, f"Unknown method: {method}")

    except Exception as e:
        return _send_error(req_id, -32603, str(e))


def main():
    """Main loop: read JSON-RPC from stdin, respond on stdout."""
    # Log to stderr only (stdout is the MCP transport)
    sys.stderr.write(f"[excel-beautifier MCP server v{__version__}] started\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            handle_request(request)
        except json.JSONDecodeError as e:
            sys.stderr.write(f"Invalid JSON: {e}\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()
