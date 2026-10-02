import fs from "node:fs";
import path from "node:path";
import { validateLongTaskInput } from "./long-task-input.mjs";

export function createLongTaskPreflight({ ledger, getConfig, getTurnContext = (ctx) => ctx }) {
  return {
    check(rawInput, toolContext) {
      const validated = validateLongTaskInput(rawInput);
      if (!validated.ok) return validated;
      const config = getConfig();
      const turn = trustedTurn(config, getTurnContext(toolContext));
      if (!turn) return rejected("context_unavailable");
      const grant = (config.longTaskSkillGrants ?? []).find((item) =>
        item.agentId === turn.agentId && item.name === validated.input.skillName);
      if (!validGrant(grant)) return rejected("skill_not_authorized");
      const document = ledger.check({ ...turn, skillName: grant.name, rootPath: grant.rootPath });
      if (!document.ok) return document;
      return { ok: true, input: validated.input, turn, grant: { ...grant } };
    },
  };
}

function trustedTurn(config, turn) {
  if (!config || config.valid === false || !turn ||
      ![turn.agentId, turn.sessionKey, turn.runId, turn.peerId, turn.replyChannel].every(text) ||
      turn.agentId === config.mainAgentId ||
      !(config.agentProfiles ?? []).some((profile) => profile.agentId === turn.agentId)) return null;
  const prefix = `agent:${turn.agentId}:`;
  if (!turn.sessionKey.startsWith(prefix) || turn.sessionKey.includes(":longtask:") ||
      !turn.sessionKey.startsWith(prefix + turn.replyChannel + ":")) return null;
  const sessionPeer = turn.replyChannel === "mattermost" ? turn.peerId.replace(/^user:/u, "") : turn.peerId;
  if (turn.sessionKey.includes(":direct:") && !turn.sessionKey.endsWith(":direct:" + sessionPeer) && turn.verifiedPeerId !== turn.peerId) return null;
  return {
    agentId: turn.agentId, sessionKey: turn.sessionKey, runId: turn.runId,
    peerId: turn.peerId, replyChannel: turn.replyChannel,
    originalPrompt: typeof turn.originalPrompt === "string" ? turn.originalPrompt : "",
  };
}

function validGrant(grant) {
  if (!grant || typeof grant.rootPath !== "string" || !path.isAbsolute(grant.rootPath)) return false;
  try {
    const root = fs.realpathSync(grant.rootPath);
    const manifestPath = fs.realpathSync(path.join(root, "muad.skill.json"));
    if (manifestPath !== path.join(root, "muad.skill.json")) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.longTask === true && (!manifest.name || manifest.name === grant.name);
  } catch {
    // Missing, malformed or escaped authorization material fails closed.
    return false;
  }
}

function text(value) { return typeof value === "string" && Boolean(value.trim()); }
function rejected(reason) { return { ok: false, reason }; }
