import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const executeFile = promisify(execFile);
export function assertPreflightQuestion(reply, kind) {
  const patterns = {
    choice: /选择|选哪|哪种|哪一个|哪个|确认|(?:先|请).*选|回复.*(?:选|序号)/u,
    context: /什么|哪一个|哪个|确认|指的|提供|说明|重新|取消|没有.*指向/u,
  };
  assert.ok(Object.hasOwn(patterns, kind), 'known preflight question kind required');
  assert.match(reply, patterns[kind]);
}
export function deploymentUser(data, agentId) {
  assert.equal(data.humanUser?.agentId, agentId, 'fault scope must be the isolated test user');
  return data.humanUser;
}
export async function probeGatewayTool(configPath, agentId) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const response = await fetch(`http://127.0.0.1:${config.gateway.port ?? 18789}/tools/invoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.gateway.auth.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'muad_submit_long_task', args: {},
      sessionKey: `agent:${agentId}:mattermost:direct:preflight-tool-probe` }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json() };
}
export const skillNames = ['quarterly-report', 'quarterly-summary', 'lookup-report', 'noarg-report', 'undocumented-report', 'conflicting-report'];

export function writePreflightFixtures(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const evidenceRoot = path.join(path.dirname(root), path.basename(root) + '-evidence');
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  const fixture = { skills: {}, evidenceRoot, businessFile: path.join(evidenceRoot, 'business.jsonl'), queryFile: path.join(evidenceRoot, 'queries.jsonl') };
  for (const name of skillNames) {
    const dir = path.join(root, name); mkdirSync(dir, { recursive: true, mode: 0o700 });
    fixture.skills[name] = dir;
    writeFileSync(path.join(dir, 'muad.skill.json'), JSON.stringify({ name, longTask: true }), { mode: 0o600 });
    writeFileSync(path.join(dir, 'SKILL.md'), skillDocument(name, dir), { mode: 0o600 });
    writeFileSync(path.join(dir, 'run.mjs'), businessScript(name, fixture.businessFile), { mode: 0o600 });
    if (name === 'lookup-report') writeFileSync(path.join(evidenceRoot, 'lookup.mjs'), queryScript(fixture.queryFile), { mode: 0o600 });
  }
  return fixture;
}

function skillDocument(name, dir) {
  const description = name === 'quarterly-summary' ? '生成客户季度简报，只输出摘要和指标' :
    name === 'lookup-report' ? '生成客户名称解析季度报告，文档允许按名称查ID' :
    name === 'noarg-report' ? '生成无需参数的固定演示报告' :
    name === 'undocumented-report' ? '生成未说明调用参数的演示报告' :
    name === 'conflicting-report' ? '生成调用说明冲突的演示报告' : '生成客户完整季度报告，包含明细、趋势和指标；不生成安全分析报告';
  let invocation = `必填参数 customerId 是客户ID，不接受客户名称。调用：node ${JSON.stringify(path.join(dir, 'run.mjs'))} --customer-id <customerId>。缺ID立即追问，不允许查询、猜测或尝试业务接口。`;
  if (name === 'lookup-report') invocation = `必填 customerId；客户只给名称时，文档明确允许先用 exec 调用 node ${JSON.stringify(path.join(path.dirname(path.dirname(dir)), path.basename(path.dirname(dir)) + '-evidence', 'lookup.mjs'))} <客户名称>。返回唯一ID可绑定；多个需选择；无结果追问。业务调用：node ${JSON.stringify(path.join(dir, 'run.mjs'))} --customer-id <customerId>。`;
  if (name === 'noarg-report') invocation = `明确无需参数；requiredNames/bindings为空。调用 node ${JSON.stringify(path.join(dir, 'run.mjs'))}。`;
  if (name === 'undocumented-report') invocation = '调用说明尚未提供。';
  if (name === 'conflicting-report') invocation = '说明A：无需参数。说明B：必须提供customerId，但没有定义调用方式。';
  const queryGuidance = name === 'lookup-report' ? 'lookup.mjs为文档授权的前台参数查询。' : '';
  return `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\n${description}\n\n${invocation}\n\n这是longTask:true长任务。前台只预检，业务脚本须后台执行。${queryGuidance}后台结果保留E2E_REPORT_RESULT标记。\n`;
}

function businessScript(name, file) {
  return `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const customerId = args[args.indexOf('--customer-id') + 1];
if (${JSON.stringify(name)} !== 'noarg-report' && (!args.includes('--customer-id') || !customerId)) { process.stderr.write('missing customerId\\n'); process.exit(2); }
const row = { skillName: ${JSON.stringify(name)}, customerId: customerId ?? '', marker: 'E2E_REPORT_RESULT', timestamp: new Date().toISOString() };
appendFileSync(${JSON.stringify(file)}, JSON.stringify(row) + '\\n', { mode: 0o600 });
process.stdout.write(JSON.stringify(row) + '\\n');
`;
}

function queryScript(file) {
  return `import { appendFileSync } from 'node:fs';
const name = process.argv[2];
const rows = name === '唯一客户' ? [{ customerId: 'customer-123', name }] : name === '同名客户' ? [{ customerId: 'customer-123', name: '同名客户甲' }, { customerId: 'customer-456', name: '同名客户乙' }] : [];
appendFileSync(${JSON.stringify(file)}, JSON.stringify({ name, rows }) + '\\n', { mode: 0o600 });
process.stdout.write(JSON.stringify(rows) + '\\n');
`;
}

export function parseE2EEnvironment(env = process.env) {
  if (!env.MUAD_PREFLIGHT_E2E_CONFIG) throw new Error('MUAD_PREFLIGHT_E2E_CONFIG required: real isolated Worker/model/IM environment');
  let config;
  try { config = JSON.parse(readFileSync(env.MUAD_PREFLIGHT_E2E_CONFIG, 'utf8')); }
  catch { throw new Error('E2E environment file unavailable or invalid'); }
  assert.equal(config.isolated, true, 'dedicated test Worker and test recipients required');
  assert.ok(config.consoleURL && config.consoleTokenFile && config.podId, 'real Console connection required');
  assert.ok(path.isAbsolute(config.configPath) && path.isAbsolute(config.stateFile), 'actual Worker config/state paths required');
  assert.ok(config.cases && typeof config.cases === 'object', 'scenario-to-isolated-user mappings required');
  assert.ok(Array.isArray(config.workerExec ?? []), 'workerExec must be an argv array');
  return config;
}

export function registerPreflightE2E(name, fn) {
  // Functional glob imports these modules without running model/deployment scenarios.
  // Every registered acceptance command explicitly sets this opt-in flag.
  if (process.env.MUAD_PREFLIGHT_E2E === '1') test(name, { timeout: 600_000 }, fn);
}

export function validateScenarioAgent(config, fixture) {
  const agent = config.agents.list.find(item => item.id === fixture.agentId);
  assert.ok(agent && agent.model, 'actual business Agent/model configuration');
  const grants = config.plugins.entries['muad-runtime-guard'].config.longTaskSkillGrants;
  const names = grants.filter(grant => grant.agentId === fixture.agentId).map(grant => grant.name);
  assert.deepEqual(names.sort(), [...fixture.skills].sort(), 'effective long-task set must match the scenario');
  assert.ok(agent.tools.allow.includes('muad_submit_long_task'), 'muad_submit_long_task must be visible');
  return agent;
}

export async function openScenario(id) {
  const environment = parseE2EEnvironment();
  const fixture = environment.cases[id];
  assert.ok(fixture, `missing fixture for ${id}`);
  assert.match(fixture.agentId, /^preflight-/u, 'use isolated test users');
  for (const field of ['root', 'evidenceRoot', 'workspace', 'sessionDir', 'deliveriesFile']) assert.ok(path.isAbsolute(fixture[field]), field);
  assert.ok(fixture.peerId && fixture.channel && Array.isArray(fixture.skills), 'actual test IM route and authorized skill set required');
  const h = new RealWorkerScenario(environment, fixture);
  await h.assertInstalled();
  await h.captureBaseline();
  return h;
}

export class RealWorkerScenario {
  constructor(environment, fixture) {
    const workerExec = fixture.workerExec ?? environment.workerExec ?? [];
    assert.ok(Array.isArray(workerExec) && workerExec.every(value => typeof value === 'string'), 'workerExec must be an argv array');
    this.environment = { ...environment, workerExec }; this.fixture = fixture;
    this.sessionKey = `agent:${fixture.agentId}:${fixture.channel}:direct:${fixture.peerId}`;
    this.baselineTasks = new Set(); this.baselineBusiness = 0; this.baselineQueries = 0; this.baselineDeliveries = 0;
  }
  async command(args) {
    const prefix = this.environment.workerExec ?? [];
    const command = prefix.length ? prefix[0] : args[0];
    const argv = prefix.length ? [...prefix.slice(1), ...args] : args.slice(1);
    const result = await executeFile(command, argv, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, OPENCLAW_CONFIG_PATH: this.environment.configPath } });
    return result.stdout;
  }
  async cli(args) { return this.command(['openclaw', ...args]); }
  async toolAvailability(agentId) {
    const script = `import { readFileSync } from 'node:fs';\nconst probe = ${probeGatewayTool.toString()};\nconsole.log(JSON.stringify(await probe(process.argv[1], process.argv[2])));`;
    return JSON.parse(await this.command(['node', '--input-type=module', '-e', script, this.environment.configPath, agentId]));
  }
  async read(file) {
    return this.command(['node', '-e', "const fs=require('node:fs');const f=process.argv[1];process.stdout.write(fs.existsSync(f)?fs.readFileSync(f,'utf8'):'');", file]);
  }
  async rows(file) {
    return (await this.read(file)).split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  async assertInstalled() {
    const config = JSON.parse(await this.read(this.environment.configPath));
    const agent = validateScenarioAgent(config, this.fixture);
    const guidance = await this.read(path.join(this.fixture.workspace, 'AGENTS.md'));
    assert.match(guidance, /muad_submit_long_task/);
    for (const name of this.fixture.skills) {
      const grant = config.plugins.entries['muad-runtime-guard'].config.longTaskSkillGrants.find(item => item.agentId === agent.id && item.name === name);
      assert.ok(grant, `missing effective grant ${name}`);
      assert.equal(await this.read(path.join(grant.rootPath, 'SKILL.md')), skillDocument(name, grant.rootPath));
    }
  }
  async captureBaseline() {
    this.baselineTasks = new Set((await this.tasks(false)).map(task => task.taskId));
    this.baselineBusiness = (await this.business(false)).length;
    this.baselineQueries = (await this.queries(false)).length;
    this.baselineDeliveries = (await this.deliveries(false)).length;
  }
  async turn(prompt) {
    const file = path.join(this.fixture.evidenceRoot, `request-${randomUUID()}.txt`);
    await this.command(['node', '-e', "require('node:fs').writeFileSync(process.argv[1],process.argv[2],{mode:0o600});", file, prompt]);
    try {
      const output = await this.cli(['agent', '--agent', this.fixture.agentId, '--session-key', this.sessionKey,
        '--message-file', file, '--reply-channel', this.fixture.channel, '--reply-to', this.fixture.peerId, '--json', '--timeout', '120']);
      const response = JSON.parse(output);
      const payloads = response.result?.payloads ?? response.payloads;
      assert.ok(Array.isArray(payloads), 'actual OpenClaw JSON reply payloads required');
      return payloads.map(item => item.text ?? '').join('\n');
    } finally { await this.command(['node', '-e', "require('node:fs').rmSync(process.argv[1],{force:true});", file]); }
  }
  async tasks(delta = true) {
    const latest = new Map();
    for (const row of await this.rows(this.environment.stateFile)) if (row.agentId === this.fixture.agentId) latest.set(row.taskId, row);
    return [...latest.values()].filter(task => !delta || !this.baselineTasks.has(task.taskId));
  }
  async business(delta = true) { return (await this.rows(path.join(this.fixture.evidenceRoot, 'business.jsonl'))).slice(delta ? this.baselineBusiness : 0); }
  async queries(delta = true) { return (await this.rows(path.join(this.fixture.evidenceRoot, 'queries.jsonl'))).slice(delta ? this.baselineQueries : 0); }
  async deliveries(delta = true) { return (await this.rows(this.fixture.deliveriesFile)).filter(row => row.peerId === this.fixture.peerId).slice(delta ? this.baselineDeliveries : 0); }
  async assertIdle() {
    assert.deepEqual(await this.tasks(), []); assert.deepEqual(await this.business(), []);
    assert.deepEqual(await this.deliveries(), []);
  }
  async complete(skillName, customerId = 'customer-123') {
    await eventually(async () => (await this.tasks()).some(task => task.status === 'succeeded'));
    const tasks = await this.tasks(), calls = await this.business();
    assert.equal(tasks.length, 1); assert.equal(tasks[0].skillName, skillName);
    assert.equal(calls.length, 1); assert.equal(calls[0].skillName, skillName); assert.equal(calls[0].customerId, customerId);
    await eventually(async () => (await this.deliveries()).some(row => row.text.includes(tasks[0].taskId) && row.text.includes('E2E_REPORT_RESULT')));
    return tasks[0];
  }
  async traces() {
    const text = await this.command(['node', '-e', "const fs=require('node:fs'),p=require('node:path');const d=process.argv[1];for(const n of fs.readdirSync(d)){if(n.endsWith('.jsonl'))process.stdout.write(fs.readFileSync(p.join(d,n),'utf8'));}", this.fixture.sessionDir]);
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  async consoleRequest(route, options = {}) {
    const token = readFileSync(this.environment.consoleTokenFile, 'utf8').trim();
    const response = await fetch(new URL(route, this.environment.consoleURL), { ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    const body = await response.json();
    assert.equal(body.code, 0, `Console request failed (${response.status}, code=${body.code})`);
    return body.data;
  }
}

export async function eventually(check, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 500)); }
  throw new Error('real Worker/model/IM boundary did not satisfy the expected state before timeout');
}
