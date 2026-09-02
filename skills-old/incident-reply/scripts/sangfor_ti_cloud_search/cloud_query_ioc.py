# -*- coding: utf-8 -*-
"""
域名云查过滤脚本
================
解析 results/*.txt 文件中的所有域名 → 深信服域名云查 → 过滤安全/仿冒网站，输出待研判域名。

用法：
  python cloud_check_domains.py results/wps_20260727_211956.txt
  python cloud_check_domains.py                          # 自动取 results 目录下最新 .txt

输出：
  - 安全域名（跳过）
  - 仿冒网站（fakewebsite，跳过）
  - 待研判域名（需人工研判）
  - 最终待研判列表写入 results/{keyword}_pending.txt
"""
import json
import os
import re
import sys
import time
from typing import Dict, List, Set, Tuple
from urllib.parse import urlparse

import requests

# ── stdout 编码重配置（兼容 Windows GBK 终端打印 emoji）─────────────────────
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass  # Python <3.7 或无 reconfigure 的环境，忽略





_BASE_URL = "https://analysis.sangfor.com.cn"
_DEFAULT_PARAMS = {
    "source": "USERRPT",
    "deviceVersion": "v1.0.0",
     "userName": "mss_claw",
}

# ── 深信服云查配置 ───────────────────────────────────────────────────────────
SANGFOR_AUTH_URL = "https://auth.sangfor.com.cn/v1/auth"
SANGFOR_DEVICE_PARAMS = {
    "source": "USERRPT",
    "apikey": "d0c0b0000a088d72bd46d61d38bc5823e865aa19ea5faec7986c02bf",
    "deviceVersion": "v1.0.0",
    "userName": "mss_claw"
}

DOMAIN_REPU_URL = (
    "https://analysis.sangfor.com.cn/v2/analysis/domain/reputation"
    "?_method=GET&token={token}"
)
BATCH_SIZE = 100  # 单次最多查 100 个域名

# ── fakewebsite 过滤关键词 ───────────────────────────────────────────────────
FAKEWEBSITE_KEYWORDS = [
    "fakewebsite", "fake_website", "仿冒", "钓鱼", "phishing",
    "假冒", "伪造", "欺诈", "fraud",
]

# ── Token 缓存 ──────────────────────────────────────────────────────────────
_token: str | None = None
_token_expire: float = 0


    
    
def make_post(url, headers={}, payload={}, files="", proxies=None, max_retries=10, retry_interval=2):
    retries = 0
    while retries < max_retries:
        try:
            if files != "":
                response = requests.request("POST", url, headers=headers, data=payload, files=files, timeout=120,
                                            proxies=proxies,
                                            verify=True)
            else:
                response = requests.request("POST", url, headers=headers, json=payload, timeout=120, proxies=proxies,
                                            verify=True)
            print(response.json())
            response.raise_for_status()  # 检查响应状态码
            return response
        except RequestException as e:
            print(f"请求发生异常: {e}")
            retries += 1
            if retries < max_retries:
                print(f"重试次数: {retries}/{max_retries}")
                time.sleep(retry_interval)
            else:
                print(str(url) + "达到最大重试次数，放弃请求")
    return None

def _build_params(**extra):
    """合并默认设备参数与调用方传入的附加参数。"""
    params = dict(_DEFAULT_PARAMS)
    params.update(extra)
    return params


def file_v1_repu(files):
    """V1 文件云查 信誉"""
    token = _get_token()
    url = f"{_BASE_URL}/v1/analysis/files?_method=GET&token={token}"
    params = _build_params(fileMd5s=files)
    result = make_post(url, payload=params)
    print(result.json())
    return result


def domains_v2_context(domains):
    """V2 DNS云查 上下文-基础信息"""
    token = _get_token()
    url = f"{_BASE_URL}/v2/analysis/domain/context/attributes?_method=GET&token={token}"
    params = _build_params(domains=domains)
    result = make_post(url, payload=params)
    return result


def domains_v2_context_relation(domains):
    """V2 DNS云查 上下文-关联信息"""
    token = _get_token()
    url = f"{_BASE_URL}/v2/analysis/domain/context/relationships?_method=GET&token={token}"
    print(url)
    params = _build_params(domains=domains)
    result = make_post(url, json=params, verify=True)
    print(result.json())
    return result


def url_v2(urls):
    """V2 url云查"""
    token = _get_token()
    url = f"{_BASE_URL}/v2/analysis/url/reputation?_method=GET&token={token}"
    params = _build_params(urls=urls)
    result = make_post(url, payload=params)
    return result


def ip_v2(ips, direction):
    """V2 IP云查信誉"""
    token = _get_token()
    url = f"{_BASE_URL}/v2/analysis/ip/reputation?_method=GET&token={token}"
    ipinfos = [{"ip": ip, "direction": direction} for ip in ips]
    params = _build_params(ipsInfo=ipinfos, types=["cf"])
    result = make_post(url, payload=params)
    return result


def ip_v2_content_base(ips, direction=1):
    """V2 IP云查上下文基础"""
    token = _get_token()
    url = f"{_BASE_URL}/v2/analysis/ip/context/attributes?_method=GET&token={token}"
    params = _build_params(ips=ips, direction=1)
    result = make_post(url, payload=params)
    return result

def file_v1_sample(file_path, max_retries=10, retry_interval=2, verify=True):
    """V1 文件云查 文件"""
    token = _get_token()
    url = f"{_BASE_URL}/v1/analysis/files?token={token}"
    params = _build_params(isReply="1", extend={"fullAnalysis": 1})
    file_handle = {'file': open(file_path, 'rb')}
    result = make_post(url=url, payload=params, files=file_handle)
    return result





def _get_token() -> str:
    """获取深信服 token（带缓存，有效期 10 分钟）。"""
    global _token, _token_expire
    now = time.time()
    if _token and now < _token_expire:
        return _token
    for attempt in range(5):
        try:
            resp = requests.post(
                SANGFOR_AUTH_URL,
                data=json.dumps(SANGFOR_DEVICE_PARAMS),
                headers={"Content-Type": "application/json"},
                timeout=10,
            )
            resp.raise_for_status()
            _token = resp.json()["data"]["token"]
            _token_expire = now + 600
            return _token
        except Exception as e:
            print(f"  ⚠️  token 获取失败({attempt+1}/5): {e}")
            time.sleep(2)
    raise RuntimeError("深信服 token 获取失败")


def domain_v2_repu(domains: List[str]) -> Dict[str, Tuple[str, str]]:
    """
    批量查询域名信誉。
    返回: {domain: (reputation, tag)}
      reputation: "0"=恶意 "1"=安全 "2"=未知 "3"=可疑 ""=查询失败
    """
    token = _get_token()
    url = DOMAIN_REPU_URL.format(token=token)
    results: Dict[str, Tuple[str, str]] = {}

    for i in range(0, len(domains), BATCH_SIZE):
        batch = domains[i : i + BATCH_SIZE]
        body = {
            "source": "USERRPT",
            "deviceVersion": "v1.0.0",
            "userName": "mss_claw",
            "domains": batch,
        }
        for attempt in range(3):
            try:
                resp = requests.post(url, json=body, timeout=30)
                resp.raise_for_status()
                data = resp.json()
                items = data.get("data", [])
                for item in items:
                    domain = item.get("domain", "") or item.get("request", "")
                    threat = item.get("threat", {})
                    if isinstance(threat, dict):
                        rep = str(threat.get("reputation", ""))
                        labels = threat.get("threatLabels", [])
                        tag_parts = []
                        if isinstance(labels, list):
                            for lbl in labels:
                                if isinstance(lbl, dict):
                                    parts = [
                                        v
                                        for v in (
                                            lbl.get("category"),
                                            lbl.get("family"),
                                            lbl.get("class"),
                                        )
                                        if v
                                    ]
                                    tag_parts.append("/".join(parts))
                        tag = "、".join(tag_parts)
                    else:
                        rep = ""
                        tag = ""
                    results[domain] = (rep, tag)
                break
            except Exception as e:
                print(f"    ⚠️  批次查询失败({attempt+1}/3): {e}")
                time.sleep(1)
        else:
            # 全部失败，标记为空
            for d in batch:
                if d not in results:
                    results[d] = ("", "查询失败")
        if i + BATCH_SIZE < len(domains):
            time.sleep(0.5)

    return results


def _parse_domains_from_file(filepath: str) -> List[str]:
    """从结果文件中提取域名列表。"""
    domains = []
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            # 匹配行首的数字编号后的域名: "   1. 365.wps.cn [Both]"
            match = re.match(r"\s*\d+\.\s+(\S+)", line)
            if match:
                domain = match.group(1)
                if domain and not domain.startswith("http"):
                    domains.append(domain)
    return domains


def _is_fakewebsite(tag: str) -> bool:
    """判断标签是否属于仿冒网站类型。"""
    tag_lower = tag.lower()
    return any(kw in tag_lower for kw in FAKEWEBSITE_KEYWORDS)


def main(domains):
    # ── 深信服云查 ──────────────────────────────────────────────────────────
    results = _batch_query_domains(domains)

    # ── 分类 ────────────────────────────────────────────────────────────────
    safe: List[Tuple[str, str]] = []          # 安全
    fakeweb: List[Tuple[str, str]] = []       # 仿冒网站
    pending: List[Tuple[str, str]] = []       # 待研判
    failed: List[str] = []                    # 查询失败

    for domain in domains:
        rep, tag = results.get(domain, ("", "查询失败"))
        if rep == "1":
            safe.append((domain, tag))
        elif rep == "0" and _is_fakewebsite(tag):
            fakeweb.append((domain, tag))
        elif rep == "":
            failed.append(domain)
        else:
            pending.append((domain, tag))

    # ── 输出 ────────────────────────────────────────────────────────────────
    print(f"\n{'─'*60}")
    print(f"🟢 安全域名（跳过）: {len(safe)} 个")
    print(f"{'─'*60}")
    for domain, tag in safe:
        tag_str = f"  [{tag}]" if tag else ""
        print(f"  {domain}{tag_str}")

    print(f"\n{'─'*60}")
    print(f"🟡 仿冒网站（fakewebsite，跳过）: {len(fakeweb)} 个")
    print(f"{'─'*60}")
    for domain, tag in fakeweb:
        print(f"  {domain}  [{tag}]")

    print(f"\n{'─'*60}")
    print(f"🔴 待研判域名: {len(pending)} 个")
    print(f"{'─'*60}")
    for domain, tag in pending:
        attr_label = {
            "0": "恶意",
            "2": "未知",
            "3": "可疑",
        }.get(results.get(domain, ("", ""))[0], results.get(domain, ("?", ""))[0])
        tag_str = f"  [{tag}]" if tag else ""
        print(f"  {domain:45s} attr={attr_label}{tag_str}")

    if failed:
        print(f"\n{'─'*60}")
        print(f"⚫ 查询失败: {len(failed)} 个")
        print(f"{'─'*60}")
        for domain in failed:
            print(f"  {domain}")

    # ── 汇总 ────────────────────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print(f"汇总")
    print(f"{'='*60}")
    print(f"  总域名数:         {len(domains)}")
    print(f"  安全（跳过）:      {len(safe)}")
    print(f"  仿冒网站（跳过）:  {len(fakeweb)}")
    print(f"  查询失败:          {len(failed)}")
    print(f"  待研判:            {len(pending)}")

