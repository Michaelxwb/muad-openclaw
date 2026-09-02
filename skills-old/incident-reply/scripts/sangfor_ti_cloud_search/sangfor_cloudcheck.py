import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from aoto_judgement.util import make_post, get_device_token

_BASE_URL = "https://analysis.sangfor.com.cn"
_DEFAULT_PARAMS = {
    "source": "NGAF",
    "deviceId": "DB3EF0D2",
    "deviceVersion": "AF8.0.5",
}


def _build_params(**extra):
    """合并默认设备参数与调用方传入的附加参数。"""
    params = dict(_DEFAULT_PARAMS)
    params.update(extra)
    return params


def file_v1_repu(files):
    """V1 文件云查 信誉"""
    token = get_device_token()
    url = f"{_BASE_URL}/v1/analysis/files?_method=GET&token={token}"
    params = _build_params(fileMd5s=files)
    result = make_post(url, payload=params)
    print(result.json())
    return result


def domains_v2_repu(domains):
    """V2 DNS云查 上下文-基础信息"""
    url = f"{_BASE_URL}/v2/analysis/domain/reputation?_method=GET&token="
    # 测试环境: url = "https://10.65.203.210/v2/analysis/domain/reputation?_method=GET&token="
    params = _build_params(domains=domains, types=["cf"])
    result = make_post(url, json=params, verify=True)
    return result


def domains_v2_context(domains):
    """V2 DNS云查 上下文-基础信息"""
    token = get_device_token()
    url = f"{_BASE_URL}/v2/analysis/domain/context/attributes?_method=GET&token={token}"
    params = _build_params(domains=domains)
    result = make_post(url, payload=params)
    return result


def domains_v2_context_relation(domains):
    """V2 DNS云查 上下文-关联信息"""
    token = get_device_token()
    url = f"{_BASE_URL}/v2/analysis/domain/context/relationships?_method=GET&token={token}"
    print(url)
    params = _build_params(domains=domains)
    result = make_post(url, json=params, verify=True)
    print(result.json())
    return result


def url_v2(urls):
    """V2 url云查"""
    token = get_device_token()
    url = f"{_BASE_URL}/v2/analysis/url/reputation?_method=GET&token={token}"
    params = _build_params(urls=urls)
    result = make_post(url, payload=params)
    return result


def ip_v2(ips, direction):
    """V2 IP云查信誉"""
    token = get_device_token()
    url = f"{_BASE_URL}/v2/analysis/ip/reputation?_method=GET&token={token}"
    ipinfos = [{"ip": ip, "direction": direction} for ip in ips]
    params = _build_params(ipsInfo=ipinfos, types=["cf"])
    result = make_post(url, payload=params)
    return result


def ip_v2_content_base(ips, direction=1):
    """V2 IP云查上下文基础"""
    token = get_device_token()
    url = f"{_BASE_URL}/v2/analysis/ip/context/attributes?_method=GET&token={token}"
    params = _build_params(ips=ips, direction=1)
    result = make_post(url, payload=params)
    return result

def file_v1_sample(file_path, max_retries=10, retry_interval=2, verify=True):
    """V1 文件云查 文件"""
    token = get_device_token()
    url = f"{_BASE_URL}/v1/analysis/files?token={token}"
    params = _build_params(isReply="1", extend={"fullAnalysis": 1})
    file_handle = {'file': open(file_path, 'rb')}
    result = make_post(url=url, payload=params, files=file_handle)
    return result


if __name__ == '__main__':
    # import csv
    #
    # domains = []
    # dns = ""
    # file_name = ("hash.txt")
    # with open(file_name, "r", encoding="utf-8", ) as file:
    #     url_list = [line.strip().split(",")[0] for line in file.readlines()]
    # with open("temp_hash.csv", "a", newline='') as w_file:
    #     writer = csv.writer(w_file)
    #     for urls in [url_list[i:i + 100] for i in range(0, len(url_list), 100)]:
    #         res = file_v1_repu(urls)
    #         res = res.json()
    #         print(res)
    #         if "data" not in res:
    #             continue
    #         for data in res["data"]:
    #             if "domain" in data:
    #                 dns = data["domain"]
    #                 repu = data["threat"]["reputation"]
    #                 tags = data["threat"]["threatLabels"]
    #                 if repu in ["0"]:
    #                     try:
    #                         row = [dns, repu, tags]
    #                         print(row)
    #                         writer.writerow(row)
    #                     except Exception as e:
    #                         print("error:", dns)
    #             if "url" in data:
    #                 dns = data["url"]
    #                 repu = data["threat"]["reputation"]
    #                 tags = data["threat"]["threatLabels"]
    #                 if repu not in []:
    #                     try:
    #                         row = [dns, repu, tags]
    #                         print(row)
    #                         writer.writerow(row)
    #                     except Exception as e:
    #                         print("error:", dns)
    #             if "filemd5" in data:
    #                 dns = data["filemd5"]
    #                 repu = data["info"]["attr"]
    #                 tags = data["info"]["tags"]
    #                 if repu in [0, 1]:
    #                     try:
    #                         row = [dns, repu, tags]
    #                         print(row)
    #                         writer.writerow(row)
    #                     except Exception as e:
    #                         print("error:", dns)
    #             if "ip" in data:
    #                 dns = data["ip"]
    #                 repu = data["threat"]["reputation"]
    #                 tags = data["threat"]["threatLabels"]
    #                 row = [dns, repu, tags]
    #                 writer.writerow(row)
    # if repu in [0, 1]:
    #     try:
    #         row = [dns, repu, tags]
    #         print(row)
    #         writer.writerow(row)
    #     except Exception as e:
    #         print("error:", dns)
    result = ip_v2_content_base(ips=['101.199.254.230', '23.158.56.120'])
    print(result.json())
