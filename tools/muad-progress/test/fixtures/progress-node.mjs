import { execFileSync } from "node:child_process";

execFileSync("muad-progress", [
  "done", "--stage", "query",
  "--text", "四语言一致 ✅\nMarkdown **bold**",
  "--id", "cross-language", "--skill", "fixture-skill",
], { stdio: ["ignore", "inherit", "inherit"] });
process.stdout.write('{"ok":true,"language":"node"}\n');
