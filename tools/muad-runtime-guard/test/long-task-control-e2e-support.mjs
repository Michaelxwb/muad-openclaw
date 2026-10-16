import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const executeFile = promisify(execFile);

export const longTaskControlSkillNames = ['cancel-long-task', 'alternate-long-task', 'queued-cancel', 'reference-report'];
export const longTaskControlResultMarker = 'MUAD_LONG_TASK_CONTROL_RESULT';

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export function readJsonl(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

export function businessRows(file, skillName) {
  return readJsonl(file).filter(row => row.skillName === skillName);
}

export function assertZeroBusinessRows(file, skillName) {
  assert.equal(businessRows(file, skillName).length, 0,
    `unexpected execution of ${skillName}: isolated fixture must stay untouched`);
  return true;
}

export async function assertBusinessStopped(file, skillName, options = {}) {
  const windowMs = options.windowMs ?? 1_000;
  const before = businessRows(file, skillName).length;
  await delay(windowMs);
  const after = businessRows(file, skillName).length;
  assert.equal(after, before, `unexpected execution of ${skillName}: business count still growing`);
}

export function assertDelivered(rows, peerId, marker) {
  const received = rows.filter(row => row.peerId === peerId);
  assert.ok(received.length > 0, 'missing real recipient delivery evidence');
  const matching = received.filter(row => String(row.text ?? '').includes(marker));
  assert.equal(matching.length, 1, `exactly one delivered result required, got ${matching.length}`);
}

export function assertDeliveredOnce(file, peerId, marker) {
  assertDelivered(readJsonl(file), peerId, marker);
}

const aliveProbe = "const fs = require('node:fs'); for (const pid of process.argv.slice(1)) { try { process.kill(Number(pid), 0); let zombie = false; try { zombie = fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(' ')[2] === 'Z'; } catch {} if (!zombie) process.stdout.write(pid + '\\n'); } catch {} }";

async function defaultRun(argv) {
  const result = await executeFile(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return result.stdout;
}

// 真实进程停止判据：必须有真实 pid 记录，且每个记录进程（含子进程）都不再存活；
// 缺失证据或伪造停止（进程仍存活）都必须失败。readText/run 可注入以适配远端 Worker。
export async function assertProcessStopped(processFile, options = {}) {
  const readText = options.readText ?? (file => readFileSync(file, 'utf8'));
  const run = options.run ?? defaultRun;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const since = Number.isInteger(options.since) && options.since > 0 ? options.since : 0;
  const sinceTime = typeof options.sinceTime === 'string' ? options.sinceTime.trim() : '';
  let rows = [];
  try {
    rows = String(await readText(processFile)).split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    rows = [];
  }
  // 场景允许多个任务并存（如 S-07 的 sibling）：只检查本任务启动后新增的 pid 行，
  // 并可按 customerId 精确圈定被测任务。
  rows = rows.slice(since);
  if (sinceTime) {
    rows = rows.filter(row => String(row.startedAt ?? '') > sinceTime);
  }
  if (typeof options.customerId === 'string' && options.customerId) {
    rows = rows.filter(row => row.customerId === options.customerId);
  }
  assert.ok(rows.length > 0, 'missing real process stop evidence: no recorded task pid');
  const pids = [...new Set(rows.flatMap(row => [row.pid, row.childPid]))]
    .filter(pid => Number.isInteger(pid) && pid > 0);
  assert.ok(pids.length >= rows.length, 'missing real process stop evidence: pid not recorded');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = String(await run([process.execPath, '-e', aliveProbe, ...pids.map(String)]))
      .split('\n').filter(Boolean);
    if (alive.length === 0) return;
    if (Date.now() >= deadline) {
      assert.fail(`long task sentinel process ${alive.join(',')} still alive: fake stop cannot pass`);
    }
    await delay(100);
  }
}

export function writeLongTaskControlFixtures(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const evidenceRoot = path.join(path.dirname(root), path.basename(root) + '-evidence');
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  const fixture = {
    root,
    evidenceRoot,
    businessFile: path.join(evidenceRoot, 'business.jsonl'),
    processFile: path.join(evidenceRoot, 'business-pids.jsonl'),
    companyLabelFile: path.join(evidenceRoot, 'company-label.jsonl'),
    companyLabelServer: path.join(evidenceRoot, 'company-label-server.mjs'),
    resultMarker: longTaskControlResultMarker,
    skills: {},
  };
  writeFileSync(fixture.companyLabelServer, companyLabelServerScript(fixture), { mode: 0o600 });
  for (const name of longTaskControlSkillNames) {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    fixture.skills[name] = dir;
    writeFileSync(path.join(dir, 'muad.skill.json'), JSON.stringify({ name, longTask: true }), { mode: 0o600 });
    writeFileSync(path.join(dir, 'SKILL.md'), skillDocument(name, dir), { mode: 0o600 });
    writeFileSync(path.join(dir, 'run.mjs'), runScript(name, fixture), { mode: 0o600 });
  }
  return fixture;
}

function skillDocument(name, dir) {
  const script = path.join(dir, 'run.mjs');
  const sentinel = name === 'cancel-long-task' || name === 'alternate-long-task';
  const description = name === 'cancel-long-task' ? '客户长报告生成 E2E 哨兵：为客户持续生成长报告（写业务计数并持有真实子进程），直到被停止或自然结束' :
    name === 'alternate-long-task' ? '客户长报告生成 E2E 第二候选：行为与 cancel-long-task 一致，用于多候选选择验收' :
    name === 'queued-cancel' ? '排队取消 E2E 哨兵：一旦执行即留下业务痕迹，用于证明排队取消不会执行' :
    '其他长任务文档：仅供等价请求读取引用，业务脚本不得执行';
  const invocation = sentinel ?
    `业务参数 customerId 是客户ID。调用：node ${JSON.stringify(script)} --customer-id <customerId>（可选 --ticks N 在 N 次计数后自然结束并写 result 行）。` :
    `调用：node ${JSON.stringify(script)}。`;
  const execution = sentinel ?
    '由长任务运行时前台阻塞执行：用 exec 直接运行 node run.mjs，exec 必须带 yieldMs=120000（前台等待 2 分钟再转入后台；严禁 &、nohup 或其它分离模式）。若 exec 返回“Command still running (session ...)”，用 process 工具 action=poll、timeout=30000 对同一会话持续轮询（心跳出现在 tail 里），直到任务被停止或看到 result 行；任务未停止前不得结束回合或返回完成。脚本会周期性输出心跳。' :
    '由长任务运行时前台执行：直接运行 node run.mjs（严禁后台或分离模式），脚本快速结束后返回。';
  const companyLabelSection = name === 'reference-report'
    ? '\n## 客户标签查询（company_label 测试接口）\n\n需要确认客户的公司标签时，用 exec 恰好调用一次；接口不接受任何查询参数（不要添加 customerId 等参数），不要重复探测：\n\n    curl -s http://127.0.0.1:39127/company-label\n\n返回固定 JSON（如 {"ok":true,"companyLabel":"company_label test interface"}）。该查询只读，不代表执行任何业务脚本。\n'
    : '';
  return `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\n${description}\n\n${invocation}\n${companyLabelSection}\n这是longTask:true长任务。前台只预检；业务脚本${execution}后台结果保留${longTaskControlResultMarker}标记。\n`;
}

function runScript(name, fixture) {
  if (name === 'cancel-long-task' || name === 'alternate-long-task') {
    return `import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const readFlag = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const customerId = readFlag('--customer-id');
if (!customerId) {
  process.stderr.write('missing --customer-id\\n');
  process.exit(2);
}
const ticks = Number(readFlag('--ticks') || '0');
const businessFile = ${JSON.stringify(fixture.businessFile)};
const processFile = ${JSON.stringify(fixture.processFile)};
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)', '--muad-long-task-marker', ${JSON.stringify(`${fixture.root}/${name}/`)}], { stdio: 'ignore' });
appendFileSync(processFile, JSON.stringify({ skillName: ${JSON.stringify(name)}, customerId, pid: process.pid, childPid: child.pid, startedAt: new Date().toISOString() }) + '\\n', { mode: 0o600 });
let tick = 0;
const write = kind => appendFileSync(businessFile, JSON.stringify({ skillName: ${JSON.stringify(name)}, customerId, kind, tick, marker: ${JSON.stringify(longTaskControlResultMarker)}, at: new Date().toISOString() }) + '\\n', { mode: 0o600 });
write('start');
const timer = setInterval(() => {
  tick += 1;
  write('tick');
  if (tick % 25 === 0) process.stdout.write('heartbeat tick=' + tick + '\\n');
  if (ticks > 0 && tick >= ticks) {
    clearInterval(timer);
    write('result');
    process.stdout.write(JSON.stringify({ skillName: ${JSON.stringify(name)}, customerId, marker: ${JSON.stringify(longTaskControlResultMarker)} }) + '\\n');
    child.kill('SIGKILL');
    process.exit(0);
  }
}, 200);
`;
  }
  return `import { appendFileSync } from 'node:fs';
const row = { skillName: ${JSON.stringify(name)}, marker: ${JSON.stringify(longTaskControlResultMarker)}, at: new Date().toISOString() };
appendFileSync(${JSON.stringify(fixture.businessFile)}, JSON.stringify(row) + '\\n', { mode: 0o600 });
process.stdout.write(JSON.stringify(row) + '\\n');
`;
}

function companyLabelServerScript(fixture) {
  return `import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const hitsFile = ${JSON.stringify(fixture.companyLabelFile)};
const port = Number(process.env.COMPANY_LABEL_PORT || '39127');
createServer((req, res) => {
  appendFileSync(hitsFile, JSON.stringify({ at: new Date().toISOString(), url: req.url }) + '\\n', { mode: 0o600 });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, companyLabel: 'company_label test interface' }));
}).listen(port, '127.0.0.1', () => {
  process.stdout.write('company label test interface on ' + port + '\\n');
});
`;
}

export function parseLongTaskControlEnvironment(env = process.env) {
  if (!env.MUAD_LONG_TASK_CONTROL_E2E_CONFIG) {
    throw new Error('MUAD_LONG_TASK_CONTROL_E2E_CONFIG required: real isolated Worker/model/IM environment');
  }
  let config;
  try {
    config = JSON.parse(readFileSync(env.MUAD_LONG_TASK_CONTROL_E2E_CONFIG, 'utf8'));
  } catch {
    throw new Error('E2E environment file unavailable or invalid');
  }
  assert.equal(config.isolated, true, 'isolated dedicated test Worker and test recipients required');
  assert.ok(config.consoleURL && config.consoleTokenFile && config.podId, 'real Console connection required');
  assert.ok(path.isAbsolute(config.configPath) && path.isAbsolute(config.stateFile), 'actual Worker config/state paths required');
  assert.ok(config.cases && typeof config.cases === 'object', 'scenario-to-isolated-user mappings required');
  assert.ok(Array.isArray(config.workerExec ?? []), 'workerExec must be an argv array');
  return config;
}

export function openLongTaskControlCase(id, environment = parseLongTaskControlEnvironment()) {
  const fixture = environment.cases[id];
  assert.ok(fixture, `missing fixture for ${id}`);
  // 专用测试前缀：longtask-*（计划用例）/ john-*（pod03 手工创建的专用用户）。
  assert.match(fixture.agentId, /^(longtask-|john-)/u, 'use isolated test users');
  for (const field of ['root', 'evidenceRoot', 'workspace', 'sessionDir', 'deliveriesFile']) {
    assert.ok(path.isAbsolute(fixture[field]), `${field} must be an absolute path to the real isolated fixture`);
  }
  assert.ok(fixture.peerId && fixture.channel && Array.isArray(fixture.skills), 'actual test IM route and authorized skill set required');
  return new LongTaskControlScenario(environment, fixture);
}

export function registerLongTaskControlE2E(name, fn) {
  // Functional glob imports these modules without running model/deployment scenarios.
  // Every registered acceptance command explicitly sets this opt-in flag.
  if (process.env.MUAD_LONG_TASK_CONTROL_E2E === '1') test(name, { timeout: 3_600_000 }, fn);
}

export function validateLongTaskScenarioAgent(config, fixture) {
  const agent = config.agents.list.find(item => item.id === fixture.agentId);
  assert.ok(agent && agent.model, 'actual business Agent/model configuration');
  const grants = config.plugins.entries['muad-runtime-guard'].config.longTaskSkillGrants
    .filter(grant => grant.agentId === fixture.agentId);
  // private skill 以目录 grant（dir:true，覆盖 fixture.root）生效；system 为精确名。
  const covered = new Set();
  for (const grant of grants) {
    if (grant.dir === true && grant.rootPath === fixture.root) for (const name of fixture.skills) covered.add(name);
    else if (grant.dir !== true) covered.add(grant.name);
  }
  for (const name of fixture.skills) assert.ok(covered.has(name), `missing effective grant ${name}`);
  assert.ok(agent.tools.allow.includes('muad_submit_long_task'), 'muad_submit_long_task must be visible');
  return agent;
}

export class LongTaskControlScenario {
  constructor(environment, fixture) {
    const workerExec = fixture.workerExec ?? environment.workerExec ?? [];
    assert.ok(Array.isArray(workerExec) && workerExec.every(value => typeof value === 'string'), 'workerExec must be an argv array');
    this.environment = { ...environment, workerExec };
    this.fixture = fixture;
    this.sessionKey = `agent:${fixture.agentId}:${fixture.channel}:direct:${fixture.peerId}`;
    // 证据文件优先取 case 显式路径，否则按 fixture 证据根派生（与生成器布局一致）。
    this.businessFile = fixture.businessFile ?? path.join(fixture.evidenceRoot, "business.jsonl");
    this.processFile = fixture.processFile ?? path.join(fixture.evidenceRoot, "business-pids.jsonl");
    this.companyLabelFile = fixture.companyLabelFile ?? path.join(fixture.evidenceRoot, "company-label.jsonl");
    this.baselineTasks = new Set();
    this.baselineBusiness = 0;
    this.baselineCompanyLabel = 0;
    this.baselineDeliveries = 0;
  }
  async command(args) {
    const prefix = this.environment.workerExec ?? [];
    const command = prefix.length ? prefix[0] : args[0];
    const argv = prefix.length ? [...prefix.slice(1), ...args] : args.slice(1);
    const result = await executeFile(command, argv, { timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, OPENCLAW_CONFIG_PATH: this.environment.configPath } });
    return result.stdout;
  }
  async cli(args) { return this.command(['openclaw', ...args]); }
  async read(file) {
    return this.command(['node', '-e', "const fs=require('node:fs');const f=process.argv[1];process.stdout.write(fs.existsSync(f)?fs.readFileSync(f,'utf8'):'');", file]);
  }
  async rows(file) {
    return (await this.read(file)).split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  async assertInstalled() {
    const config = JSON.parse(await this.read(this.environment.configPath));
    const agent = validateLongTaskScenarioAgent(config, this.fixture);
    const guidance = await this.read(path.join(this.fixture.workspace, 'AGENTS.md'));
    assert.match(guidance, /muad_submit_long_task/);
    for (const name of this.fixture.skills) {
      const document = await this.read(path.join(this.fixture.root, name, 'SKILL.md'));
      assert.ok(document.length > 0, `missing installed skill ${name}`);
    }
  }
  async captureBaseline() {
    this.baselineTasks = new Set((await this.tasks(false)).map(task => task.taskId));
    this.baselineBusiness = (await this.rows(this.businessFile)).length;
    // 以启动时刻为水位线圈定"本次运行新增"的进程行，避免行号基线在并发/补写场景失真。
    this.baselineProcessAt = new Date().toISOString();
    this.baselineCompanyLabel = (await this.rows(this.companyLabelFile)).length;
    this.baselineDeliveries = (await this.rows(this.fixture.deliveriesFile)).length;
  }
  async turn(prompt, options = {}) {
    const file = path.join(this.fixture.evidenceRoot, `request-${randomUUID()}.txt`);
    // 每轮独立 session：避免历史上下文让真实模型漂移到追问路径；并放宽 CLI 超时。
    await this.command(['node', '-e', "require('node:fs').writeFileSync(process.argv[1],process.argv[2],{mode:0o600});", file, prompt]);
    try {
      // 单次执行：重试交给提交辅助器按“是否实际新任务”判断，避免重复提交。
      this.turnSeq = (this.turnSeq ?? 0) + 1;
      // options.sessionKey：同一执行池的多次提交共享会话（否则 poolKey 不同、无法形成排队）。
      const sessionKey = options.sessionKey ?? `${this.sessionKey}-r${this.turnSeq}`;
      let output;
      try {
        output = await this.cli(['agent', '--agent', this.fixture.agentId, '--session-key', sessionKey,
          '--message-file', file, '--reply-channel', this.fixture.channel, '--reply-to', this.fixture.peerId, '--json', '--timeout', '240']);
      } catch (error) {
        const stderr = String(error?.stderr ?? '').trim();
        throw new Error(`agent CLI failed (exit=${error?.code ?? '?'}): ${stderr || error?.message || 'no stderr'}`);
      }
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
  async task(taskId) {
    // Worker 侧读取偶发瞬时失败（exec 抖动/空输出）不应误判为"任务不存在"：短暂重试。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const found = (await this.tasks(false)).find(task => task.taskId === taskId);
      if (found) return found;
      await delay(300);
    }
    return undefined;
  }
  async waitForTask(taskId, statuses, timeout = 600_000) {
    await eventually(async () => {
      const task = await this.task(taskId);
      return Boolean(task && statuses.includes(task.status));
    }, timeout);
    return this.task(taskId);
  }
  async business(skillName = null, delta = true) {
    const rows = (await this.rows(this.businessFile)).slice(delta ? this.baselineBusiness : 0);
    return skillName ? rows.filter(row => row.skillName === skillName) : rows;
  }
  async processRows() { return this.rows(this.processFile); }
  async companyLabelHits(delta = true) {
    return (await this.rows(this.companyLabelFile)).slice(delta ? this.baselineCompanyLabel : 0);
  }
  async deliveries(delta = true) {
    return (await this.rows(this.fixture.deliveriesFile))
      .filter(row => row.peerId === this.fixture.peerId).slice(delta ? this.baselineDeliveries : 0);
  }
  async assertProcessStopped(options = {}) {
    return assertProcessStopped(this.processFile, {
      ...options,
      sinceTime: options.sinceTime ?? this.baselineProcessAt ?? '',
      readText: file => this.read(file),
      // 远端 Worker 的探活命令固定用 node（argv[0] 占位），不能透传本机 node 路径。
      run: argv => this.command(["node", ...argv.slice(1)]),
    });
  }
  // 本任务是否留下真实 pid 记录（与 assertProcessStopped 相同过滤口径：水位线 + customerId）。
  async hasProcessEvidence(options = {}) {
    const sinceTime = options.sinceTime ?? this.baselineProcessAt ?? '';
    const customerId = typeof options.customerId === 'string' ? options.customerId : '';
    return (await this.processRows()).some(row =>
      (!sinceTime || String(row.startedAt ?? '') > sinceTime) &&
      (!customerId || row.customerId === customerId));
  }
  // 启动过就必须真实停止；取消先于脚本启动（重启/快速取消）时无进程可验，返回 false。
  async assertProcessStoppedIfStarted(options = {}) {
    if (!(await this.hasProcessEvidence(options))) return false;
    await this.assertProcessStopped(options);
    return true;
  }
  async assertZeroBusinessRows(skillName) {
    assert.equal((await this.business(skillName)).length, 0,
      `unexpected execution of ${skillName}: isolated fixture must stay untouched`);
  }
  async assertBusinessStopped(skillName, options = {}) {
    const windowMs = options.windowMs ?? 1_000;
    const before = (await this.business(skillName)).length;
    await delay(windowMs);
    const after = (await this.business(skillName)).length;
    assert.equal(after, before, `unexpected execution of ${skillName}: business count still growing`);
  }
  async assertDeliveredOnce(marker) { assertDelivered(await this.deliveries(), this.fixture.peerId, marker); }
  async traces() {
    const text = await this.command(['node', '-e', "const fs=require('node:fs'),p=require('node:path');const d=process.argv[1];for(const n of fs.readdirSync(d)){if(n.endsWith('.jsonl'))process.stdout.write(fs.readFileSync(p.join(d,n),'utf8'));}", this.fixture.sessionDir]);
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  async consoleFetch(route, options = {}) {
    const token = readFileSync(this.environment.consoleTokenFile, 'utf8').trim();
    const response = await fetch(new URL(route, this.environment.consoleURL), { ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body };
  }
  async consoleRequest(route, options = {}) {
    const { status, body } = await this.consoleFetch(route, options);
    assert.equal(status, 200, `Console ${route} status ${status}`);
    assert.equal(body.code, 0, `Console request failed (${status}, code=${body.code})`);
    return body.data;
  }
  async listTasks(query = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
    const suffix = params.toString() ? `?${params}` : '';
    return this.consoleRequest(`/api/v1/long-tasks${suffix}`);
  }
  async cancelTask(taskId) {
    return this.consoleFetch(`/api/v1/long-tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', body: '' });
  }
}

export function assertCancelResponse(response, { httpStatus, outcome, taskStatus }) {
  assert.equal(response.status, httpStatus, 'cancel HTTP status');
  assert.equal(response.body?.code, 0, 'cancel envelope code');
  const data = response.body.data;
  assert.equal(data.outcome, outcome, 'cancel outcome');
  if (taskStatus) assert.equal(data.status, taskStatus, 'cancel task status');
  return data;
}

export async function eventually(check, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(500); }
  throw new Error('real Worker/model/IM boundary did not satisfy the expected state before timeout');
}
