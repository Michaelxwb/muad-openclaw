import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeShellCommand, matchAuthorizedExecution } from '../src/long-task-command-policy.mjs';

// S-13 真实边界：真实 bash-parser AST 模块、临时脚本/目录与真实 symlink；
// 断言执行判定、普通查看不误判、解析不确定返回显式结果。
function setup(t) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'muad-command-policy-')));
  const root = path.join(base, 'skill');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const script = path.join(root, 'scripts/run.py');
  writeFileSync(script, "print('report')\n");
  const entry = path.join(root, 'run.sh');
  writeFileSync(entry, '#!/bin/sh\necho report\n');
  writeFileSync(path.join(root, 'data.txt'), 'alpha\nbeta\n');
  const outside = path.join(base, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'tool.py'), "print('tool')\n");
  const linkIn = path.join(outside, 'link-in.py');
  symlinkSync(script, linkIn);
  const linkOut = path.join(root, 'scripts/link-out.py');
  symlinkSync(path.join(outside, 'tool.py'), linkOut);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, root, script, entry, outside, linkIn, linkOut };
}

function verdict(command, options, f) {
  const analysis = analyzeShellCommand(command, options);
  return { analysis, match: matchAuthorizedExecution(analysis, { rootPath: f.root }) };
}

function assertBlocked(f, command, options, label = command) {
  const result = verdict(command, options, f);
  assert.equal(result.match.decision, 'block', `${label} should be blocked: ${JSON.stringify(result)}`);
  assert.ok(result.match.reason, `${label} should carry an explicit refusal basis`);
  return result;
}

function assertAllowed(f, command, options, label = command) {
  const result = verdict(command, options, f);
  assert.equal(result.match.decision, 'allow', `${label} should stay allowed: ${JSON.stringify(result)}`);
  return result;
}

test('LongTaskControlS13 resolves execution through cwd, cd, wrappers, nesting and substitution', async t => {
  const f = setup(t);
  assertBlocked(f, 'python3 scripts/run.py', { cwd: f.root }, 'cwd-relative interpreter');
  assertBlocked(f, `python3 ${f.script}`, { cwd: f.outside }, 'absolute interpreter');
  assertBlocked(f, `cd ${f.root} && ./run.sh`, { cwd: f.outside }, 'cd then relative entry');
  assertBlocked(f, `cd ${f.root}/scripts && python3 run.py`, { cwd: f.outside }, 'cd into subdir');
  assertBlocked(f, `cd ${f.root} && python3 ./scripts/run.py`, {}, 'cd without trusted cwd');
  assertBlocked(f, `FOO=1 python3 ${f.script}`, {}, 'assignment prefix');
  assertBlocked(f, `env FOO=1 python3 ${f.script}`, {}, 'env wrapper');
  assertBlocked(f, `timeout 60 bash ${f.entry}`, {}, 'timeout wrapper');
  assertBlocked(f, `sudo -u deploy python3 ${f.script}`, {}, 'sudo wrapper with flag value');
  assertBlocked(f, `bash -c "cd ${f.root} && python3 scripts/run.py"`, { cwd: f.outside }, 'nested -c shell');
  assertBlocked(f, `echo $(python3 ${f.script})`, {}, 'command substitution');
  assertBlocked(f, `echo \`python3 ${f.script}\``, {}, 'backtick substitution');
  assertBlocked(f, `x=1; python3 ${f.script}`, {}, 'sequence');
  assertBlocked(f, `(cd ${f.root} && python3 scripts/run.py)`, { cwd: f.outside }, 'subshell');
  assertBlocked(f, `if true; then python3 ${f.script}; fi`, {}, 'if body');
});

test('LongTaskControlS13 distinguishes find/awk/sed execution behavior from plain viewing', async t => {
  const f = setup(t);
  assertBlocked(f, `find ${f.root} -name "*.py" -exec python3 {} \\;`, {}, 'find -exec');
  assertBlocked(f, `find . -name "*.py" -exec python3 {} +`, { cwd: f.root }, 'find -exec relative scope');
  assertBlocked(f, `find ${f.base} -name "*.py" -exec python3 {} \\;`, {}, 'find scope covering root');
  assertBlocked(f, `find ${f.base} -name "*.py" -exec python3 ${f.script} \\;`, {}, 'find -exec fixed script');
  assertBlocked(f, `find ${f.root} -type f -exec {} \\;`, {}, 'find -exec matched entry');
  assertBlocked(f, `find ${f.root} -name "*.sh" -execdir bash {} \\;`, {}, 'find -execdir');
  assertBlocked(f, `awk 'BEGIN{system("python3 ${f.script}")}' /dev/null`, {}, 'awk system');
  assertBlocked(f, `sed -n '1e python3 ${f.script}' ${path.join(f.root, 'data.txt')}`, {}, 'sed e command');
  assertBlocked(f, `bash < ${f.entry}`, {}, 'stdin redirect');
  assertBlocked(f, `cat ${f.entry} | bash`, {}, 'pipeline into interpreter');
  assertBlocked(f, `bash -c 'cat ${f.entry} | sh'`, {}, 'nested pipeline');
  assertAllowed(f, `find . -name "*.py"`, { cwd: f.root }, 'find without exec');
  assertAllowed(f, `awk '{print $1}' data.txt`, { cwd: f.root }, 'awk printing');
  assertAllowed(f, `sed 's/alpha/gamma/' data.txt`, { cwd: f.root }, 'sed substitution');
  assertAllowed(f, `sed -i s/alpha/gamma/ data.txt`, { cwd: f.root }, 'sed in-place write');
  assertAllowed(f, `cat ${f.entry} | grep report`, {}, 'pipeline of readers');
});

test('LongTaskControlS13 uses realpath for symlinks and does not misjudge inspections', async t => {
  const f = setup(t);
  assertBlocked(f, `python3 ${f.linkIn}`, {}, 'symlink into root');
  assertAllowed(f, `python3 ${f.linkOut}`, {}, 'symlink out of root');
  assertAllowed(f, `ls scripts/`, { cwd: f.root }, 'ls relative');
  assertAllowed(f, `cat scripts/run.py`, { cwd: f.root }, 'cat script');
  assertAllowed(f, `grep -n report scripts/run.py`, { cwd: f.root }, 'grep script');
  assertAllowed(f, `head -2 scripts/run.py && wc -l scripts/run.py`, { cwd: f.root }, 'compound readers');
  assertAllowed(f, `python3 -c "print(1)"`, { cwd: f.root }, 'inline code');
  assertAllowed(f, `git status`, { cwd: f.root }, 'unrelated program');
  assertAllowed(f, `echo scripts/run.py`, { cwd: f.root }, 'mention only');
  assertAllowed(f, `echo $HOME/run.py`, { cwd: f.root }, 'dynamic read mention');
});

test('LongTaskControlS13 reports explicit results when parsing or resolution is uncertain', async t => {
  const f = setup(t);
  const unclosed = analyzeShellCommand('echo "unclosed', { cwd: f.root });
  assert.equal(unclosed.status, 'indeterminate');
  assert.ok(unclosed.reason);
  const blocked = assertBlocked(f, `python3 "${f.script}`, { cwd: f.root }, 'unparsable but mentions root');
  assert.equal(blocked.match.basis, 'indeterminate');
  const dynamic = assertBlocked(f, 'python3 $SCRIPT_DIR/run.py', { cwd: f.root }, 'dynamic operand inside root');
  assert.equal(dynamic.match.basis, 'indeterminate');
  assert.ok(dynamic.analysis.accesses.some(access => access.certainty === 'unresolved'));
  const missing = assertBlocked(f, 'python3 scripts/missing.py', { cwd: f.root }, 'unresolved static operand inside root');
  assert.equal(missing.match.basis, 'indeterminate');
  assertAllowed(f, 'python3 $SCRIPT_DIR/run.py', { cwd: f.outside }, 'dynamic operand outside root');
  assertAllowed(f, 'python3 scripts/missing.py', { cwd: f.outside }, 'missing operand outside root');
  assertAllowed(f, 'echo "unclosed', { cwd: f.root }, 'unparsable without root mention');
});
