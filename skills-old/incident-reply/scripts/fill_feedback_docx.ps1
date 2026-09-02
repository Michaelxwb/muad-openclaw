$ErrorActionPreference = "Stop"

$src = "M:\Users\User\Downloads\网络安全事件处理反馈单.docx"
$dst = "M:\Users\User\Downloads\网络安全事件处理反馈单_风行天下.docx"

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0

try {
    $doc = $word.Documents.Open($src, $false, $true)

    # --- step A: fill 接收单位 cell (label text = 接收单位) ---
    $paramLab = $null
    foreach ($tbl in $doc.Tables) {
        foreach ($row in $tbl.Rows) {
            if ($row.Cells.Count -ge 2) {
                $lab = ($row.Cells.Item(1).Range.Text -replace "[\r\n\a\x07]","").Trim()
                if ($lab -eq "接收单位") {
                    $c = $row.Cells.Item(2).Range
                    $c.Text = "风行天下"
                    $paramLab = ($row.Cells.Item(2).Range.Text -replace "[\r\n\a\x07]","").Trim()
                }
            }
        }
    }
    Write-Output "RECV_UNIT_FILLED=[$paramLab]"

    # --- step B: fill 涉事系统 ---
    $null = $doc.Content.Find.Execute("经查为我司出口防火墙nat出的互联网地址，外连C2 服务器时段为XXX的个人电脑终端使用。", $false, $false, $false, $false, $false, $true, 1, $false, "源IP为39.144.190.29，外联目标地址为192.168.18.35（端口49001）。", 2)

    # --- step C: fill 事件处理措施 5 步 ---
    $null = $doc.Content.Find.Execute("1.通过AF日志定位到通报中外联恶意服务器的电脑终端。", $false, $false, $false, $false, $false, $true, 1, $false, "1.经查询客户资产台账，该资产（源IP 39.144.190.29）未录入我司资产台账，未命中客户资产记录。", 2)
    $null = $doc.Content.Find.Execute("2.通过流量分析，暂未发现该终端感染病毒后存在病毒扩散、文件窃取、横向攻击等行为。", $false, $false, $false, $false, $false, $true, 1, $false, "2.经深信服威胁情报平台研判，通报IoC（192.168.18.35:49001）信誉评级为安全，无威胁标签，研判结果正常。", 2)
    $null = $doc.Content.Find.Execute("3.已使用杀毒软件对该终端进行全盘查杀。", $false, $false, $false, $false, $false, $true, 1, $false, "3.经查网络安全日志，该资产与通报IoC存在匹配的安全日志记录，共1894条，动作均为允许（时间范围2026-08-11 23:08:53至2026-08-18 23:01:16）。", 2)
    $null = $doc.Content.Find.Execute("4.在出口防火墙上对外联恶意IP进行封禁。", $false, $false, $false, $false, $false, $true, 1, $false, "4.经查TCP访问日志（通报IoC为IP+端口），该资产与通报IoC未发现相关访问日志记录。", 2)
    $null = $doc.Content.Find.Execute("5.对涉及人员进行网络安全教育，提高网络安全意识。", $false, $false, $false, $false, $false, $true, 1, $false, "5.综合研判结论：通报IoC信誉安全，未发现该资产存在恶意外联或感染行为，后续将持续监测该资产外联动态。", 2)

    # --- step D: 安全管理情况 ---
    $null = $doc.Content.Find.Execute("涉事终端为个人电脑终端，已对其进行网络安全教育，并安装杀毒软件，定期开展病毒查杀。", $false, $false, $false, $false, $false, $true, 1, $false, "该资产（源IP 39.144.190.29）未录入资产台账，暂无法确认EDR安装状态（agent_status：N/A），建议尽快纳入资产管理并部署EDR端点安全防护，加强日常监测。", 2)

    $doc.SaveAs2($dst, 16)
    Write-Output "SAVED"
    $doc.Close($false)
} finally {
    # do NOT call $word.Quit() to avoid hang; just release
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null } catch {}
}
