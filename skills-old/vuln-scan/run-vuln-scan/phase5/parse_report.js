/**
 * 解析漏扫报告，生成漏洞话术
 * 纯 Node.js，通过 PowerShell COM 读取 XLS（处理合并单元格）
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const zlib = require('zlib');
const os = require('os');

// ── 1. 找到最新的 ZIP ──────────────────────────────────────────────
function findLatestZip(dir) {
    let latest = null, latestMtime = 0;
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.zip')) continue;
        const stat = fs.statSync(path.join(dir, f));
        if (stat.mtimeMs > latestMtime) { latestMtime = stat.mtimeMs; latest = f; }
    }
    return latest ? path.join(dir, latest) : null;
}

// ── 2. 从 ZIP 提取 xls bytes ───────────────────────────────────────
function extractXlsFromZip(zipBuf) {
    const sig = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
    let pos = 0;
    while (pos < zipBuf.length - 30) {
        const idx = zipBuf.indexOf(sig, pos);
        if (idx === -1 || idx > zipBuf.length - 30) break;
        const method = zipBuf.readUInt16LE(idx + 8);
        const compSize = zipBuf.readUInt32LE(idx + 18);
        const nameLen = zipBuf.readUInt16LE(idx + 26);
        const extraLen = zipBuf.readUInt16LE(idx + 28);
        const name = zipBuf.slice(idx + 30, idx + 30 + nameLen).toString('utf8');
        const dataOffset = idx + 30 + nameLen + extraLen;
        if (name.endsWith('.xls')) {
            const data = zipBuf.slice(dataOffset, dataOffset + compSize);
            return method === 8 ? zlib.inflateRawSync(data) : data;
        }
        pos = dataOffset + compSize;
        const next = zipBuf.indexOf(sig, pos);
        pos = (next >= 0 && next < zipBuf.length - 30) ? next : pos + 1;
    }
    return null;
}

// ── 3. PowerShell COM 读取 XLS → JSON（同步）────────────────────────
function xlsToJsonSync(xlsBuf) {
    const tmpXls = path.join(os.tmpdir(), 'vl_s_' + Date.now() + '.xls');
    const tmpJson = path.join(os.tmpdir(), 'vl_j_' + Date.now() + '.json');
    const tmpPs1 = path.join(os.tmpdir(), 'vl_r_' + Date.now() + '.ps1');
    fs.writeFileSync(tmpXls, xlsBuf);
    const e = s => s.replace(/\\/g, '\\\\');
    const ps = [
        '\uFEFF$obj=New-Object -ComObject Excel.Application',
        '$obj.Visible=$false; $obj.DisplayAlerts=$false',
        '$wb=$obj.Workbooks.Open("' + e(tmpXls) + '")',
        '$all=@()',
        'for($si=1;$si -le $wb.Sheets.Count;$si++){',
        '  $ws=$wb.Sheets.Item($si)',
        '  $ur=$ws.UsedRange',
        '  $maxR=$ur.Row+$ur.Rows.Count-1; $maxC=$ur.Column+$ur.Columns.Count-1',
        '  $sheetData=@{name=$ws.Name;rows=$maxR;cols=$maxC;data=@()}',
        '  for($r=1;$r -le $maxR;$r++){',
        '    $row=@()',
        '    for($c=1;$c -le $maxC;$c++){',
        '      $val=$ws.Cells.Item($r,$c).Text',
        '      if($null -ne $val -and $val.ToString().Trim() -ne ""){$row+=$val.ToString().Trim()}else{$row+=$null}',
        '    }',
        '    $sheetData.data+=,@($row)',
        '  }',
        '  $all+=$sheetData',
        '}',
        '$wb.Close($false); $obj.Quit()',
        '[System.Runtime.Interopservices.Marshal]::ReleaseComObject($obj)|Out-Null',
        '$all|ConvertTo-Json -Depth 20 -Compress|Out-File -FilePath "' + e(tmpJson) + '" -Encoding UTF8',
    ].join('\n');
    fs.writeFileSync(tmpPs1, ps, 'utf8');
    try {
        execSync('powershell -ExecutionPolicy Bypass -File "' + tmpPs1 + '" -NoProfile -NonInteractive', { timeout: 60000, windowsHide: true });
        let raw = fs.readFileSync(tmpJson, 'utf8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        return JSON.parse(raw);
    } finally {
        try { fs.unlinkSync(tmpXls); } catch(e) {}
        try { fs.unlinkSync(tmpPs1); } catch(e) {}
        try { fs.unlinkSync(tmpJson); } catch(e) {}
    }
}

// ── 4. URL host 提取 ─────────────────────────────────────────────────
function extractHost(url) {
    try { return new URL(url).hostname; } catch(e) {
        const s = String(url).replace(/^[a-zA-Z]+:\/\//, '');
        const i = s.indexOf('/'); return i >= 0 ? s.substring(0, i) : s;
    }
}

// ── 5. 生成话术 ────────────────────────────────────────────────────
function generateReportMessage(xlsJson, templateStr) {
    let summary = '(未获取到漏洞总览)';

    // Sheet1（index=0）：漏洞总览
    if (xlsJson[0] && xlsJson[0].data && xlsJson[0].data.length > 1) {
        const row1 = xlsJson[0].data[1];
        if (row1 && row1[0]) {
            // 取第一列的长字符串作为总结
            summary = String(row1[0]).trim();
        }
    }

    // Sheet4（index=3）：全部漏洞清单
    // 列索引（硬编码，基于 Excel 列顺序）
    // A=序号(0), B=业务系统(1), C=负责人(2), D=漏洞名称(3), E=扫描方式(4),
    // F=漏洞类型(5), G=漏洞等级(6), H=是否可利用(7), I=防护规则(8),
    // J=受影响主机/位置(9), K=端口(10), L=版本号(11), M=内/外网(12),
    // N=修复优先级(13), O=跟进状态(14), P=备注信息(15), Q=来源(16),
    // R=发现时间(17), S=更新时间(18), T=漏洞危害(19), U=解决方案(20), V=参考资料(21)
    const BIZ = 1, VULN = 3, HOST = 9, SOL = 20, LEVEL = 6;

    const top3 = [];
    if (xlsJson[3] && xlsJson[3].data && xlsJson[3].data.length > 1) {
        const s = xlsJson[3];
        let lastBiz = null;
        const candidates = [];

        for (let r = 1; r < s.data.length; r++) {
            const row = s.data[r];
            if (!row) continue;

            const bizRaw = row[BIZ];
            const vulnVal = row[VULN];
            if (!vulnVal) continue;  // 跳过无漏洞名的行（如合并单元格的续行）

            if (bizRaw) {
                const bs = String(bizRaw).trim();
                if (bs) lastBiz = bs;
            }

            const hostRaw = row[HOST];
            const solRaw = row[SOL];
            const levelRaw = row[LEVEL];

            const hostS = hostRaw ? String(hostRaw).trim() : '';
            const vulnS = String(vulnVal).trim();
            if (!lastBiz || !vulnS) continue;

            const isUrl = /^[a-zA-Z]+:\/\//.test(hostS);
            const ip = isUrl ? extractHost(hostS) : hostS;
            candidates.push({
                biz: lastBiz, ip, vuln: vulnS,
                sol: solRaw ? String(solRaw).trim() : '',
                level: levelRaw ? String(levelRaw).trim() : '',
                isExternal: isUrl
            });
        }

        // 规则1：外网优先；规则2：四列都有值
        candidates.sort((a, b) => (b.isExternal ? 1 : 0) - (a.isExternal ? 1 : 0));
        top3.push(...candidates.slice(0, 3));
    }

    // 填充模板
    let msg = templateStr.replace('{漏洞扫描总结}', summary);
    // 生成单个漏洞条目行
    const fmtLine = (idx, item) =>
        `${idx}、${item.biz}（${item.ip}）存在${item.vuln};修复建议：${item.sol}`;

    // 构建高危漏洞段落（按实际条目数量，最多3条）
    const vulnLines = top3.map((item, i) => fmtLine(i + 1, item));

    // 用正则定位并替换模板中的"部分高危漏洞如下"段落
    // 匹配从"部分高危漏洞如下："到"修复指引"之间的所有行（含换行）
    const sectionStart = '部分高危漏洞如下：';
    const sectionEnd = '修复指引';
    const sectionIdx = msg.indexOf(sectionStart);
    if (sectionIdx !== -1 && vulnLines.length > 0) {
        const endIdx = msg.indexOf(sectionEnd, sectionIdx);
        const before = msg.slice(0, sectionIdx + sectionStart.length + 1); // 含换行
        const after = msg.slice(endIdx);  // 含"修复指引"及之后全部
        msg = before + vulnLines.join('\n') + '\n' + after;
    }
    return msg;
}

// ── 入口 ───────────────────────────────────────────────────────────
function main(argv) {
    const zipArg = argv.find(a => a.startsWith('--zip='));
    const zipPath = zipArg ? zipArg.split('=')[1] : findLatestZip('M:/Users/User/Downloads');
    if (!zipPath) throw new Error('未找到 ZIP 文件');
    const zipBuf = fs.readFileSync(zipPath);
    const xlsBuf = extractXlsFromZip(zipBuf);
    if (!xlsBuf) throw new Error('ZIP 中未找到漏洞清单.xls');
    const xlsJson = xlsToJsonSync(xlsBuf);
    const tplPath = path.join(__dirname, '..', '..', 'run-vuln-scan', 'templates', 'vuln_scan_report_message.txt');
    const templateStr = fs.readFileSync(tplPath, 'utf8');
    return generateReportMessage(xlsJson, templateStr);
}

module.exports = { generateReportMessage, extractXlsFromZip, findLatestZip, xlsToJsonSync };

if (require.main === module) {
    console.log(main(process.argv.slice(2)));
}