import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..", "..");

test("worker image pins OpenClaw and records the base version", () => {
  const dockerfile = read("Dockerfile");
  const workflow = read(".github/workflows/build-image.yml");
  assert.match(dockerfile, /^ARG OPENCLAW_VERSION=2026\.6\.10$/mu);
  assert.match(dockerfile, /io\.muad\.openclaw\.version="\$\{OPENCLAW_VERSION\}"/u);
  assert.match(workflow, /OPENCLAW_VERSION=\$\{\{ inputs\.openclaw_version \|\| '2026\.6\.10' \}\}/u);
  assert.doesNotMatch(workflow, /OPENCLAW_VERSION=.*latest/u);
});

test("worker image builds session-manager and installs all runtime plugins and CLI", () => {
  const dockerfile = read("Dockerfile");
  for (const expected of [
    "AS session-manager-builder",
    "npm ci --include=dev",
    "COPY tools/session-manager/fixtures ./fixtures",
    "RUN npm test",
    "/opt/muad/session-manager",
    "/opt/muad/muad-run-skill",
    "/opt/muad/muad-runtime-guard",
    "/opt/muad/muad-runtime-guard/src/binding_code_spec.json",
    "private-skill-installer.mjs",
    "/usr/local/bin/session-manager",
    "runtime-image-self-check.mjs --image-only",
  ]) assert.equal(dockerfile.includes(expected), true, `Dockerfile missing ${expected}`);

  assert.match(read("entrypoint.sh"), /node \/opt\/muad\/runtime-image-self-check\.mjs/u);
});

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}
