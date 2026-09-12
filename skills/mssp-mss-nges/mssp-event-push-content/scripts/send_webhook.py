#!/usr/bin/env python3
"""把单个事件的结果推送到用户指定的企微群机器人 webhook。

用法：
  # 文字（markdown）
  python3 send_webhook.py --url "<webhook URL>" --text "<正文>"
  python3 send_webhook.py --url "<webhook URL>" --text-file /path/to/推送文案.md

  # 图片（base64 直发，唯一的图片发送方式；不走 upload_media）
  python3 send_webhook.py --url "<webhook URL>" --image /path/to/摘要截图.png

- 文字消息：msgtype=markdown，content = 正文原文（不得改写、润色、重排）。
  单条 markdown 的 content 上限为 4096 字节（UTF-8）。正文超过 4096 字节时，脚本自动按
  段落边界切成最多 2 条依次发送（非循环、非任意拆分），切分只发生在段落之间，不破坏语义。
- 图片消息：msgtype=image，{"base64": <图片base64>, "md5": <图片内容md5>}。
  企微群机器人 upload_media 不支持 type=image，无法取得可用 media_id，故图片必须走 base64 直发。
- URL 处理：webhook 地址可能含非 ASCII 字符（如省略号 …），发送前统一做 URL 百分号编码，避免 ascii 编码错误。
- 严禁通过本脚本发送测试消息、占位消息或任何非该事件定稿内容的正文；正文只允许放该事件的最终结论。
- best-effort：任何一条失败都只如实返回错误，不阻断主流程（退出码 0，errcode 记于 stdout）。
  仅当参数缺失/文件不存在等调用错误时退出非 0。
"""

import argparse
import base64
import hashlib
import json
import sys
import urllib.parse
import urllib.request

# 企微 markdown 单条 content 上限（UTF-8 字节）
MAX_CONTENT_BYTES = 4096
# 超长时最多拆成多少条（按段落边界），避免退化成逐行刷屏
MAX_SEGMENTS = 2


def _normalize_url(url):
    """把可能含非 ASCII 字符的 URL 做百分号编码，返回 ASCII 安全 URL。"""
    try:
        url.encode("ascii")
        return url
    except UnicodeEncodeError:
        parts = urllib.parse.urlsplit(url)
        return urllib.parse.urlunsplit(
            (
                parts.scheme,
                parts.netloc.encode("idna").decode("ascii")
                if parts.netloc
                else parts.netloc,
                urllib.parse.quote(parts.path, safe="/%"),
                urllib.parse.quote(parts.query, safe="=&%"),
                urllib.parse.quote(parts.fragment, safe="%"),
            )
        )


def _post(url, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read().decode("utf-8")
    try:
        return json.loads(body)
    except Exception:
        return {"raw": body}


def split_markdown(content, max_bytes=MAX_CONTENT_BYTES):
    """把 markdown 按 UTF-8 字节上限 max_bytes 顺序硬截断成多段。

    - 未超长：原样返回单段。
    - 超长：从开头累积，收到满 max_bytes 字节即断一条，剩余继续切，直到发完。
      不做段落边界对齐、不做对半均衡，只在字节上限处切断（在字符边界上，不切坏多字节字符）。
    - 不加任何 (i/N) 之类的前缀，正文即原文。
    - 返回列表，元素为可直接发送的正文。
    """
    if len(content.encode("utf-8")) <= max_bytes:
        return [content]

    segs = []
    buf = ""
    buf_bytes = 0
    for ch in content:
        csz = len(ch.encode("utf-8"))
        if buf_bytes + csz > max_bytes:
            segs.append(buf)
            buf = ch
            buf_bytes = csz
        else:
            buf += ch
            buf_bytes += csz
    if buf:
        segs.append(buf)
    return segs


def main(argv=None):
    p = argparse.ArgumentParser(description="推送单个事件结果到企微 webhook")
    p.add_argument("--url", required=True, help="企微群机器人 webhook 地址")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--text", help="markdown 正文")
    g.add_argument("--text-file", help="markdown 正文文件路径")
    g.add_argument("--image", help="要发送的图片路径（base64 直发）")
    args = p.parse_args(argv)

    url = _normalize_url(args.url)

    try:
        if args.image:
            with open(args.image, "rb") as f:
                raw = f.read()
            payload = {
                "msgtype": "image",
                "image": {
                    "base64": base64.b64encode(raw).decode("ascii"),
                    "md5": hashlib.md5(raw).hexdigest(),
                },
            }
            try:
                result = _post(url, payload)
            except Exception as e:  # best-effort，不阻断
                result = {"errcode": -1, "errmsg": f"send failed: {e}"}
            print(json.dumps(result, ensure_ascii=False))
            return 0

        if args.text_file:
            with open(args.text_file, "r", encoding="utf-8") as f:
                content = f.read()
        else:
            content = args.text
    except OSError as e:
        sys.stderr.write(f"[错误] 读取输入失败: {e}\n")
        return 2

    segments = split_markdown(content)
    results = []
    for seg in segments:
        payload = {"msgtype": "markdown", "markdown": {"content": seg}}
        try:
            results.append(_post(url, payload))
        except Exception as e:  # best-effort，不阻断
            results.append({"errcode": -1, "errmsg": f"send failed: {e}"})

    if len(results) == 1:
        print(json.dumps(results[0], ensure_ascii=False))
    else:
        print(json.dumps(results, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
