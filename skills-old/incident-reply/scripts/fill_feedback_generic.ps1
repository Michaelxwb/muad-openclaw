param(
    [Parameter(Mandatory=$true)][string]$paramsJson
)
# 通用回函 docx 填充脚本：从 paramsJson 读取填充内容
$ErrorActionPreference = "Stop"

$p = Get-Content $paramsJson -Raw -Encoding utf8 | ConvertFrom-Json

$src = $p.srcDocx
$dst = $p.dstDocx

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0

try {
    $doc = $word.Documents.Open($src, $false, $true)

    # A) 接收单位 = 公司名
    foreach ($tbl in $doc.Tables) {
        foreach ($row in $tbl.Rows) {
            if ($row.Cells.Count -ge 2) {
                $lab = ($row.Cells.Item(1).Range.Text -replace "[\r\n\a\x07]","").Trim()
                if ($lab -eq "接收单位") {
                    $c = $row.Cells.Item(2).Range
                    $c.Text = $p.recvUnit
                }
            }
        }
    }

    # B) 涉事系统情况
    $null = $doc.Content.Find.Execute($p.findSrcTxt, $false, $false, $false, $false, $false, $true, 1, $false, $p.sheShiTxt, 2)

    # C) 事件处理措施 1-4 步 + m5（删除占位）
    $null = $doc.Content.Find.Execute($p.findM1, $false, $false, $false, $false, $false, $true, 1, $false, $p.m1, 2)
    $null = $doc.Content.Find.Execute($p.findM2, $false, $false, $false, $false, $false, $true, 1, $false, $p.m2, 2)
    $null = $doc.Content.Find.Execute($p.findM3, $false, $false, $false, $false, $false, $true, 1, $false, $p.m3, 2)
    $null = $doc.Content.Find.Execute($p.findM4, $false, $false, $false, $false, $false, $true, 1, $false, $p.m4, 2)

    # m5：若值为空，则用空串替换占位文本，并删除残留的整个段落（含段落标记），避免残留空行/结论；否则正常替换
    $m5Text = [string]$p.m5
    if ($m5Text -eq "") {
        # 先用空串替换占位文本（清空该段落文字）
        $null = $doc.Content.Find.Execute($p.findM5, $false, $false, $false, $false, $false, $true, 1, $false, "", 2)
        # 再按精确占位文本定位段落并整体删除（含段落标记 wdParagraph=4）
        $find = $doc.Content.Find
        $found = $find.Execute($p.findM5, $false, $false, $false, $false, $false, $true, 1, $false)
        if ($found) {
            $rng = $find.Parent
            $rng.MoveEnd(4, 1) | Out-Null
            $rng.Delete() | Out-Null
        }
    } else {
        $null = $doc.Content.Find.Execute($p.findM5, $false, $false, $false, $false, $false, $true, 1, $false, $m5Text, 2)
    }

    # D) 安全管理情况
    $null = $doc.Content.Find.Execute($p.findSafeTxt, $false, $false, $false, $false, $false, $true, 1, $false, $p.safeTxt, 2)

    $doc.SaveAs2($dst, 16)
    Write-Output "SAVED: $dst"
    $doc.Close($false)
} finally {
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null } catch {}
}
