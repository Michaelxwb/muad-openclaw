import assert from "node:assert/strict";
import test from "node:test";

import { validateLongTaskInput } from "../src/long-task-input.mjs";

const request = () => ({
  skillName: "quarterly-report",
  objective: "生成客户季报",
  selectionBasis: "unique_match",
  requiredNames: ["customerId"],
  bindings: [{ name: "customerId", value: "customer-123", source: "user_message" }],
});

test("PreflightS10 accepts complete input and explicit no-input Skills", () => {
  const input = request();
  const result = validateLongTaskInput(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.input, input);
  assert.notEqual(result.input.bindings, input.bindings);
  assert.notEqual(result.input.bindings[0], input.bindings[0]);
  assert.equal(validateLongTaskInput({ ...input, requiredNames: [], bindings: [] }).ok, true);
  assert.deepEqual(validateLongTaskInput({ ...input, requiredNames: ["customerId", "customerId"] }).input.requiredNames, ["customerId"]);
});

test("PreflightS10 rejects missing, empty and ambiguous input before submission", () => {
  for (const bindings of [[], [{ name: "customerId", value: " ", source: "user_message" }]]) {
    const result = validateLongTaskInput({ ...request(), bindings });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing_input");
    assert.deepEqual(result.missingNames, ["customerId"]);
  }
  const first = request().bindings[0];
  assert.equal(validateLongTaskInput({ ...request(), bindings: [first, first] }).reason, "invalid_input");
});

test("PreflightS10 rejects unknown fields, identity injection and malformed contracts", () => {
  const malformed = [null, [], "request", {},
    { ...request(), agentId: "another-user" },
    { ...request(), rootPath: "/another-user/skills" },
    { ...request(), selectionBasis: "confirmed" },
    { ...request(), skillName: "../quarterly-report" },
    { ...request(), skillName: { toString: () => "quarterly-report" } },
    { ...request(), objective: " " },
    { ...request(), requiredNames: [42] },
    { ...request(), requiredNames: Array(1) },
    { ...request(), bindings: Array(1) },
    { ...request(), bindings: [{ name: "customerId", value: 123, source: "user_message" }] },
    { ...request(), bindings: [{ name: "customerId", value: "123", source: "guessed" }] },
    { ...request(), bindings: [{ name: "customerId", value: "123", source: "user_message", trusted: true }] },
    { ...request(), bindings: [{ name: "__proto__", value: "123", source: "user_message" }] },
  ];
  for (const input of malformed) {
    assert.equal(validateLongTaskInput(input).reason, "invalid_input");
  }
});
