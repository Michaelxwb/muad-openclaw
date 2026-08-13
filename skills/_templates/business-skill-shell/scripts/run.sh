#!/usr/bin/env bash
set -euo pipefail

skill_name="business-skill-shell-template"
session_state_file="$(mktemp)"

cleanup() {
  rm -f "$session_state_file"
}

trap cleanup EXIT

session-manager get-state --skill-name "$skill_name" >"$session_state_file"

# 写文件用 SKILL_OUTPUT_DIR（guard 注入的 per-agent 目录）；别写 Skill 根目录（只读）或 /tmp
out_dir="${SKILL_OUTPUT_DIR:-}"
if [ -n "$out_dir" ]; then
  mkdir -p "$out_dir"
  printf '{"ok":true}\n' > "$out_dir/result.json"
fi

printf '{"ok":true}\n'
