/**
 * 事件流落盘(2026-10-05 新增)。
 *
 * 为什么单独测:面板与"桥重启后的回放"都只能读盘,而盘上的东西有两个必须钉住的性质 ——
 *  ① 不许有明文凭证:落盘比交回主脑更难撤回(铁律一不设例外),所以写入点自己就得脱敏,
 *     不能只信"调用方已经脱过";
 *  ② 截断必须可见:一个长任务能出上千条事件、一条 tool_result 能夹几十万字节,
 *     不封顶就无界增长,封顶又不说 = 静默丢东西(本项目最忌)。
 *
 * 两个上限在本文件里都设得很小(env 在 import 前设),否则用例得先造出几兆事件。
 * 零模型额度:全是桩 worker。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'llms-bridge-evlog-home-'));
process.env.LLMS_BRIDGE_HOME = home;
process.env.LLMS_BRIDGE_EVENT_FIELD_CAP = '50';
process.env.LLMS_BRIDGE_EVENT_BYTES_CAP = '400';

const { appendEvent, eventLogPath, readEventLog } = await import('../src/journal.ts');
const { Scheduler } = await import('../src/scheduler.ts');

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-evlog-repo-'));
  git(dir, ['init', '-q']);
  await writeFile(join(dir, 'seed.txt'), 'seed\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return dir;
}

const specFor = (cwd, taskId, extra = {}) => ({
  taskId,
  harness: 'stub',
  prompt: 'P',
  cwd,
  approval: 'read-only',
  budget: { maxWallMs: 30_000 },
  session: { mode: 'fresh' },
  ...extra,
});

/** 桩 worker:把 stdout 的每行都翻译成一个事件,便于造出"很多条"而不必真跑模型。 */
function makeStub({ stdout = 'EVT0\nEVT1', onLine = null } = {}) {
  return {
    id: 'stub',
    tier: 3,
    displayName: 'Stub (无模型)',
    supportedApprovals: ['read-only', 'workspace-write'],
    detect: async () => ({ available: true, version: 'stub-1' }),
    plan: () => ({ command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(stdout)})`] }),
    createRun(spec, taskId) {
      let n = 0;
      return {
        parseLine(line) {
          const seq = n++;
          if (onLine) return onLine(line, seq, taskId);
          return [{ taskId, seq, harness: 'stub', tier: 3, at: Date.now(), type: 'tool_call', text: line }];
        },
        finalize: () => ({ text: 'DONE' }),
      };
    },
  };
}

async function linesOf(cwd, taskId) {
  const file = eventLogPath(cwd, taskId);
  if (!existsSync(file)) return null;
  return (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim().length > 0);
}

test('每个事件落一行,顺序与类型都在', async () => {
  const repo = await makeRepo();
  try {
    const scheduler = new Scheduler([makeStub({ stdout: 'EVT0\nEVT1\nEVT2\n' })]);
    await scheduler.dispatch(specFor(repo, 'e-order'));
    await scheduler.idle();

    const lines = await linesOf(repo, 'e-order');
    assert.ok(lines, '事件流文件必须存在');
    const parsed = lines.map((l) => JSON.parse(l));
    const kinds = parsed.map((p) => p.type);
    assert.deepEqual(kinds.slice(0, 3), ['tool_call', 'tool_call', 'tool_call']);
    assert.ok(kinds.includes('result'), '终态 result 也要落盘,否则面板看不到它答了什么');
    assert.deepEqual(parsed.map((p) => p.seq).slice(0, 3), [0, 1, 2], 'seq 必须保留,回放靠它排序');
    assert.equal(parsed[0].harness, undefined, 'harness 不每行重复(记录里已有),省下的都是盘上字节');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('事件落盘的文件不许出现在 git status 里', async () => {
  const repo = await makeRepo();
  try {
    const scheduler = new Scheduler([makeStub({ stdout: 'EVT0\n' })]);
    await scheduler.dispatch(specFor(repo, 'e-clean'));
    await scheduler.idle();
    assert.ok(existsSync(eventLogPath(repo, 'e-clean')));
    assert.equal(git(repo, ['status', '--porcelain']).trim(), '', `事件流污染了用户的工作区:${git(repo, ['status', '--porcelain'])}`);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('raw 里的凭证字段不许以明文落盘', async () => {
  const repo = await makeRepo();
  try {
    const scheduler = new Scheduler([
      makeStub({
        stdout: 'EVT0\n',
        onLine: (line, seq, taskId) => [
          {
            taskId,
            seq,
            harness: 'stub',
            tier: 3,
            at: Date.now(),
            type: 'status',
            text: line,
            raw: { apiKey: 'LEAK-MUST-NOT-HIT-DISK', token_count: 42 },
          },
        ],
      }),
    ]);
    await scheduler.dispatch(specFor(repo, 'e-redact'));
    await scheduler.idle();

    const body = await readFile(eventLogPath(repo, 'e-redact'), 'utf8');
    assert.doesNotMatch(body, /LEAK-MUST-NOT-HIT-DISK/, '落盘比交回主脑更难撤回,明文 key 一个都不许留在盘上');
    assert.match(body, /\[已隐去:apiKey\]/);
    // 用量字段必须活着:把它一起抹掉会让预算闸门变成瞎子(见 src/redact.ts)。
    assert.match(body, /token_count/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('直写路径也自己脱敏:不许只信调用方脱过敏', async () => {
  const repo = await makeRepo();
  try {
    appendEvent(repo, {
      taskId: 'e-direct',
      seq: 0,
      harness: 'stub',
      tier: 3,
      type: 'tool_result',
      at: Date.now(),
      raw: { authorization: 'Bearer SUPERSECRET' },
    });
    const body = await readFile(eventLogPath(repo, 'e-direct'), 'utf8');
    assert.doesNotMatch(body, /SUPERSECRET/);
    assert.match(body, /\[已隐去:authorization\]/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('超长字段截断并标记,不静默丢内容', async () => {
  const repo = await makeRepo();
  try {
    const scheduler = new Scheduler([
      makeStub({
        stdout: 'EVT0\n',
        onLine: (line, seq, taskId) => [
          { taskId, seq, harness: 'stub', tier: 3, at: Date.now(), type: 'tool_result', text: 'R'.repeat(500) },
        ],
      }),
    ]);
    await scheduler.dispatch(specFor(repo, 'e-clip'));
    await scheduler.idle();

    const read = readEventLog(repo, 'e-clip');
    const cut = read.lines.filter((l) => l.type === 'tool_result');
    assert.equal(cut.length, 1);
    assert.equal(cut[0].clipped, true, '切过就必须标记,否则读日志的人会以为工具只返回了 50 字符');
    assert.ok(cut[0].text.length < 500, '必须真的少');
    assert.match(cut[0].text, /事件字段已截断/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('撞到每任务字节上限后停写,并留一条可见的标记', async () => {
  const repo = await makeRepo();
  try {
    const many = Array.from({ length: 40 }, (_, i) => `EVT${i}`).join('\n') + '\n';
    const scheduler = new Scheduler([makeStub({ stdout: many })]);
    await scheduler.dispatch(specFor(repo, 'e-cap'));
    await scheduler.idle();

    const read = readEventLog(repo, 'e-cap');
    assert.ok(read.total < 41, `上限是 400 字节,不该把 40 条事件加终态都写进来(实际 ${read.total} 行)`);
    assert.equal(read.capped, true, '撞上限必须留下标记行,不能让"少了几条"变成静默的');
    const marker = read.lines.find((l) => l.marker === 'bytes-cap');
    assert.match(marker.text, /字节上限/);
    assert.equal(read.lines.filter((l) => l.marker === 'bytes-cap').length, 1, '标记只写一条,别每行都喊');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('残行跳过并计数:崩在写一半不该让整份事件流读不出来', async () => {
  const repo = await makeRepo();
  try {
    const scheduler = new Scheduler([makeStub({ stdout: 'EVT0\n' })]);
    await scheduler.dispatch(specFor(repo, 'e-torn'));
    await scheduler.idle();

    const file = eventLogPath(repo, 'e-torn');
    await writeFile(file, (await readFile(file, 'utf8')) + '{"seq":9,"type":"tool_cal', 'utf8');
    const read = readEventLog(repo, 'e-torn');
    assert.ok(read.total >= 1, '前面完好的行仍要读得出来');
    assert.equal(read.malformed, 1, '坏行要报数,不能悄悄吞');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('worker 的改动以 diff 事件落盘(面板据此回答"它到底改了什么")', async () => {
  const repo = await makeRepo();
  try {
    const writer = {
      ...makeStub({ stdout: 'EVT0\n' }),
      supportedApprovals: ['workspace-write'],
      plan: () => ({
        command: process.execPath,
        args: ['-e', "require('node:fs').writeFileSync('WORKER_CHANGE.txt','changed\\n')"],
      }),
    };
    const scheduler = new Scheduler([writer]);
    const ack = await scheduler.dispatch(
      specFor(repo, 'e-diff', { approval: 'workspace-write', budget: { maxWallMs: 60_000 } }),
    );
    await scheduler.idle();
    assert.equal(ack.isolated, true, '写档应自动分配 worktree(铁律三)');

    // 隔离任务的产物落在 worktree 里,与记录同目录。
    const read = readEventLog(ack.worktreePath, 'e-diff');
    const diffEvent = read.lines.find((l) => l.type === 'diff');
    assert.ok(diffEvent, `事件流里应有 diff 一条:${JSON.stringify(read.lines)}`);
    assert.match(diffEvent.text, /WORKER_CHANGE\.txt/, 'diff 的 stat 说清了动了哪些文件');
    assert.equal(diffEvent.clipped, true, 'patch 超出逐字段上限时要截断并标记,完整的那份留在 worktree 里');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
