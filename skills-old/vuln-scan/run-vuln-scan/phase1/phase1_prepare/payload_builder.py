#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1 Payload Builder - 构造创建扫描任务的payload

从多个配置源提取字段，构造完整的payload
"""
import os
import json
from datetime import datetime
from typing import Dict, Any

# 配置文件路径
CONFIGS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "companies"
)
TEMPLATES_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "templates"
)


def _get_default_other(field: str, default=None):
    """从 default_other_config.json 读取字段，作为配置补全fallback"""
    path = os.path.join(TEMPLATES_DIR, "default_other_config.json")
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f).get(field, default)
        except Exception:
            pass
    return default


def load_company_config(company_id: str) -> Dict[str, Any]:
    """加载公司配置"""
    config_path = os.path.join(CONFIGS_DIR, f"{company_id}.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[WARNING] 加载公司配置失败: {e}")
    
    return {}


def build_task_payload(
    company_id: str,
    dev_id: int,
    user_start_time: int = 0,
    task_name: str = None,
    asset_list: list = None,
    asset_mode: int = None,
    fuzz_scan: int = None,
    task_type: int = None,
    conc_module: int = None,
    port_type: str = None,
    port_alive: list = None
) -> Dict[str, Any]:
    """
    构造创建扫描任务的payload
    
    Args:
        company_id: 公司ID（必填）
        dev_id: 设备ID（必填，从 get_dev_id API 动态获取）
        user_start_time: 用户指定的开始时间（Unix时间戳），0表示立即执行
        task_name: 任务名称（若为 None 则自动生成）
        asset_list: 资产列表（若为 None 则从公司配置读取）
        asset_mode: 资产模式（若为 None 则从公司配置读取）
        fuzz_scan: fuzz测试开关（必填，从公司配置读取，不允许硬编码默认值）
        task_type: 漏洞评估类型（必填，从公司配置读取，不允许硬编码默认值）
        conc_module: 并发模块（必填，从公司配置读取，不允许硬编码默认值）
        port_type: 端口扫描策略（必填，从公司配置读取，不允许硬编码默认值）
        port_alive: 端口存活列表（必填，从公司配置读取，不允许硬编码默认值）
    
    Returns:
        完整的payload字典
    """
    # 加载公司配置
    company_config = load_company_config(company_id)
    
    # task_name：优先使用传入值，否则自动生成
    if task_name is None:
        task_name = f"{company_id}_{int(datetime.now().timestamp())}"
    
    # asset_mode：优先使用传入值，否则从公司配置读取
    if asset_mode is None:
        asset_mode = company_config.get("asset_mode")
        if asset_mode is None:
            raise ValueError(f"公司配置 company_id={company_id} 中缺少 asset_mode 字段")
    
    # asset_list：优先使用传入值，否则从公司配置读取
    if asset_list is None:
        asset_list = company_config.get("asset_list", [])
    
    # 以下字段从公司配置读取，不允许使用硬编码默认值
    # fuzz_scan
    if fuzz_scan is None:
        fuzz_scan = company_config.get("fuzz_scan")
        if fuzz_scan is None:
            fuzz_scan = _get_default_other("fuzz_scan")
        if fuzz_scan is None:
            raise ValueError(f"公司配置 company_id={company_id} 中缺少 fuzz_scan 字段")
    
    # task_type
    if task_type is None:
        task_type = company_config.get("task_type")
        if task_type is None:
            task_type = _get_default_other("task_type")
        if task_type is None:
            raise ValueError(f"公司配置 company_id={company_id} 中缺少 task_type 字段")
    
    # conc_module
    if conc_module is None:
        conc_module = company_config.get("conc_module")
        if conc_module is None:
            conc_module = _get_default_other("conc_module")
        if conc_module is None:
            raise ValueError(f"公司配置 company_id={company_id} 中缺少 conc_module 字段")
    
    # port_type
    if port_type is None:
        port_type = company_config.get("port_type")
        if port_type is None:
            port_type = _get_default_other("port_type")
        if port_type is None:
            raise ValueError(f"公司配置 company_id={company_id} 中缺少 port_type 字段")
    
    # port_alive
    if port_alive is None:
        port_alive = company_config.get("port_alive")
        if port_alive is None:
            port_alive = _get_default_other("port_alive")
        if port_alive is None:
            raise ValueError(f"公司配置 company_id={company_id} 中缺少 port_alive 字段")
    
    # excute_mode 和 start_time 处理
    # excute_mode=0: 定时模式，start_time=日期0点毫秒，cycle_time_start=时分秒
    # excute_mode=2: 定时模式，start_time=秒时间戳（漏扫原版逻辑）
    # excute_mode=1: 立即执行
    if user_start_time > 0:
        start_time = user_start_time
        excute_mode = 0  # 定时模式（资产发现风格）
    else:
        # 从公司配置读取立即执行的时间设置
        start_time = company_config.get("start_time", 0)
        excute_mode = company_config.get("excute_mode", 1)

    # 构造payload
    payload = {
        "task_name": task_name,
        "excute_mode": excute_mode,
        "fuzz_scan": fuzz_scan,
        "task_type": task_type,
        "conc_module": conc_module,
        "port_type": port_type,
        "port_alive": port_alive,
        "start_time": start_time,
        "asset_mode": asset_mode,
        "dev_id": dev_id,
        "company_id": company_id,
        "asset_list": asset_list
    }

    # excute_mode=0 时补充 cycle_time_start/cycle_time_end
    # 注意：start_time 必须保持毫秒级时间戳格式
    if excute_mode == 0 and user_start_time > 0:
        from datetime import datetime, timezone, timedelta
        sh_tz = timezone(timedelta(hours=8))
        # user_start_time 是毫秒时间戳，转为秒用于 datetime 解析
        ts_sec = user_start_time // 1000
        user_dt = datetime.fromtimestamp(ts_sec, tz=sh_tz)
        # start_time = 当天零点（毫秒）
        date_midnight_ts = int(user_dt.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
        payload["start_time"] = date_midnight_ts
        payload["cycle_time_start"] = user_dt.strftime("%H:%M:%S")
        payload["cycle_time_end"] = ""


    return payload


def print_payload(payload: Dict[str, Any]):
    """打印payload信息"""
    print("\n" + "=" * 60)
    print("构造的 Payload:")
    print("=" * 60)
    for key, value in payload.items():
        if key == "asset_list" and isinstance(value, list):
            print(f"  {key}: [{len(value)} items]")
        else:
            print(f"  {key}: {value}")
    print("=" * 60)


if __name__ == "__main__":
    # 测试用法
    import argparse
    
    parser = argparse.ArgumentParser(description="构造扫描任务payload")
    parser.add_argument("--company-id", type=str, required=True, help="公司ID")
    parser.add_argument("--dev-id", type=int, required=True, help="设备ID（从 get_dev_id API 获取）")
    parser.add_argument("--start-time", type=int, default=0, help="开始时间（Unix时间戳）")
    
    args = parser.parse_args()
    
    payload = build_task_payload(
        company_id=args.company_id,
        dev_id=args.dev_id,
        user_start_time=args.start_time
    )
    
    print_payload(payload)
    
    print(f"\nJSON格式:")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
