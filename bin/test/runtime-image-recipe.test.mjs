import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..", "..");

test("worker image pins OpenClaw and records the base version", () => {
  const base = read("Dockerfile.base");
  const app = read("Dockerfile");
  const workflow = read(".github/workflows/build-image.yml");
  // Base image pins openclaw version
  assert.match(base, /^ARG OPENCLAW_VERSION=2026\.7\.1$/mu);
  assert.match(base, /io\.muad\.openclaw\.version="\$\{OPENCLAW_VERSION\}"/u);
  assert.match(base, /io\.muad\.image\.role="base"/u);
  // App image references base with BASE_IMAGE and BASE_TAG
  assert.match(app, /^ARG BASE_IMAGE=muad-openclaw-base$/mu);
  assert.match(app, /^ARG BASE_TAG=latest$/mu);
  assert.match(app, /^FROM \$\{BASE_IMAGE\}:\$\{BASE_TAG\}$/mu);
  assert.match(
    app,
    /# ── 最终镜像 ──[\s\S]*?FROM \$\{BASE_IMAGE\}:\$\{BASE_TAG\}\n\nLABEL io\.muad\.image\.role="app"/u,
  );
  // CI still passes openclaw version through
  assert.match(
    workflow,
    /OPENCLAW_VERSION=\$\{\{ inputs\.openclaw_version \|\| '2026\.7\.1' \}\}/u,
  );
  assert.doesNotMatch(workflow, /OPENCLAW_VERSION=.*latest/u);
});

test("worker image builds session-manager and installs all runtime plugins and CLI", () => {
  const app = read("Dockerfile");
  for (const expected of [
    "AS session-manager-builder",
    "npm ci --include=dev",
    "COPY tools/session-manager/fixtures ./fixtures",
    "COPY tools/session-manager/scripts ./scripts",
    "COPY tools/fake-business-platform /build/fake-business-platform",
    "COPY skills /skills",
    "RUN npm test",
    "/opt/muad/session-manager",
    "/opt/muad/muad-runtime-guard",
    "/opt/muad/muad-runtime-guard/src/binding_code_spec.json",
    "private-skill-installer.mjs",
    "prune-managed-plugin-installs.mjs",
    "/usr/local/bin/session-manager",
    "runtime-image-self-check.mjs --image-only",
    "image-plugin-paths.mjs",
    "channel-config.mjs",
  ])
    assert.equal(
      app.includes(expected),
      true,
      `Dockerfile missing ${expected}`,
    );

  assert.match(
    read("entrypoint.sh"),
    /node \/opt\/muad\/runtime-image-self-check\.mjs/u,
  );
  assert.doesNotMatch(app, /COPY --from=session-manager-builder[\s\S]*\/build\/fake-business-platform/u);
  assert.doesNotMatch(app, /COPY --from=session-manager-builder[\s\S]*\/skills/u);
});

test("S-06 worker image builds tests and installs muad-progress without runtime npm install", () => {
  const app = read("Dockerfile");
  const builder = app.match(
    /FROM \$\{BASE_IMAGE\}:\$\{BASE_TAG\} AS muad-progress-builder([\s\S]*?)# ── 最终镜像 ──/u,
  )?.[1] ?? "";
  const finalStage = app.split("# ── 最终镜像 ──")[1] ?? "";

  for (const expected of [
    "WORKDIR /build/muad-progress",
    "tools/muad-progress/package.json",
    "tools/muad-progress/package-lock.json",
    "tools/muad-progress/tsconfig.json",
    "npm ci --include=dev",
    "COPY tools/muad-progress/src ./src",
    "COPY tools/muad-progress/test ./test",
    "RUN npm test",
  ]) assert.equal(builder.includes(expected), true, `muad-progress builder missing ${expected}`);

  assert.match(finalStage, /COPY --from=muad-progress-builder \/build\/muad-progress\/dist \/opt\/muad\/muad-progress\/dist/u);
  assert.match(finalStage, /COPY tools\/muad-progress\/package\.json \/opt\/muad\/muad-progress\//u);
  assert.match(finalStage, /ln -s \/opt\/muad\/muad-progress\/dist\/cli\.js \/usr\/local\/bin\/muad-progress/u);
  assert.match(finalStage, /chmod 0755[\s\S]*\/opt\/muad\/muad-progress\/dist\/cli\.js/u);
  assert.match(finalStage, /chmod -R a\+rX[\s\S]*\/opt\/muad\/muad-progress/u);
  assert.match(finalStage, /chown -R node:node[\s\S]*\/opt\/muad\/muad-progress/u);
  assert.doesNotMatch(finalStage, /npm (?:ci|install)[^\n]*muad-progress/u);
  assert.doesNotMatch(finalStage, /COPY --from=muad-progress-builder[^\n]*\/test(?:\s|$)/u);
});

test("S-06 Qianliu recipe carries prebuilt muad-progress dist through cache into the runtime image", () => {
  const task0 = read("build/docker-build/task0-session-manager.sh");
  const task4 = read("build/docker-build/task4-openclaw.sh");
  const app = read("build/docker-build/Dockerfile.openclaw");

  for (const expected of [
    "tools/muad-progress",
    "npm run build",
    "${CACHE_DIR}/muad-progress-dist",
    "muad-progress/dist/cli.js",
  ]) assert.equal(task0.includes(expected), true, `Qianliu Task0 missing ${expected}`);
  assert.match(task0, /build_package "muad-progress" "\$\{PROGRESS_DIR\}"/u);
  assert.match(
    task0,
    /cp -r "\$\{PROGRESS_DIR\}\/dist\/\." "\$\{CACHE_DIR\}\/muad-progress-dist\/"/u,
  );

  for (const expected of [
    "${CACHE_DIR}/muad-progress-dist",
    "tools/muad-progress/dist",
    "muad-progress/dist/cli.js",
  ]) assert.equal(task4.includes(expected), true, `Qianliu Task4 missing ${expected}`);
  assert.match(
    task4,
    /copy_dist "muad-progress" "\$\{PROGRESS_CACHE\}" "\$\{PROGRESS_DEST\}"/u,
  );
  assert.match(task4, /--password-stdin/u);
  assert.match(task4, /DOCKER_USER[^\n]*required/u);
  assert.match(task4, /DOCKER_PASS[^\n]*required/u);
  assert.doesNotMatch(task4, /DOCKER_(?:USER|PASS):-/u);

  for (const expected of [
    "COPY tools/muad-progress/dist /opt/muad/muad-progress/dist",
    "COPY tools/muad-progress/package.json /opt/muad/muad-progress/",
    "ln -s /opt/muad/muad-progress/dist/cli.js /usr/local/bin/muad-progress",
    "/opt/muad/muad-progress/dist/cli.js",
    "/opt/muad/runtime-image-self-check.mjs",
    "ENTRYPOINT [\"/usr/local/bin/muad-entrypoint.sh\"]",
  ]) assert.equal(app.includes(expected), true, `Qianliu Dockerfile missing ${expected}`);

  assert.match(app, /chmod -R a\+rX[^;]*\/opt\/muad\/muad-progress/u);
  assert.match(app, /chown -R node:node[^;]*\/opt\/muad\/muad-progress/u);
  assert.doesNotMatch(app, /(?:RUN|&&|;)\s+npm (?:ci|install)\b/u);
  assert.doesNotMatch(app, /COPY tools\/muad-progress\/(?:node_modules|test)(?:\s|$)/u);
});

test("base image contains OpenClaw, Chromium/Playwright, channel plugins, and seed", () => {
  const base = read("Dockerfile.base");
  const entrypoint = read("entrypoint.sh");
  // OpenClaw upstream
  assert.match(
    base,
    /FROM ghcr\.io\/openclaw\/openclaw:\$\{OPENCLAW_VERSION\}/u,
  );
  // Playwright / Chromium
  assert.match(
    base,
    /node \/app\/node_modules\/playwright-core\/cli\.js install --with-deps chromium/u,
  );
  // WeCom plugin
  assert.match(base, /openclaw plugins install.*wecom-openclaw-plugin/u);
  // WeChat plugin
  assert.match(base, /openclaw plugins install.*openclaw-weixin/u);
  // Mattermost plugin
  assert.match(base, /^ARG MATTERMOST_PLUGIN_VERSION=2026\.7\.1$/mu);
  assert.match(base, /openclaw plugins install.*@openclaw\/mattermost/u);
  assert.match(base, /\/opt\/openclaw-plugins\/wecom-openclaw-plugin/u);
  assert.match(base, /\/opt\/openclaw-plugins\/openclaw-weixin/u);
  assert.match(base, /\/opt\/openclaw-plugins\/mattermost/u);
  assert.match(base, /cp -a "\$node_modules_dir"\/\. "\$target\/node_modules"\//u);
  assert.match(base, /rm -rf "\$target\/node_modules\/\$\{package_path\}"/u);
  assert.match(base, /rm -rf \/home\/node\/\.openclaw\/npm\/projects/u);
  assert.match(entrypoint, /node \/opt\/muad\/prune-managed-plugin-installs\.mjs/u);
  // Baseline seed
  assert.match(base, /seed-config\.mjs/u);
  assert.match(base, /\/opt\/openclaw-seed/u);
  // Entrypoint seed-to-PVC copy on first boot
  assert.match(entrypoint, /cp -r \/opt\/openclaw-seed/u);
  // Labels
  assert.match(base, /io\.muad\.image\.role="base"/u);
  assert.match(base, /io\.muad\.openclaw\.version="/u);
});

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}
