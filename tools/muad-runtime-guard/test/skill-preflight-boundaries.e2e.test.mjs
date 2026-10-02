import assert from 'node:assert/strict';
import { openScenario, registerPreflightE2E } from './skill-preflight-e2e-support.mjs';

registerPreflightE2E('PreflightE01 exploring quarterly report instructions for unavailable security analysis never executes', async () => {
  const h = await openScenario('E01');
  const reply = await h.turn('请先读取已有季度报告 Skill 的 SKILL.md 了解能力，然后为客户 customer-123 生成安全分析报告。如果季度报告不具备安全分析能力请说明缺少适用 Skill，不要生成季度报告。');
  assert.match(reply, /没有|缺少|不支持|不具备|无法/u); assert.match(reply, /安全|Skill|技能/u);
  const records = await h.traces();
  const calls = records.flatMap(row => row.message?.content ?? []).filter(item => item.type === 'toolCall');
  assert.ok(calls.some(call => call.name === 'read' && JSON.stringify(call.arguments).includes('SKILL.md')), 'actual model must have read the quarterly documentation');
  await h.assertIdle(); assert.deepEqual(await h.queries(), []);
});

registerPreflightE2E('PreflightB02 actual slash dispatch preserves preflight and complete input executes without extra confirmation', async () => {
  const h = await openScenario('B02');
  // IM ingress command is mandatory here: CLI agent alone does not exercise before_dispatch.
  const ingress = h.environment.slashIngressCommand;
  assert.ok(Array.isArray(ingress) && ingress.length, 'actual test IM ingress command required for slash dispatch');
  const before = (await h.rows(h.fixture.deliveriesFile)).length;
  await h.command([...ingress, h.fixture.peerId, '/skill:quarterly-report 为唯一客户生成季度报告']);
  const { eventually } = await import('./skill-preflight-e2e-support.mjs');
  await eventually(async () => (await h.rows(h.fixture.deliveriesFile)).length > before);
  const first = (await h.rows(h.fixture.deliveriesFile)).slice(before).map(row => row.text).join('\n');
  assert.match(first, /customerId|客户\s*ID|客户编号/iu);
  assert.deepEqual(await h.tasks(), []); assert.deepEqual(await h.business(), []);
  await h.command([...ingress, h.fixture.peerId, '/skill:quarterly-report 客户ID customer-123，生成完整季度报告']);
  await h.complete('quarterly-report');
  const replies = (await h.rows(h.fixture.deliveriesFile)).slice(before + 1).map(row => row.text).join('\n');
  assert.doesNotMatch(replies, /是否.*确认|需要.*确认|请选择/u);
});
