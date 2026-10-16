import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  eventually,
  openLongTaskControlCase,
  registerLongTaskControlE2E,
} from './long-task-control-e2e-support.mjs';

// 真实浏览器/Console/Worker 终验登记：配置应用与故障回滚（S-08）、真实浏览器
// 中英文与取消交互（S-10）、故障与权限失效 UI（E-05）。仅在
// MUAD_LONG_TASK_CONTROL_E2E=1 时注册；浏览器结果由真实浏览器执行器导出，
// 不接受 HTTP stub 或测试自写观测。

const executeFile = promisify(execFile);

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function runLocalCommand(argv) {
  assert.ok(Array.isArray(argv) && argv.length > 0, 'real boundary command argv required');
  return executeFile(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 600_000 });
}

async function runBrowserObservations(scenario, name, payload) {
  const command = scenario.fixture.browserCommand;
  assert.ok(Array.isArray(command) && command.length > 0,
    'real browser verification command required (HTTP stubs are not acceptable)');
  // 浏览器执行器在测试机本地运行：场景/结果文件写本地受控目录（含 0600），
  // Worker 上不存在测试机路径不能在远端写文件。
  const workDir = scenario.fixture.browserWorkDir
    ?? process.env.MUAD_LTC_BROWSER_WORKDIR
    ?? path.join(os.tmpdir(), 'muad-ltc-browser');
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const scenarioFile = path.join(workDir, `browser-${name}.json`);
  const resultFile = path.join(workDir, `browser-${name}-result.json`);
  writeFileSync(scenarioFile, JSON.stringify({
    ...payload,
    uiURL: scenario.fixture.uiURL ?? payload.uiURL ?? scenario.environment.consoleURL,
  }), { mode: 0o600 });
  await executeFile(command[0], [...command.slice(1), scenarioFile, resultFile], { encoding: 'utf8', timeout: 900_000 });
  assert.ok(existsSync(resultFile), 'browser verification must produce real observations');
  return JSON.parse(readFileSync(resultFile, 'utf8'));
}

async function submitRunningSentinel(scenario, prompt, options = {}) {
  // seen/sessionKey：同场景多次提交（排队前提）时锁定新任务并共享 pool（poolKey 基于 session）。
  const seen = options.seen ?? new Set((await scenario.tasks()).map(task => task.taskId));
  await scenario.turn(prompt, options);
  await eventually(async () => (await scenario.tasks()).some(task => !seen.has(task.taskId)), 300_000);
  const [task] = (await scenario.tasks()).filter(item => !seen.has(item.taskId))
    .sort((left, right) => String(right.submittedAt ?? '').localeCompare(String(left.submittedAt ?? '')));
  await scenario.waitForTask(task.taskId, ['running'], 600_000);
  return task;
}

async function cancelAndSettle(scenario, taskId, options = {}) {
  const response = await scenario.cancelTask(taskId);
  assert.equal(response.body?.code, 0, `cleanup cancel failed for ${taskId}`);
  await scenario.waitForTask(taskId, ['cancelled', 'succeeded', 'failed']);
  const task = await scenario.task(taskId);
  // 排队任务取消先于脚本启动：无 pid 证据时不误判；有证据仍强制真实停止（可按 customerId 圈定）。
  if (task.status === 'cancelled') {
    await scenario.assertProcessStoppedIfStarted({ timeoutMs: 30_000, ...options });
  }
  return task;
}

function modelAndSkillLayers(config) {
  const agents = (config.agents?.list ?? []).map(agent => ({ id: agent.id, model: agent.model }));
  const grants = config.plugins?.entries?.['muad-runtime-guard']?.config?.longTaskSkillGrants ?? [];
  return { agents, grants };
}

registerLongTaskControlE2E(
  'LongTaskControlS08 console apply transaction keeps cancel guidance while health failures roll back without layer changes',
  async () => {
    const scenario = openLongTaskControlCase('S08');
    const deployment = scenario.fixture.deployment;
    assert.ok(deployment?.breakHealthCommand && deployment?.restoreHealthCommand,
      'real health fault commands required for the rollback scenario');
    await scenario.assertInstalled();
    const podId = scenario.environment.podId;
    const configBefore = JSON.parse(await scenario.read(scenario.environment.configPath));
    // apply-config 的真实契约：202 Accepted（仅入队，不代表已应用）；最终以 generation/状态收敛为准。
    const apply = async () => {
      const { status, body } = await scenario.consoleFetch(
        `/api/v1/containers/${podId}/apply-config`, { method: 'POST', body: '{}' });
      assert.equal(status, 202, 'apply-config must be accepted (202)');
      assert.equal(body.code, 0, 'apply-config envelope code');
    };
    const waitPod = async predicate => {
      let pod;
      await eventually(async () => {
        pod = await scenario.consoleRequest(`/api/v1/containers/${podId}`);
        return predicate(pod);
      }, 600_000);
      return pod;
    };
    // 真实 Console 配置变更源：用户指导 prompt 属于 runtime DTO（RuntimeAgent.Prompt），
    // 改动会推进 generation（不改模型绑定/Skill 分层），供成功应用与故障回滚各自驱动一次事务。
    const users = await scenario.consoleRequest(`/api/v1/containers/${podId}/human-users`);
    const user = (users.items ?? []).find(item => item.agentId === scenario.fixture.agentId);
    assert.ok(user?.humanUserId, 'S08 fixture agent must exist as a Pod Human User');
    const userDetail = await scenario.consoleRequest(`/api/v1/human-users/${user.humanUserId}`);
    const originalPrompt = userDetail.humanUser?.prompt ?? '';
    const applyPrompt = async value => {
      const { status, body } = await scenario.consoleFetch(
        `/api/v1/human-users/${user.humanUserId}`, { method: 'PATCH', body: JSON.stringify({ prompt: value }) });
      assert.equal(status, 200, 'prompt update must be accepted');
      assert.equal(body.code, 0, 'prompt update envelope code');
    };

    // 成功应用：能力与指导生效，无模型绑定或 Skill 分层改变。
    await applyPrompt(`${originalPrompt}\n[e2e-s08 apply-1]`);
    await apply();
    const healthy = await waitPod(pod =>
      pod.appliedGeneration === pod.configGeneration && pod.lastApplyStatus === 'applied');
    assert.equal(healthy.state, 'running', 'worker must be healthy after successful apply');
    assert.equal(healthy.runtimeGuardHealthy, true, 'cancel capability requires a healthy guard');
    const guidance = await scenario.read(path.join(scenario.fixture.workspace, 'AGENTS.md'));
    assert.match(guidance, /muad_submit_long_task/u, 'cancel guidance must be applied to the workspace');
    const configApplied = JSON.parse(await scenario.read(scenario.environment.configPath));
    assert.deepEqual(modelAndSkillLayers(configApplied), modelAndSkillLayers(configBefore),
      'apply must not change model bindings or skill layering');

    // 健康故障：新配置变更 + apply 失败并回滚到 last-good，业务分层仍不变。
    try {
      await runLocalCommand(deployment.breakHealthCommand);
      await applyPrompt(`${originalPrompt}\n[e2e-s08 apply-2]`);
      await apply();
      await waitPod(pod => pod.lastApplyStatus === 'failed');
      const rolledBack = JSON.parse(await scenario.read(scenario.environment.configPath));
      assert.deepEqual(rolledBack, configApplied, 'rollback must restore the last-good config');
      assert.deepEqual(modelAndSkillLayers(rolledBack), modelAndSkillLayers(configBefore),
        'rollback must keep model bindings and skill layering unchanged');
    } finally {
      await runLocalCommand(deployment.restoreHealthCommand);
      await applyPrompt(originalPrompt);
    }
    await apply();
    await waitPod(pod => pod.appliedGeneration === pod.configGeneration && pod.lastApplyStatus === 'applied');
  },
);

registerLongTaskControlE2E(
  'LongTaskControlS10 real browser switches languages, terminates via confirm, filters and polls without spinner flicker',
  async () => {
    const scenario = openLongTaskControlCase('S10');
    await scenario.assertInstalled();
    await scenario.captureBaseline();
    // 排队前提（pod03 槽位=2）：同一会话（poolKey 基于 session）两个运行哨兵占满槽位，
    // 第三个 queued-cancel 才会真实排队，供 UI 呈现"排队中/取消排队"。
    const poolSession = `${scenario.sessionKey}-s10-pool`;
    const running = await submitRunningSentinel(
      scenario,
      '/skill:cancel-long-task 请为客户 customer-123 生成长报告，持续运行很长时间，不要询问确认。',
      { sessionKey: poolSession },
    );
    const seen = new Set((await scenario.tasks()).map(task => task.taskId));
    const sibling = await submitRunningSentinel(
      scenario,
      '/skill:cancel-long-task 同时为客户 customer-124 生成长报告，需持续运行很长时间，不要询问确认。',
      { sessionKey: poolSession, seen },
    );
    await scenario.turn('/skill:queued-cancel 为客户 customer-125 生成一个排队报告，立即开始。', { sessionKey: poolSession });
    await eventually(async () => (await scenario.tasks()).length >= 3, 300_000);
    const queued = (await scenario.tasks()).find(task => task.skillName === 'queued-cancel');
    assert.ok(queued, 'third task must be the queued sentinel');
    await scenario.waitForTask(queued.taskId, ['queued']);
    const observations = await runBrowserObservations(scenario, 'S10', {
      consoleURL: scenario.environment.consoleURL,
      consoleTokenFile: scenario.environment.consoleTokenFile,
      podId: scenario.environment.podId,
      checks: {
        zhStatusLabels: ['排队中', '运行中'],
        zhActionLabels: ['取消排队', '终止任务'],
        enStatusLabels: ['Queued', 'Running'],
        enActionLabels: ['Cancel queued', 'Terminate task'],
        confirmDialog: { skill: 'cancel-long-task', taskId: running.taskId, mustMentionNoRecall: true },
        filterCancelled: true,
        pagination: true,
        backgroundRefreshNoSpinner: true,
        cancelQueuedTask: queued.taskId,
        terminateViaUI: running.taskId,
      },
    });
    // 中英文标签正确且随语言切换更新。
    for (const label of ['排队中', '运行中']) assert.ok(observations.zh?.statusLabels?.includes(label), `zh ${label}`);
    for (const label of ['取消排队', '终止任务']) assert.ok(observations.zh?.actionLabels?.includes(label), `zh ${label}`);
    for (const label of ['Queued', 'Running']) assert.ok(observations.en?.statusLabels?.includes(label), `en ${label}`);
    for (const label of ['Cancel queued', 'Terminate task']) assert.ok(observations.en?.actionLabels?.includes(label), `en ${label}`);
    // 确认框含 Skill 与任务 ID、且说明不撤回已完成外部操作。
    assert.ok(observations.confirmDialogText?.includes('cancel-long-task'), 'confirm must name the skill');
    assert.ok(observations.confirmDialogText?.includes(running.taskId), 'confirm must name the task id');
    assert.equal(observations.confirmMentionsNoRecall, true, 'confirm must state no recall of external work');
    // 取消状态筛选、分页、后台轮询不闪 spinner、无重试入口。
    assert.equal(observations.filterCancelledOnly, true, 'cancelled filter must show only cancelled rows');
    assert.equal(observations.paginationApplied, true, 'pagination must work');
    assert.equal(observations.spinnerDuringBackgroundRefresh, 0, 'background refresh must not flicker the table spinner');
    assert.equal(observations.retryButtonPresent, false, 'no retry entry is allowed');
    // 浏览器发起的终止必须以真实停止收敛，且无新结果投递。
    assert.equal(observations.terminateRequested, true, 'browser must issue the terminate request via UI');
    assert.equal(observations.terminateDisabledDuringStop, true, 'cancelling rows must be disabled');
    // 收尾顺序：先终止同池 sibling（同技能同 skillRoot，避免其存活进程干扰停止判据），
    // 再确认 UI 终止的任务真实停止；投递增量只针对被终止任务（其他任务的合理投递不在此断言内）。
    const deliveredForRunning = (await scenario.deliveries())
      .filter(row => String(row.text ?? '').includes(running.taskId)).length;
    await cancelAndSettle(scenario, sibling.taskId, { customerId: 'customer-124' });
    await scenario.waitForTask(running.taskId, ['cancelled'], 600_000);
    await scenario.assertProcessStopped({ timeoutMs: 60_000, customerId: 'customer-123' });
    await scenario.assertBusinessStopped('cancel-long-task', { windowMs: 3_000 });
    await delay(3_000);
    assert.equal((await scenario.deliveries())
      .filter(row => String(row.text ?? '').includes(running.taskId)).length, deliveredForRunning,
    'no new result delivery after UI termination');
    await cancelAndSettle(scenario, queued.taskId);
    await scenario.assertZeroBusinessRows('queued-cancel');
  },
);

registerLongTaskControlE2E(
  'LongTaskControlE05 unreachable worker shows readable failure, survives refresh, and expired auth returns to login',
  async () => {
    const scenario = openLongTaskControlCase('E05');
    const deployment = scenario.fixture.deployment;
    assert.ok(deployment?.breakHealthCommand && deployment?.restoreHealthCommand,
      'real worker fault commands required for the UI failure scenario');
    await scenario.assertInstalled();
    await scenario.captureBaseline();
    const task = await submitRunningSentinel(
      scenario,
      '请立即用 cancel-long-task 为客户 customer-123 生成长报告，持续运行，不要询问确认。',
    );
    try {
      await runLocalCommand(deployment.breakHealthCommand);
      const observations = await runBrowserObservations(scenario, 'E05', {
        consoleURL: scenario.environment.consoleURL,
        consoleTokenFile: scenario.environment.consoleTokenFile,
        podId: scenario.environment.podId,
        checks: {
          terminateExpectFailure: task.taskId,
          messageSurvivesRefresh: true,
          unauthorizedRedirectsToLogin: true,
        },
      });
      // 明确原因而非成功；无重试按钮；刷新不覆盖较新操作状态；权限失效回登录。
      assert.ok(String(observations.failureText ?? '').length > 0, 'readable failure reason required');
      assert.equal(observations.successShown, false, 'UI must not claim success');
      assert.equal(observations.retryButtonPresent, false, 'no retry button is allowed');
      assert.equal(observations.messageSurvivesRefresh, true, 'refresh must not overwrite the newer operation state');
      assert.equal(observations.unauthorizedRedirectedToLogin, true, 'expired auth must return to login');
      // 任务不得被伪报为已取消。
      assert.notEqual((await scenario.task(task.taskId)).status, 'cancelled');
    } finally {
      await runLocalCommand(deployment.restoreHealthCommand);
    }
    await eventually(async () => (await scenario.task(task.taskId)).status === 'running', 120_000);
    // 冻结期间能力探测会暂时标记"不可取消"：恢复后等 Console 重新确认能力再收尾，
    // 否则收尾取消会被 41003（unsupported）拒绝（这不是任务状态问题）。
    await eventually(async () => {
      const data = await scenario.listTasks({ podId: scenario.environment.podId, page: 1, pageSize: 50, q: task.taskId });
      return (data.items ?? []).some(item => item.taskId === task.taskId && item.canCancel === true);
    }, 180_000);
    await cancelAndSettle(scenario, task.taskId);
  },
);
