"""
分支1统一入口。

职责：
1. 可选执行策略检查采集，落盘 Excel + JSON
2. 基于显式传入的数据文件生成 scoring / protection_effectiveness
3. 输出主流程可直接消费的 reportPatch 与 artifact 信息
"""

import argparse
import json
import os
import sys
import tempfile

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from scoring import ScoringEngine  # noqa: E402
from data_reader import read_excel, read_json  # noqa: E402
from protection_effectiveness import stat_core_assets_without_aes, stat_policy_check  # noqa: E402
from policy_check_export import PolicyCheckExporter  # noqa: E402


def run_scoring(config_path: str) -> dict:
    engine = ScoringEngine(config_path)
    engine.load_data()
    return engine.calc_total_score()


def run_data_stats(asset_path: str, policy_json_path: str, asset_header_row: int, asset_data_start_row: int) -> dict:
    if asset_path and os.path.exists(asset_path):
        asset_data = read_excel(
            asset_path,
            header_row=asset_header_row,
            data_start_row=asset_data_start_row,
        )
    else:
        asset_data = []

    if policy_json_path and os.path.exists(policy_json_path):
        policy_data = read_json(policy_json_path, data_path=None)
    else:
        policy_data = []

    return {
        "without_aes_asset_stats": stat_core_assets_without_aes(asset_data),
        "policy_stats": stat_policy_check(policy_data),
    }


def build_config(args, policy_excel_path: str, policy_json_path: str) -> dict:
    asset_header_row = args.asset_header_row
    asset_data_start_row = args.asset_data_start_row
    event_header_row = args.event_header_row
    event_data_start_row = args.event_data_start_row

    return {
        "data_source": {
            "base_path": args.base_path or ".",
            "files": {
                "asset": {
                    "filename": os.path.abspath(args.asset_path),
                    "sheet": args.asset_sheet,
                    "header_row": asset_header_row,
                    "data_start_row": asset_data_start_row,
                },
                "event": {
                    "filename": os.path.abspath(args.event_path),
                    "sheet": args.event_sheet,
                    "header_row": event_header_row,
                    "data_start_row": event_data_start_row,
                },
                "vuln": {
                    "filename": os.path.abspath(args.vuln_path),
                    "sheet": args.vuln_sheet,
                },
                "weak_pwd": {
                    "filename": os.path.abspath(args.weakpwd_path),
                    "sheet": args.weakpwd_sheet,
                },
                "expose": {
                    "filename": os.path.abspath(args.exposure_path),
                    "sheet": args.exposure_sheet,
                },
                "policy": {
                    "filename": os.path.abspath(policy_excel_path),
                    "sheet": args.policy_sheet,
                },
                "policy_json": {
                    "type": "json",
                    "filename": os.path.abspath(policy_json_path),
                },
                "device": {
                    "type": "json",
                    "filename": os.path.abspath(args.device_path),
                    "data_path": "data.list",
                },
            },
        },
        "weights": default_weights(),
    }


def default_weights() -> dict:
    return {
        "DEFAULT_ASSETS_RATIO": 0.6,
        "ASSETS_RATIO": 0.4,
        "COMPONENTS_RATIO": 0.6,
        "EVENTS_RATIO": 0.6,
        "VULNERABILITIES_RATIO": 0.4,
        "SERVER_RATIO": 0.75,
        "PC_SCORE": 0.25,
        "DEVICE_K": 0.5,
        "POLICY_K": 0.5,
        "VULNERABILITY_K": 0.5,
        "WEAK_PASSWORD_K": 0.25,
        "PORT_K": 0.25,
        "WEAK_PASSWORD_BASE_K": 1,
        "SERVER_MAJOR_EVENT_K": 10,
        "SERVER_GENERAL_EVENT_K": 7.5,
        "SERVER_OTHER_EVENT_K": 5,
        "SERVER_MAJOR_THREAT_K": 2.5,
        "PC_MAJOR_EVENT_K": 5,
        "PC_GENERAL_EVENT_K": 3.75,
        "PC_OTHER_EVENT_K": 2.5,
        "PC_MAJOR_THREAT_K": 1.25,
        "AGENT_FIX_VULN_K": 15,
        "FAST_FIX_VULN_K": 7.5,
        "SUGGEST_FIX_VULN_K": 1,
        "RISK_PORT_K": 20,
        "HIGH_LEVEL_WEAKPWD_K": 20,
        "MIDDLE_LEVEL_WEAKPWD_K": 10,
        "LOW_LEVEL_WEAKPWD_K": 5,
        "UNKNOWN_LEVEL_WEAKPWD_K": 2,
    }


def write_temp_config(config: dict) -> str:
    temp_file = tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".yaml", delete=False)
    try:
        yaml.safe_dump(config, temp_file, allow_unicode=True, sort_keys=False)
        return temp_file.name
    finally:
        temp_file.close()


def parse_args():
    parser = argparse.ArgumentParser(description="分支1统一入口")
    parser.add_argument("--asset-path", required=True)
    parser.add_argument("--event-path", required=True)
    parser.add_argument("--weakpwd-path", required=True)
    parser.add_argument("--vuln-path", required=True)
    parser.add_argument("--exposure-path", required=True)
    parser.add_argument("--device-path", required=True)
    parser.add_argument("--output", required=True, help="输出 JSON 路径")
    parser.add_argument("--policy-json-path", default=None)
    parser.add_argument("--policy-excel-path", default=None)
    parser.add_argument("--cookie-path", default=None)
    parser.add_argument("--company-id", default=None)
    parser.add_argument("--start", default=None)
    parser.add_argument("--end", default=None)
    parser.add_argument("--policy-status", default="")
    parser.add_argument("--mock", action="store_true", help="使用本地 JSON 文件模拟策略检查数据，跳过接口调用")
    parser.add_argument("--mssw-base-url", default=None, help="MSSW 站点域名，未传时使用 policy_check_export.py 内的默认值")
    parser.add_argument("--base-path", default=".")
    parser.add_argument("--asset-sheet", default="Sheet1")
    parser.add_argument("--event-sheet", default="事件表")
    parser.add_argument("--vuln-sheet", default="漏洞")
    parser.add_argument("--weakpwd-sheet", default="弱口令")
    parser.add_argument("--exposure-sheet", default="端口表")
    parser.add_argument("--policy-sheet", default="策略检查")
    parser.add_argument("--asset-header-row", type=int, default=2)
    parser.add_argument("--asset-data-start-row", type=int, default=3)
    parser.add_argument("--event-header-row", type=int, default=1)
    parser.add_argument("--event-data-start-row", type=int, default=2)
    return parser.parse_args()


def ensure_parent_dir(file_path: str):
    os.makedirs(os.path.dirname(os.path.abspath(file_path)), exist_ok=True)


def maybe_export_policy(args):
    required = [args.cookie_path, args.company_id, args.start, args.end]
    if not all(required):
        raise ValueError("缺少策略检查输入：需同时提供 policy 路径，或提供 cookie/company-id/start/end 以自动采集")

    script_dir = os.path.dirname(os.path.abspath(__file__))
    policy_json_path = args.policy_json_path or os.path.join(script_dir, "tmp", "policy_check.json")
    policy_excel_path = args.policy_excel_path or os.path.join(script_dir, "策略检查清单.xlsx")
    ensure_parent_dir(policy_json_path)
    ensure_parent_dir(policy_excel_path)

    exporter = PolicyCheckExporter(
        company_id=args.company_id,
        start_time=args.start,
        end_time=args.end,
        status=args.policy_status,
        cookie_path=args.cookie_path,
        output_path=policy_excel_path,
        json_output_path=policy_json_path,
        mock=args.mock,
        base_url=args.mssw_base_url,
    )
    result = exporter.run()
    return {
        "jsonPath": os.path.abspath(result["jsonPath"]),
        "excelPath": os.path.abspath(result["excelPath"]),
        "recordCount": result.get("recordCount"),
    }


def main():
    args = parse_args()

    print("=" * 60)
    print("分支1统一入口")
    print("=" * 60)
    print(f"资产表: {args.asset_path}")
    print(f"事件表: {args.event_path}")
    print(f"弱口令表: {args.weakpwd_path}")
    print(f"漏洞表: {args.vuln_path}")
    print(f"暴露面表: {args.exposure_path}")
    print(f"设备JSON: {args.device_path}")

    policy_artifact = maybe_export_policy(args)
    print(f"策略检查 Excel: {policy_artifact['excelPath']}")
    print(f"策略检查 JSON: {policy_artifact['jsonPath']}")

    config = build_config(args, policy_artifact["excelPath"], policy_artifact["jsonPath"])
    config_path = write_temp_config(config)

    try:
        print("[branch1] 开始评分计算 (run_scoring) ...", flush=True)
        scoring_result = run_scoring(config_path)
        print("[branch1] 评分计算完成", flush=True)
        print("[branch1] 开始防护有效性统计 (run_data_stats) ...", flush=True)
        protection_effectiveness = run_data_stats(
            args.asset_path,
            policy_artifact["jsonPath"],
            args.asset_header_row,
            args.asset_data_start_row,
        )
        print("[branch1] 防护有效性统计完成", flush=True)
    finally:
        try:
            os.unlink(config_path)
        except OSError:
            pass

    payload = {
        "reportPatch": {
            "scoring": scoring_result,
            "protection_effectiveness": protection_effectiveness,
        },
        "artifacts": {
            "policyJsonPath": policy_artifact["jsonPath"],
            "policyExcelPath": policy_artifact["excelPath"],
        },
    }

    ensure_parent_dir(args.output)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, default=str)

    print(f"\n输出文件: {args.output}")
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
