# SKILL.md 写法

SKILL.md 是 Skill 的入口，frontmatter 决定何时触发，body 决定怎么执行。

## frontmatter（YAML）

只写 `name` 和 `description` 两个字段，**不要加其它字段**：

```yaml
---
name: <skill名>
description: "MANDATORY before calling <工具/场景>. Trigger on: <触发场景>。"
---
```

### `name`

- 小写字母、数字、`-` 或 `_`，必须以字母开头
- 与 `muad.skill.json` 的 `name`、目录名三者一致
- 不要与平台名长得像（见 [`naming-pitfalls.md`](naming-pitfalls.md)）

### `description`

这是 **Skill 的主触发机制**——模型只读 frontmatter 决定是否调用本 Skill，body 在触发后才加载。所以：

- **写清"何时使用"**：把所有触发场景写在这里，不要写到 body 的「何时使用」节（body 加载时已经触发了，写那里没用）。
- **包含具体触发词**：例如 `Trigger on: 搜索/抓取网页/打开网站`，比泛泛的"用于网页操作"更易触发。
- **不含密钥/内部 URL/业务数据**：frontmatter 是元数据，会被扫描进索引。
- **例**：`"Comprehensive document creation, editing, and analysis with support for tracked changes, comments, formatting preservation, and text extraction. Use when Claude needs to work with professional documents (.docx files) for: (1) Creating new documents, (2) Modifying or editing content, (3) Working with tracked changes, (4) Adding comments, or any other document tasks"`

## body（Markdown）

### 写法

- **祈使句**：`Extract text with pdfplumber:` 而不是 `This skill extracts text with pdfplumber.`
- **渐进式披露**：核心流程放 SKILL.md，大段规范/示例放 `references/`，在 SKILL.md 里链接过去。
- **控制在 500 行以内**：接近就拆分到 `references/`。
- **引导模型跑脚本，而非直接调工具**：顶部用「快速调用速查」直接列出脚本命令（如 `node scripts/run.mjs`），不要让模型直接调 `session_get_state` 工具。

### 渐进式披露三种模式

**模式 1：高层指南 + references**

```markdown
# PDF Processing

## Quick start
Extract text with pdfplumber:
[code example]

## Advanced features
- **Form filling**: See [FORMS.md](FORMS.md) for complete guide
- **API reference**: See [REFERENCE.md](REFERENCE.md) for all methods
```

**模式 2：按领域/变体拆分**

```
bigquery-skill/
├── SKILL.md (overview and navigation)
└── references/
    ├── finance.md
    ├── sales.md
    └── product.md
```

**模式 3：条件分支**

```markdown
## Creating documents
Use docx-js for new documents. See [DOCX-JS.md](DOCX-JS.md).

## Editing documents
For simple edits, modify the XML directly.
**For tracked changes**: See [REDLINING.md](REDLINING.md)
```

### references 文件规则

- **只深一级**：所有 references 直接由 SKILL.md 链接，不要嵌套 references 引用 references。
- **>100 行加目录**：长文件顶部加 table of contents，让模型预览时能看到全貌。
- **避免重复**：信息要么在 SKILL.md，要么在 references，不要两边都写。优先放 references，保持 SKILL.md 精简。

## 不要写的东西

- **不要**写 README.md / INSTALLATION_GUIDE.md / QUICK_REFERENCE.md / CHANGELOG.md 等辅助文档，skill 目录只放 AI 干活必需的文件。
- **不要**在 body 里写「何时使用本 Skill」节——触发场景应在 frontmatter `description` 里。
- **不要**把密钥/内部 URL/业务数据写进 frontmatter 或 body。
