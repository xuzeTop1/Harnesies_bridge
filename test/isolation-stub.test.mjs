/**
 * 用桩适配器覆盖"写任务 → worktree 隔离 → diff 回收 → 超长截断"这条路径,**不消耗任何模型额度**。
 *
 * 为什么要有这个文件:这条链是交叉评审的输入端,但在此之前它**只能靠 LLMS_BRIDGE_LIVE=1 的真派发
 * 覆盖** —— 也就是说改坏了要花钱才知道。AGENTS.md §五 要求闸门改动必须有用例,而"截断的 diff 不能
 * 被当成完整 diff 去评审"正是一道安全闸门。
 *
 * DIFF_CAP 在模块加载时读一次,所以这里**先设环境变量再动态 import**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';

process.env.LLMS_BRIDGE_DIFF_CAP = '4000';

const { Scheduler } = await import('../src/scheduler.ts');

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

/** 桩 worker:不连任何模型,只在被给的 cwd(调度器已换成 worktree)里写一个文件。 */
function makeStubAdapter(seen, opts = {}) {
  const emitResult = opts.emitResult === true;
  return {
    id: 'stub',
    tier: 3,
    displayName: 'Stub worker (无模型)',
    supportedApprovals: ['read-only', 'workspace-write'],
    detect: async () => ({ available: true, version: 'stub-1' }),
    plan(spec) {
      const bytes = Number(process.env.STUB_BYTES ?? 10);
      return {
        command: process.execPath,
        args: [
          '-e',
          "require('fs').writeFileSync(process.argv[1], 'x'.repeat(Number(process.argv[2])) + '\\n');" +
            "console.log('SENTINEL_RESULT')",
          join(spec.cwd, 'gen.txt'),
          String(bytes),
        ],
      };
    },
    createRun(spec, taskId) {
      seen?.push(spec);
      return {
        parseLine(line) {
          // 模拟层级② 适配器的行为:把协议里的 result 行翻译成 `result` 事件。
          if (emitResult && line === 'SENTINEL_RESULT') {
            return [
              {
                taskId,
                seq: 0,
                harness: 'stub',
                tier: 3,
                type: 'result',
                at: Date.now(),
                text: 'stub done',
              },
            ];
          }
          return [];
        },
        finalize: () => ({ text: 'stub done' }),
      };
    },
  };
}

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-stub-'));
  git(dir, ['init', '-q']);
  await writeFile(join(dir, 'README.md'), '# seed\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return dir;
}

async function runWriteTask(bytes, seen, opts) {
  process.env.STUB_BYTES = String(bytes);
  const scheduler = new Scheduler([makeStubAdapter(seen, opts)]);
  const repo = await makeRepo();
  try {
    const ack = await scheduler.dispatch({
      taskId: crypto.randomUUID(),
      harness: 'stub',
      prompt: '写一个文件',
      cwd: repo,
      approval: 'workspace-write',
      budget: { maxWallMs: 60_000 },
      session: { mode: 'fresh' },
    });
    const result = await scheduler.collect(ack.taskId);
    return { result, repo, scheduler, taskId: ack.taskId };
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

test('小改动:diff 完整回收,diffTruncated 必须是 false', async () => {
  const { result } = await runWriteTask(20);
  assert.equal(result.status, 'ok', `桩任务应成功,reason=${result.reason}`);
  assert.equal(result.isolated, true, '写任务必须被 worktree 隔离');
  assert.ok(result.diff && result.diff.length > 0, '应回收出 diff');
  assert.equal(result.diffTruncated, false, '未超长时必须是明确的 false,不能是 undefined');
  assert.ok(!result.diff.includes('已截断'), '未截断的 diff 不该带截断标记');
});

test('超长改动:diff 被截断时,diffTruncated 必须为 true 且留下标记', async () => {
  const { result } = await runWriteTask(200_000);
  assert.equal(result.status, 'ok', `桩任务应成功,reason=${result.reason}`);
  assert.equal(result.isolated, true);
  assert.ok(result.diff, '应回收出 diff');
  assert.equal(result.diffTruncated, true, '超长必须给出机器可读的告警位');
  assert.ok(result.diff.includes('[diff 已截断]'), '文本里也要留人可读的标记');
  assert.ok(result.diff.length < 5000, `diff 应被上限压住,实际 ${result.diff.length}`);
});

test('只读任务不分配 worktree,因此 diffTruncated 保持 undefined', async () => {
  const scheduler = new Scheduler([makeStubAdapter([])]);
  const repo = await makeRepo();
  try {
    const ack = await scheduler.dispatch({
      taskId: crypto.randomUUID(),
      harness: 'stub',
      prompt: '只看不动',
      cwd: repo,
      approval: 'read-only',
      budget: { maxWallMs: 60_000 },
      session: { mode: 'fresh' },
    });
    const result = await scheduler.collect(ack.taskId);
    assert.equal(result.isolated, false, 'read-only 不该分配 worktree');
    assert.equal(result.diff, undefined, '没隔离就不该有 diff');
    assert.equal(result.diffTruncated, undefined, '无 diff 时该字段必须是 undefined 而非 false');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/**
 * 沙箱根在哪:adapter 拿到的 spec.cwd **必须**是 worktree,而不是用户的源仓库。
 *
 * 这条现在不影响任何已开放的档位(层级① 的写任务在派发阶段就被拒,层级②③ 的 worker 自己执行写),
 * 但 `acp.ts` 的 `confine()` 是拿 `spec.cwd` 当沙箱根的 —— 一旦 `ACP_WRITE_APPROVALS_WIRED` 翻成
 * true,如果哪天有人把 `createRun(runSpec)` 改回 `createRun(原 spec)`,worker 就会被允许
 * **直接写进用户的真实仓库**,而且所有现有用例照样全绿。所以在这里钉死。
 */
test('写任务交给 adapter 的 cwd 必须是 worktree,绝不能是源仓库', async () => {
  const seen = [];
  const { result, repo } = await runWriteTask(20, seen);
  assert.equal(seen.length, 1, `createRun 应被调用一次,实际 ${seen.length}`);
  const given = normalize(seen[0].cwd);
  const root = normalize(repo);
  assert.equal(given, normalize(result.worktreePath), 'adapter 看到的 cwd 应等于回传的 worktree');
  assert.notEqual(given, root, '绝不能把源仓库交给 worker 当工作目录');
  assert.ok(given.includes(join('.llms-bridge', 'worktrees')), `应在桥的 worktree 容器下:${given}`);
  assert.equal(existsSync(join(repo, 'gen.txt')), false, '源仓库里不该出现 worker 写的文件');
});

/**
 * 终态 `result` 事件必须**恰好一条**。
 * 2026-09-20 在 Qoder 里真调 codebuddy 时发现事件流里有两条内容完全相同的 result:
 * 适配器把协议的 result 行翻译了一条,调度器收尾又无条件补了一条。三个适配器都这样,
 * 所以**每个任务**都在重复 —— 主脑按 harness_events 增量跟踪时要把答案读两遍,还得猜是不是结束了两次。
 */
const countResults = (scheduler, taskId) =>
  scheduler.events(taskId).filter((e) => e.type === 'result').length;

test('适配器自己发 result 时,调度器不得再补一条', async () => {
  const { scheduler, taskId } = await runWriteTask(20, [], { emitResult: true });
  assert.equal(
    countResults(scheduler, taskId),
    1,
    `终态 result 应恰好一条,实际 ${countResults(scheduler, taskId)} 条`,
  );
});

test('适配器不发 result 时(层级③ 形态),调度器必须补上唯一那条', async () => {
  const { scheduler, taskId } = await runWriteTask(20, []);
  assert.equal(
    countResults(scheduler, taskId),
    1,
    `终态 result 应恰好一条,实际 ${countResults(scheduler, taskId)} 条`,
  );
});
