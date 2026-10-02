import assert from 'node:assert/strict';
import { openScenario, registerPreflightE2E, assertPreflightQuestion } from './skill-preflight-e2e-support.mjs';

registerPreflightE2E('PreflightS08 follow-up inputs and final objective survive real background execution and delivery', async () => {
  const h = await openScenario('S08');
  const reply = await h.turn('为“唯一客户”生成完整季度报告，只关注本季度，报告要包含明细。');
  assert.match(reply, /customerId|客户\s*ID|客户编号/iu); await h.assertIdle();
  await h.turn('补充客户ID customer-123，最终报告用中文，包含原来要求的明细。');
  const task = await h.complete('quarterly-report');
  assert.match(task.originalPrompt, /customer-123/u); assert.match(task.objective, /报告/u);
  assert.match(task.objective, /明细/u); assert.match(task.objective, /中文/u);
  const traces = await h.traces();
  const messages = JSON.stringify(traces);
  assert.match(messages, /Inputs resolved before submission/u); assert.match(messages, /customer-123/u);
  assert.match(messages, /background long task/u);
  const replies = await h.deliveries();
  assert.equal(replies.some(row => /请提供.*客户.*ID|缺少.*customerId/iu.test(row.text)), false);
});

registerPreflightE2E('PreflightB01 choices stay in the current uncancelled user conversation', async () => {
  const h = await openScenario('B01');
  const reply = await h.turn('客户ID customer-123，需要季度报告，详细版或简报都可以，先让我选。');
  assert.match(reply, /quarterly-report/u); assert.match(reply, /quarterly-summary/u); await h.assertIdle();
  await h.turn('取消刚才的报告，改成普通聊天：你好。'); await h.assertIdle();
  const cancelled = await h.turn('第2个。');
  assertPreflightQuestion(cancelled, 'context'); await h.assertIdle();
  const other = await openScenario('B01-other');
  const cross = await other.turn('第2个。');
  assertPreflightQuestion(cross, 'context'); await other.assertIdle();
  const fresh = await h.turn('重新为客户 customer-123 生成季度报告，详细版或简报都可以，先让我选。');
  assert.match(fresh, /quarterly-report/u); assert.match(fresh, /quarterly-summary/u);
  const second = fresh.indexOf('quarterly-report') < fresh.indexOf('quarterly-summary') ? 'quarterly-summary' : 'quarterly-report';
  await h.turn('第2个，客户ID customer-123。'); await h.complete(second);
});
