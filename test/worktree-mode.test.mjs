/**
 * worktree 形态由调用方选:复用已有 worktree / 放弃隔离 / 什么都不给(新建)。
 *
 * 为什么单独测:`reuseWorktreePath` 是"复用别人建好的工作区"的入口,验不严就等于开后门 ——
 * 随手传个主工作区路径就能让 worker 直接改源仓库,却还标着 `isolated: true`。
 * 这类"标记与实际不符"正是 AGENTS.md 铁律三点名不许发生的事,必须逐条钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LLMS_BRIDGE_HOME = join(tmpdir(), `llms-bridge-test-home-${process.pid}`);

const { Scheduler } = await import('../src/scheduler.ts');

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

/** 桩 worker:把"我在哪个目录跑的"写进 stdout,cwd 由 plan() 从 spec 拿到。 */
function makeStub(seen) {
  return {
    id: 'stub',
    tier: 3,
    displayName: 'Stub',
    supportedApprovals: ['read-only', 'workspace-write'],
    detect: async () => ({ available: true, version: 'stub-1' }),
    plan: (spec) => {
      seen.push(spec);
      return {
        command: process.execPath,
        args: ['-e', "console.log(require('fs').readFileSync('marker.txt','utf8'))"],
      };
    },
    createRun: (spec, taskId) => ({
      parseLine: () => [],
      finalize: () => ({ text: 'ok' }),
    }),
  };
}

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-wtmode-'));
  git(dir, ['init', '-q']);
  await writeFile(join(dir, 'marker.txt'), 'MAIN\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return dir;
}

const base = (cwd, taskId, extra = {}) => ({
  taskId,
  harness: 'stub',
  prompt: 'x',
  cwd,
  approval: 'workspace-write',
  budget: { maxWallMs: 30_000 },
  session: { mode: 'fresh' },
  ...extra,
});

test('什么都不给:git 仓库里写任务仍是"新建 worktree + isolated:true"(默认不变)', async () => {
  const repo = await makeRepo();
  try {
    const seen = [];
    const scheduler = new Scheduler([makeStub(seen)]);
    const ack = await scheduler.dispatch(base(repo, 'wt-auto'));
    await scheduler.idle();

    assert.equal(ack.isolated, true);
    assert.match(ack.worktreePath ?? '', /\.llms-bridge[\\/]worktrees[\\/]wtauto$/);
    assert.notEqual(seen[0].cwd, repo, 'worker 的 cwd 必须被换成 worktree');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('allowUnisolatedWrite 在 git 仓库里也生效:直接写 cwd,且标 isolated:false', async () => {
  const repo = await makeRepo();
  try {
    const seen = [];
    const scheduler = new Scheduler([makeStub(seen)]);
    const ack = await scheduler.dispatch(base(repo, 'wt-none', { allowUnisolatedWrite: true }));
    await scheduler.idle();

    assert.equal(ack.isolated, false, '不许把"没隔离"混成"隔离了"');
    assert.equal(ack.worktreePath, undefined);
    assert.equal(seen[0].cwd, repo, 'worker 应在源仓库里跑(这是调用方显式要的)');
    assert.equal(existsSync(join(repo, '.llms-bridge', 'worktrees')), false, '不该顺手建 worktree');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('reuse:复用同仓库的独立 worktree,worker 的 cwd 就是它', async () => {
  const repo = await makeRepo();
  try {
    const wt = join(repo, '.llms-bridge', 'worktrees', 'shared');
    git(repo, ['worktree', 'add', '--detach', wt, 'HEAD']);
    await writeFile(join(wt, 'marker.txt'), 'WORKTREE\n', 'utf8');

    const seen = [];
    const scheduler = new Scheduler([makeStub(seen)]);
    const ack = await scheduler.dispatch(base(repo, 'wt-reuse', { reuseWorktreePath: wt }));
    await scheduler.idle();

    assert.equal(ack.isolated, true);
    assert.equal(ack.worktreePath, wt);
    assert.equal(seen[0].cwd, wt, 'worker 必须跑在那个已有 worktree 里,而不是嵌套一个新的一层');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('reuse 不许拿主工作区冒充:那是"直接改源仓库却标隔离"的后门', async () => {
  const repo = await makeRepo();
  try {
    const seen = [];
    const scheduler = new Scheduler([makeStub(seen)]);
    await assert.rejects(
      () => scheduler.dispatch(base(repo, 'wt-main', { reuseWorktreePath: repo })),
      /主工作区/,
    );
    assert.equal(seen.length, 0, '拒绝必须发生在启动之前');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('reuse 不许跨仓库:别的仓库的 worktree 也不算隔离', async () => {
  const repoA = await makeRepo();
  const repoB = await makeRepo();
  try {
    const wtB = join(repoB, '.llms-bridge', 'worktrees', 'other');
    git(repoB, ['worktree', 'add', '--detach', wtB, 'HEAD']);

    const seen = [];
    const scheduler = new Scheduler([makeStub(seen)]);
    await assert.rejects(
      () => scheduler.dispatch(base(repoA, 'wt-cross', { reuseWorktreePath: wtB })),
      /另一个仓库/,
    );
    assert.equal(seen.length, 0);
  } finally {
    await rm(repoA, { recursive: true, force: true });
    await rm(repoB, { recursive: true, force: true });
  }
});

test('reuse 指向不存在的目录:当场拒,不静默降级成别的形态', async () => {
  const repo = await makeRepo();
  try {
    const scheduler = new Scheduler([makeStub([])]);
    await assert.rejects(
      () => scheduler.dispatch(base(repo, 'wt-miss', { reuseWorktreePath: join(repo, 'nope') })),
      /不是已存在的目录/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('只读档传 reuse:明确拒绝并指路,不许静默忽略', async () => {
  const repo = await makeRepo();
  try {
    const wt = join(repo, '.llms-bridge', 'worktrees', 'shared-ro');
    git(repo, ['worktree', 'add', '--detach', wt, 'HEAD']);
    await writeFile(join(wt, 'marker.txt'), 'UNCOMMITTED\n', 'utf8'); // 既有未提交改动

    const seen = [];
    const scheduler = new Scheduler([makeStub(seen)]);
    await assert.rejects(
      () => scheduler.dispatch(base(repo, 'wt-reuse-ro', { approval: 'read-only', reuseWorktreePath: wt })),
      /不支持 reuseWorktreePath[\s\S]*直接把 cwd 设成那个路径/,
      '要拒绝,而且要告诉调用方该怎么做',
    );
    assert.equal(seen.length, 0, '拒绝必须发生在启动之前');

    // 别人工作区里那份未提交改动必须原封不动 —— 这条路径上根本不该有 git add。
    assert.equal(git(wt, ['diff', '--cached', '--name-only']).trim(), '');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('只读档想读某个 worktree 的快照:照文档指路,cwd 一指就通', async () => {
  const repo = await makeRepo();
  try {
    const wt = join(repo, '.llms-bridge', 'worktrees', 'shared-ro2');
    git(repo, ['worktree', 'add', '--detach', wt, 'HEAD']);
    await writeFile(join(wt, 'marker.txt'), 'SNAPSHOT\n', 'utf8');

    const seen = [];
    const scheduler = new Scheduler([makeStub(seen)]);
    const ack = await scheduler.dispatch(base(repo, 'ro-via-cwd', { cwd: wt, approval: 'read-only' }));
    await scheduler.idle();

    assert.equal(seen[0].cwd, wt, '只读档 cwd 原样透传,worker 读到的就是那份快照');
    assert.equal(ack.isolated, false, '只读档不分配 worktree,不许标成隔离');
    assert.equal(git(wt, ['diff', '--cached', '--name-only']).trim(), '', '只读任务不该动 index');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
