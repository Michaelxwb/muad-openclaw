#!/usr/bin/env bash
set -euo pipefail

muad-progress done \
  --stage query \
  --text $'四语言一致 ✅\nMarkdown **bold**' \
  --id cross-language \
  --skill fixture-skill
printf '{"ok":true,"language":"shell"}\n'
