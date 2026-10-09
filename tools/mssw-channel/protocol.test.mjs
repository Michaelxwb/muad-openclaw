import test from "node:test";
import assert from "node:assert/strict";
import { targetFor, decodeTarget, validateMessage } from "./protocol.mjs";

test("target and session identity survive lowercase canonicalization", () => {
  const id = "55f6da6d-6915-48e1-87ac-4b73efb1f209";
  const target = targetFor("Max-User", "Tenant-A", id);
  assert.deepEqual(decodeTarget(target.toLowerCase()), {
    senderId: "Max-User",
    tenantId: "Tenant-A",
    conversationId: id,
  });
});
test("different users, tenants and conversations yield different targets", () => {
  const id = "55f6da6d-6915-48e1-87ac-4b73efb1f209";
  assert.notEqual(targetFor("a", "t1", id), targetFor("b", "t1", id));
  assert.notEqual(targetFor("a", "t1", id), targetFor("a", "t2", id));
});
test("caller cannot select an agent or session", () => {
  const value = {
    runId: "55f6da6d-6915-48e1-87ac-4b73efb1f209",
    conversationId: "55f6da6d-6915-48e1-87ac-4b73efb1f209",
    senderId: "user",
    tenantId: "tenant",
    text: "hello",
  };
  assert.equal(validateMessage(value), value);
  assert.throws(() => validateMessage({ ...value, agentId: "other" }));
  assert.throws(() => validateMessage({ ...value, sessionKey: "foreign" }));
  assert.throws(() => validateMessage({ ...value, runId: "../other" }));
});
