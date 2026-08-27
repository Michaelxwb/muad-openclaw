#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
安全组件分布统计脚本。

读取 tmp/device.json，按 devType 聚合设备数，分类为 6 个类别：
- AF、EDR、SIP、STA：4 个明确深信服核心组件（单独显示）
- 深信服其他组件：DEV_TYPE_DICT 中除 AF/EDR/SIP/STA 之外的加总
- 第三方组件：devType 不在 DEV_TYPE_DICT 里的设备

输出 JSON：
{
  "total": 总设备数（含第三方组件）,
  "componentDistribution": [{"name": "AF", "value": 19}, ...]
}
"""
import json
import os
import sys
from collections import Counter

from _path_helper import decode_argv
decode_argv()


# devType → 组件类型名称映射（与 分支1/report/policy_check_export.py 的 DEV_TYPE_DICT 保持一致）
DEV_TYPE_DICT = {
    3: "AF",
    9: "SIP",
    12: "EDR",
    25: "STA",
    72: "云镜-服务版",
    50038: "EDR-探针版",
    19: "aTrust",
    2: "AC",
    15: "云镜",
    100012: "SAAS EDR",
    69: "SaaS NGES",
    37: "CWPP",
    100038: "SaaS-EDR-探针版",
}

# 4 个核心组件（单独显示）
CORE_COMPONENTS = {"AF", "EDR", "SIP", "STA"}

# 饼图类别固定顺序
DISTRIBUTION_ORDER = ["AF", "EDR", "SIP", "STA", "深信服其他组件", "第三方组件"]


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: device_component_stats.py <device.json> [--third-party-count N]")

    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('device_json')
    parser.add_argument('--third-party-count', type=int, default=0,
                        help='第三方设备数量（来自 MSSW 第三方设备统计接口，不在 device.json 里）')
    args = parser.parse_args()

    with open(args.device_json, "r", encoding="utf-8") as f:
        data = json.load(f)

    items = data.get("data", {}).get("list", []) or []
    component_counter = Counter()
    third_party_count = args.third_party_count
    total = 0

    for item in items:
        total += 1
        dev_type = item.get("devType")
        name = DEV_TYPE_DICT.get(dev_type)
        if name:
            component_counter[name] += 1
        else:
            # device.json 里 devType 不在 DEV_TYPE_DICT 里的也算第三方组件
            third_party_count += 1

    # 深信服其他组件 = DEV_TYPE_DICT 里除 AF/EDR/SIP/STA 之外的加总
    sangfor_other_count = sum(
        count for name, count in component_counter.items()
        if name not in CORE_COMPONENTS
    )

    # total 包含第三方设备（device.json 里的 + 接口查到的）
    total += args.third_party_count

    # 按固定顺序构建 distribution，只保留 value > 0 的类别
    distribution_by_name = {
        "AF": component_counter.get("AF", 0),
        "EDR": component_counter.get("EDR", 0),
        "SIP": component_counter.get("SIP", 0),
        "STA": component_counter.get("STA", 0),
        "深信服其他组件": sangfor_other_count,
        "第三方组件": third_party_count,
    }
    distribution = [
        {"name": name, "value": distribution_by_name[name]}
        for name in DISTRIBUTION_ORDER
        if distribution_by_name[name] > 0
    ]

    print(json.dumps({
        "total": total,
        "componentDistribution": distribution
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
