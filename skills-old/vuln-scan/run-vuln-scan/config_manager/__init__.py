#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Vuln Scan Configuration Manager
配置管理模块 - 处理配置项生成、用户输入和配置保存
"""

from .config_handler import (
    interactive_config,
    get_config,
    config_exists,
    load_config,
    save_config,
)

from .asset_processor import (
    process_asset_detail,
    get_all_assets as fetch_all_assets,
)

from .input_parser import (
    parse_config_input,
    parse_asset_input,
    validate_ip,
)

from .quick_config_handler import (
    quick_config_dialog,
)

__all__ = [
    'interactive_config',
    'get_config',
    'config_exists',
    'load_config',
    'save_config',
    'process_asset_detail',
    'fetch_all_assets',
    'parse_config_input',
    'parse_asset_input',
    'validate_ip',
    'quick_config_dialog',
]
