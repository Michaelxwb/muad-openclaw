import assert from 'node:assert/strict';
import { openScenario, registerPreflightE2E, assertPreflightQuestion } from './skill-preflight-e2e-support.mjs';

registerPreflightE2E('PreflightS04 customer name cannot substitute ID or start background probing', async () => {
  const h = await openScenario('S04');
  const reply = await h.turn('请为客户“唯一客户”生成完整季度报告。');
  assert.match(reply, /customerId|客户\s*ID|客户编号/iu);
  assert.match(reply, /提供|补充|缺少|需要/u);
  await h.assertIdle(); assert.deepEqual(await h.queries(), []);
  await h.turn('客户ID是 customer-123，请生成刚才要求的完整季度报告。');
  await h.complete('quarterly-report');
});

registerPreflightE2E('PreflightS05 documented name resolution submits only unique results and asks for ambiguous or absent IDs', async () => {
  const unique = await openScenario('S05-unique');
  await unique.turn('请使用名称解析季度报告 Skill 为“唯一客户”生成季度报告。');
  await unique.complete('lookup-report');
  assert.equal((await unique.queries()).length, 1);
  assert.equal((await unique.queries())[0].name, '唯一客户');
  const multiple = await openScenario('S05-multiple');
  const reply = await multiple.turn('请使用名称解析季度报告 Skill 为“同名客户”生成季度报告。');
  assert.match(reply, /customer-123/u); assert.match(reply, /customer-456/u);
  assertPreflightQuestion(reply, 'choice'); await multiple.assertIdle();
  assert.equal((await multiple.queries()).length, 1);
  await multiple.turn('选择客户ID customer-456。');
  await multiple.complete('lookup-report', 'customer-456');
  const none = await openScenario('S05-none');
  const absent = await none.turn('请使用名称解析季度报告 Skill 为“不存在”生成季度报告。');
  assert.match(absent, /customerId|客户\s*ID|找不到|未找到/iu);
  await none.assertIdle(); assert.equal((await none.queries()).length, 1);
});

registerPreflightE2E('PreflightB04 explicit no-argument documentation executes while unknown and conflicting documents clarify', async () => {
  const noarg = await openScenario('B04-noarg');
  await noarg.turn('生成无需参数的固定演示报告。');
  const task = await noarg.complete('noarg-report', '');
  assert.deepEqual(task.executionInputs.requiredNames, []);
  for (const id of ['B04-unknown', 'B04-conflict']) {
    const h = await openScenario(id);
    const reply = await h.turn(id === 'B04-unknown' ? '生成未说明调用参数的演示报告。' : '生成调用说明冲突的演示报告。');
    assert.match(reply, /调用|参数|文档|说明/u); assert.match(reply, /完善|补充|确认|明确|澄清/u);
    await h.assertIdle(); assert.deepEqual(await h.queries(), []);
  }
});
