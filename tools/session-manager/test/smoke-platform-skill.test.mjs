import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_BUSINESS_BASE_URL,
  businessBaseUrl,
  readCookies,
  selectPlatform,
} from "../../../skills/smoke-platform/scripts/run.mjs";

test("smoke-platform Skill defaults to the local fake platform and smoke platform", () => {
  assert.equal(DEFAULT_BUSINESS_BASE_URL, "http://host.docker.internal:18080");
  assert.equal(businessBaseUrl({}), "http://host.docker.internal:18080");
  assert.equal(businessBaseUrl({ SMOKE_BUSINESS_BASE_URL: " http://custom.internal:18080 " }), "http://custom.internal:18080");

  const selected = selectPlatform({
    platforms: [
      { platform: "other_platform", source: "refresh" },
      { platform: "smoke_platform", source: "cache" },
    ],
  }, {});
  assert.equal(selected.platform, "smoke_platform");
  assert.equal(selected.source, "cache");
});

test("smoke-platform reads cookie values from the skill-scoped session state file", async () => {
  const root = mkdtempSync(join(tmpdir(), "smoke-platform-session-"));
  try {
    const sessionStateFile = join(root, "alice", "session-store", "smoke-platform.session.json");
    mkdirSync(join(root, "alice", "session-store"), { recursive: true });
    writeFileSync(sessionStateFile, `${JSON.stringify({
      version: 1,
      agentId: "alice",
      skillName: "smoke-platform",
      platforms: {
        smoke_platform: {
          source: "refresh",
          expiresAt: "2099-01-01T00:00:00.000Z",
          cookies: [{ name: "sid", value: "session-cookie", domain: ".internal", path: "/" }],
          storageState: { cookies: [], origins: [] },
        },
      },
    })}\n`, { mode: 0o600 });
    assert.equal(await readCookies(sessionStateFile, "smoke_platform"), "sid=session-cookie");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("smoke-platform runs the script directly and ensures fresh state itself", () => {
  const body = readFileSync(new URL("../../../skills/smoke-platform/SKILL.md", import.meta.url), "utf8");
  assert.match(body, /run the validation script directly/iu);
  assert.match(body, /node \/opt\/openclaw-skills\/smoke-platform\/scripts\/run\.mjs/u);
  assert.match(body, /ensures fresh session state automatically/iu);
  assert.match(body, /do not\s+inspect local ports/iu);
  assert.doesNotMatch(body, /session_get_state/iu);
  assert.doesNotMatch(body, /SESSION_STATE_JSON/iu);
});
