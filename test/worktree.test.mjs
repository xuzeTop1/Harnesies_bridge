/**
 * worktree 隔离测试(AGENTS.md 铁律三)。
 *
 * 全部在 os.tmpdir() 下的一次性 git 仓库里做,不碰本仓库、也不消耗模型额度。
 * 验证的不变量:
 *   1. 分配后源仓库必须干净(靠 .git/info/exclude,而不是改版本化的 .gitignore)
 *   2. worker 在 worktree 里写的文件不能出现在源仓库
 *   3. diff 能回收,且能反映 worker 的改动
 *   4. 回收后 worktree 摘干净,源仓库依然干净
 *   5. 非 git 目录要被识别出来(调度器据此拒绝写任务)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import {
  allocateWorktree,
  captureDiff,
  cleanBridgeWorktrees,
  isGitRepo,
  listWorktrees,
  removeWorktree,
} from '../src/worktree.ts';

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-wt-'));
  git(dir, ['init', '-q']);
  await writeFile(join(dir, 'README.md'), 'hello\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return dir;
}

test('isGitRepo 区分 git 仓库与普通目录', async () => {
  const repo = await makeRepo();
  const plain = await mkdtemp(join(tmpdir(), 'llms-bridge-plain-'));
  try {
    assert.equal(await isGitRepo(repo), true);
    assert.equal(await isGitRepo(plain), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  }
});

test('分配 worktree 后源仓库保持干净,容器目录被本地排除', async () => {
  const repo = await makeRepo();
  try {
    const wt = await allocateWorktree(repo, 'task-abc-123');
    assert.ok(existsSync(wt.path), 'worktree 目录应存在');
    assert.equal(wt.repoRoot, repo);

    assert.equal(git(repo, ['status', '--short']).trim(), '', '源仓库 status 必须为空');

    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.match(exclude, /^\.llms-bridge\/$/m, '容器目录应写进 .git/info/exclude');

    // 版本化的 .gitignore 不该被碰
    assert.equal(existsSync(join(repo, '.gitignore')), false, '不应创建 .gitignore');

    const list = git(repo, ['worktree', 'list']);
    assert.ok(list.includes(wt.path.replaceAll('\\', '/')) || list.includes(wt.path), 'worktree list 应包含新 worktree');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('worker 在 worktree 里写的文件不出现在源仓库,diff 能回收', async () => {
  const repo = await makeRepo();
  try {
    const wt = await allocateWorktree(repo, 'task-write-1');

    // 模拟 worker 的改动
    await writeFile(join(wt.path, 'PONG.txt'), 'pong\n', 'utf8');

    assert.equal(existsSync(join(repo, 'PONG.txt')), false, '源仓库里不能出现 worker 写的文件');
    assert.equal(git(repo, ['status', '--short']).trim(), '', '源仓库仍须干净');

    const { patch, stat: diffStat } = await captureDiff(wt.path);
    assert.match(diffStat, /PONG\.txt/, 'diff --stat 应提到新建的文件');
    assert.match(patch, /\+pong/, 'patch 应含新增内容');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('回收 worktree 后不留残留,源仓库依然干净', async () => {
  const repo = await makeRepo();
  try {
    const wt = await allocateWorktree(repo, 'task-cleanup-1');
    await removeWorktree(repo, wt.path);
    assert.equal(existsSync(wt.path), false, 'worktree 目录应被摘掉');
    assert.equal(git(repo, ['worktree', 'list']).trim().split('\n').length, 1, '只剩主工作区');
    assert.equal(git(repo, ['status', '--short']).trim(), '', '源仓库仍须干净');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('同一仓库可并行分配多个互不干扰的 worktree', async () => {
  const repo = await makeRepo();
  try {
    const a = await allocateWorktree(repo, 'parallel-a');
    const b = await allocateWorktree(repo, 'parallel-b');
    assert.notEqual(a.path, b.path, '两个 worker 必须拿到不同目录');

    await writeFile(join(a.path, 'from-a.txt'), 'a\n', 'utf8');
    await writeFile(join(b.path, 'from-b.txt'), 'b\n', 'utf8');

    assert.equal(existsSync(join(a.path, 'from-b.txt')), false, 'a 不该看到 b 的文件');
    assert.equal(existsSync(join(b.path, 'from-a.txt')), false, 'b 不该看到 a 的文件');
    assert.equal(git(repo, ['status', '--short']).trim(), '', '源仓库仍须干净');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('worktree 是 --detach,不污染分支列表', async () => {
  const repo = await makeRepo();
  try {
    await allocateWorktree(repo, 'task-detach');
    const branches = git(repo, ['branch', '--format=%(refname:short)']).trim().split('\n');
    assert.deepEqual(branches, ['master'], `不应新增分支,实际 ${branches.join(',')}`);
    assert.match(git(repo, ['worktree', 'list']), /detached HEAD/, 'worktree 应是 detached HEAD');
    // 确认 stat 已导入但未使用被 tsc 提醒前,这里用一下避免 lint 噪音
    assert.ok((await stat(repo)).isDirectory());
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('listWorktrees 能区分桥创建的与其它 worktree', async () => {
  const repo = await makeRepo();
  try {
    await allocateWorktree(repo, 'owned-1');
    await allocateWorktree(repo, 'owned-2');
    const all = await listWorktrees(repo);
    const bridge = all.filter((w) => w.ownedByBridge);
    const others = all.filter((w) => !w.ownedByBridge);
    assert.equal(bridge.length, 2, `应识别出 2 个桥 worktree,实际 ${JSON.stringify(all)}`);
    assert.equal(others.length, 1, '主工作区不该被算作桥 worktree');
    assert.ok(bridge.every((w) => w.detached), '桥 worktree 都是 detached');
    assert.ok(bridge.every((w) => w.head.length >= 8), '应能解析出 HEAD');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('listWorktrees 与 allocateWorktree 给出同一种路径写法', async () => {
  const repo = await makeRepo();
  try {
    const wt = await allocateWorktree(repo, 'path-form-1');
    const all = await listWorktrees(repo);
    const mine = all.filter((w) => w.ownedByBridge);
    assert.equal(mine.length, 1);
    // git 输出用正斜杠、allocateWorktree 返回平台形式(Windows 反斜杠);
    // 两边必须能归一化到同一个值,否则调用方一比较就不等。
    assert.equal(
      normalize(mine[0].path),
      normalize(wt.path),
      `同一目录不该有两种写法:${mine[0].path} vs ${wt.path}`,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('清理默认是 dry-run:不加 confirm 时一个都不删', async () => {
  const repo = await makeRepo();
  try {
    const wt = await allocateWorktree(repo, 'dry-run-1');
    const dry = await cleanBridgeWorktrees(repo, { confirm: false });
    assert.deepEqual(dry.removed, [], 'dry-run 不该删任何东西');
    assert.ok(existsSync(wt.path), 'worktree 应还在');
    assert.equal(dry.targets.length, 1, `应报出 1 个待删,实际 ${JSON.stringify(dry)}`);
    assert.ok(dry.targets[0].includes('dryrun1'), '待删清单应含该路径');
    assert.ok(dry.kept.every((p) => !p.includes('.llms-bridge')), 'kept 里不该出现桥 worktree');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('confirm 后只删桥创建的,主工作区必须留下', async () => {
  const repo = await makeRepo();
  try {
    const a = await allocateWorktree(repo, 'clean-a');
    const b = await allocateWorktree(repo, 'clean-b');
    const { removed } = await cleanBridgeWorktrees(repo, { confirm: true });

    assert.equal(removed.length, 2, `应删 2 个,实际 ${JSON.stringify(removed)}`);
    assert.equal(existsSync(a.path), false, 'a 应被删');
    assert.equal(existsSync(b.path), false, 'b 应被删');
    assert.ok(existsSync(repo), '主工作区必须还在');
    assert.equal(git(repo, ['status', '--short']).trim(), '', '源仓库仍须干净');
    assert.equal((await listWorktrees(repo)).length, 1, '只剩主工作区');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('--only 子串能限定只清一部分', async () => {
  const repo = await makeRepo();
  try {
    const keep = await allocateWorktree(repo, 'keepme-1');
    const drop = await allocateWorktree(repo, 'dropme-1');
    const { removed } = await cleanBridgeWorktrees(repo, { confirm: true, only: 'dropme' });
    assert.equal(removed.length, 1);
    assert.equal(existsSync(drop.path), false, 'dropme 应被删');
    assert.equal(existsSync(keep.path), true, 'keepme 不该被动');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});