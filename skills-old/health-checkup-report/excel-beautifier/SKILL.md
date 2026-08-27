---
name: excel-beautifier
author: 陈梅（35937）
description: >
  为 Excel (.xlsx) / CSV (.csv) 表格统一套用视觉规范的工具。当用户要求"美化/优化表格"、
  "统一表格风格"、"套用模板"、"按规范输出表格"、"生成规范样式的 Excel"、
  "安全清单风格"、"汇报风格"等时使用。内置两套主题：classic 经典清单
  （宋体浅蓝底，适合安全/合规清单）与 modern 现代汇报（雅黑斑马纹，
  适合汇报/对外）。自动识别表头与数据区，处理前先清除表格原有单元格样式（含
  条件格式），再统一应用字体、表头色、底色/斑马纹、边框、数字格式、语义色
  （等级/状态/结果/优先级/攻击文字着色）、行高自适应、页面设置，可选水印。
  支持 CSV 直出规范表格（编码自动识别 utf-8/gbk，首行即表头）。
---

# excel-beautifier — Excel 表格统一视觉规范

## 使用场景

1. 用户提供任意 .xlsx 或 .csv 表格，希望统一优化成规范视觉样式
2. AI 工具（openclaw 等）生成报告后，按规范输出表格（CSV 直出最省事）
3. 需要安全清单风格或商务汇报风格的 Excel 输出

## 两种主题

| 主题 | 特征 | 适用场景 |
|------|------|----------|
| `classic` | 宋体、深蓝表头 #1F497D、统一浅蓝底 #DCE6F2、左对齐 | 安全/合规检查清单、台账 |
| `modern` | 微软雅黑、主蓝 #1F4E79+辅蓝 #0D51D9、隔行斑马纹 #F2F6FC、居中表头 | 汇报材料、对外交付 |

默认主题：classic。拿不准时：清单/台账/安全类选 classic，汇报/对外/经营类选 modern。

## 执行步骤

1. 用 CLI 处理（无需读文件内容，工具自动识别结构）：

```bash
cd <excel-beautifier 目录>
python3 scripts/cli.py style "<输入.xlsx>" -t classic -o "<输出.xlsx>"
# 或 -t modern；不传 -o 则覆盖原文件
# 需要水印时追加 --watermark "机密"
# CSV 直出：python3 scripts/cli.py style report.csv -t classic -o report.xlsx
```

2. 处理完成后向用户说明：输出路径、使用的主题、生效的样式（表头色/底色/语义色/行高等）。

## 注意事项

- 支持 .xlsx 与 .csv（.csv 编码自动识别 utf-8/gbk，逗号/Tab 分隔，首行即表头，输出 .xlsx）；不支持旧版 .xls
- 水印默认关闭，Pillow 为可选依赖；传 `--watermark` 即自动启用
- 处理前自动清除原单元格样式（字体/填充/边框/数字格式/条件格式），统一按主题规则渲染；原值、公式、合并单元格不受影响
- 语义色列识别：等级/风险列（表头含「等级/级别/风险」）、状态列（含「状态」，覆盖处置状态/推送状态等）、结果列（含「结果」）、优先级列（含「优先级」，覆盖修复优先级等）、攻击列（含「攻击」，覆盖攻击结果/攻击状态——该列的「成功/失陷」按负面红色处理，与处置/推送成功绿色区分）
- 语义色为**文字着色**（不改背景），枚举值见 `scripts/excel_beautifier/themes/shared_semantic.json`，可用 `list_templates`/`show_template`（MCP）或读该文件了解
- 涨跌红绿条件格式仅作用于含「增长」等关键词的列，不会误染端口号等普通数字列
- 行高 24–62 点自适应；超长文本列不参与行高估算，不会撑爆行高

## 配置说明

- 主题文件：`scripts/excel_beautifier/themes/classic.json`、`modern.json`
- 共享语义色：`scripts/excel_beautifier/themes/shared_semantic.json`（改一处全主题生效）
- 详细规范见同目录 `README.md`

## 作者与联系

本技能由 **陈梅（35937）** 创建并维护。如遇使用问题、Bug 反馈或主题定制需求，欢迎联系作者。
