#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import contextlib
import importlib.util
import io
import json
import os
import sys


SCRIPT_MAP = {
    'weakpwd': ('weak_report.py', 'weak_report'),
    'vuln': ('vuln_report.py', 'vuln_report'),
    'exposure': ('exposuer_report.py', 'exposuer_report'),
}


def load_module(table_type):
    filename, module_name = SCRIPT_MAP[table_type]
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    module_path = os.path.join(repo_root, '分支2', 'excel_scripts', filename)
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def require_file(filepath, label):
    if not filepath or not os.path.exists(filepath):
        raise SystemExit(f'{label} 不存在: {filepath}')


def build_target_argv(table_type, args):
    if table_type in ('weakpwd', 'vuln'):
        return [
            f'{table_type}.py',
            args.customer,
            '--start-time',
            args.start,
            '--end-time',
            args.end,
        ]

    return [
        'exposure.py',
        args.customer,
        '--start-time',
        args.start,
        '--end-time',
        args.end,
    ]


def configure_module(module, table_type, args):
    module.TEMP_DIR = args.temp_dir
    module.OUTPUT_FILE = args.output_file

    if args.mssw_base_url:
        if not args.mssw_base_url.startswith('http'):
            args.mssw_base_url = 'https://' + args.mssw_base_url
        module.MSSW_BASE_URL = args.mssw_base_url

    if args.soar_base_url:
        if not args.soar_base_url.startswith('http'):
            args.soar_base_url = 'https://' + args.soar_base_url
        module.SOAR_BASE_URL = args.soar_base_url

    if table_type == 'exposure':
        module.COOKIES_FILE = args.easm_cookie_path
        return

    module.EASM_COOKIES_FILE = args.easm_cookie_path
    module.MSSW_COOKIES_FILE = args.mssw_cookie_path


def main():
    parser = argparse.ArgumentParser(description='Run branch2 prevention table exporter')
    parser.add_argument('table_type', choices=sorted(SCRIPT_MAP.keys()))
    parser.add_argument('--customer', required=True)
    parser.add_argument('--start', required=True)
    parser.add_argument('--end', required=True)
    parser.add_argument('--output-file', required=True)
    parser.add_argument('--temp-dir', required=True)
    parser.add_argument('--easm-cookie-path')
    parser.add_argument('--mssw-cookie-path')
    parser.add_argument('--mssw-base-url')
    parser.add_argument('--soar-base-url')
    args = parser.parse_args()

    os.makedirs(args.temp_dir, exist_ok=True)
    os.makedirs(os.path.dirname(args.output_file), exist_ok=True)

    if args.table_type == 'exposure':
        require_file(args.easm_cookie_path, 'EASM Cookie 文件')
    else:
        require_file(args.easm_cookie_path, 'EASM Cookie 文件')
        require_file(args.mssw_cookie_path, 'MSSW Cookie 文件')

    module = load_module(args.table_type)
    configure_module(module, args.table_type, args)

    previous_argv = sys.argv[:]
    sys.argv = build_target_argv(args.table_type, args)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            module.main()
    finally:
        sys.argv = previous_argv

    print(json.dumps({
        'ok': True,
        'filePath': os.path.abspath(args.output_file),
        'tableType': args.table_type,
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
