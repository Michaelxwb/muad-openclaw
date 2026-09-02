#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1 准备阶段 - 资产发现任务创建前的准备工作

职责：
1. 确认公司信息（company_name, company_id）
2. 管理配置
3. 确认是否创建任务
"""

from .phase1_company import (
    resolve_company,
    resolve_company_by_id,
    MultipleCandidatesError,
    lookup_candidate_by_index,
    lookup_candidate_by_name,
    config_exists,
    manage_config,
    ConfigExistAskError,
)

from .get_dev_id import get_dev_id
from .asset_fetch import fetch_all_asset_ips
from .asset_task import create_asset_discovery_task
from .asset_count import get_asset_count
from .discover_asset_list import fetch_task_asset_list

__all__ = [
    'resolve_company',
    'resolve_company_by_id',
    'MultipleCandidatesError',
    'lookup_candidate_by_index',
    'lookup_candidate_by_name',
    'config_exists',
    'manage_config',
    'ConfigExistAskError',
    'get_dev_id',
    'fetch_all_asset_ips',
    'create_asset_discovery_task',
    'get_asset_count',
    'fetch_task_asset_list',
]