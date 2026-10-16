import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendTaskStateRecord,
  compactTaskStateFile,
  confirmTaskCancellation,
  nextTaskRecord,
  normalizeTaskRecord,
  readActiveTaskRecords,
  readLatestTaskStateRecords,
  recoverInterruptedRecord,
  requestTaskCancellation,
} from '../src/long-task-cancel-state.mjs';
import { LongTaskManager } from '../src/long-task-manager.mjs';

const TS = {
  t0: '2026-10-15T08:00:00.000Z',
  t1: '2026-10-15T08:01:00.000Z',
  t2: '2026-10-15T08:02:00.000Z',
  t3: '2026-10-15T08:03:00.000Z',
};

function legacyRecord(overrides = {}) {
  return {
    taskId: 'task-cancel',
    poolKey: 'agent:alice:wecom:direct:wx-1',
    sourceSessionKey: 'agent:alice:wecom:direct:wx-1',
    sessionKey: 'agent:alice:longtask:task-cancel',
    agentId: 'alice',
    peerId: 'wx-1',
    skillName: 'xdr-query',
    skillRoot: '/skills/xdr-query',
    status: 'queued',
    submittedAt: TS.t0,
    updatedAt: TS.t0,
    startedAt: '',
    endedAt: '',
    terminalReason: '',
    errorCode: '',
    ...overrides,
  };
}

function tmpStateFile(t, name = 'state.jsonl') {
  const root = mkdtempSync(path.join(tmpdir(), 'muad-cancel-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'queue', name);
}

test('LongTaskControlS15 keeps revisions monotonic and persists cancel requests reliably', t => {
  const stateFile = tmpStateFile(t);
  const legacy = normalizeTaskRecord(legacyRecord());
  assert.equal(legacy.stateRevision, 0);
  assert.equal(legacy.cancelRequestedAt, "");
  const revisions = [];
  const write = record => { revisions.push(record.stateRevision); appendTaskStateRecord(stateFile, record); };
  write(legacy);
  let latest = readLatestTaskStateRecords(stateFile).get('task-cancel');
  assert.equal(latest.stateRevision, 0);
  assert.equal(latest.status, 'queued');
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  const running = nextTaskRecord({ ...latest, status: 'running', startedAt: TS.t1 }, TS.t1);
  write(running);
  const cancelling = requestTaskCancellation(running, { requestedBy: 'operator-1', now: TS.t2 });
  assert.equal(cancelling.status, 'cancelling');
  assert.equal(cancelling.cancelRequestedAt, TS.t2);
  assert.equal(cancelling.cancelRequestedBy, 'operator-1');
  assert.throws(() => requestTaskCancellation(cancelling, { requestedBy: 'operator-2', now: TS.t2 }), /not cancellable/u);
  write(cancelling);
  latest = readLatestTaskStateRecords(stateFile).get('task-cancel');
  assert.equal(latest.status, 'cancelling');
  assert.equal(latest.cancelRequestedBy, 'operator-1');
  const cancelled = confirmTaskCancellation(latest, { now: TS.t3 });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelledAt, TS.t3);
  assert.equal(cancelled.terminalReason, 'manual_cancel');
  assert.throws(() => confirmTaskCancellation(cancelled, { now: TS.t3 }), /cannot confirm cancel/u);
  write(cancelled);
  assert.deepEqual(revisions, [0, 1, 2, 3]);
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  const final = readLatestTaskStateRecords(stateFile).get('task-cancel');
  assert.deepEqual(
    [final.status, final.stateRevision, final.cancelledAt, final.cancelRequestedBy],
    ['cancelled', 3, TS.t3, 'operator-1'],
  );
});

test('LongTaskControlS15 fails loudly on state writes and never fabricates cancellation', t => {
  const stateFile = tmpStateFile(t, 'readable.jsonl');
  appendTaskStateRecord(stateFile, normalizeTaskRecord(legacyRecord()));
  const blocked = path.join(path.dirname(stateFile), 'blocked-path');
  writeFileSync(blocked, 'not a directory');
  const cancelling = requestTaskCancellation(
    nextTaskRecord(legacyRecord(), TS.t1),
    { requestedBy: 'operator-1', now: TS.t2 },
  );
  const cancelled = confirmTaskCancellation(cancelling, { now: TS.t3 });
  assert.throws(() => appendTaskStateRecord(path.join(blocked, 'state.jsonl'), cancelled), /long task state unavailable/u);
  assert.equal(readLatestTaskStateRecords(stateFile).get('task-cancel').status, 'queued');
});

test('LongTaskControlS15 recovers legacy records and preserves cancelling tombstones', t => {
  const stateFile = tmpStateFile(t);
  const queued = legacyRecord({ taskId: 'task-queued' });
  const running = legacyRecord({ taskId: 'task-running', status: 'running', startedAt: TS.t1, updatedAt: TS.t1, childPid: 424242 });
  const tombstone = requestTaskCancellation(
    legacyRecord({ taskId: 'task-cancel', status: 'running', startedAt: TS.t1, updatedAt: TS.t1 }),
    { requestedBy: 'operator-1', now: TS.t2 },
  );
  const done = legacyRecord({ taskId: 'task-done', status: 'succeeded', updatedAt: '2026-10-15T07:00:00.000Z' });
  for (const record of [queued, running, tombstone, done]) appendTaskStateRecord(stateFile, record);
  const latest = readLatestTaskStateRecords(stateFile);
  assert.equal(latest.get('task-queued').stateRevision, 0);
  assert.equal(latest.get('task-queued').cancelRequestedAt, '');
  assert.deepEqual(
    readActiveTaskRecords(stateFile).map(record => record.taskId).sort(),
    ['task-cancel', 'task-queued', 'task-running'],
  );
  const recovered = recoverInterruptedRecord(latest.get('task-queued'), { now: TS.t3 });
  assert.equal(recovered.changed, true);
  assert.equal(recovered.record.status, 'failed');
  assert.equal(recovered.record.stateRevision, 1);
  assert.equal(recovered.record.errorCode, 'long_task_interrupted');
  const orphan = recoverInterruptedRecord(latest.get('task-running'), { now: TS.t3, childAlive: true });
  assert.match(orphan.record.terminalReason, /orphaned child/u);
  const preserved = recoverInterruptedRecord(latest.get('task-cancel'), { now: TS.t3 });
  assert.equal(preserved.changed, false);
  assert.equal(preserved.record.status, 'cancelling');
  assert.equal(preserved.record.cancelledAt, '');
  assert.equal(recoverInterruptedRecord(latest.get('task-done'), { now: TS.t3 }).changed, false);
  compactTaskStateFile(stateFile, () => new Date(TS.t3), 10 * 60_000);
  const after = readLatestTaskStateRecords(stateFile);
  assert.equal(after.get('task-cancel').status, 'cancelling');
  assert.equal(after.get('task-done'), undefined);
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);
});

test('LongTaskControlS15 restarts keep cancelling tasks as tombstones without re-execution', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'muad-cancel-restart-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.jsonl');
  appendTaskStateRecord(stateFile, requestTaskCancellation(
    legacyRecord({ taskId: 'task-cancel', status: 'running', startedAt: TS.t1, updatedAt: TS.t1 }),
    { requestedBy: 'operator-1', now: TS.t2 },
  ));
  appendTaskStateRecord(stateFile, legacyRecord({ taskId: 'task-queued' }));
  const runs = [];
  const options = () => ({
    stateFile,
    now: () => new Date(TS.t3),
    runTask: task => { runs.push(task.taskId); return Promise.resolve(); },
  });
  const first = new LongTaskManager(options());
  assert.deepEqual(runs, []);
  const firstTasks = first.snapshot().pools.flatMap(pool => pool.tasks);
  const cancellingTask = firstTasks.find(task => task.taskId === 'task-cancel');
  assert.equal(cancellingTask.status, 'cancelling');
  assert.equal(cancellingTask.stateRevision, 1);
  const restored = firstTasks.find(task => task.taskId === 'task-queued');
  assert.equal(restored.status, 'failed');
  assert.equal(restored.errorCode, 'long_task_interrupted');
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(readLatestTaskStateRecords(stateFile).get('task-cancel').status, 'cancelling');
  first.close();
  const second = new LongTaskManager(options());
  assert.deepEqual(runs, []);
  const again = second.snapshot().pools.flatMap(pool => pool.tasks).find(task => task.taskId === 'task-cancel');
  assert.equal(again.status, 'cancelling');
  assert.equal(readLatestTaskStateRecords(stateFile).get('task-cancel').cancelledAt, '');
  second.close();
});
