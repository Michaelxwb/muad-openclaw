#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import importlib.util
import json
import os
import sys

import openpyxl

from _path_helper import decode_argv
decode_argv()


def load_branch2_module():
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    module_path = os.path.join(repo_root, '分支2', 'generate_data.py')
    spec = importlib.util.spec_from_file_location('branch2_generate_data', module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_wb(filepath):
    return openpyxl.load_workbook(filepath, data_only=True)


def choose_asset_sheet(workbook):
    for sheet_name in ('资产清单', '资产表'):
        if sheet_name in workbook.sheetnames:
            return workbook[sheet_name]
    return workbook.worksheets[0]


def find_sheet(workbook, prefix):
    """按前缀匹配 sheet 名，兼容无数据时「端口表（0）」等带括号后缀的情况"""
    for name in workbook.sheetnames:
        stripped = name.split('（')[0].split('(')[0].strip()
        if stripped == prefix:
            return workbook[name]
    raise KeyError(f"Worksheet {prefix} does not exist.")


def main():
    if len(sys.argv) != 6:
        raise SystemExit(
            'Usage: prevention_data.py <asset.xlsx> <incident.xlsx> <weak.xlsx> <vuln.xlsx> <exposure.xlsx>'
        )

    asset_path, incident_path, weak_path, vuln_path, exposure_path = sys.argv[1:6]
    branch2 = load_branch2_module()

    wb_exp = load_wb(exposure_path)
    wb_vuln = load_wb(vuln_path)
    wb_weak = load_wb(weak_path)
    wb_event = load_wb(incident_path)
    wb_asset = load_wb(asset_path)
    ws_asset = choose_asset_sheet(wb_asset)

    raw = {
        'wb_exp': wb_exp,
        'rows_web_risk': branch2.get_rows(find_sheet(wb_exp, 'Web服务风险分布')),
        'rows_nonweb_risk': branch2.get_rows(find_sheet(wb_exp, '非Web服务风险分布')),
        'rows_port': branch2.get_rows(find_sheet(wb_exp, '端口表')),
        'rows_vuln': branch2.get_rows(wb_vuln['漏洞']),
        'rows_weak': branch2.get_rows(wb_weak['弱口令']),
        'rows_event': branch2.get_rows(wb_event.active),
        'rows_asset': branch2.get_asset_rows(ws_asset),
    }

    ds = branch2.prepare_datasets(raw)
    result = {
        'summary': branch2.calc_summary(ds),
        'key_risks': branch2.calc_key_risks(ds),
        'risk_detail': branch2.calc_risk_detail(ds),
        'internet': {
            'exposure': branch2.calc_internet_exposure(ds),
            'vuln': branch2.calc_internet_vuln(ds),
            'weak_pwd': branch2.calc_internet_weak_pwd(ds),
        },
        'intranet': {
            'vuln': branch2.calc_intranet_vuln(ds),
            'weak_pwd': branch2.calc_intranet_weak_pwd(ds),
        },
    }

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
