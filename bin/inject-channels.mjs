// Runtime hot-update: reads channel configs + plugin toggles from stdin, writes
// them to openclaw.json, and signals the gateway to restart (SIGUSR1 to PID 1).
//
// stdin: JSON object, e.g.:
//   {
//     "channels": {
//       "wecom":         { "connectionMode": "websocket", "botId": "...", "secret": "..." },
//       "openclaw-weixin": {}
//     },
//     "plugins": {
//       "allow": ["wecom-openclaw-plugin"],
//       "entries": {
//         "wecom-openclaw-plugin": { "enabled": true },
//         "openclaw-weixin":      { "enabled": false }
//       }
//     }
//   }
//
// - `channels` keys not in the input are removed from openclaw.json (clean stale
//   entries from old bugs). The Go side sends correct OpenClaw channel IDs.
// - `plugins.allow` is set to the input list (suppresses openclaw's
//   "non-bundled plugins may auto-load" warning — it does NOT actually gate
//   loading).
// - `plugins.entries.<id>.enabled` is the **real** gate: openclaw's plugin
//   loader checks this per plugin. Removed channels get `enabled: false` so
//   the next gateway restart actually unloads the plugin and its long-poll
//   session; kept channels get `enabled: true`.
// - For each removed channel, BOTH the plugin's on-disk state (saved login
//   session, sync buffer) AND the agent's session index / trajectory
//   files are wiped. The transport wipe forces a fresh QR on re-bind; the
//   session wipe prevents the LLM from reading the previous conversation
//   history (e.g. the agent knowing "this is the 6th conversation" and
//   carrying the user's profile forward). Other channels' sessions are
//   untouched.
// - After writing, we send SIGUSR1 to PID 1 (the openclaw gateway). The
//   gateway hot reloads config and restarts; without the restart a removed
//   channel's plugin would still be running on its previous sync buffer.
//
// Exit codes: 0=success, 1=error

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const state = process.env.OPENCLAW_STATE_DIR || `${homedir()}/.openclaw`;
const p = `${state}/openclaw.json`;

// Plugin state directories wiped on channel removal. Keyed by the openclaw
// channel id (i.e. "openclaw-weixin", not the external "wechat" alias — the
// Go side already maps wechat→openclaw-weixin before sending to us).
const PLUGIN_STATE_DIRS = {
  "openclaw-weixin": `${state}/openclaw-weixin`,
  // wecom stores auth via botId/secret in channels config, not on disk —
  // no separate state dir to wipe.
};

const AGENT_DIR = `${state}/agents/main`;
const SESSIONS_INDEX = `${AGENT_DIR}/sessions/sessions.json`;
const SESSIONS_DIR = `${AGENT_DIR}/sessions`;

try {
  const input = JSON.parse(readFileSync(0, "utf8").trim());
  const d = JSON.parse(readFileSync(p, "utf8"));

  // --- channels block ---
  d.channels = d.channels || {};
  const inputChannels = input.channels || {};
  const channelKeys = new Set(Object.keys(inputChannels));

  // Capture removed set BEFORE mutating d.channels so the wipe loop below
  // still knows what was there.
  const removedChannels = Object.keys(d.channels).filter(
    (id) => !channelKeys.has(id),
  );

  for (const [id, cfg] of Object.entries(inputChannels)) {
    d.channels[id] = { ...(d.channels[id] || {}), ...cfg, enabled: true };
  }
  // Remove channel keys not in input (stale entries).
  for (const id of removedChannels) {
    delete d.channels[id];
  }

  // --- plugins block (gate auto-load) ---
  d.plugins = d.plugins || {};
  if (input.plugins && Array.isArray(input.plugins.allow)) {
    d.plugins.allow = input.plugins.allow;
  }
  if (
    input.plugins &&
    input.plugins.entries &&
    typeof input.plugins.entries === "object"
  ) {
    d.plugins.entries = d.plugins.entries || {};
    for (const [id, entry] of Object.entries(input.plugins.entries)) {
      d.plugins.entries[id] = {
        ...(d.plugins.entries[id] || {}),
        ...entry,
      };
    }
  }

  writeFileSync(p, JSON.stringify(d, null, 2));

  // --- wipe plugin transport state for removed channels ---
  for (const ch of removedChannels) {
    const dir = PLUGIN_STATE_DIRS[ch];
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.error(`[inject-channels] wipe transport ${dir}: ${e.message}`);
    }
  }

  // --- wipe agent session index + trajectory files for removed channels ---
  // The session index in `agents/main/sessions/sessions.json` is keyed by
  // `agent:main:<channel>:<chatType>:<peer>`. Each entry also references a
  // `sessionFile` (the .jsonl trajectory). Without this wipe the LLM sees
  // the full prior conversation history on the next message from the same
  // wechat identity — which is what caused "agent knows it's the 6th
  // conversation" on re-bind. Per-channel filter keeps wecom / other
  // channels' sessions untouched.
  if (removedChannels.length > 0 && existsSync(SESSIONS_INDEX)) {
    process.stderr.write(`[inject-channels] session-wipe: removedChannels=${JSON.stringify(removedChannels)}\n`);
    let sessions;
    try {
      sessions = JSON.parse(readFileSync(SESSIONS_INDEX, "utf8"));
    } catch (e) {
      process.stderr.write(`[inject-channels] parse sessions.json: ${e.message}\n`);
      sessions = {};
    }
    const trajectoryPaths = new Set();
    let removed = 0;
    for (const [k, v] of Object.entries(sessions)) {
      // Key format: "agent:main:<channel>:<chatType>:<peer>"
      const matches = removedChannels.some((ch) => k.startsWith(`agent:main:${ch}:`));
      if (!matches) continue;
      if (v && typeof v.sessionFile === "string") {
        trajectoryPaths.add(v.sessionFile);
      }
      delete sessions[k];
      removed++;
    }
    if (removed > 0) {
      process.stderr.write(`[inject-channels] session-wipe: removed=${removed} trajectories=${trajectoryPaths.size}\n`);
      try {
        writeFileSync(SESSIONS_INDEX, JSON.stringify(sessions, null, 2));
      } catch (e) {
        process.stderr.write(`[inject-channels] write sessions.json: ${e.message}\n`);
      }
      for (const p of trajectoryPaths) {
        // sessionFile may be absolute or relative to SESSIONS_DIR; resolve
        // both forms. We delete the .jsonl, .trajectory.jsonl and
        // .trajectory-path.json siblings.
        const candidates = [];
        if (p.startsWith("/")) {
          candidates.push(p);
        } else {
          candidates.push(`${SESSIONS_DIR}/${p}`);
        }
        for (const f of candidates) {
          for (const suffix of ["", ".trajectory.jsonl", ".trajectory-path.json"]) {
            try {
              rmSync(f + suffix, { force: true });
            } catch (_) {
              /* ignore */
            }
          }
        }
      }
    }
  }

  // --- restart gateway so the removed plugin actually unloads ---
  try {
    process.kill(1, "SIGUSR1");
  } catch (_) {
    // Best-effort: if we can't signal (e.g. PID 1 isn't openclaw), skip.
  }
} catch (e) {
  console.error(`[inject-channels] FAILED: ${e.message}`);
  process.exit(1);
}
