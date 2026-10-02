import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { openScenario, registerPreflightE2E, eventually, deploymentUser } from './skill-preflight-e2e-support.mjs';

registerPreflightE2E('PreflightS09 real Console desired DTO transaction renderer Worker visibility and failed-health rollback', async () => {
  const h = await openScenario('S09'), deployment = h.environment.deployment;
  assert.ok(deployment?.humanUserId, 'isolated Human User ID required for real generation changes');
  for (const key of ['breakHealthCommand', 'restoreHealthCommand']) assert.ok(Array.isArray(deployment[key]) && deployment[key].length, `actual ${key} required`);
  const podRoute = `/api/v1/containers/${encodeURIComponent(h.environment.podId)}`;
  const userRoute = `/api/v1/human-users/${encodeURIComponent(deployment.humanUserId)}`;
  const user = deploymentUser(await h.consoleRequest(userRoute), h.fixture.agentId);
  const previousPrompt = user.prompt ?? '';
  try {
    await h.consoleRequest(userRoute, { method: 'PATCH', body: JSON.stringify({ prompt: `preflight success ${randomUUID()}` }) });
    await h.consoleRequest(podRoute + '/apply-config', { method: 'POST', body: '{}' });
    await eventually(async () => { const pod = await h.consoleRequest(podRoute); return pod.appliedGeneration === pod.configGeneration && pod.runtimeGuardHealthy; });
    await h.assertInstalled();
    const businessTools = await h.cli(['gateway', 'call', 'tools.catalog', '--params', JSON.stringify({ agentId: h.fixture.agentId }), '--json']);
    assert.match(businessTools, /muad_submit_long_task/u);
    const businessProbe = await h.toolAvailability(h.fixture.agentId), mainProbe = await h.toolAvailability('main');
    assert.equal(businessProbe.status, 200); assert.equal(businessProbe.body.ok, true);
    const rejection = JSON.parse(businessProbe.body.result.content.find(item => item.type === 'text').text);
    assert.equal(rejection.status, 'rejected'); assert.equal(rejection.reason, 'invalid_input');
    assert.equal(mainProbe.status, 404); assert.equal(mainProbe.body.ok, false);
    assert.equal(mainProbe.body.error.type, 'not_found');
    const lastGood = hash(await h.read(h.environment.configPath));
    const generation = (await h.consoleRequest(podRoute)).appliedGeneration;
    await h.command(deployment.breakHealthCommand);
    await h.consoleRequest(userRoute, { method: 'PATCH', body: JSON.stringify({ prompt: `preflight fault ${randomUUID()}` }) });
    await h.consoleRequest(podRoute + '/apply-config', { method: 'POST', body: '{}' });
    await eventually(async () => (await h.consoleRequest(podRoute)).lastApplyStatus === 'failed', 300_000);
    const failed = await h.consoleRequest(podRoute);
    assert.ok(failed.configGeneration > generation); assert.equal(failed.appliedGeneration, generation);
    assert.equal(hash(await h.read(h.environment.configPath)), lastGood, 'health failure must restore actual last-good Worker config');
  } finally {
    await h.command(deployment.restoreHealthCommand);
    await h.consoleRequest(userRoute, { method: 'PATCH', body: JSON.stringify({ prompt: previousPrompt }) });
    await h.consoleRequest(podRoute + '/apply-config', { method: 'POST', body: '{}' });
    await eventually(async () => { const pod = await h.consoleRequest(podRoute); return pod.appliedGeneration === pod.configGeneration && pod.runtimeGuardHealthy; }, 240_000);
  }
});
function hash(text) { return createHash('sha256').update(text).digest('hex'); }
