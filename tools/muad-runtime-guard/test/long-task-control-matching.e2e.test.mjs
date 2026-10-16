import assert from 'node:assert/strict';
import path from 'node:path';
import {
  eventually,
  openLongTaskControlCase,
  registerLongTaskControlE2E,
} from './long-task-control-e2e-support.mjs';

// 真实模型/Worker/IM 终验登记：唯一匹配（S-01）、多候选（S-02）、截图等价参考与
// company_label（S-03）、无适用/缺参/显式名称不一致（E-06）。仅在
// MUAD_LONG_TASK_CONTROL_E2E=1 时注册；未启用不执行任何真实场景。

async function cancelAndSettle(scenario, taskId) {
  const response = await scenario.cancelTask(taskId);
  assert.equal(response.body?.code, 0, `cleanup cancel failed for ${taskId}`);
  await scenario.waitForTask(taskId, ['cancelled', 'succeeded', 'failed']);
  const task = await scenario.task(taskId);
  if (task.status === 'cancelled') await scenario.assertProcessStopped({ timeoutMs: 30_000 });
  return task;
}

registerLongTaskControlE2E(
  'LongTaskControlS01 unique applicable task with complete input runs without extra confirmation and exactly once',
  async () => {
    const scenario = openLongTaskControlCase('S01');
    await scenario.assertInstalled();
    await scenario.captureBaseline();
    // 唯一适用且输入完整：真实模型必须直接发起，不追加确认（否则不会出现新任务）。
    await scenario.turn('请立即用 cancel-long-task 为客户 customer-123 生成长报告，需要持续运行；不要询问确认。');
    await eventually(async () => (await scenario.tasks()).length === 1);
    const [task] = await scenario.tasks();
    assert.equal(task.skillName, 'cancel-long-task', 'unique applicable skill must be selected');
    await scenario.waitForTask(task.taskId, ['queued', 'running', 'succeeded']);
    await eventually(async () => (await scenario.business('cancel-long-task')).length >= 1);
    const executed = await scenario.business('cancel-long-task');
    assert.equal(executed.filter(row => row.kind === 'start').length, 1, 'exactly one real execution required');
    assert.equal((await scenario.business('queued-cancel')).length, 0, 'unrelated skills must not execute');
    assert.equal((await scenario.business('reference-report')).length, 0, 'unrelated skills must not execute');
    await cancelAndSettle(scenario, task.taskId);
  },
);

registerLongTaskControlE2E(
  'LongTaskControlS02 multiple plausible candidates list differences first and execute only the chosen skill',
  async () => {
    const scenario = openLongTaskControlCase('S02');
    await scenario.assertInstalled();
    await scenario.captureBaseline();
    const reply = await scenario.turn('给客户 customer-123 跑一个完整的长任务报告，哪个任务合适都行，尽快开始。');
    // 选择前：必须给出候选差异（回复同时提及两个候选），且零执行、零入队。
    assert.match(reply, /cancel-long-task/u, 'candidate list must mention cancel-long-task');
    assert.match(reply, /alternate-long-task/u, 'candidate list must mention alternate-long-task');
    assert.deepEqual(await scenario.tasks(), [], 'no task may be submitted before the user chooses');
    await scenario.assertZeroBusinessRows('cancel-long-task');
    await scenario.assertZeroBusinessRows('alternate-long-task');
    // 用户选择后：仅执行所选 Skill。
    await scenario.turn('选择 cancel-long-task，客户 customer-123，立即开始。');
    await eventually(async () => (await scenario.tasks()).length === 1);
    const [task] = await scenario.tasks();
    assert.equal(task.skillName, 'cancel-long-task');
    await eventually(async () => (await scenario.business('cancel-long-task')).length >= 1);
    assert.equal((await scenario.business('alternate-long-task')).length, 0, 'only the chosen skill may execute');
    await cancelAndSettle(scenario, task.taskId);
  },
);

registerLongTaskControlE2E(
  'LongTaskControlS03 screenshot-equivalent request reads reference docs, hits company_label once and never runs unrelated skills',
  async () => {
    const scenario = openLongTaskControlCase('S03');
    await scenario.assertInstalled();
    await scenario.captureBaseline();
    // 截图等价请求：需要先查看其他长任务文档，再访问 company_label 测试接口。
    const reply = await scenario.turn(
      '请参考 reference-report 长任务文档里对客户标签的说明，然后调用 company_label 测试接口确认客户 customer-123 的公司标签，最后用 cancel-long-task 为客户 customer-123 生成长报告。',
    );
    assert.ok(reply.length > 0, 'real model reply required');
    // 真实读取其他长任务文档：会话轨迹必须包含对 reference SKILL.md 的读取。
    const referenceDoc = path.join(scenario.fixture.root, 'reference-report', 'SKILL.md');
    const traces = JSON.stringify(await scenario.traces());
    assert.ok(traces.includes(referenceDoc), 'reference long task document must be really read');
    // company_label 测试接口恰好一次；无关 Skill 零任务、零业务。
    await eventually(async () => (await scenario.companyLabelHits()).length >= 1);
    assert.equal((await scenario.companyLabelHits()).length, 1, 'company_label test interface hit exactly once');
    await scenario.assertZeroBusinessRows('reference-report');
    const referenceTasks = (await scenario.tasks()).filter(task => task.skillName === 'reference-report');
    assert.deepEqual(referenceTasks, [], 'reference skill must not be submitted');
    // 授权业务技能可以提交；收尾清理。
    await eventually(async () => (await scenario.tasks()).length >= 1);
    const [task] = await scenario.tasks();
    assert.equal(task.skillName, 'cancel-long-task');
    await cancelAndSettle(scenario, task.taskId);
  },
);

registerLongTaskControlE2E(
  'LongTaskControlE06 no applicable skill, missing required input and explicit-name mismatch explain or ask with zero execution',
  async () => {
    // 无适用 Skill：说明而不得入队或执行任何脚本。
    const none = openLongTaskControlCase('E06-none');
    await none.assertInstalled();
    await none.captureBaseline();
    const noneReply = await none.turn('请用 cancel-long-task 为客户 customer-123 生成长报告，立即开始。');
    assert.ok(noneReply.length > 0, 'readable explanation required');
    assert.deepEqual(await none.tasks(), [], 'no task may be submitted without an applicable skill');
    await none.assertZeroBusinessRows('cancel-long-task');

    // 仅缺用户必填输入：追问 customerId，且零入队、零业务脚本。
    const missing = openLongTaskControlCase('E06-missing');
    await missing.assertInstalled();
    await missing.captureBaseline();
    const missingReply = await missing.turn('用 cancel-long-task 生成一份长报告，马上开始。');
    assert.match(missingReply, /customerId|customer|客户/u, 'must ask for the missing required customer id');
    assert.deepEqual(await missing.tasks(), [], 'incomplete preflight must not submit');
    await missing.assertZeroBusinessRows('cancel-long-task');

    // 显式名称与本轮请求不一致：说明/追问，未完成预检前零入队、零执行。
    const mismatch = openLongTaskControlCase('E06-mismatch');
    await mismatch.assertInstalled();
    await mismatch.captureBaseline();
    const mismatchReply = await mismatch.turn(
      '客户 customer-123 要生成季度报告，请用 reference-report 这个长任务执行（我确认就要这个）。',
    );
    assert.ok(mismatchReply.length > 0, 'readable explanation required');
    assert.deepEqual(await mismatch.tasks(), [], 'mismatched explicit name must not submit blindly');
    await mismatch.assertZeroBusinessRows('reference-report');
    await mismatch.assertZeroBusinessRows('cancel-long-task');
  },
);
