# self-skill-review 规则

确定性规则由 `scripts/check.py` 执行，只读文本与 Python AST，不执行目标代码。所有规则的建议都带 `file:line`；`error` 使审阅退出码为 1，`warning` 只提示。

| 规则 | 级别 | 检查内容 |
|------|------|----------|
| SS-R001 | error | 文件类型：只允许 `.md/.json/.py/.txt/.yaml/.yml/.csv/.tsv` 与常见图片；TS/Shell 脚本已下线；禁止 symlink |
| SS-R002 | error | `muad.skill.json` 存在、JSON 合法；`name` 非空；`runtime` 只能是 `script`；`version` 为 semver；`platforms` 为字符串数组 |
| SS-R003 | error | `SKILL.md` frontmatter 的 `name`、manifest `name`、目录名三者一致 |
| SS-R004 | error | `entrypoint` 声明时必须指向存在的 `.py` 文件 |
| SS-R005 | error | 声明了 `platforms` 的 Skill 必须 import 并调用 `muad_skill_http.platform_request`；每次调用必须传 `state_file`，且脚本通过 `session-manager get-state` 获取该状态文件 |
| SS-R006 | error | 禁止 `requests` / `httpx` / `aiohttp` / `urllib.request` / `http.client` 直连业务接口 |
| SS-R007 | warning | 禁止手工拼装 `Cookie` / CSRF / `Traceid` 等敏感头（仅检查 headers/cookies 容器；普通响应字段如 `{"traceId": ...}` 不告警）；由 `platform_request` 统一构造 |
| SS-R008 | error | 禁止用 `subprocess` / `os.system` 调用 `curl`、`wget`、`http` 或 `requests` 发业务请求 |
| SS-R009 | error | 异常路径不得只写 stdout，也不得 `exit(0)`；必须 stderr + 非 0 |
| SS-R010 | error | 写文件必须使用 `SKILL_OUTPUT_DIR`；禁止绝对路径与 `/tmp` |
| SS-R011 | error | `session-manager get-state --skill-name` 的值必须是硬编码字符串，且等于 manifest `name` |
| SS-R012 | error | 不得硬编码密码、Token、Cookie 等凭据或内部 URL |
| SS-R013 | error | Python 文件必须能解析（语法错误无法审查） |
| SS-R014 | error | `muad.skill.json.author` 必须存在且为非空字符串（作者姓名/工号/用户名） |

## 正反例

✅ 业务请求走 SDK

```python
from muad_skill_http import platform_request

state_file = ...  # session-manager get-state --skill-name <skill>
response = platform_request("demo_platform", "GET", "/api/v1/items", state_file=state_file)
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

## 语义审查清单（模型执行）

以下问题无法由确定性规则可靠判断，跑完 `check.py` 后必须逐项核对：

- **文档与断言一致**：文档声称验证的 Cookie/CSRF/Host/静态头/Traceid，脚本是否真的断言了？GET 冒烟不能默认证明 CSRF；要么补状态变更请求，要么收窄文档。
- **Traceid 唯一性**：平台 Skill 是否连续请求并比较 `Traceid`？单请求只能证明有值，不能证明每请求独立。
- **stdout/stderr 契约**：stdout 是否只有一条机器可读 JSON？进度、诊断是否写 stderr？
- **退出码完整**：是否说明成功、参数错误、运行时失败、Traceid 重复、SDK 限额 `86` 的区别？
- **探测边界**：`--path` 是否有 allowlist，`--count` 是否有上限，避免测试 Skill 变成任意接口探测器。
- **限额 hard-exit**：SDK 触发限额会 `os._exit(86)`，脚本若要在终止前输出汇总，必须在最后一次请求前打印，不能依赖 `finally`/末尾代码。
- **产物 best-effort**：写 `SKILL_OUTPUT_DIR` 失败不得吞掉已经成功的 stdout 结果。
- **常量收敛**：平台名、接口路径不要在多处重复；从共享常量或 manifest 读取。
- **接口语义**：不要把 `healthEndpoint` 当作业务冒烟接口；健康检查不保证返回用户/Traceid。内部 endpoint 路径在文档中用占位符。

## 稳定性与停止条件

- 报告中的 `Fingerprint` 标识被审代码快照；相同 fingerprint 的重复语义审查应可比较，结论差异视为审查员判断差异，不是代码变化。
- 高：让“通过”结论不可信，或破坏 stdout/stderr、退出码、限额告警、安全边界；必须修。
- 中：文档/实现不一致、边界不足或明显维护性问题；建议修，但不单独阻塞上传，除非影响正确性。
- 低：风格、示例、命名；记录到 backlog，可延后。
- 停止条件：确定性检查 PASS，且语义审查无“高”级问题 → 可上传。同一 fingerprint 下新增的“中/低”问题不要求无限重跑追平。

## 说明

- 规则 ID（`SS-Rxxx`）是内部追踪与抑制标识，不要求 Skill 作者理解；面向用户的报告必须先描述**问题是什么、影响是什么**，规则 ID 只做括号备注。

- `SS-R007` 是 warning，因为设计上请求头规则是"警告级、不阻断上传"；其余规则为 error。
- 规则只覆盖可确定判断的模式。语义问题（触发描述、节点粒度、业务正确性）由模型按 `SKILL.md` 流程审查。
- 兼容性：存量 Skill 不做上传拦截，审阅结果用于管理员审批与逐步迁移。
