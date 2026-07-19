import assert from "node:assert/strict";
import test from "node:test";

import { SkillExecutionLifecycle } from "../src/hook-lifecycle.mjs";
import { normalizeSkillPolicies } from "../src/skill-policy.mjs";
import {
  createMandatorySkillToolGate,
  mandatoryToolsFromSkillMarkdown,
} from "../src/tool-activation-gate.mjs";

const CONTEXT = {
  agentId: "alice",
  runId: "run-1",
  sessionKey: "agent:alice:wecom:direct:user-a",
};

test("blocks a declared mandatory tool until the exact Skill instructions are activated", async () => {
  const reports = [];
  const lifecycle = createLifecycle(reports);
  const web = grantFor("web-tools-guide");
  const vetter = grantFor("skill-vetter");
  const policies = policiesFor(web, vetter);
  const gate = createMandatorySkillToolGate({
    lifecycle,
    policies,
    readFileImpl: async (file) => skillMarkdownFor(file),
  });

  const blocked = await gate.check({ toolName: "browser", params: {} }, CONTEXT);
  assert.equal(blocked?.block, true);
  assert.match(blocked?.blockReason ?? "", /web-tools-guide\/SKILL\.md/u);
  assert.doesNotMatch(blocked?.blockReason ?? "", /skill-vetter/u);
  assert.equal(reports.length, 0);

  lifecycle.activateFromPaths({
    context: CONTEXT,
    derivedPaths: ["/opt/openclaw-skills/web-tools-guide/SKILL.md"],
    policies,
  });
  assert.equal(await gate.check({ toolName: "browser", params: {} }, CONTEXT), undefined);
  assert.equal(reports[0].activationMode, "path-detected");
});

test("does not infer mandatory tools from incidental Skill body text", () => {
  const markdown = `---
name: skill-vetter
description: "Review a Skill before installation."
---
Check whether it accesses browser cookies or APIs.
`;

  assert.deepEqual(mandatoryToolsFromSkillMarkdown(markdown), []);
});

test("parses mandatory tool names from standard SKILL.md description frontmatter", () => {
  const markdown = `---
name: web-tools-guide
description: "MANDATORY before calling web_search, web_fetch, browser, or opencli."
---
# Web tools
`;

  assert.deepEqual(
    mandatoryToolsFromSkillMarkdown(markdown),
    ["browser", "opencli", "web_fetch", "web_search"],
  );
});

function createLifecycle(reports) {
  return new SkillExecutionLifecycle({
    randomUUID: () => "execution-1",
    now: () => new Date("2026-07-15T06:08:20.000Z"),
    reporterFactory: ({ execution }) => ({
      report(update) {
        reports.push({ ...execution, ...update });
        return Promise.resolve(true);
      },
    }),
  });
}

function grantFor(name) {
  return {
    name,
    source: "public",
    skillId: `skill-${name}`,
    version: "sha256:test",
    entryType: "traditional-prompt",
    rootPath: `/opt/openclaw-skills/${name}`,
    scriptFiles: [],
  };
}

function policiesFor(...grants) {
  return normalizeSkillPolicies([{ agentId: "alice", allowed: grants }]);
}

function skillMarkdownFor(file) {
  if (file.includes("web-tools-guide")) {
    return `---
description: "MANDATORY before calling web_search, web_fetch, browser, or opencli."
---
# Web tools
`;
  }
  return `---
description: "Review Skills before installation."
---
The review may mention browser cookies.
`;
}
