# self-skill-review 规则

确定性规则由 `scripts/check.py` 执行，只读文本与 Python AST，不执行目标代码。所有规则的建议都带 `file:line`；`error` 使审阅退出码为 1，`warning` 只提示。

| 规则 | 级别 | 检查内容 |
|------|------|----------|
| SS-R001 | error | 文件类型：只允许 `.md/.json/.py/.txt/.yaml/.yml/.csv/.tsv` 与常见图片；TS/Shell 脚本已下线；禁止 symlink |
| SS-R002 | error | `muad.skill.json` 存在、JSON 合法；`name` 非空；`runtime` 只能是 `script`；`version` 为 semver；`platforms` 为字符串数组 |
| SS-R003 | error | `SKILL.md` frontmatter 的 `name`、manifest `name`、目录名三者一致 |
| SS-R004 | error | `entrypoint` 声明时必须指向存在的 `.py` 文件 |
| SS-R005 | error | 声明了 `platforms` 的 Skill 必须 import 并调用 `muad_skill_http.platform_request` |
| SS-R006 | error | 禁止 `requests` / `httpx` / `aiohttp` / `urllib.request` / `http.client` 直连业务接口 |
| SS-R007 | warning | 禁止手工拼装 `Cookie` / CSRF / `Traceid` 等敏感头；由 `platform_request` 统一构造 |
| SS-R008 | error | 禁止用 `subprocess` / `os.system` 调用 `curl`、`wget`、`http` 或 `requests` 发业务请求 |
| SS-R009 | error | 异常路径不得只写 stdout，也不得 `exit(0)`；必须 stderr + 非 0 |
| SS-R010 | error | 写文件必须使用 `SKILL_OUTPUT_DIR`；禁止绝对路径与 `/tmp` |
| SS-R011 | error | `session-manager get-state --skill-name` 的值必须是硬编码字符串，且等于 manifest `name` |
| SS-R012 | error | 不得硬编码密码、Token、Cookie 等凭据或内部 URL |
| SS-R013 | error | Python 文件必须能解析（语法错误无法审查） |

## 正反例

✅ 业务请求走 SDK

```python
from muad_skill_http import platform_request

response = platform_request("demo_platform", "GET", "/api/v1/items")
```

❌ 手工拼 Cookie/CSRF、直连 requests

```python
headers = {"Cookie": cookie_str, "X-CSRFToken": csrf}
requests.get(url, headers=headers)
```

✅ 写文件用 `SKILL_OUTPUT_DIR`

```python
out_dir = os.environ.get("SKILL_OUTPUT_DIR")
if out_dir:
    with open(os.path.join(out_dir, "report.md"), "w", encoding="utf-8") as handle:
        handle.write(report)
```

❌ 写 `/tmp` 或 Skill 根目录

```python
with open("/tmp/report.md", "w", encoding="utf-8") as handle:
    handle.write(report)
```

✅ 失败 fail loud

```python
if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"ok": False}), file=sys.stderr)
        sys.exit(1)
```

❌ 失败写 stdout 并正常退出

```python
try:
    main()
except Exception:
    print("failed")
```

## 说明

- `SS-R007` 是 warning，因为设计上请求头规则是"警告级、不阻断上传"；其余规则为 error。
- 规则只覆盖可确定判断的模式。语义问题（触发描述、节点粒度、业务正确性）由模型按 `SKILL.md` 流程审查。
- 兼容性：存量 Skill 不做上传拦截，审阅结果用于管理员审批与逐步迁移。
