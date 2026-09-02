"""
企微群机器人 Webhook 发送工具
===========================
读取 references/webhook_config.json 配置，上传文件并通过群机器人发送。

用法：
    python send_webhook.py --file report.html
    python send_webhook.py --file report.html --key YOUR_KEY
"""
import os
import sys
import json
import argparse
import requests

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REFERENCES_DIR = os.path.join(SKILL_DIR, "references")


def load_webhook_config():
    """Load webhook URL from config file."""
    config_path = os.path.join(REFERENCES_DIR, "webhook_config.json")
    if not os.path.exists(config_path):
        return None
    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)
    return config.get("webhook_url")


def send_file(file_path, webhook_url):
    """Upload file and send via WeCom bot webhook."""
    filename = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)

    if file_size > 20 * 1024 * 1024:
        print(f"❌ File too large ({file_size / 1024 / 1024:.1f} MB > 20 MB)")
        return False

    key = webhook_url.split("key=")[-1] if "key=" in webhook_url else ""
    upload_url = f"https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media?key={key}&type=file"

    print(f"📤 Uploading {filename} ({file_size / 1024:.1f} KB)...")

    with open(file_path, 'rb') as f:
        r = requests.post(upload_url, files={'media': (filename, f, 'text/html')}, timeout=30)

    result = r.json()
    if result.get('errcode') != 0:
        print(f"❌ Upload failed: {result}")
        return False

    media_id = result['media_id']
    print(f"✅ Uploaded, media_id: {media_id}")

    # Send
    msg = {"msgtype": "file", "file": {"media_id": media_id}}
    r2 = requests.post(webhook_url, json=msg, timeout=15)
    send_result = r2.json()
    if send_result.get('errcode') == 0:
        print(f"✅ Sent to WeCom group!")
        return True
    else:
        print(f"❌ Send failed: {send_result}")
        return False


def main():
    parser = argparse.ArgumentParser(description="企微群机器人文件发送")
    parser.add_argument("--file", required=True, help="要发送的文件路径")
    parser.add_argument("--key", help="Webhook key（可选，默认从配置文件读取）")
    args = parser.parse_args()

    file_path = args.file
    if not os.path.exists(file_path):
        print(f"❌ File not found: {file_path}")
        sys.exit(1)

    if args.key:
        webhook_url = f"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={args.key}"
    else:
        webhook_url = load_webhook_config()

    if not webhook_url:
        print("❌ No webhook URL configured. Set it in references/webhook_config.json or use --key")
        sys.exit(1)

    success = send_file(file_path, webhook_url)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
