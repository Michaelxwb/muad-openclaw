import assert from 'node:assert/strict';
import { openScenario, registerPreflightE2E, assertPreflightQuestion } from './skill-preflight-e2e-support.mjs';

registerPreflightE2E('PreflightS02 unique complete request directly executes once through the real model and tool', async () => {
  const h = await openScenario('S02');
  const reply = await h.turn('为客户 customer-123 生成完整季度报告，包含明细、趋势和指标。');
  assert.doesNotMatch(reply, /是否.*确认|需要.*确认|请选择|请.*选择/u);
  const task = await h.complete('quarterly-report');
  assert.equal(task.executionInputs.bindings.find(binding => binding.name === 'customerId').value, 'customer-123');
  const trace = JSON.stringify(await h.traces());
  assert.match(trace, /muad_submit_long_task/u); assert.match(trace, /SKILL\.md/u);
});

registerPreflightE2E('PreflightS03 multiple appropriate candidates wait for selection before real submission', async () => {
  const h = await openScenario('S03');
  const reply = await h.turn('给客户 customer-123 生成季度报告，还没有决定详细版还是简报。');
  assert.match(reply, /quarterly-report/u); assert.match(reply, /quarterly-summary/u);
  assert.match(reply, /明细|详细/u); assert.match(reply, /摘要|简报/u); assertPreflightQuestion(reply, 'choice');
  await h.assertIdle();
  await h.turn('我选择 quarterly-summary，客户ID仍是 customer-123。');
  await h.complete('quarterly-summary');
});
