import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("Python, TypeScript, and Shell fixtures delegate to the same CLI contract", (t) => {
  const binDir = mkdtempSync(join(tmpdir(), "session-manager-fixture-bin-"));
  t.after(() => rmSync(binDir, { recursive: true, force: true }));
  const executable = join(binDir, "session-manager");
  writeFileSync(executable, "#!/bin/sh\nprintf '{\"version\":1,\"status\":\"ready\",\"platform\":\"%s\"}\\n' \"$3\"\n");
  chmodSync(executable, 0o755);
  const env = { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` };
  const fixtures = fixturePaths();

  const results = [
    spawnSync("python3", [fixtures.python, "xdr"], { encoding: "utf8", env }),
    spawnSync(process.execPath, [fixtures.typescript, "xdr"], { encoding: "utf8", env }),
    spawnSync("sh", [fixtures.shell, "xdr"], { encoding: "utf8", env }),
  ];
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { version: 1, status: "ready", platform: "xdr" });
  }
  assert.equal(new Set(results.map((result) => result.stdout)).size, 1);
});

function fixturePaths() {
  return {
    python: fileURLToPath(new URL("../fixtures/python/get_state.py", import.meta.url)),
    typescript: fileURLToPath(new URL("../fixtures/typescript/get-state.ts", import.meta.url)),
    shell: fileURLToPath(new URL("../fixtures/shell/get-state.sh", import.meta.url)),
  };
}
