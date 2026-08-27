"""
数据统计脚本
============
读取资产清单和策略检查清单，输出 JSON 统计结果。

统计内容：
1. 资产统计：重要级别为"核心"且数据源中不含 aES 类型设备（CWPP、SaaS-EDR-探针版、
   EDR-探针版、EDR、SAAS EDR）的资产 IP 列表及其总数。
   数据源类型解析参考 report.scoring._parse_dev_types_from_datasource。
2. 策略检查统计：策略检查总数、异常项数量、按设备类型聚合的异常项数量、
   按设备聚合的列表（设备名称、设备类型、检查数量、异常数量）。
   异常项定义：策略状态为"异常"或"策略获取失败"，或风险状态为"at_risk"。
   数据源为 tmp/policy_check.json（由 report/policy_check_export.py 的 _save_json 写入），
   字段沿用接口原始字段名：dev_name、dev_type、policy_status、risk_status。
   dev_type 优先取 JSON 中的字段，缺失时按设备名称前缀推断（aES/EDR→EDR，
   SIP→SIP，AF→AF，STA→STA，其他→未知）。

用法:
    python protection_effectiveness.py
    python protection_effectiveness.py --output stats.json
"""

import argparse
import json
import os
import re
import sys

import yaml

# 复用 report.scoring 模块中的数据源解析函数
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scoring import _parse_dev_types_from_datasource  # noqa: E402
from data_reader import read_excel, read_json, resolve_data_file  # noqa: E402
from policy_config import POLICY_HAZARD_LEVEL  # noqa: E402

# 危害等级 → 排序权重：P0 最重排在最前；未知等级放最后
_HAZARD_LEVEL_WEIGHT = {"P0": 0, "P1": 1, "P2": 2, "P3": 3, "P4": 4}
_UNKNOWN_WEIGHT = 5


def _policy_hazard_weight(policy_row: dict) -> int:
    """
    获取策略检查项的危害等级排序权重。

    policy_row 中的 policy_type 字段为接口下发的实际枚举值字符串
    （与 POLICY_HAZARD_LEVEL 的 key 一致），据此查表返回权重；
    未匹配时返回 _UNKNOWN_WEIGHT（排在已知等级之后）。
    """
    policy_type = str(policy_row.get("policy_type", "")).strip()
    level = POLICY_HAZARD_LEVEL.get(policy_type)
    if level is None:
        return _UNKNOWN_WEIGHT
    return _HAZARD_LEVEL_WEIGHT.get(level, _UNKNOWN_WEIGHT)


# 配置文件路径（相对脚本所在目录）
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.yaml")


# ── aES 对应的设备类型集合（小写） ──
# 包括 CWPP、SaaS-EDR-探针版、EDR-探针版、EDR、SAAS EDR
AES_DEVICE_TYPES = {
    "cwpp",
    "saas-edr-探针版",
    "edr-探针版",
    "edr",
    "saas edr",
    "saas-edr",
}


# ── 设备名称前缀到设备类型的映射（用于策略检查的设备类型推断） ──
def _infer_dev_type_from_name(dev_name: str) -> str:
    """
    根据设备名称推断设备类型（dev_type 字段缺失时的回退方案）。

    策略检查 JSON 通常含 dev_type 字段，缺失时按名称前缀推断：
      - aES / EDR 开头  → EDR
      - SIP 开头         → SIP
      - AF 开头          → AF
      - STA 开头         → STA
      - NTA 开头         → NTA
      - 其他             → 未知

    Args:
        dev_name: 设备名称

    Returns:
        设备类型字符串
    """
    if not dev_name or not isinstance(dev_name, str):
        return "未知"

    name = dev_name.strip()
    # 大小写不敏感匹配前缀
    lower = name.lower()
    if lower.startswith("aes"):
        return "EDR"
    if lower.startswith("edr"):
        return "EDR"
    if lower.startswith("sip"):
        return "SIP"
    if lower.startswith("af"):
        return "AF"
    if lower.startswith("sta"):
        return "STA"
    if lower.startswith("nta"):
        return "NTA"
    return "未知"


# ── 异常项判定 ──
def _is_abnormal(policy_row: dict) -> bool:
    """
    判定策略检查行是否为异常项。

    异常定义（字段沿用接口原始字段名）：
      - policy_status 为"异常"或"策略获取失败"
      - 或 risk_status 为"at_risk"

    Args:
        policy_row: 策略检查行字典

    Returns:
        True / False
    """
    risk = str(policy_row.get("risk_status", "")).strip()

    if risk == "at_risk":
        return True
    return False


# ── 统计 1：核心资产且数据源不含 aES ──
def stat_core_assets_without_aes(asset_data: list) -> dict:
    """
    统计重要级别为"核心"且数据源中不含 aES 对应设备类型的资产。

    Args:
        asset_data: 资产清单行列表

    Returns:
        {
            "ips": [ip1, ip2, ...],
            "total": N,
            "hide_hint": bool  # total == 0 时为 True，用于前端控制提示语隐藏
        }
    """

    datasource_col = "数据源"
    ip_col = "IP地址"

    ips = []
    seen = set()
    for row in asset_data:

        datasource_text = str(row.get(datasource_col, "")).strip()
        dev_types = _parse_dev_types_from_datasource(datasource_text)

        # 数据源中含任一 aES 类型则跳过
        if dev_types & AES_DEVICE_TYPES:
            continue

        ip = str(row.get(ip_col, "")).strip()
        if not ip:
            continue
        if ip in seen:
            continue
        seen.add(ip)
        ips.append(ip)

    return {"ips": "、".join(ips[:3]), "total": len(ips), "hide_hint": len(ips) == 0}


# ── 统计 2：策略检查 ──
def stat_policy_check(policy_data: list) -> dict:
    """
    统计策略检查数据。

    Args:
        policy_data: 策略检查行列表

    Returns:
        {
            "total": 策略检查总数,
            "abnormal_count": 异常项数量,
            "abnormal_by_dev_type": {设备类型: 异常数量, ...},
            "abnormal_by_dev_type_text": "设备类型 X 个、设备类型 X 个" 中文顿号分隔文本,
            "abnormal_by_dev_type_bracket": "（设备类型 X 个）" 带括号文本，无异常组件时为空字符串,
            "abnormal_component_count": 异常组件数（abnormal_count > 0 的设备数）,
            "total_component_count": 全部组件数（by_device 长度）,
            "by_device": [
                {
                    "dev_name": 设备名称,
                    "dev_type": 设备类型,
                    "check_count": 检查数量,
                    "abnormal_count": 异常数量
                },
                ...
            ]
        }
    """
    total = len(policy_data)
    abnormal_count = 0
    abnormal_by_dev_type = {}
    device_agg = {}  # dev_name -> {check_count, abnormal_count}
    policy_check_example = []

    for row in policy_data:
        dev_name = str(row.get("dev_name", "")).strip() or "未知"
        # 优先使用 JSON 中的 dev_type，缺失时按设备名称前缀推断
        dev_type = str(row.get("dev_type", "")).strip()
        if not dev_type:
            dev_type = _infer_dev_type_from_name(dev_name)

        if dev_name not in device_agg:
            device_agg[dev_name] = {
                "dev_name": dev_name,
                "dev_type": dev_type,
                "check_count": 0,
                "abnormal_count": 0,
            }
        device_agg[dev_name]["check_count"] += 1

        if _is_abnormal(row):
            abnormal_count += 1
            policy_check_example.append(row)
            device_agg[dev_name]["abnormal_count"] += 1
            abnormal_by_dev_type[dev_type] = abnormal_by_dev_type.get(dev_type, 0) + 1

    by_device = list(device_agg.values())
    # 按检查数量倒序，便于阅读
    by_device.sort(key=lambda x: x["check_count"], reverse=True)

    # policy_check_example 按危害等级排序后取 top5（P0 → P4，未知项放最后）
    policy_check_example.sort(key=_policy_hazard_weight)
    policy_check_example_top5 = policy_check_example[:5]

    # 按设备类型生成"设备类型 X 个"的中文顿号分隔文本，供 HTML 模板直接渲染
    # 顺序：按异常数量倒序，便于阅读
    abnormal_by_dev_type_sorted = sorted(
        abnormal_by_dev_type.items(), key=lambda x: x[1], reverse=True
    )
    abnormal_by_dev_type_text = "、".join(
        f"{dev_type} {count} 个" for dev_type, count in abnormal_by_dev_type_sorted
    )
    # 带括号的版本：存在异常组件时为"（EDR 5 个、AF 2 个）"，无异常组件时为空字符串
    abnormal_by_dev_type_bracket = f"（{abnormal_by_dev_type_text}）" if abnormal_by_dev_type_text else ""
    # 异常组件数（abnormal_count > 0 的设备数）与全部组件数（by_device 长度）
    abnormal_component_count = sum(1 for d in by_device if d["abnormal_count"] > 0)
    total_component_count = len(by_device)

    return {
        "total": total,
        "abnormal_count": abnormal_count,
        "abnormal_by_dev_type": abnormal_by_dev_type,
        "abnormal_by_dev_type_text": abnormal_by_dev_type_text,
        "abnormal_by_dev_type_bracket": abnormal_by_dev_type_bracket,
        "abnormal_component_count": abnormal_component_count,
        "total_component_count": total_component_count,
        "by_device": by_device,
        "policy_check_example": policy_check_example_top5
    }


# ── 主流程 ──
def _load_config() -> dict:
    """读取 report/config.yaml 配置文件。"""
    if not os.path.exists(CONFIG_PATH):
        raise FileNotFoundError(f"配置文件不存在: {CONFIG_PATH}")
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def main():
    parser = argparse.ArgumentParser(description="数据统计：资产与策略检查")
    parser.add_argument("--asset", default=None,
                        help="资产清单 Excel 路径（默认使用配置文件中的路径）")
    parser.add_argument("--policy", default=None,
                        help="策略检查 JSON 路径（默认使用配置文件中 policy_json 的路径）")
    parser.add_argument("--output", default=None,
                        help="输出 JSON 文件路径（默认 protection_effectiveness.json）")
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    config = _load_config()
    ds_cfg = config["data_source"]
    base_path = ds_cfg["base_path"]

    asset_path = args.asset or resolve_data_file(
        base_path, ds_cfg["files"]["asset"])
    # 策略检查改为读取 JSON（config.yaml 中的 policy_json），路径与格式参考
    # report/policy_check_export.py 的 _save_json（JSON 顶层为记录列表，无需 data_path）
    policy_json_cfg = ds_cfg["files"].get("policy_json", {})
    policy_path = args.policy or resolve_data_file(
        base_path, policy_json_cfg) or os.path.join(base_path, "tmp/policy_check.json")
    output_path = args.output or os.path.join(script_dir, "protection_effectiveness.json")

    print("=" * 60)
    print("数据统计")
    print("=" * 60)
    print(f"资产清单: {asset_path}")
    print(f"策略检查(JSON): {policy_path}")

    # 读取数据
    if os.path.exists(asset_path):
        asset_data = read_excel(asset_path, header_row=2, data_start_row=3)
        print(f"已加载资产清单: {len(asset_data)} 行")
    else:
        print(f"[WARNING] 资产清单不存在: {asset_path}")
        asset_data = []

    if os.path.exists(policy_path):
        # JSON 顶层为记录列表，data_path 留空
        policy_data = read_json(policy_path, data_path=None)
        print(f"已加载策略检查(JSON): {len(policy_data)} 行")
    else:
        print(f"[WARNING] 策略检查(JSON)不存在: {policy_path}")
        policy_data = []

    # 统计
    without_aes_asset_stats = stat_core_assets_without_aes(asset_data)
    policy_stats = stat_policy_check(policy_data)

    result = {
        "without_aes_asset_stats": without_aes_asset_stats,
        "policy_stats": policy_stats,
    }

    # 打印摘要
    print("\n--- 统计结果 ---")
    print(f"核心资产（无 aES 数据源）IP 数: {without_aes_asset_stats['total']}")
    if without_aes_asset_stats["ips"]:
        print(f"  IP 列表: {', '.join(without_aes_asset_stats['ips'])}")
    print(f"策略检查总数: {policy_stats['total']}")
    print(f"异常项数量: {policy_stats['abnormal_count']}")
    if policy_stats["abnormal_by_dev_type"]:
        print("按设备类型聚合的异常项数量:")
        for dt, cnt in policy_stats["abnormal_by_dev_type"].items():
            print(f"  {dt}: {cnt}")
    print(f"按设备聚合的列表项数: {len(policy_stats['by_device'])}")

    # 输出 JSON
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2, default=str)
    print(f"\n统计结果已保存: {output_path}")
    print("=" * 60)


if __name__ == "__main__":
    main()
