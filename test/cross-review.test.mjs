/**
 * 交叉评审流程的真实端到端验证(PLAN.md M4)。
 *
 * **会消耗模型额度**的那条默认跳过;要跑:`LLMS_BRIDGE_LIVE=1 npm run test:live`。
 *
 * 这里跑的是**真·跨厂商**:producer = codex,reviewer = codebuddy(腾讯,复用 WorkBuddy 登录态)。
 * 两家都必须先 detect 通过,且都必须支持写档位 —— 生产者要先落出 diff 才有东西可评。
 *
 * 不自动挑选 harness 的原因(实测教训):detect() 只看得出二进制、协议、鉴权三件事,
 * 看不出"能跑但产出为空"(mimo:end_turn 却零文本零 usage)、"能跑但账号欠费"(claude 402)、
 * 也看不出"档位支持到哪"(层级① 现在只支持 read-only)。自动挑选必然会挑错 ——
 * 先前那个过滤器就选中了 mimo,随即被写档位拒绝。
 *
 * 注意:本文件是 .mjs(纯 JS),不能出现 TS 语法 —— 类型标注、`import type`、非空断言 `!`
 * 都会让整份文件加载即失败。之前就是这么栽的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scheduler } from '../src/scheduler.ts';
import { createAdapters } from '../src/registry.ts';

const live = process.env.LLMS_BRIDGE_LIVE === '1';

// 账本索引默认写在 ~/.llms-bridge/,跑测试不该碰用户真实目录(journal.ts 惰性读这个变量)。
process.env.LLMS_BRIDGE_HOME = join(tmpdir(), `llms-bridge-test-home-${process.pid}`);

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

async function makeBuggyRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-review-'));
  git(dir, ['init', '-q']);
  await writeFile(
    join(dir, 'calc.py'),
    'def add(a, b):\n    # 故意写错:应为 a + b\n    return a - b\n',
    'utf8',
  );
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return dir;
}

async function dispatchAndWait(scheduler, spec) {
  const ack = await scheduler.dispatch({
    taskId: crypto.randomUUID(),
    harness: spec.harness,
    prompt: spec.prompt,
    cwd: spec.cwd,
    approval: spec.approval,
    budget: { maxWallMs: spec.maxWallMs },
    session: { mode: 'fresh' },
  });
  return scheduler.collect(ack.taskId);
}

// —— 不需要额度:先确认评审要用的基线与隔离边界 ——

test('评审基线:测试仓库初始是带 bug 版本,且工作区干净', async () => {
  const repo = await makeBuggyRepo();
  try {
    assert.equal(git(repo, ['status', '--short']).trim(), '');
    assert.match(await readFile(join(repo, 'calc.py'), 'utf8'), /return a - b/);
    // 评审方拿到的 cwd 是源仓库(而非生产方的 worktree),所以基线必须仍是错的
    assert.equal(git(repo, ['branch', '--format=%(refname:short)']).trim(), 'master');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('源仓库里不该出现生产方在 worktree 里写的文件', async () => {
  const repo = await makeBuggyRepo();
  try {
    const status = git(repo, ['status', '--short']).trim();
    assert.ok(!status.includes('calc.py'), `源仓库不该有未跟踪的 calc.py: ${status}`);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// —— 需要额度:真·跨厂商完整流程 ——

test(
  '跨厂商交叉评审:codex 生产 → codebuddy(腾讯)评审',
  { skip: live ? false : '设 LLMS_BRIDGE_LIVE=1 才跑' },
  async () => {
    const scheduler = new Scheduler(createAdapters());
    const repo = await makeBuggyRepo();
    try {
      const report = await scheduler.detectAll();

      const need = (id) => {
        const h = report.find((r) => r.id === id);
        assert.ok(h && h.available, `${id} 应可用,实际: ${JSON.stringify(h)}`);
        assert.ok(
          h.supportedApprovals.includes('workspace-write'),
          `${id} 必须支持写档位(生产者要先落出 diff)`,
        );
        return h;
      };
      need('codex');
      need('codebuddy');

      // ① 生产:codex 修掉 calc.py 的 bug(写任务 → 必然走 worktree 隔离)
      const produced = await dispatchAndWait(scheduler, {
        harness: 'codex',
        prompt:
          'calc.py 里的 add() 有 bug,它返回的是差而不是和。请修正,使 add 返回两数之和。改完简要说明你改了什么。',
        cwd: repo,
        approval: 'workspace-write',
        maxWallMs: 240_000,
      });
      assert.equal(produced.status, 'ok', `生产任务应成功,实际 reason=${produced.reason}`);
      assert.equal(produced.isolated, true, '写任务必须被 worktree 隔离');
      assert.ok(produced.diff && produced.diff.length > 0, '应回收出非空 diff');
      assert.ok(produced.worktreePath, '隔离任务应回传 worktree 路径');
      assert.equal(
        git(repo, ['status', '--short']).trim(),
        '',
        '源仓库必须保持干净(改动只在 worktree 里)',
      );

      // ② 评审:把 diff 原文交给**另一家**,read-only
      const reviewPrompt = [
        '下面是另一个模型对 calc.py 的改动 diff。',
        '请只指出真实问题(正确性、边界、可读性),不要复述改动。',
        '最后必须明确回答是否 LGTM。',
        '',
        produced.diff,
      ].join('\n');

      const reviewed = await dispatchAndWait(scheduler, {
        harness: 'codebuddy',
        prompt: reviewPrompt,
        cwd: repo,
        approval: 'read-only',
        maxWallMs: 240_000,
      });
      assert.equal(reviewed.status, 'ok', `评审任务应成功,实际 reason=${reviewed.reason}`);
      assert.equal(reviewed.harness, 'codebuddy', '评审方必须是另一家厂商');
      assert.equal(reviewed.isolated, false, 'read-only 不该分配 worktree');
      assert.ok(reviewed.text && reviewed.text.trim().length > 0, '应给出评审结论文本');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  },
);

// —— 三家投票:同一个 diff,两家独立评审 ——
//
// 为什么值得多花这一家:两家评审"意见一致"可能只是巧合或同温层;三家能把**附和**照出来。
// 所以这里**不断言**它们同意 —— 一致与否是要观察的结果,不是通过条件。
// 一次生产 + 两路**并发**评审 = 3 个模型回合,墙钟时间约等于最慢的那一路。
test(
  '三家投票:codex 生产 → codebuddy(腾讯)+ claude(deepseek)并发独立评审',
  { skip: live ? false : '设 LLMS_BRIDGE_LIVE=1 才跑' },
  async () => {
    const scheduler = new Scheduler(createAdapters());
    const repo = await makeBuggyRepo();
    try {
      const report = await scheduler.detectAll();
      for (const id of ['codex', 'codebuddy', 'claude']) {
        const h = report.find((r) => r.id === id);
        assert.ok(h && h.available, `${id} 应可用,实际: ${JSON.stringify(h)}`);
      }

      const produced = await dispatchAndWait(scheduler, {
        harness: 'codex',
        prompt:
          'calc.py 里的 add() 有 bug,它返回的是差而不是和。请修正,使 add 返回两数之和。改完简要说明你改了什么。',
        cwd: repo,
        approval: 'workspace-write',
        maxWallMs: 240_000,
      });
      assert.equal(produced.status, 'ok', `生产任务应成功,实际 reason=${produced.reason}`);
      assert.ok(produced.diff && produced.diff.length > 0, '应回收出非空 diff');

      const reviewPrompt = [
        '下面是另一个模型对 calc.py 的改动 diff。',
        '请只指出真实问题(正确性、边界、可读性),不要复述改动。',
        '最后必须明确回答是否 LGTM。',
        '',
        produced.diff,
      ].join('\n');

      const reviews = await Promise.all(
        ['codebuddy', 'claude'].map((harness) =>
          dispatchAndWait(scheduler, {
            harness,
            prompt: reviewPrompt,
            cwd: repo,
            approval: 'read-only',
            // 240s 实测**不够**:2026-09-19 13:52 那次两路并发评审有一路直接 `status: timeout`
            // (并发抢资源把单路耗时拉长),整条用例白跑、评审原文也没能落盘。
            // 串行跑单路接近 240s,并发就必须留余量 —— 这是实测出来的数,不是拍的。
            maxWallMs: 480_000,
          }),
        ),
      );

      for (const r of reviews) {
        assert.equal(r.status, 'ok', `${r.harness} 评审应成功,实际 reason=${r.reason}`);
        assert.notEqual(r.harness, 'codex', '评审方不能是生产方自己');
        assert.equal(r.isolated, false, 'read-only 不该分配 worktree');
        assert.ok(r.text && r.text.trim().length > 0, `${r.harness} 应给出评审结论文本`);
      }
      assert.notEqual(reviews[0].harness, reviews[1].harness, '两家必须是不同厂商');
      assert.equal(
        git(repo, ['status', '--short']).trim(),
        '',
        '源仓库必须保持干净(改动只在 worktree 里)',
      );

      const verdicts = reviews.map((r) => `${r.harness}: ${/LGTM/i.test(r.text) ? 'LGTM' : '不 LGTM'}`);
      const agree = new Set(verdicts.map((s) => s.split(': ')[1])).size === 1;
      console.log(`  [三家投票] ${verdicts.join(' | ')}  (一致=${agree})`);

      // 分歧的**理由**才是这项验证的全部价值;只留一行"一致=false"等于把结论扔掉。
      // 落盘到 .scratch/(已 gitignore),供人事后读原文比对谁说得对。
      const out = join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '.scratch',
        `live-review-${Date.now()}`,
      );
      await mkdir(out, { recursive: true });
      await writeFile(join(out, 'producer.diff'), produced.diff, 'utf8');
      for (const r of reviews) await writeFile(join(out, `review-${r.harness}.md`), r.text, 'utf8');
      await writeFile(join(out, 'verdict.txt'), `${verdicts.join('\n')}\n一致=${agree}\n`, 'utf8');
      console.log(`  [产物] ${normalize(out)}`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  },
);