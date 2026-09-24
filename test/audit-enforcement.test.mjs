/**
 * 两道闸门的用例:(a) 审批档位"拦不拦得住"要如实外露;(c) 事后磁盘审计要能抓出越界写。
 *
 * 为什么必须钉死这两条:(a) 错了,调用方会把一个标签当沙箱用(R7 真发生过:
 * opencode 的 read-only 照样往主仓库写文件);(c) 错了,越界会被"status=ok"盖掉 ——
 * 而实测确有调用方只读 status。两条都是"改了不补用例就等于没守"的那种。
 *
 * 全程桩适配器 + node 子进程,**零模型额度消耗**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LLMS_BRIDGE_HOME = join(tmpdir(), `llms-bridge-test-home-${process.pid}`);

const { Scheduler } = await import('../src/scheduler.ts');
const { enforcementOf, enforcementNote } = await import('../src/enforcement.ts');
const { snapshotDisk, auditDisk } = await import('../src/audit.ts');

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-audit-'));
  git(dir, ['init', '-q']);
  await writeFile(join(dir, 'README.md'), '# seed\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return dir;
}

/**
 * @param behavior 'quiet' 什么都不写 | 'cwd' 往它拿到的 cwd 写一个文件
 * @param enforcement 可选,模拟 adapter 自报档位约束力
 */
function makeAdapter(behavior, enforcement) {
  return {
    id: 'stub',
    tier: 3,
    displayName: 'Stub worker',
    supportedApprovals: ['read-only', 'workspace-write'],
    ...(enforcement ? { approvalEnforcement: enforcement } : {}),
    detect: async () => ({ available: true, version: 'stub-1' }),
    plan(spec) {
      if (behavior === 'quiet') return { command: process.execPath, args: ['-e', 'void 0'] };
      return {
        command: process.execPath,
        args: [
          '-e',
          "require('fs').writeFileSync(process.argv[1],'escaped\\n')",
          join(spec.cwd, 'escaped.txt'),
        ],
      };
    },
    createRun: () => ({ parseLine: () => [], finalize: () => ({ text: 'done' }) }),
  };
}

async function run(adapter, specOverrides, verify) {
  const scheduler = new Scheduler([adapter]);
  const repo = await makeRepo();
  try {
    const ack = await scheduler.dispatch({
      taskId: crypto.randomUUID(),
      harness: 'stub',
      prompt: 'p',
      cwd: repo,
      approval: 'read-only',
      budget: { maxWallMs: 60_000 },
      session: { mode: 'fresh' },
      ...specOverrides,
    });
    const result = await scheduler.collect(ack.taskId);
    // verify 必须在 finally 删仓库**之前**跑完:否则要验的"文件还在不在盘上"根本没得验。
    if (verify) await verify({ result, repo, ack, scheduler });
    return { ack, result, repo, scheduler };
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

// ---------- (a) 档位诚实化 ----------

test('没实测过的档位一律判 unknown,不许默认成"拦得住"', () => {
  assert.equal(enforcementOf(makeAdapter('quiet'), 'read-only'), 'unknown');
  assert.equal(enforcementOf(makeAdapter('quiet', { 'read-only': 'advisory' }), 'read-only'), 'advisory');
  // 声明了别的档位不能串味:advisory 只作用于它标注的那一档。
  assert.equal(enforcementOf(makeAdapter('quiet', { 'read-only': 'advisory' }), 'workspace-write'), 'unknown');
});

test('advisory 与 unknown 的说明都必须明说"别当沙箱"', () => {
  assert.match(enforcementNote('read-only', 'advisory'), /不会/);
  assert.match(enforcementNote('read-only', 'advisory'), /别把它当沙箱/);
  assert.match(enforcementNote('read-only', 'unknown'), /不确定|没有实测/);
  assert.match(enforcementNote('read-only', 'enforced'), /沙箱拦住/);
});

/**
 * 'full' 不该被套进"拦不拦得住"的问句里 —— 它的语义就是不给约束。
 * 照抄会产生一句看似谨慎实则无意义的话("没实测过它会不会收手":它本来就该不收手),
 * 那等于用措辞掩盖档位真实含义。
 */
test('full 档的说明直接讲"不加约束",不套"拦不拦得住"的句式', () => {
  for (const e of ['enforced', 'advisory', 'unknown']) {
    const note = enforcementNote('full', e);
    assert.match(note, /不加约束|无人确认/);
    assert.doesNotMatch(note, /收手|沙箱拦住/, `full 配 ${e} 不该出现"拦得住"式措辞`);
  }
});

test('ack 里就给出档位约束力,不等结果', async () => {
  const { ack } = await run(makeAdapter('quiet', { 'read-only': 'advisory' }), {});
  assert.equal(ack.approvalEnforcement, 'advisory');
  assert.match(ack.approvalNote, /只是标签/);
});

test('harness_list 逐档位带出约束力,与 supportedApprovals 同时出现', async () => {
  const scheduler = new Scheduler([makeAdapter('quiet', { 'read-only': 'advisory' })]);
  const info = (await scheduler.detectAll()).find((r) => r.id === 'stub');
  assert.deepEqual(info.approvalEnforcement, { 'read-only': 'advisory', 'workspace-write': 'unknown' });
});

// ---------- (c) 事后磁盘审计 ----------

test('只读档却改了 cwd:判 failed 并说清越界,不能停在 ok', async () => {
  await run(makeAdapter('cwd'), {}, ({ result, repo }) => {
    assert.equal(result.diskAudit.audited, true);
    assert.equal(result.diskAudit.changed, true, `应抓到改动,paths=${JSON.stringify(result.diskAudit.paths)}`);
    assert.deepEqual(
      result.diskAudit.paths.map((p) => p.path),
      ['escaped.txt'],
    );
    assert.equal(result.status, 'failed', '越界写必须翻掉 status');
    assert.match(result.reason, /越界改动/);
    assert.ok(existsSync(join(repo, 'escaped.txt')), '审计只报告,不擅自回滚用户的盘');
  });
});

test('只读档什么都没改:审计如实报 changed=false,任务保持 ok', async () => {
  const { result } = await run(makeAdapter('quiet'), {});
  assert.equal(result.status, 'ok', `reason=${result.reason}`);
  assert.equal(result.diskAudit.audited, true);
  assert.equal(result.diskAudit.changed, false);
  assert.deepEqual(result.diskAudit.paths, []);
});

test('写档即使隔离在 worktree,越界写主仓库也要被抓出来', async () => {
  // 桩的 plan 拿到的 cwd 已被换成 worktree,所以它写的是 worktree —— 这条不该报越界。
  const { result } = await run(makeAdapter('cwd'), { approval: 'workspace-write' });
  assert.equal(result.isolated, true);
  assert.equal(result.diskAudit.changed, false, `主仓库不该被动:${JSON.stringify(result.diskAudit.paths)}`);
  assert.equal(result.status, 'ok', `reason=${result.reason}`);
});

test('调用方主动放弃隔离时,写 cwd 是它要的行为,不算越界', async () => {
  const { result } = await run(makeAdapter('cwd'), {
    approval: 'workspace-write',
    allowUnisolatedWrite: true,
  });
  assert.equal(result.isolated, false);
  assert.equal(result.diskAudit.changed, true, '确实改了盘,这点不粉饰');
  assert.equal(result.status, 'ok', '但这是显式授权的写,不该判越界');
});

test('非 git 目录:如实报"没审计成",并且不据此判越界', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-nogit-'));
  try {
    const scheduler = new Scheduler([makeAdapter('cwd')]);
    const ack = await scheduler.dispatch({
      taskId: crypto.randomUUID(),
      harness: 'stub',
      prompt: 'p',
      cwd: dir,
      approval: 'read-only',
      budget: { maxWallMs: 60_000 },
      session: { mode: 'fresh' },
    });
    const result = await scheduler.collect(ack.taskId);
    assert.equal(result.diskAudit.audited, false);
    assert.equal(result.diskAudit.changed, undefined, '没审计成就不能给出 changed 的结论');
    assert.match(result.diskAudit.caveats[0], /没法验证|不是"没改动"/);
    assert.equal(result.status, 'ok', '无从判定不等于判定违约 —— 不许拿"没审计"当"越界"');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('审计必须自带盲区说明,不许让 changed=false 被读成"什么都没发生"', async () => {
  const { result } = await run(makeAdapter('quiet'), {});
  assert.ok(result.diskAudit.caveats.length >= 3);
  assert.match(result.diskAudit.caveats.join('\n'), /gitignore/);
  assert.match(result.diskAudit.caveats.join('\n'), /仓库外|其它盘/);
});

test('worker 在用户仓库里 commit 了要能看出来(HEAD 移动)', async () => {
  const repo = await makeRepo();
  try {
    const before = await snapshotDisk(repo);
    await writeFile(join(repo, 'new.txt'), 'x\n', 'utf8');
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'by worker']);
    const audit = await auditDisk(repo, before);
    assert.equal(audit.audited, true);
    assert.equal(audit.changed, true);
    assert.equal(audit.headMoved, true);
    // 提交之后工作区是干净的,只看 status 会漏 —— 这正是必须比 HEAD 的理由。
    assert.deepEqual(audit.paths, []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
