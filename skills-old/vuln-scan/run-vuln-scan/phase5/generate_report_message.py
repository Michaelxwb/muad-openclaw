# -*- coding: utf-8 -*-
"""Phase 5：解析漏洞报告 ZIP，生成漏洞话术"""
import sys
import os
import re
import json
import subprocess
import base64
import tempfile
import shutil

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _read_xls_from_zip(zip_path: str, xls_entry_name_hint: str = '©���嵥') -> list:
    """
    读取 zip_path，解压后用 Excel COM 读取第一个 .xls 文件。
    PowerShell 输出 TSV（避免 JSON 编码问题），Python 解析 TSV 构建返回结构。
    只读 Sheet1(A2)、Sheet3(全部行)、Sheet4(前20行)。
    返回 sheets 结构 list：[{name, rows, cols, data}, ...]
    """
    import shutil
    import zipfile
    import subprocess

    tmp_dir = tempfile.mkdtemp()
    try:
        with zipfile.ZipFile(zip_path, 'r', metadata_encoding='gbk') as zf:
            zf.extractall(tmp_dir)

        xls_path = None
        for root, dirs, files in os.walk(tmp_dir):
            for f in files:
                if f.lower().endswith('.xls'):
                    xls_path = os.path.join(root, f)
                    break
            if xls_path:
                break

        if not xls_path:
            raise RuntimeError(f"No .xls file found in zip: {zip_path}")

        ascii_xls = os.path.join(tmp_dir, '_vuln.xls')
        basename = os.path.basename(xls_path)
        if any(b > 127 for b in basename.encode('utf-8', errors='ignore')):
            shutil.copy2(xls_path, ascii_xls)
            xls_path = ascii_xls

        s1_out = os.path.join(tmp_dir, '_s1.tsv')
        s3_out = os.path.join(tmp_dir, '_s3.tsv')
        s4_out = os.path.join(tmp_dir, '_s4.tsv')
        ps_path = os.path.join(tmp_dir, '_read_tsv.ps1')

        ps_lines = [
            "$obj = New-Object -ComObject Excel.Application",
            "$obj.Visible = $false",
            "$obj.DisplayAlerts = $false",
            "$wb = $obj.Workbooks.Open('XLS_PATH')",
            # Sheet1: A2 only
            "$ws1 = $wb.Sheets.Item(1)",
            "$v = $ws1.Cells.Item(2, 1).Text",
            "$v = $v.Replace([char]13, ' ').Replace([char]10, ' ')",
            "$v | Out-File -FilePath 'S1_OUT' -Encoding UTF8",
            # Sheet3: all rows, all cols
            "$ws3 = $wb.Sheets.Item(3)",
            "$ur3 = $ws3.UsedRange",
            "$maxR3 = $ur3.Row + $ur3.Rows.Count - 1",
            "$maxC3 = $ur3.Column + $ur3.Columns.Count - 1",
            "$lines3 = @()",
            "for ($r = 1; $r -le $maxR3; $r++) {",
            "    $row = @()",
            "    for ($c = 1; $c -le $maxC3; $c++) {",
            "        $cell = $ws3.Cells.Item($r, $c).Text",
            "        if ($null -eq $cell -or $cell.ToString().Trim() -eq '') { $row += '' } else { $row += $cell.ToString().Trim().Replace([char]13, ' ').Replace([char]10, ' ') }",
            "    }",
            "    $lines3 += ($row -join [char]9)",
            "}",
            "$lines3 | Out-File -FilePath 'S3_OUT' -Encoding UTF8",
            # Sheet4: first 20 rows, all cols
            "$ws4 = $wb.Sheets.Item(4)",
            "$ur4 = $ws4.UsedRange",
            "$maxR4 = $ur4.Row + $ur4.Rows.Count - 1",
            "$maxC4 = $ur4.Column + $ur4.Columns.Count - 1",
            "if ($maxR4 -gt 20) { $maxR4 = 20 }",
            "$lines4 = @()",
            "for ($r = 1; $r -le $maxR4; $r++) {",
            "    $row = @()",
            "    for ($c = 1; $c -le $maxC4; $c++) {",
            "        $cell = $ws4.Cells.Item($r, $c).Text",
            "        if ($null -eq $cell -or $cell.ToString().Trim() -eq '') { $row += '' } else { $row += $cell.ToString().Trim().Replace([char]13, ' ').Replace([char]10, ' ') }",
            "    }",
            "    $lines4 += ($row -join [char]9)",
            "}",
            "$lines4 | Out-File -FilePath 'S4_OUT' -Encoding UTF8",
            "$wb.Close($false)",
            "$obj.Quit()",
        ]

        ps_content = '\n'.join(ps_lines)
        ps_content = ps_content \
            .replace('XLS_PATH', xls_path.replace('\\', '\\\\')) \
            .replace('S1_OUT', s1_out.replace('\\', '\\\\')) \
            .replace('S3_OUT', s3_out.replace('\\', '\\\\')) \
            .replace('S4_OUT', s4_out.replace('\\', '\\\\'))

        try:
            with open(ps_path, 'w', encoding='utf-8-sig') as f:
                f.write(ps_content)
                f.flush()
        except Exception as e:
            print(f"[WARN] 写入 PS 脚本失败: {e}", flush=True)
            return  # 无法写入脚本则跳过

        try:
            subprocess.run(
                ['powershell', '-ExecutionPolicy', 'Bypass', '-File', ps_path],
                capture_output=True, timeout=120
            )

            sheets = []
            for sheet_label, out_path in [
                ('1-©������', s1_out),
                ('3-急需修复漏洞+进度跟踪', s3_out),
                ('4-全部漏洞清单', s4_out),
            ]:
                if not os.path.exists(out_path):
                    continue
                try:
                    with open(out_path, 'r', encoding='utf-8-sig') as f:
                        raw = f.read()
                except UnicodeDecodeError:
                    with open(out_path, 'r', encoding='utf-8') as f:
                        raw = f.read()

                if not raw.strip():
                    continue

                lines = raw.split('\n')
                rows = []
                for line in lines:
                    if not line:
                        continue
                    cells = line.split('\t')
                    rows.append(cells)

                if not rows:
                    continue

                max_cols = max(len(r) for r in rows) if rows else 0
                sheets.append({
                    'name': sheet_label,
                    'rows': len(rows),
                    'cols': max_cols,
                    'data': rows,
                })

            return sheets
        finally:
            for p in (ps_path, s1_out, s3_out, s4_out):
                try:
                    os.unlink(p)
                except OSError:
                    pass
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _load_template():
    """读取话术模板"""
    tpl_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        'templates', 'vuln_scan_report_message.txt'
    )
    with open(tpl_path, 'r', encoding='utf-8') as f:
        return f.read()



def _load_ending():
    """读取修复指引模板"""
    end_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        'templates', 'vul_scan_report_message_ending.txt'
    )
    with open(end_path, 'r', encoding='utf-8') as f:
        return f.read()


def _get_sheet(sheets, hint):
    for s in sheets:
        if hint in s.get('name', ''):
            return s
    return None


def _col_idx(headers, *keywords):
    for idx, h in enumerate(headers):
        if not h:
            continue
        h_str = str(h).strip()
        if any(k in h_str for k in keywords):
            return idx
    return None


def _cell(row, col_idx, default=None):
    if col_idx is None:
        return default
    try:
        v = row[col_idx]
        return str(v).strip() if v else default
    except IndexError:
        return default


def _severity_weight(level_str):
    s = str(level_str).strip() if level_str else ''
    if s and s not in ('', '无'):
        if '高' in s:
            return 3
        if '中' in s:
            return 2
        if '低' in s:
            return 1
    return 0


def generate_vuln_summary(zip_path: str) -> dict:
    """
    解析 zip_path（漏洞报告 zip），返回话术字典：
    {summary: str, top3: [{biz, ip, vuln, sol}, ...]}

    规则：
    - summary: Sheet1 第2行第1列
    - top3: 优先从 Sheet3 取，次从 Sheet4 取
      - 只选 扫描方式=原理扫描
      - 按危害程度排序：高危>中危>低危
      - 不同业务系统优先，各业务系统只取第1条
      - 合并单元格 biz 为空时继承上一个值
    """
    sheets = _read_xls_from_zip(zip_path, '漏洞清单')

    summary = ''
    if sheets and sheets[0].get('data') and len(sheets[0]['data']) >= 1:
        row0 = sheets[0]['data'][0]
        if row0 and row0[0]:
            summary = str(row0[0]).strip()

    candidates = []

    for sheet_hint in ['3-急需修复漏洞+进度跟踪', '4-全部漏洞清单']:
        s = _get_sheet(sheets, sheet_hint)
        if not s or not s.get('data'):
            continue

        rows = s['data']
        headers = rows[0] if rows else []

        col_biz = _col_idx(headers, '业务系统')
        col_host = _col_idx(headers, '受影响主机', '位置')
        col_vuln = _col_idx(headers, '漏洞名称')
        col_sol = _col_idx(headers, '解决方案')
        col_scan = _col_idx(headers, '扫描方式')
        col_sev = _col_idx(headers, '漏洞等级', '危害程度', '危险级别')

        last_biz = None
        for r in range(1, len(rows)):
            row = rows[r]

            biz_raw = _cell(row, col_biz)
            if biz_raw:
                last_biz = biz_raw
            if not last_biz:
                continue

            if col_scan is not None:
                scan_val = _cell(row, col_scan) or ''
                if '原理扫描' not in scan_val:
                    continue

            host = _cell(row, col_host) or ''
            vuln = _cell(row, col_vuln) or ''
            sol = _cell(row, col_sol) or ''
            sev = _cell(row, col_sev) or ''

            if not vuln:
                continue

            candidates.append({
                'biz': last_biz,
                'host': host,
                'vuln': vuln,
                'sol': sol,
                'sev': sev,
                'sev_weight': _severity_weight(sev),
            })

        if len(candidates) >= 3:
            break

    def is_external(entry):
        h = entry.get('host', '')
        return bool(re.match(r'^[a-zA-Z]+://', h))

    candidates.sort(key=lambda x: (x['sev_weight'], is_external(x)), reverse=True)

    seen_biz = []
    unique = []
    for c in candidates:
        if c['biz'] in seen_biz:
            continue
        seen_biz.append(c['biz'])
        unique.append(c)

    top3 = unique[:3]

    for entry in top3:
        h = entry.get('host', '')
        if re.match(r'^[a-zA-Z]+://', h):
            try:
                from urllib.parse import urlparse
                entry['ip'] = urlparse(h).hostname or h
            except Exception:
                entry['ip'] = h
        else:
            entry['ip'] = h

    return {
        'summary': summary,
        'top3': top3,
    }


def _normalize_summary(s: str) -> str:
    """将 summary 中的多个空格替换为换行，使段落分开，并结构化处理关键节点"""
    s = re.sub(r' {2,}', '\n', s.strip())
    # 按「具体情况如下：」分段
    parts = re.split(r'(具体情况如下：)', s)
    # parts: [前缀内容, '具体情况如下：', 第一段详情, '具体情况如下：', 第二段详情]
    result_parts = []
    for i, part in enumerate(parts):
        if i % 2 == 1:  # 是分隔符「具体情况如下：」，其后换行
            result_parts.append(part)
            result_parts.append('\n')
        else:  # 内容段，首个「目前」前加换行
            if part and '目前' in part:
                part = re.sub(r'(?<=\n)(目前)', '\n目前', part)
            result_parts.append(part)
    return ''.join(result_parts)


def build_message(template: str, summary: str, top3: list) -> str:
    """
    填充模板。成功通知无符号前缀。

    不足3条漏洞时，只保留实际数量的漏洞行，删除多余占位符行，不留空行。
    修复指引部分读取 vul_scan_report_message_ending.txt，三个内容块之间用回车换行衔接。
    """
    msg = template.replace('{漏洞扫描总结}', _normalize_summary(summary))

    # 收集模板各部分：标题段、漏洞列表段、补充段
    parts = msg.split('\n')


    # 构建漏洞列表（只保留 <= len(top3) 的行）
    vuln_lines = []
    for line in parts:
        m = re.match(r'^(\d+)、', line)
        if m:
            num = int(m.group(1))
            if num <= len(top3):
                item = top3[num - 1]
                n = num
                # 替换4个占位符
                line = line.replace(f'{{业务系统{n}}}', item['biz'])
                line = line.replace(f'{{IP列表{n}}}', item['ip'])
                line = line.replace(f'{{漏洞名称{n}}}', item['vuln'])
                line = line.replace(f'{{解决方案{n}}}', item['sol'])
                vuln_lines.append(line)
        # else: 跳过非数字开头的行（先收集，后面重建）

    # 重建消息：标题+警告 → 空行 → 漏洞列表 → 空行 → 修复指引
    result_lines = []
    for line in parts:
        m = re.match(r'^(\d+)、', line)
        if m:
            continue  # 漏洞行单独处理，跳过这里的占位符行
        result_lines.append(line)

    # 在 "部分漏洞如下：" 后插入漏洞列表
    out_lines = []
    inserted = False
    for line in result_lines:
        out_lines.append(line)
        if '部分漏洞如下' in line and not inserted:
            # 追加漏洞行
            for vl in vuln_lines:
                out_lines.append(vl)
            inserted = True

    built = '\n'.join(out_lines)

    # 追加修复指引（与前面内容用换行衔接）
    ending = _load_ending()
    final_msg = built + '\n\n' + ending

    return final_msg


if __name__ == '__main__':
    import pathlib
    zip_path = r'M:\Users\User\Downloads\漏洞清单.zip'
    # zip_path = r'M:\Users\User\Downloads\托管服务测试-业务维度-漏洞报告-20260512-211241.zip'
    result = generate_vuln_summary(zip_path)

    out_dir = pathlib.Path(r'C:\Users\User\AppData\Local\Temp\vuln_msg_out')
    out_dir.mkdir(exist_ok=True)

    try:
        with open(out_dir / 'result.json', 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
            f.flush()
    except Exception as e:
        print(f"[WARN] 写入 result.json 失败: {e}", flush=True)

    template = _load_template()
    msg = build_message(template, result['summary'], result['top3'])
    try:
        with open(out_dir / 'message.txt', 'w', encoding='utf-8') as f:
            f.write(msg)
            f.flush()
    except Exception as e:
        print(f"[WARN] 写入 message.txt 失败: {e}", flush=True)

    print('Output written to', out_dir)
    print('summary length:', len(result['summary']))
    print('top3 count:', len(result['top3']))
    for i, item in enumerate(result['top3']):
        print('  [' + str(i+1) + '] sev=' + str(item['sev_weight']) + ' biz=' + item['biz'])