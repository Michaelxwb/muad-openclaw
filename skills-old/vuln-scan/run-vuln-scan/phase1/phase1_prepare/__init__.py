#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1 准备阶段 - 扫描任务创建前的准备工作

阶段1准备职责：
1. 确认公司信息（company_name, company_id）
2. 管理扫描配置（加载/创建/修改）
3. 确认是否创建扫描任务

阶段1准备结束：用户确认"创建扫描任务并立即执行"
"""

from .phase1_company import (
    resolve_company,
    resolve_company_by_id,
    MultipleCandidatesError,
    phase1_prepare,
    manage_config,
    confirm_create_task,
    ConfigExistAskError,
)

__all__ = [
    'resolve_company',
    'resolve_company_by_id',
    'MultipleCandidatesError',
    'phase1_prepare',
    'manage_config',
    'confirm_create_task',
    'ConfigExistAskError',
]
