#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""通过企微群 webhook 发送文件（docx 回函）。复用漏扫 skill 的 send_file_message 逻辑。"""
import os
import json
import urllib.request

CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "webhook_config.json",
)


def send_file_message(file_path: str, message: str = ""):
    webhook_url = json.load(open(CONFIG_PATH, encoding="utf-8"))["webhook_url"]
    key = webhook_url.split("key=")[1]

    file_name = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)
    with open(file_path, "rb") as f:
        file_data = f.read()

    # Step 1: 上传临时文件
    boundary = "----FormBoundary7MA4YWxkTrZu0gW"
    body = (f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="media"; filename="{file_name}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n").encode("utf-8")
    body += file_data
    body += f"\r\n--{boundary}--\r\n".encode("utf-8")

    upload_req = urllib.request.Request(
        f"https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media?key={key}&type=file",
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
    )
    with urllib.request.urlopen(upload_req, timeout=60) as resp:
        upload_result = json.loads(resp.read().decode("utf-8"))
    if upload_result.get("errcode") != 0:
        print(f"[X ERROR] 文件上传失败: {upload_result}", flush=True)
        return False
    media_id = upload_result["media_id"]
    print(f"[INFO] 文件上传成功, media_id={media_id}", flush=True)

    # Step 2: 发送文件消息
    data = json.dumps({
        "msgtype": "file",
        "file": {"media_id": media_id},
    }, ensure_ascii=False).encode("utf-8")
    file_req = urllib.request.Request(
        webhook_url, data=data, headers={"Content-Type": "application/json; charset=utf-8"}
    )
    with urllib.request.urlopen(file_req, timeout=30) as response:
        result = json.loads(response.read().decode("utf-8"))

    if result.get("errcode") != 0:
        print(f"[X ERROR] 文件消息发送失败: {result}", flush=True)
        return False
    print(f"[OK] 文件已发送到企微群: {file_name} ({file_size / 1024:.1f} KB)", flush=True)
    return True


if __name__ == "__main__":
    import sys
    fp = sys.argv[1]
    msg = sys.argv[2] if len(sys.argv) > 2 else "网络安全事件处理反馈单（风行天下）"
    ok = send_file_message(fp, msg)
    sys.exit(0 if ok else 1)
