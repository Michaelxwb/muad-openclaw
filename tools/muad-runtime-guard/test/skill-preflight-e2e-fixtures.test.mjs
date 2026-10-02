import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { writePreflightFixtures, parseE2EEnvironment, RealWorkerScenario, probeGatewayTool } from './skill-preflight-e2e-support.mjs';

test('PreflightS26 actual private config and HTTP probe preserve tool availability without submitting work', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'muad-tool-probe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const token = randomUUID(), requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      requests.push({ authorization: req.headers.authorization, url: req.url, body: JSON.parse(raw) });
      const main = JSON.parse(raw).sessionKey.startsWith('agent:main:');
      res.writeHead(main ? 404 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(main ? { ok: false, error: { type: 'not_found' } } :
        { ok: true, result: { content: [{ type: 'text', text: '{"status":"rejected","reason":"invalid_input"}' }] } }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const file = path.join(root, 'config.json');
  writeFileSync(file, JSON.stringify({ gateway: { port: server.address().port, auth: { token } } }), { mode: 0o600 });
  const business = await probeGatewayTool(file, 'preflight-report'), main = await probeGatewayTool(file, 'main');
  assert.equal(business.status, 200); assert.equal(business.body.ok, true);
  assert.equal(main.status, 404); assert.equal(main.body.error.type, 'not_found');
  assert.ok(!JSON.stringify([business, main]).includes(token));
  for (const request of requests) {
    assert.equal(request.authorization, `Bearer ${token}`); assert.equal(request.url, '/tools/invoke');
    assert.equal(request.body.tool, 'muad_submit_long_task'); assert.deepEqual(request.body.args, {});
    assert.match(request.body.sessionKey, /^agent:(?:main|preflight-report):mattermost:direct:preflight-tool-probe$/u);
  }
});

test('PreflightS24 scenarios select their actual Worker without changing shared environment', () => {
  const environment = { workerExec: ['kubectl', 'exec', 'pod-a', '--'] };
  const fixture = { agentId: 'preflight-a', channel: 'mattermost', peerId: 'test-a' };
  assert.deepEqual(new RealWorkerScenario(environment, fixture).environment.workerExec, environment.workerExec);
  const other = new RealWorkerScenario(environment, { ...fixture, workerExec: ['kubectl', 'exec', 'pod-b', '--'] });
  assert.deepEqual(other.environment.workerExec, ['kubectl', 'exec', 'pod-b', '--']);
  assert.deepEqual(environment.workerExec, ['kubectl', 'exec', 'pod-a', '--']);
  assert.throws(() => new RealWorkerScenario(environment, { ...fixture, workerExec: 'pod-b' }), /argv array/u);
  assert.throws(() => new RealWorkerScenario(environment, { ...fixture, workerExec: [1] }), /argv array/u);
});

test('PreflightS27 real Skill documents authorize lookup only for the lookup scenario', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'muad-preflight-docs-'));
  const fixture = writePreflightFixtures(root);
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(fixture.evidenceRoot, { recursive: true, force: true }); });
  for (const [name, dir] of Object.entries(fixture.skills)) {
    const doc = readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    if (name === 'lookup-report') assert.match(doc, /文档明确允许先用 exec/u);
    else assert.doesNotMatch(doc, /lookup\.mjs.*授权/u);
  }
});

test('PreflightS27 actual Console response wrapper preserves deployment Agent verification', async () => {
  const { deploymentUser } = await import('./skill-preflight-e2e-support.mjs');
  const humanUser = { agentId: 'preflight-report', prompt: 'original' };
  assert.equal(deploymentUser({ humanUser, identities: [] }, 'preflight-report'), humanUser);
  assert.throws(() => deploymentUser(humanUser, 'preflight-report'));
  assert.throws(() => deploymentUser({ humanUser }, 'preflight-other'));
});

test('PreflightS28 real clarification replies accept equivalent wording and reject execution receipts', async () => {
  const { assertPreflightQuestion } = await import('./skill-preflight-e2e-support.mjs');
  assertPreflightQuestion('请回复选项序号（1 或 2），或直接给出 customerId，我再提交季度报告生成任务。', 'choice');
  assertPreflightQuestion('本会话里还没有出现过一个选项列表，所以第2个暂时没有指向。你想说的是哪一个？', 'context');
  assertPreflightQuestion('请选择哪个客户。', 'choice');
  assertPreflightQuestion('你指的是什么？请提供背景。', 'context');
  assert.throws(() => assertPreflightQuestion('任务已经执行完成。', 'choice'));
  assert.throws(() => assertPreflightQuestion('已经为你执行第二个任务。', 'context'));
  assert.throws(() => assertPreflightQuestion('请选择。', 'unknown'));
});

test('PreflightS29 candidate questions accept actual numbered-choice wording without accepting execution receipts', async () => {
  const { assertPreflightQuestion } = await import('./skill-preflight-e2e-support.mjs');
  assertPreflightQuestion('有两个目标不同的候选，需要你先选一个再执行。', 'choice');
  assertPreflightQuestion('请回复选「1」或「2」，我就提交对应任务。', 'choice');
  assertPreflightQuestion('请选一个：1 详细版，2 简报。', 'choice');
  assert.throws(() => assertPreflightQuestion('已为你执行详细版报告，任务已完成。', 'choice'));
});

test('PreflightS13 real fixture documents and executable scripts produce observable queries and business sentinels', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'muad-preflight-e2e-fixtures-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = writePreflightFixtures(root);
  t.after(() => rmSync(fixture.evidenceRoot, { recursive: true, force: true }));
  assert.equal(Object.keys(fixture.skills).length, 6);
  for (const [name, dir] of Object.entries(fixture.skills)) {
    assert.match(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), new RegExp(name));
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'muad.skill.json'))).longTask, true);
  }
  const run = spawnSync(process.execPath, [path.join(fixture.skills['quarterly-report'], 'run.mjs'), '--customer-id', 'customer-123'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).customerId, 'customer-123');
  assert.equal(statSync(fixture.businessFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(fixture.businessFile, 'utf8').trim()).customerId, 'customer-123');
  const fail = spawnSync(process.execPath, [path.join(fixture.skills['quarterly-report'], 'run.mjs')], { encoding: 'utf8' });
  assert.notEqual(fail.status, 0); assert.match(fail.stderr, /customerId/);
  const query = path.join(fixture.evidenceRoot, 'lookup.mjs');
  for (const [name, count] of [['唯一客户', 1], ['同名客户', 2], ['不存在', 0]]) {
    const result = spawnSync(process.execPath, [query, name], { encoding: 'utf8' });
    assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).length, count);
  }
  assert.equal(readFileSync(fixture.queryFile, 'utf8').trim().split('\n').length, 3);
});

test('PreflightS13 missing real model worker and isolated recipients fail explicitly', () => {
  assert.throws(() => parseE2EEnvironment({}), /MUAD_PREFLIGHT_E2E_CONFIG/);
  assert.throws(() => parseE2EEnvironment({ MUAD_PREFLIGHT_E2E_CONFIG: '/nonexistent/preflight.json' }), /environment file/);
});

test('PreflightS19 actual renderer protected ordinary Skills do not invalidate the long-task fixture set', async () => {
  const { renderOpenClawConfig } = await import('../../../bin/openclaw-config-renderer.mjs');
  const { validateScenarioAgent } = await import('./skill-preflight-e2e-support.mjs');
  const runtime = JSON.parse(readFileSync(new URL('../../../bin/test/fixtures/runtime-v1.json', import.meta.url), 'utf8'));
  runtime.skills.agents[0].allowed.push({ ...runtime.skills.agents[0].allowed[0],
    name: 'web-tools-guide', source: 'system', rootPath: '/opt/openclaw-skills/web-tools-guide', longTask: false });
  const config = renderOpenClawConfig(runtime);
  const fixture = { agentId: 'alice', skills: ['xdr-query'] };
  assert.doesNotThrow(() => validateScenarioAgent(config, fixture));
  assert.ok(config.plugins.entries['muad-runtime-guard'].config.skillAuditGrants.some(grant =>
    grant.agentId === 'alice' && grant.name === 'web-tools-guide' && grant.source === 'system'));
  assert.throws(() => validateScenarioAgent(config, { ...fixture, skills: [] }));
  const noTool = structuredClone(config); noTool.agents.list[1].tools.allow = ['read'];
  assert.throws(() => validateScenarioAgent(noTool, fixture), /muad_submit_long_task/);
  const noModel = structuredClone(config); delete noModel.agents.list[1].model;
  assert.throws(() => validateScenarioAgent(noModel, fixture), /model/);
});
