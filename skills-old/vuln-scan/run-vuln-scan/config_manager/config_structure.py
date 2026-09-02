#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
配置结构定义
基于 user_choice.json 和 choice_chinese_field.json 构建配置结构
"""
import os
import json
from typing import Dict, Any

# 配置文件路径
USER_CHOICE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "templates", "user_choice.json")
CHINESE_FIELD_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "templates", "choice_chinese_field.json")


def load_chinese_field_mapping() -> Dict[str, Any]:
    """加载中文字段到配置字段/值的映射"""
    if os.path.exists(CHINESE_FIELD_PATH):
        try:
            with open(CHINESE_FIELD_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[WARNING] 加载 choice_chinese_field.json 失败: {e}")
    return {}


def load_user_choice() -> list:
    """加载用户选择配置"""
    if os.path.exists(USER_CHOICE_PATH):
        try:
            with open(USER_CHOICE_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[WARNING] 加载 user_choice.json 失败: {e}")
    return []


def build_config_structure() -> Dict[str, Any]:
    """
    构建配置结构
    基于 user_choice.json 和 choice_chinese_field.json
    """
    user_choices = load_user_choice()
    chinese_mapping = load_chinese_field_mapping()
    
    config_structure = {}
    
    for item in user_choices:
        select_key = item.get("select_key", "")
        select_values = item.get("select_value", [])
        default_value = item.get("default_value", "")
        
        # 从映射中获取配置字段名
        config_field = chinese_mapping.get(select_key)
        if not config_field:
            continue
        
        # 构建选项列表
        options = []
        for idx, val in enumerate(select_values, 1):
            # 从映射中获取实际存储值（可能是int或str）
            actual_value = chinese_mapping.get(val, idx)
            options.append({
                "display_num": idx,
                "display_name": val,
                "actual_value": actual_value,
                "is_default": val == default_value
            })
        
        config_structure[config_field] = {
            "display_name": select_key,
            "options": options,
            "default_option": default_value
        }
    
    return config_structure


def get_default_config() -> Dict[str, Any]:
    """获取默认配置：合并 default_config.json 与 user_choice.json 的默认值"""
    from shared import DEFAULT_ASSET_LIST
    
    # 基础配置：读取 default_other_config.json 中的所有默认值
    default_config_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "templates", "default_other_config.json"
    )
    config = {}
    if os.path.exists(default_config_path):
        try:
            with open(default_config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
        except Exception as e:
            print(f"[WARNING] 加载 default_config.json 失败: {e}")
    
    # user_choice.json 中的默认值覆盖同名字段
    structure = build_config_structure()
    for field, field_def in structure.items():
        for opt in field_def["options"]:
            if opt["is_default"]:
                config[field] = opt["actual_value"]
                break
    
    config.setdefault("asset_list", DEFAULT_ASSET_LIST)

    return config
