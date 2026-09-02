$ErrorActionPreference = "Stop"

$dst = "M:\Users\User\Downloads\网络安全事件处理反馈单_风行天下.docx"

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0

try {
    $doc = $word.Documents.Open($dst, $false, $true)

    $filled = $false
    foreach ($tbl in $doc.Tables) {
        foreach ($row in $tbl.Rows) {
            if ($row.Cells.Count -ge 2) {
                $label = $row.Cells.Item(1).Range.Text
                $label = ($label -replace "[\r\n\a\x07]","").Trim()
                if ($label -eq "接收单位") {
                    $row.Cells.Item(2).Range.Text = "风行天下"
                    $filled = $true
                }
            }
        }
    }

    if ($filled) {
        Write-Output "FILLED_PARAM"
    } else {
        Write-Output "NOT_FOUND"
    }

    $doc.Save()
    $doc.Close($false)
} finally {
    $word.Quit()
}
