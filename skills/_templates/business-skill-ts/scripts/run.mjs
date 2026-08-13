import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const skillName = "business-skill-ts-template";

async function main() {
  const { stdout } = await execFileAsync(
    "session-manager",
    ["get-state", "--skill-name", skillName],
    { timeout: 30000 },
  );
  const state = JSON.parse(stdout);
  // 写文件用 SKILL_OUTPUT_DIR（guard 注入的 per-agent 目录）；别写 Skill 根目录（只读）或 /tmp
  const outDir = process.env.SKILL_OUTPUT_DIR;
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(`${outDir}/result.json`, JSON.stringify({ ok: true }));
  }
  console.log(JSON.stringify({ ok: true, sessionState: state.state ?? "ready" }));
}

main().catch(() => {
  console.error(JSON.stringify({ ok: false, error: "处理失败，请稍后重试" }));
  process.exitCode = 1;
});
