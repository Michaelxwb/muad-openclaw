import { execFile } from "node:child_process";
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
  console.log(JSON.stringify({ ok: true, sessionState: state.state ?? "ready" }));
}

main().catch(() => {
  console.error(JSON.stringify({ ok: false, error: "处理失败，请稍后重试" }));
  process.exitCode = 1;
});
