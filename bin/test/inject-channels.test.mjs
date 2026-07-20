import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

test("inject-channels atomically updates config and wipes removed channel sessions", () => {
  const state = mkdtempSync(join(tmpdir(), "muad-inject-channels-"));
  const sessionDir = join(state, "agents/main/sessions");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(state, "openclaw.json"), JSON.stringify({
    channels: {
      wecom: { enabled: true, botId: "old" },
      "openclaw-weixin": { enabled: true },
    },
    plugins: { allow: ["old"], entries: { "openclaw-weixin": { enabled: true } } },
  }));
  writeFileSync(join(sessionDir, "sessions.json"), JSON.stringify({
    "agent:main:openclaw-weixin:direct:alice": { sessionFile: "alice.jsonl" },
    "agent:main:wecom:direct:bob": { sessionFile: "bob.jsonl" },
    "agent:main:openclaw-weixin:direct:escape": { sessionFile: "/tmp/should-not-delete" },
  }));
  writeFileSync(join(sessionDir, "alice.jsonl"), "old chat");
  writeFileSync(join(sessionDir, "bob.jsonl"), "kept chat");

  execFileSync(process.execPath, ["bin/inject-channels.mjs"], {
    cwd: join(import.meta.dirname, "../.."),
    env: { ...process.env, OPENCLAW_STATE_DIR: state },
    input: JSON.stringify({
      channels: { wecom: { botId: "new" } },
      plugins: { allow: ["wecom-openclaw-plugin"], entries: { "openclaw-weixin": { enabled: false } } },
    }),
  });

  const config = JSON.parse(readFileSync(join(state, "openclaw.json"), "utf8"));
  assert.deepEqual(Object.keys(config.channels), ["wecom"]);
  assert.equal(config.channels.wecom.botId, "new");
  assert.equal(config.plugins.entries["openclaw-weixin"].enabled, false);

  const sessions = JSON.parse(readFileSync(join(sessionDir, "sessions.json"), "utf8"));
  assert.deepEqual(Object.keys(sessions), ["agent:main:wecom:direct:bob"]);
  assert.equal(existsSync(join(sessionDir, "alice.jsonl")), false);
  assert.equal(existsSync(join(sessionDir, "bob.jsonl")), true);
});
