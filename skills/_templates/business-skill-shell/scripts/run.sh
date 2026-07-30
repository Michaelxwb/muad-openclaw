#!/usr/bin/env bash
set -euo pipefail

skill_name="business-skill-shell-template"
session_state_file="$(mktemp)"

cleanup() {
  rm -f "$session_state_file"
}

trap cleanup EXIT

session-manager get-state --skill-name "$skill_name" >"$session_state_file"

printf '{"ok":true}\n'
