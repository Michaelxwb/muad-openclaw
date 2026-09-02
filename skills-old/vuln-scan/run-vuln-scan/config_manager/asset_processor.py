#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""资产处理（转发给 phase1.phase1_prepare.asset_processor）"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from phase1.phase1_prepare.asset_processor import (
    get_all_assets,
    filter_assets_specific,
    filter_assets_except,
)


def process_asset_detail(company_id, asset_detail):
    """
    根据 asset_detail 配置从公司全部资产中筛选出 asset_list
    asset_detail: dict，keys: asset_type ("specific"/"except"), group (list), ip (list)
    """
    if not asset_detail:
        return []

    cookie_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "shared"
    )
    from shared import get_cookie
    cookie = get_cookie()

    asset_type = asset_detail.get("asset_type", "specific")
    group_list = asset_detail.get("group", [])
    ip_list = asset_detail.get("ip", [])

    all_assets = get_all_assets(company_id, cookie)
    if not all_assets:
        return []

    if asset_type == "except":
        return filter_assets_except(all_assets, group_list, ip_list)
    else:
        return filter_assets_specific(all_assets, group_list, ip_list)
