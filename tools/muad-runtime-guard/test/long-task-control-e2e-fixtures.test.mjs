import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  assertBusinessStopped,
  assertDeliveredOnce,
  assertProcessStopped,
  assertZeroBusinessRows,
  businessRows,
  longTaskControlSkillNames,
  openLongTaskControlCase,
  parseLongTaskControlEnvironment,
  writeLongTaskControlFixtures,
} from './long-task-control-e2e-support.mjs';

// LongTaskControlS28 [integration] 真实边界：真实隔离 fixture 生成器、真实执行
// 哨兵进程、真实本地文件与观察断言；伪造/缺失证据或未就绪环境不得验收成功。

function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() >= deadline) { clearInterval(timer); reject(new Error('condition not reached before timeout')); }
    }, 50);
  });
}

test('LongTaskControlS28 fixtures are private, credential-free and run a real sentinel', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'muad-ltc-fixtures-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}-evidence`, { recursive: true, force: true });
  });
  const fixture = writeLongTaskControlFixtures(root);
  for (const name of longTaskControlSkillNames) {
    const dir = fixture.skills[name];
    assert.equal(statSync(dir).mode & 0o777, 0o700, `${name} dir mode`);
    for (const file of ['SKILL.md', 'muad.skill.json', 'run.mjs']) {
      assert.equal(statSync(path.join(dir, file)).mode & 0o777, 0o600, `${name}/${file} mode`);
    }
    const content = ['SKILL.md', 'muad.skill.json', 'run.mjs']
      .map(file => readFileSync(path.join(dir, file), 'utf8')).join('\n');
    assert.doesNotMatch(content, /(api[_-]?key|password|Bearer)\s*[:=]/iu, `${name} must not embed credentials`);
    const check = spawnSync(process.execPath, ['--check', path.join(dir, 'run.mjs')], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${name} run.mjs syntax: ${check.stderr}`);
  }
  assert.equal(statSync(fixture.companyLabelServer).mode & 0o777, 0o600, 'company label interface script mode');
  assert.equal(
    spawnSync(process.execPath, ['--check', fixture.companyLabelServer], { encoding: 'utf8' }).status,
    0,
    'company label interface script syntax',
  );

  // 真实执行哨兵：启动 cancel-long-task 脚本，记录真实 pid + 子进程，并产生业务计数。
  const script = path.join(fixture.skills['cancel-long-task'], 'run.mjs');
  const child = spawn(process.execPath, [script, '--customer-id', 'customer-123'], { stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } });
  await waitFor(() => businessRows(fixture.businessFile, 'cancel-long-task').length >= 1);
  const pids = readFileSync(fixture.processFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(pids.length, 1);
  assert.ok(pids[0].pid > 0 && pids[0].childPid > 0);

  // 伪造停止不得通过：进程仍存活时必须失败；真正停止后才通过。
  await assert.rejects(() => assertProcessStopped(fixture.processFile, { timeoutMs: 500 }), /still alive|停/u);
  process.kill(-child.pid, 'SIGKILL');
  await assertProcessStopped(fixture.processFile, { timeoutMs: 5_000 });

  // 缺失进程停止证据不得通过。
  rmSync(fixture.processFile, { force: true });
  await assert.rejects(() => assertProcessStopped(fixture.processFile, { timeoutMs: 200 }), /missing real process stop evidence/u);

  // 零执行与停止判据：未执行技能零行；已执行技能计数可断言不再增长。
  assert.ok(assertZeroBusinessRows(fixture.businessFile, 'queued-cancel'));
  assert.throws(() => assertZeroBusinessRows(fixture.businessFile, 'cancel-long-task'), /unexpected execution/u);
  await assertBusinessStopped(fixture.businessFile, 'cancel-long-task', { windowMs: 400 });
});

test('LongTaskControlS28 delivery evidence must be real and exactly once', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'muad-ltc-deliveries-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'received.jsonl');
  assert.throws(() => assertDeliveredOnce(file, 'test-peer', 'TASK-1'), /missing real recipient delivery evidence/u);
  writeFileSync(file, `${JSON.stringify({ peerId: 'test-peer', text: 'TASK-1 报告完成' })}\n`, { mode: 0o600 });
  assert.doesNotThrow(() => assertDeliveredOnce(file, 'test-peer', 'TASK-1'));
  writeFileSync(file, `${JSON.stringify({ peerId: 'test-peer', text: 'TASK-1 报告完成' })}\n${JSON.stringify({ peerId: 'test-peer', text: 'TASK-1 重复投递' })}\n`);
  assert.throws(() => assertDeliveredOnce(file, 'test-peer', 'TASK-1'), /exactly one/u);
  writeFileSync(file, `${JSON.stringify({ peerId: 'other-peer', text: 'TASK-1 报告完成' })}\n`);
  assert.throws(() => assertDeliveredOnce(file, 'test-peer', 'TASK-1'), /missing real recipient delivery evidence/u);
});

test('LongTaskControlS28 unready environments and missing cases fail explicitly', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'muad-ltc-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'e2e.json');
  const base = {
    isolated: true,
    consoleURL: 'http://test-console:8080',
    consoleTokenFile: '/private/test-console-token',
    podId: 'ltc-test',
    configPath: '/state/openclaw.json',
    stateFile: '/tmp/muad-runtime-queues/long-task/state.jsonl',
    workerExec: [],
    cases: {
      S06: {
        agentId: 'longtask-s06', peerId: 'test-peer', channel: 'mattermost',
        root: '/state/workspace-longtask-s06/skills',
        evidenceRoot: '/state/workspace-longtask-s06/evidence',
        workspace: '/state/workspace-longtask-s06',
        sessionDir: '/state/agents/longtask-s06/sessions',
        deliveriesFile: '/test-observer/received.jsonl',
        skills: ['cancel-long-task'],
      },
    },
  };
  assert.throws(() => parseLongTaskControlEnvironment({}), /MUAD_LONG_TASK_CONTROL_E2E_CONFIG required/u);
  assert.throws(
    () => parseLongTaskControlEnvironment({ MUAD_LONG_TASK_CONTROL_E2E_CONFIG: path.join(root, 'missing.json') }),
    /unavailable or invalid/u,
  );
  writeFileSync(configPath, JSON.stringify({ ...base, isolated: false }), { mode: 0o600 });
  assert.throws(
    () => parseLongTaskControlEnvironment({ MUAD_LONG_TASK_CONTROL_E2E_CONFIG: configPath }),
    /isolated/u,
  );
  writeFileSync(configPath, JSON.stringify(base), { mode: 0o600 });
  const environment = parseLongTaskControlEnvironment({ MUAD_LONG_TASK_CONTROL_E2E_CONFIG: configPath });
  assert.equal(environment.cases.S06.agentId, 'longtask-s06');
  assert.throws(() => openLongTaskControlCase('E99', environment), /missing fixture for E99/u);
  const badFixture = { ...base, cases: { S06: { ...base.cases.S06, root: 'relative/skills' } } };
  writeFileSync(configPath, JSON.stringify(badFixture), { mode: 0o600 });
  assert.throws(
    () => openLongTaskControlCase('S06', parseLongTaskControlEnvironment({ MUAD_LONG_TASK_CONTROL_E2E_CONFIG: configPath })),
    /root/u,
  );
  const badAgent = { ...base, cases: { S06: { ...base.cases.S06, agentId: 'prod-user' } } };
  writeFileSync(configPath, JSON.stringify(badAgent), { mode: 0o600 });
  assert.throws(
    () => openLongTaskControlCase('S06', parseLongTaskControlEnvironment({ MUAD_LONG_TASK_CONTROL_E2E_CONFIG: configPath })),
    /isolated test users/u,
  );
  writeFileSync(configPath, JSON.stringify(base), { mode: 0o600 });
  // 本地 Worker：fixture 命令前缀为空时 kill -0 检查走本机真实进程。
  const scenario = openLongTaskControlCase('S06', parseLongTaskControlEnvironment({ MUAD_LONG_TASK_CONTROL_E2E_CONFIG: configPath }));
  assert.deepEqual(scenario.environment.workerExec, []);
  assert.equal(
    spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' }).status,
    0,
  );
});
