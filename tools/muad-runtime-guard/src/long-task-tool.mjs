import { createHash } from 'node:crypto';

const parameters = {
  type: 'object', additionalProperties: false,
  required: ['skillName', 'objective', 'selectionBasis', 'requiredNames', 'bindings'],
  properties: {
    skillName: { type: 'string' }, objective: { type: 'string' },
    selectionBasis: { type: 'string', enum: ['unique_match', 'user_choice', 'explicit_name'] },
    requiredNames: { type: 'array', items: { type: 'string' } },
    bindings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['name', 'value', 'source'], properties: {
        name: { type: 'string' }, value: { type: 'string' },
        source: { type: 'string', enum: ['user_message', 'conversation', 'document_default', 'document_resolution'] },
      } } },
  },
};

export function createLongTaskToolFactory({ preflight, manager, getConfig, log = () => {} }) {
  return toolContext => ({
    name: 'muad_submit_long_task', label: '提交已完成预检的长任务',
    description: '只在唯一明确匹配或用户已选择且文档参数齐全后提交。先在当前轮 read SKILL.md；不用于探索、选择或补参。',
    parameters,
    async execute(_callId, rawInput) {
      const checked = preflight.check(rawInput, toolContext);
      if (!checked.ok) return rejected(checked.reason, checked.missingNames, log);
      try { return jsonResult(submitOnce(checked, manager, getConfig())); }
      catch { return rejected('queue_unavailable', undefined, log); }
    },
  });
}

function submitOnce({ input, turn, grant }, manager, config) {
  if (!manager || manager.closed) throw new Error('queue unavailable');
  const taskId = createHash('sha256').update(JSON.stringify([turn.agentId, turn.sessionKey, turn.runId])).digest('hex');
  const snapshot = manager.snapshot();
  const pool = snapshot.pools.find(item => item.agentId === turn.agentId &&
    item.tasks.some(task => task.taskId === taskId));
  const previous = pool?.tasks.find(task => task.taskId === taskId);
  if (previous) {
    if (previous.skillName !== input.skillName) return { status: 'rejected', reason: 'invalid_input' };
    if (previous.errorCode === 'long_task_state_unavailable') throw new Error('queue unavailable');
    return accepted(previous, pool);
  }
  const result = manager.submit({ ...turn, skillName: grant.name, skillRoot: grant.rootPath,
    taskId, objective: input.objective, locale: config?.locale,
    executionInputs: { requiredNames: input.requiredNames, bindings: input.bindings } });
  return accepted(result.task, result);
}

function accepted(task, counts) {
  return { status: 'accepted', taskId: task.taskId, skillName: task.skillName,
    queuedAhead: counts.queuedAhead ?? 0, active: counts.active, queued: counts.queued };
}
function rejected(reason, missingNames, log) {
  log(`[muad-runtime-guard][longtask-submit] rejected reason=${reason}`);
  return jsonResult({ status: 'rejected', reason, ...(missingNames ? { missingNames } : {}) });
}
function jsonResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }
