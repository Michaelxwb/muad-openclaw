import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function progress(stage, text) {
  await execFileAsync("muad-progress", ["stage", "--stage", stage, "--text", text], {
    timeout: 3000,
  }).catch(() => undefined);
}

async function done(text) {
  await execFileAsync("muad-progress", ["done", "--text", text], { timeout: 3000 }).catch(
    () => undefined,
  );
}

async function fail(stage, text) {
  await execFileAsync("muad-progress", ["error", "--stage", stage, "--text", text], {
    timeout: 3000,
  }).catch(() => undefined);
}

async function main() {
  await progress("accepted", "已收到请求，开始处理");
  await progress("auth", "正在检查业务系统登录态");
  // await execFileAsync("session-manager", ["get-state", "--platform", "xdr", "--json"]);
  await progress("query", "正在查询业务系统数据");
  await progress("analysis", "正在分析结果");
  await done("处理完成，正在生成结果");
  console.log(JSON.stringify({ ok: true }));
}

main().catch(async () => {
  await fail("error", "处理失败，请稍后重试");
  process.exitCode = 1;
});
