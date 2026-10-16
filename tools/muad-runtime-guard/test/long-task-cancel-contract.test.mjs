import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const enabled = process.env.MUAD_LONG_TASK_CONTRACT === '1';
const image = process.env.MUAD_LONG_TASK_CONTRACT_IMAGE
  || 'muad-openclaw:skill-preflight-e2e-20261001-r4';

// Execute inside the installed distribution, without credentials, mounts or networking.
const contract = String.raw`
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  OPENCLAW_VERSION, abortAndDrainAgentHarnessRun,
  setActiveEmbeddedRun, clearActiveEmbeddedRun, resolveActiveEmbeddedRunSessionId,
} from 'openclaw/plugin-sdk/agent-harness-runtime';
import { killProcessTree } from 'openclaw/plugin-sdk/agent-core';

async function ownedRun(id, stopsProcess) {
  const sessionKey = 'agent:main:longtask:' + id;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore',
  });
  const closed = once(child, 'close');
  await once(child, 'spawn');
  const handle = {
    runId: 'run-' + id, isAbortable: () => true,
    isStreaming: () => true, isCompacting: () => false,
    abort: () => { if (stopsProcess) killProcessTree(child.pid, { force: true }); },
  };
  child.once('close', () => clearActiveEmbeddedRun(id, handle, sessionKey));
  setActiveEmbeddedRun(id, handle, sessionKey);
  return { id, sessionKey, child, handle, closed };
}

async function verifyContract() {
  assert.equal(OPENCLAW_VERSION, '2026.7.1');
  const target = await ownedRun('probe-contract-target', true);
  const other = await ownedRun('probe-contract-other', false);
  try {
    assert.equal(resolveActiveEmbeddedRunSessionId(target.sessionKey), target.id);
    clearActiveEmbeddedRun(target.id, {}, target.sessionKey);
    assert.equal(resolveActiveEmbeddedRunSessionId(target.sessionKey), target.id);
    const stopped = await abortAndDrainAgentHarnessRun({
      sessionId: target.id, sessionKey: target.sessionKey, settleMs: 2000, forceClear: false,
    });
    assert.deepEqual(stopped, { aborted: true, drained: true, forceCleared: false });
    await target.closed;
    assert.equal(target.child.signalCode, 'SIGKILL');
    assert.equal(resolveActiveEmbeddedRunSessionId(target.sessionKey), undefined);
    assert.equal(resolveActiveEmbeddedRunSessionId(other.sessionKey), other.id);
    const pending = await abortAndDrainAgentHarnessRun({
      sessionId: other.id, sessionKey: other.sessionKey, settleMs: 100, forceClear: false,
    });
    assert.deepEqual(pending, { aborted: true, drained: false, forceCleared: false });
    assert.equal(other.child.signalCode, null);
    assert.equal(resolveActiveEmbeddedRunSessionId(other.sessionKey), other.id);
    const missing = await abortAndDrainAgentHarnessRun({ sessionId: 'probe-missing' });
    assert.deepEqual(missing, { aborted: false, drained: false, forceCleared: false });
  } finally {
    for (const run of [target, other]) {
      if (run.child.signalCode === null) killProcessTree(run.child.pid, { force: true });
      await run.closed;
      clearActiveEmbeddedRun(run.id, run.handle, run.sessionKey);
    }
  }
  console.log('LongTaskControlS11: 2026.7.1 public SDK, owned process close, isolation, timeout verified');
}
await verifyContract();
`;

function runContract() {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [
      'run', '--rm', '-i', '--network', 'none', '--entrypoint', 'node', image,
      '--input-type=module', '-',
    ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 45_000 });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => { output = (output + chunk).slice(-16_384); });
    }
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0) reject(new Error(`contract exited ${code}/${signal}: ${output}`));
      else resolve(output);
    });
    child.stdin.end(contract);
  });
}

test('LongTaskControlS11 pinned public abort/drain and real owned process contract', {
  skip: !enabled, timeout: 50_000,
}, async () => {
  assert.match(await runContract(), /LongTaskControlS11: 2026\.7\.1 public SDK/);
});
