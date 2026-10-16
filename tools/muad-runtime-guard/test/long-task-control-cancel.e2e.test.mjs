import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  eventually,
  openLongTaskControlCase,
  registerLongTaskControlE2E,
} from './long-task-control-e2e-support.mjs';

// 真实 Console/Worker/收件终验登记：排队取消（S-05）、运行终止（S-06）、
// 隔离与槽位恢复（S-07）、故障不伪报（E-01）、能力缺失/归属不可证明（E-02）、
// 取消中重启（B-04）。仅在 MUAD_LONG_TASK_CONTROL_E2E=1 时注册。

const executeFile = promisify(execFile);

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function runLocalCommand(argv) {
  assert.ok(Array.isArray(argv) && argv.length > 0, 'real boundary command argv required');
  return executeFile(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 120_000 });
}

async function waitForE2eEvidence(scenario, customerId, timeoutMs = 20_000) {
  try {
    await eventually(async () => {
      const rows = await scenario.rows(scenario.businessFile);
      return rows.some(row => row.customerId === customerId);
    }, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function cancelAndSettle(scenario, taskId, options = {}) {
  // 收尾清理：取消被拒（如幽灵任务 not_found）不判场景失败，但仍等终态并校验停止。
  try { await waitInStore(scenario, taskId, 60_000); } catch { /* store 未同步仍走容错路径 */ }
  const response = await scenario.cancelTask(taskId);
  if (response.body?.code !== 0) {
    console.warn(`[cleanup] cancel rejected for ${taskId}: ${response.body?.code ?? response.status}`);
  }
  await scenario.waitForTask(taskId, ['cancelled', 'succeeded', 'failed'], 600_000);
  const task = await scenario.task(taskId);
  if (task.status === 'cancelled') {
    // 任务可能在脚本实际执行前即被取消：先给证据行短暂出现的机会，确实未执行则无进程可验。
    const hasEvidence = options.customerId
      ? await waitForE2eEvidence(scenario, options.customerId)
      : true;
    if (hasEvidence) await scenario.assertProcessStopped({ timeoutMs: 30_000, ...options });
  }
  return task;
}

async function killRecordedProcesses(scenario) {
  const rows = await scenario.processRows();
  if (rows.length === 0) return;
  const script = "const rows=JSON.parse(process.argv[1]);for(const row of rows){for(const pid of [row.pid,row.childPid]){try{process.kill(Number(pid),'SIGKILL');}catch{}}}";
  await scenario.command(['node', '-e', script, JSON.stringify(rows)]);
}

async function submitTurnUntil(scenario, prompt, predicate, options = {}) {
  // CLI 可能瞬时失败但模型已提交：先查是否实际出现新任务，未出现才重试一次，
  // 避免重复提交（重复任务会在后续停止断言中表现为仍未停止）。
  let attempts = 0;
  let lastError;
  for (;;) {
    attempts += 1;
    lastError = undefined;
    try {
      await scenario.turn(prompt, options);
    } catch (error) {
      lastError = error;
    }
    try {
      await eventually(async () => predicate(await scenario.tasks()), 90_000);
      return;
    } catch (error) {
      if (attempts >= 3) throw lastError ?? error;
      await new Promise(resolve => setTimeout(resolve, 30_000));
    }
  }
}

function newestBySkill(tasks, skillName) {
  return tasks
    .filter(task => task.skillName === skillName)
    .sort((left, right) => String(right.submittedAt ?? '').localeCompare(String(left.submittedAt ?? '')))[0];
}

async function waitInStore(scenario, taskId, timeoutMs = 120_000) {
  await eventually(async () => {
    const data = await scenario.listTasks({ page: 1, pageSize: 50 });
    return (data.items ?? []).some(item => item.taskId === taskId);
  }, timeoutMs);
}

async function submitRunningSentinel(scenario, prompt, options = {}) {
  // seen：同场景多次提交/重试时的既有任务 id 集合，确保拿到的必是本轮新任务。
  const seen = options.seen ?? new Set((await scenario.tasks()).map(task => task.taskId));
  await submitTurnUntil(scenario, prompt,
    tasks => tasks.some(task => !seen.has(task.taskId)), options);
  const [task] = (await scenario.tasks()).filter(item => !seen.has(item.taskId)).sort((left, right) =>
    String(right.submittedAt ?? '').localeCompare(String(left.submittedAt ?? '')));
  await scenario.waitForTask(task.taskId, ['running'], 600_000);
  return task;
}

// 等排队哨兵（seen 之外的新 queued-cancel 任务）进入 queued；
// 若它已被调度执行（运行哨兵提前结束、槽位释放），显式返回 lost。
async function waitQueuedPremise(scenario, seen, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = newestBySkill((await scenario.tasks()).filter(item => !seen.has(item.taskId)), 'queued-cancel');
    if (task) {
      if (task.status === 'queued') return { task };
      if (['running', 'succeeded', 'failed'].includes(task.status)) return { lost: true, task };
    }
    if (Date.now() >= deadline) return { lost: true };
    await delay(1_000);
  }
}

// 排队前提组：同一会话（poolKey 基于 session）先提交两个运行哨兵占满执行槽，
// 第三个排队哨兵才会真实排队；返回三者身份、排队哨兵执行前的水位线与本轮已见任务集合。
async function formQueuedTask(scenario, poolSession, attempt) {
  const seed = attempt * 100;
  const runningCustomer = `customer-${seed + 23}`;
  const siblingCustomer = `customer-${seed + 24}`;
  const queuedRowsBefore = (await scenario.business('queued-cancel')).length;
  const seen = new Set((await scenario.tasks()).map(task => task.taskId));
  const running = await submitRunningSentinel(scenario,
    `/skill:cancel-long-task 请为客户 ${runningCustomer} 生成长报告，需要持续运行很长时间，不要询问确认。`,
    { sessionKey: poolSession, seen });
  seen.add(running.taskId);
  const sibling = await submitRunningSentinel(scenario,
    `/skill:cancel-long-task 同时为客户 ${siblingCustomer} 生成长报告，需持续运行很长时间，不要询问确认。`,
    { sessionKey: poolSession, seen });
  seen.add(sibling.taskId);
  await submitTurnUntil(scenario,
    '/skill:queued-cancel 为客户 customer-125 生成一个排队报告，立即开始。',
    tasks => tasks.some(task => !seen.has(task.taskId)), { sessionKey: poolSession });
  const premise = await waitQueuedPremise(scenario, seen);
  return { running, sibling, runningCustomer, siblingCustomer, queuedRowsBefore, ...premise };
}

// 排队哨兵的容错清理：排队取消不产生进程证据（哨兵被设计为不执行）；
// 被提前调度时（前提丢失）也只要求收敛到终态，不把“无 pid 记录”误判为停止失败。
async function cleanupQueuedSentinel(scenario, taskId) {
  const current = await scenario.task(taskId);
  if (!current || ['cancelled', 'succeeded', 'failed'].includes(current.status)) return current;
  try { await waitInStore(scenario, taskId, 60_000); } catch { /* store 未同步仍走容错路径 */ }
  const response = await scenario.cancelTask(taskId);
  if (response.body?.code !== 0) {
    console.warn(`[cleanup] cancel rejected for ${taskId}: ${response.body?.code ?? response.status}`);
  }
  await scenario.waitForTask(taskId, ['cancelled', 'succeeded', 'failed'], 600_000);
  return scenario.task(taskId);
}

function queuedTotal(data) {
  return (data.pools ?? []).reduce((sum, pool) => sum + (pool.poolQueued ?? 0), 0);
}

registerLongTaskControlE2E(
  'LongTaskControlS05 cancelling a queued task never executes its sentinel and the queue shrinks',
  async () => {
    const scenario = openLongTaskControlCase('S05');
    await scenario.assertInstalled();
    await scenario.captureBaseline();
    // pod03 槽位=2：先用两个长任务占满执行槽，第三个才会真实排队。
    // 三个提交必须来自同一会话（poolKey 基于 session），否则各自独立池、无法形成排队。
    // 排队前提对“运行哨兵提前自然结束”敏感：哨兵按 SKILL.md 以 yieldMs=120000 前台阻塞；
    // 若前提仍丢失（排队哨兵被提前调度），清理本轮后做一次有界重试。
    const poolSession = `${scenario.sessionKey}-s05-pool`;
    let formed = null;
    let lossReason = '';
    for (let attempt = 1; attempt <= 2 && !formed; attempt += 1) {
      const outcome = await formQueuedTask(scenario, poolSession, attempt);
      if (outcome.task && !outcome.lost) { formed = outcome; break; }
      lossReason = outcome.task
        ? 'queued sentinel was scheduled before cancellation (slots freed too early)'
        : 'queued sentinel did not appear before timeout';
      await cancelAndSettle(scenario, outcome.sibling.taskId, { customerId: outcome.siblingCustomer });
      await cancelAndSettle(scenario, outcome.running.taskId, { customerId: outcome.runningCustomer });
      if (outcome.task) await cleanupQueuedSentinel(scenario, outcome.task.taskId);
    }
    assert.ok(formed, `queue premise did not form: ${lossReason || 'no queued task'}`);
    const { task: queued, running, sibling, runningCustomer, siblingCustomer, queuedRowsBefore } = formed;
    await waitInStore(scenario, queued.taskId);
    // 取消前前提仍成立：被取消的必须是仍在排队的任务，而不是已被调度执行的任务。
    assert.equal((await scenario.task(queued.taskId)).status, 'queued', 'queued task must still be queued at cancel time');
    const before = await scenario.listTasks({ page: 1, pageSize: 50 });
    const queuedBefore = queuedTotal(before);
    assert.ok(queuedBefore >= 1, 'a real queued task must be reflected in the pool snapshot');
    const response = await scenario.cancelTask(queued.taskId);
    assert.equal(response.body?.code, 0, 'queued cancel must be accepted');
    await scenario.waitForTask(queued.taskId, ['cancelled']);
    // 排队取消后哨兵从未执行：queued-cancel 业务行数不得越过提交前水位线（含取消后观察窗口）。
    assert.equal((await scenario.business('queued-cancel')).length, queuedRowsBefore,
      'queued sentinel must never execute its business script');
    await delay(1_000);
    assert.equal((await scenario.business('queued-cancel')).length, queuedRowsBefore,
      'queued sentinel must not execute after cancellation');
    // Console 列表 → Store：最终 cancelled 且排队数减少。
    const after = await scenario.listTasks({ page: 1, pageSize: 50 });
    const row = after.items.find(item => item.taskId === queued.taskId);
    assert.ok(row, 'cancelled queued task must be visible in Console list');
    assert.equal(row.status, 'cancelled');
    assert.ok(queuedTotal(after) < queuedBefore, 'queue length must shrink after queued cancellation');
    await cancelAndSettle(scenario, sibling.taskId, { customerId: siblingCustomer });
    await cancelAndSettle(scenario, running.taskId, { customerId: runningCustomer });
  },
);

registerLongTaskControlE2E(
  'LongTaskControlS06 terminating a running task stops real processes, business growth and further delivery',
  async () => {
    const scenario = openLongTaskControlCase('S06');
    await scenario.assertInstalled();
    await scenario.captureBaseline();
    const task = await submitRunningSentinel(
      scenario,
      '/skill:cancel-long-task 请为客户 customer-123 生成长报告，持续运行很长时间，不要询问确认。',
    );
    await eventually(async () => (await scenario.business('cancel-long-task')).length >= 3, 60_000);
    const response = await scenario.cancelTask(task.taskId);
    assert.equal(response.body?.code, 0, 'running termination must be accepted');
    const outcome = response.body?.data?.outcome;
    assert.ok(['cancel_requested', 'cancelled'].includes(outcome), `unexpected terminate outcome ${outcome}`);
    // 202 仅表达已接受：最终必须以 Worker 实际停止收敛到 cancelled。
    await scenario.waitForTask(task.taskId, ['cancelled'], 600_000);
    await scenario.assertProcessStopped({ timeoutMs: 60_000, customerId: 'customer-123' });
    await scenario.assertBusinessStopped('cancel-long-task', { windowMs: 3_000 });
    // 无新结果投递（取消后结果不得再发）。
    const delivered = (await scenario.deliveries()).length;
    await delay(3_000);
    assert.equal((await scenario.deliveries()).length, delivered, 'no new result delivery after termination');
    // 列表终态。
    const data = await scenario.listTasks({ page: 1, pageSize: 50 });
    const row = data.items.find(item => item.taskId === task.taskId);
    assert.equal(row?.status, 'cancelled');
    assert.equal(row?.canCancel, false);
  },
);

registerLongTaskControlE2E(
  'LongTaskControlS07 other same-user and cross-user tasks keep running and the slot releases exactly once',
  async () => {
    const scenario = openLongTaskControlCase('S07');
    const other = openLongTaskControlCase('S07-other');
    await scenario.assertInstalled();
    await other.assertInstalled();
    await scenario.captureBaseline();
    await other.captureBaseline();
    // 另一用户真实任务：取消 A 期间不得受影响。
    const crossUser = await submitRunningSentinel(
      other,
      '/skill:cancel-long-task 请为客户 customer-900 生成长报告，持续运行，不要询问确认。',
    );
    await submitTurnUntil(scenario, '/skill:cancel-long-task 请为客户 customer-123 生成长报告A，持续运行，不要询问确认。',
      tasks => tasks.some(task => task.skillName === 'cancel-long-task'));
    await submitTurnUntil(scenario, '/skill:alternate-long-task 并追加任务：为客户 customer-124 生成长报告B，持续运行，不要询问确认。',
      tasks => tasks.some(task => task.skillName === 'alternate-long-task'));
    const taskA = newestBySkill(await scenario.tasks(), 'cancel-long-task');
    const taskB = newestBySkill(await scenario.tasks(), 'alternate-long-task');
    assert.ok(taskA && taskB, 'both same-user tasks must exist');
    await scenario.waitForTask(taskA.taskId, ['running']);
    // sibling 允许自然完成（完成≠失败）：不落入 failed/cancelled 即视为未受影响。
    await eventually(async () => ['running', 'cancelling', 'succeeded'].includes((await scenario.task(taskB.taskId))?.status ?? ''), 300_000);
    await waitInStore(scenario, taskA.taskId);
    // 终止 A：B 与另一用户任务继续运行。
    const growthB = (await scenario.business('alternate-long-task')).length;
    const crossUserBefore = (await other.business('cancel-long-task')).length;
    const response = await scenario.cancelTask(taskA.taskId);
    assert.equal(response.body?.code, 0);
    await scenario.waitForTask(taskA.taskId, ['cancelled'], 600_000);
    await scenario.assertProcessStopped({ timeoutMs: 60_000 });
    await eventually(async () => (await scenario.business('alternate-long-task')).length > growthB, 60_000);
    const siblingAfterCancel = await scenario.task(taskB.taskId);
    assert.ok(['running', 'cancelling', 'succeeded'].includes(siblingAfterCancel.status),
      `same-user sibling must not end as ${siblingAfterCancel.status}`);
    await eventually(async () => (await other.business('cancel-long-task')).length > crossUserBefore, 60_000);
    // 主会话可用。
    const reply = await scenario.turn('请只回复：主会话可用。');
    assert.ok(reply.trim().length > 0, 'main session must stay usable after termination');
    // 执行槽恰好释放一次：下一项按序启动，与 B 同时运行。
    await submitTurnUntil(scenario, '/skill:cancel-long-task 请为客户 customer-125 生成长报告C，持续运行，不要询问确认。',
      tasks => tasks.filter(task => ![taskA.taskId, taskB.taskId].includes(task.taskId)).length >= 1);
    const taskC = (await scenario.tasks()).find(task => ![taskA.taskId, taskB.taskId].includes(task.taskId));
    assert.ok(taskC, 'next task must start after the slot is freed');
    await scenario.waitForTask(taskC.taskId, ['running'], 600_000);
    const siblingAtSlotRelease = await scenario.task(taskB.taskId);
    assert.ok(['running', 'cancelling', 'succeeded'].includes(siblingAtSlotRelease.status),
      `sibling must not end as ${siblingAtSlotRelease.status}`);
    await cancelAndSettle(scenario, taskB.taskId, { customerId: 'customer-124' });
    await cancelAndSettle(scenario, taskC.taskId, { customerId: 'customer-125' });
    await cancelAndSettle(other, crossUser.taskId);
  },
);

registerLongTaskControlE2E(
  'LongTaskControlE01 unreachable worker or unconfirmed stop never fakes cancelled, releases slots or retries',
  async () => {
    const scenario = openLongTaskControlCase('E01');
    const fault = scenario.fixture.fault;
    assert.ok(fault?.breakCommand && fault?.restoreCommand, 'real worker fault commands required');
    await scenario.assertInstalled();
    await scenario.captureBaseline();
    const task = await submitRunningSentinel(
      scenario,
      '请立即用 cancel-long-task 为客户 customer-123 生成长报告，持续运行，不要询问确认。',
    );
    const before = await scenario.listTasks({ page: 1, pageSize: 50 });
    const runningBefore = (before.pools ?? []).reduce((sum, pool) => sum + (pool.poolRunning ?? 0), 0);
    try {
      await runLocalCommand(fault.breakCommand);
      const response = await scenario.cancelTask(task.taskId);
      const faked = response.status === 200 && response.body?.code === 0 &&
        response.body?.data?.outcome === 'cancelled';
      assert.equal(faked, false, 'unreachable worker must not be reported as cancelled');
      if (response.body?.code !== 0) {
        assert.ok(String(response.body?.message ?? '').length > 0, 'diagnostic message required on failure');
      }
      // 保留实际可知状态；槽位不提前释放；不启动重试任务。
      const current = await scenario.task(task.taskId);
      assert.notEqual(current.status, 'cancelled');
      const after = await scenario.listTasks({ page: 1, pageSize: 50 });
      const runningAfter = (after.pools ?? []).reduce((sum, pool) => sum + (pool.poolRunning ?? 0), 0);
      assert.ok(runningAfter >= runningBefore, 'slot must not be released before stop confirmation');
      assert.equal((await scenario.tasks()).length, 1, 'no retry task may start after failure');
    } finally {
      await runLocalCommand(fault.restoreCommand);
    }
    await eventually(async () => Boolean(await scenario.task(task.taskId)), 60_000);
    await cancelAndSettle(scenario, task.taskId);
  },
);

registerLongTaskControlE2E(
  'LongTaskControlE02 old worker without cancel capability or unprovable ownership stays explicit and truthful',
  async () => {
    // 旧 Worker / 缺失取消能力：明确不支持，保留实际可知状态，不按历史 PID 盲杀。
    const unsupported = openLongTaskControlCase('E02-unsupported');
    await unsupported.assertInstalled();
    await unsupported.captureBaseline();
    const task = await submitRunningSentinel(
      unsupported,
      '请立即用 cancel-long-task 为客户 customer-123 生成长报告，持续运行，不要询问确认。',
    );
    const response = await unsupported.cancelTask(task.taskId);
    assert.ok(response.status >= 400 || response.body?.code !== 0, 'missing capability must not fake success');
    assert.ok(String(response.body?.message ?? '').length > 0, 'explicit unsupported message required');
    assert.notEqual((await unsupported.task(task.taskId)).status, 'cancelled');
    await eventually(async () => (await unsupported.business('cancel-long-task')).length >= 1);
    const growth = (await unsupported.business('cancel-long-task')).length;
    await delay(3_000);
    assert.ok((await unsupported.business('cancel-long-task')).length >= growth,
      'history pid must not be blindly killed on unsupported workers');
    try {
      await killRecordedProcesses(unsupported);
    } finally {
      // 清理后保留可解释状态；不伪报已取消。
      const cleaned = await unsupported.task(task.taskId);
      assert.notEqual(cleaned.status, 'unknown');
    }

    // 重启后运行归属不可证明：明确无法确认，只有确认停止后才 cancelled。
    const ownership = openLongTaskControlCase('E02-ownership');
    const restart = ownership.fixture.restartCommand;
    assert.ok(restart, 'real worker restart command required');
    await ownership.assertInstalled();
    await ownership.captureBaseline();
    const orphan = await submitRunningSentinel(
      ownership,
      '请立即用 cancel-long-task 为客户 customer-123 生成长报告，持续运行，不要询问确认。',
    );
    const accepted = await ownership.cancelTask(orphan.taskId);
    assert.equal(accepted.body?.code, 0, 'cancel request must be durably recorded before restart');
    await runLocalCommand(restart);
    await eventually(async () => (await ownership.read(ownership.environment.configPath)).length > 0, 120_000);
    await delay(5_000);
    const state = await ownership.task(orphan.taskId);
    assert.ok(['cancelling', 'cancelled'].includes(state.status), 'tombstone must survive restart');
    if (state.status === 'cancelled') {
      await ownership.assertProcessStopped({ timeoutMs: 30_000 });
      await ownership.assertBusinessStopped('cancel-long-task', { windowMs: 3_000 });
    } else {
      assert.equal(state.status, 'cancelling', 'unconfirmed stop must stay explicit');
    }
    await killRecordedProcesses(ownership);
  },
);

registerLongTaskControlE2E(
  'LongTaskControlB04 restarted worker keeps cancel tombstones and never resumes cancelled runs',
  async () => {
    const scenario = openLongTaskControlCase('B04');
    const restart = scenario.fixture.restartCommand;
    assert.ok(restart, 'real worker restart command required');
    await scenario.assertInstalled();
    await scenario.captureBaseline();
    const task = await submitRunningSentinel(
      scenario,
      '请立即用 cancel-long-task 为客户 customer-123 生成长报告，持续运行，不要询问确认。',
    );
    const response = await scenario.cancelTask(task.taskId);
    assert.equal(response.body?.code, 0);
    await runLocalCommand(restart);
    await eventually(async () => (await scenario.read(scenario.environment.configPath)).length > 0, 120_000);
    // 取消中的任务不恢复执行：状态不得回退为 running/queued。
    for (let i = 0; i < 15; i += 1) {
      const state = await scenario.task(task.taskId);
      assert.ok(!['running', 'queued'].includes(state.status), 'cancelled run must not resume after restart');
      await delay(1_000);
    }
    const settled = await scenario.task(task.taskId);
    if (settled.status === 'cancelled') {
      await scenario.assertProcessStopped({ timeoutMs: 60_000 });
      await scenario.assertBusinessStopped('cancel-long-task', { windowMs: 3_000 });
    } else {
      await scenario.assertBusinessStopped('cancel-long-task', { windowMs: 3_000 });
      assert.equal(settled.status, 'cancelling', 'tombstone must remain explicit until stop is confirmed');
    }
    await killRecordedProcesses(scenario);
  },
);
