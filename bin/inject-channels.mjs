// Runtime hot-update: reads channel configs JSON from stdin, updates openclaw.json
// channels section, and writes back. Gateway auto-detects the file change and
// hot-reloads within ~200ms (hybrid mode). No container restart needed.
//
// stdin: JSON object mapping OpenClaw channel IDs → config objects, e.g.:
//   {"wecom":{"botId":"aib…","secret":"sk-…"},"openclaw-weixin":{}}
//
// Exit codes: 0=success, 1=error

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const state = process.env.OPENCLAW_STATE_DIR || `${homedir()}/.openclaw`;
const p = `${state}/openclaw.json`;

try {
  const input = JSON.parse(readFileSync(0, "utf8").trim());
  const d = JSON.parse(readFileSync(p, "utf8"));

  d.channels = d.channels || {};
  const keys = new Set(Object.keys(input));

  // Enable and configure channels in the input
  for (const [id, cfg] of Object.entries(input)) {
    d.channels[id] = { ...(d.channels[id] || {}), ...cfg, enabled: true };
  }

  // Remove channel keys not in the input (clean stale entries from old bugs).
  // The Go side sends correct OpenClaw channel IDs; any key not in input is stale.
  for (const id of Object.keys(d.channels)) {
    if (!keys.has(id)) {
      delete d.channels[id];
    }
  }

  writeFileSync(p, JSON.stringify(d, null, 2));
} catch (e) {
  console.error(`[inject-channels] FAILED: ${e.message}`);
  process.exit(1);
}
