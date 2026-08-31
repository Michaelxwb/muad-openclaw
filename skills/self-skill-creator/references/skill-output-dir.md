# SKILL_OUTPUT_DIR 输出目录

Skill 若要写文件（报告、临时结果），必须写到环境变量 `SKILL_OUTPUT_DIR` 指向的目录。

## 为什么必须用 SKILL_OUTPUT_DIR

| 写入位置 | 问题 |
|---------|------|
| Skill 根目录 | 只读，Runtime Guard 不允许写 |
| `/tmp` | 不隔离不持久，跨 Skill 串数据，Pod 重启丢失 |
| `SKILL_OUTPUT_DIR` | Runtime Guard 注入的 per-agent 隔离目录，持久、隔离 |

## 三种语言最小用法

### TypeScript

```js
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outDir = process.env.SKILL_OUTPUT_DIR;
if (outDir) {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "result.json"), JSON.stringify({ ok: true }));
}
```

### Python

```python
import json
import os

out_dir = os.environ.get("SKILL_OUTPUT_DIR")
if out_dir:
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "result.json"), "w", encoding="utf-8") as f:
        json.dump({"ok": True}, f, ensure_ascii=False)
```

### Shell

```bash
out_dir="${SKILL_OUTPUT_DIR:-}"
if [ -n "$out_dir" ]; then
  mkdir -p "$out_dir"
  printf '{"ok":true}\n' > "$out_dir/result.json"
fi
```

## 关键约束

- **必须先判空**：`SKILL_OUTPUT_DIR` 可能为空（脚本被非 Skill 上下文调用时），空时不要写文件，避免误写到 cwd 或根目录。
- **递归创建**：用 `mkdir -p` / `mkdir recursive: true`，目录可能不存在。
- **不要写绝对路径**：所有写文件路径都以 `SKILL_OUTPUT_DIR` 为前缀拼接，不要硬编码其它绝对路径。
- **文件名避免冲突**：per-agent 隔离，但同一 Skill 多次调用可能复用同一目录，需要时加时间戳或自增序号。

## 与最终回复的关系

写文件后，**最终结果仍走 OpenClaw 原生最终回复**（脚本 stdout → 模型总结给用户）。`SKILL_OUTPUT_DIR` 里的文件是给后续步骤或用户下载用的，不是最终回复本身。最小版本不内置独立进度 CLI。
