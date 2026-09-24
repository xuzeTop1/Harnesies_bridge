/**
 * 任务账本:宿主重启后,"未知 taskId"必须变成"派发过,进程死了,产出在此"。
 *
 * 为什么单独测:2026-09-23 实测到 Codex 重启后三个 taskId 一律查无此 ID,
 * 调用方因此无法分辨"这个 ID 从没派发过"与"派发过但进程死了、结果丢了" ——
 * 而它正是主脑判断"评议跑完没有"的唯一依据。这条界限靠人工是验不出来的,
 * 必须有用例钉住。测试用**两个 Scheduler 实例**模拟"进程换了、内存清空了"。
 *
 * 索引路径由 LLMS_BRIDGE_HOME 指到临时目录,绝不碰真用户目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'llms-bridge-journal-home-'));
process.env.LLMS_BRIDGE_HOME = home;
process.env.LLMS_BRIDGE_JOURNAL_CAP = '80';

const { Scheduler } = await import('../src/scheduler.ts');

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

/** 桩 worker:不连模型,立即输出一行,并可选地自报一段"产出正文"。 */
function makeStub(opts = {}) {
  const stdout = opts.stdout ?? 'STUB_OUT';
  return {
    id: 'stub',
    tier: 3,
    displayName: 'Stub (无模型)',
    supportedApprovals: ['read-only', 'workspace-write'],
    detect: async () => ({ available: true, version: 'stub-1' }),
    // 写档会走 worktree 分配;这里只测账本,所以让桩任务一律只读,避免动 git。
    plan: () => ({ command: process.execPath, args: ['-e', `console.log(${JSON.stringify(stdout)})`] }),
    createRun(spec, taskId) {
      let text = '';
      return {
        parseLine(line) {
          if (line !== stdout) return [];
          text = opts.resultText ?? '';
          return [
            { taskId, seq: 0, harness: 'stub', tier: 3, type: 'message', at: Date.now(), text: line },
            { taskId, seq: 1, harness: 'stub', tier: 3, type: 'result', at: Date.now(), text: opts.resultText },
          ];
        },
        finalize: () => ({ text, usage: { inputTokens: 7, outputTokens: 3 } }),
      };
    },
  };
}

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-journal-repo-'));
  git(dir, ['init', '-q']);
  await writeFile(join(dir, 'seed.txt'), 'seed\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return dir;
}

const specFor = (cwd, taskId, prompt = 'PROMPT_BODY') => ({
  taskId,
  harness: 'stub',
  prompt,
  cwd,
  approval: 'read-only',
  budget: { maxWallMs: 30_000 },
  session: { mode: 'fresh' },
});

test('派发即落盘:账本里有 spec 摘要、正文、状态与用量', async () => {
  const repo = await makeRepo();
  try {
    const scheduler = new Scheduler([makeStub({ resultText: 'RESULT_BODY' })]);
    await scheduler.dispatch(specFor(repo, 't-basic'));
    await scheduler.idle();

    const file = join(repo, '.llms-bridge', 'tasks', 't-basic.json');
    assert.ok(existsSync(file), '派发后账本必须存在');
    const record = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(record.taskId, 't-basic');
    assert.equal(record.harness, 'stub');
    assert.equal(record.approval, 'read-only');
    assert.equal(record.status, 'ok');
    assert.equal(record.prompt, 'PROMPT_BODY', '题目正文要留下,否则进程死了连派发过什么都不知道');
    assert.equal(record.text, 'RESULT_BODY', '产出正文要留下 —— 这是"重启后读回结果"的全部意义');
    assert.deepEqual(record.usage, { inputTokens: 7, outputTokens: 3 });
    assert.equal(typeof record.endedAt, 'number');
    assert.equal(record.requestedCwd, repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('进程消失:新的 Scheduler(空内存)仍能查到这个任务并读回产出', async () => {
  const repo = await makeRepo();
  try {
    const before = new Scheduler([makeStub({ resultText: 'SURVIVED_RESTART' })]);
    await before.dispatch(specFor(repo, 't-survive'));
    await before.idle();

    // 换一个实例 = 宿主重启后那个空内存的新桥进程。
    const after = new Scheduler([makeStub()]);
    const snap = after.poll('t-survive');
    assert.equal(snap.fromJournal, true, '必须标明这是账本里的,不是本进程的活任务');
    assert.equal(snap.taskId, 't-survive');
    assert.equal(snap.status, 'ok');
    assert.match(snap.journalPath ?? '', /t-survive\.json$/);

    const result = await after.collect('t-survive');
    assert.equal(result.text, 'SURVIVED_RESTART', '产出正文必须能读回来');
    assert.equal(result.fromJournal, true);
    assert.equal(result.usage?.inputTokens, 7);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('停在 running 的记录:判为中断,且不许让调用方无限轮询', async () => {
  const repo = await makeRepo();
  try {
    // 用真实派发把索引写出来(这步是 recordDispatch 干的),再把记录改回 running ——
    // 那正是"进程在写终态之前被杀"时磁盘上的样子。手写整个文件会绕过索引,测不到真路径。
    const before = new Scheduler([makeStub({ resultText: 'R' })]);
    await before.dispatch(specFor(repo, 't-dead'));
    await before.idle();

    const file = join(repo, '.llms-bridge', 'tasks', 't-dead.json');
    const record = JSON.parse(await readFile(file, 'utf8'));
    delete record.endedAt;
    delete record.text;
    delete record.usage;
    record.status = 'running';
    await writeFile(file, JSON.stringify(record), 'utf8');

    const after = new Scheduler([makeStub()]);
    const snap = after.poll('t-dead');
    assert.equal(snap.finished, true, '回 finished=false 会让调用方一直轮询一个已不存在的进程');
    assert.equal(snap.status, 'failed');
    assert.match(snap.reason ?? '', /桥进程已经消失/);
    assert.equal(snap.eventCount, 0, '事件流没落盘,不许假装有历史');

    const result = await after.collect('t-dead');
    assert.equal(result.status, 'failed');
    assert.equal(result.text, undefined, '没产出就是没产出,不能编');
    assert.match(result.reason ?? '', /不代表任务失败/);
    assert.equal(result.endedAt, undefined, '没人观测到结束,就不许给一个"结束时间"(拿 startedAt 顶替更糟)');
    assert.equal(typeof result.startedAt, 'number', '开始时间是确定的,必须给');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('真的查无此 ID 时,措辞必须与"进程死了"区分开', async () => {
  const scheduler = new Scheduler([makeStub()]);
  assert.throws(() => scheduler.poll('t-typo-xyz'), /账本里都没有它/);
  assert.throws(() => scheduler.events('t-typo-xyz'), /账本里都没有它/);
  await assert.rejects(() => scheduler.collect('t-typo-xyz'), /账本里都没有它/);
});

test('账本存在但事件流没有:events() 要说清,而不是回空数组', async () => {
  const repo = await makeRepo();
  try {
    const before = new Scheduler([makeStub({ resultText: 'X' })]);
    await before.dispatch(specFor(repo, 't-noev'));
    await before.idle();

    const after = new Scheduler([makeStub()]);
    assert.throws(() => after.events('t-noev'), /无法回放/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('超长正文截断并标记,不静默丢内容', async () => {
  const repo = await makeRepo();
  try {
    const longPrompt = 'P'.repeat(500);
    const scheduler = new Scheduler([makeStub({ resultText: 'R'.repeat(500) })]);
    await scheduler.dispatch(specFor(repo, 't-cut', longPrompt));
    await scheduler.idle();

    const record = JSON.parse(await readFile(join(repo, '.llms-bridge', 'tasks', 't-cut.json'), 'utf8'));
    assert.equal(record.promptTruncated, true);
    assert.equal(record.textTruncated, true);
    assert.ok(record.prompt.length < longPrompt.length, '必须真的截断');
    assert.match(record.prompt, /账本已截断/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('只读任务的账本不许出现在 git status 里(靠 .git/info/exclude)', async () => {
  const repo = await makeRepo();
  try {
    const scheduler = new Scheduler([makeStub()]);
    await scheduler.dispatch(specFor(repo, 't-clean'));
    await scheduler.idle();

    assert.ok(existsSync(join(repo, '.llms-bridge', 'tasks', 't-clean.json')), '账本应已落盘');
    const status = git(repo, ['status', '--porcelain']);
    assert.equal(status.trim(), '', `账本目录污染了工作区:${status}`);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
