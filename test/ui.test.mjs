/**
 * 只读面板的用例。零模型额度:桩 worker + 临时账本目录。
 *
 * 钉的是四条边界而不只是"页面画得对":
 *  ① 只监听回环(放开就是把本机 prompt 与模型原文交给局域网);
 *  ② 端口临时分配(AGENTS.md 禁止硬编码);
 *  ③ 没有任何写接口;
 *  ④ 汇总不许把"没自报用量"算成"用了 0"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = join(tmpdir(), `llms-bridge-ui-test-${process.pid}`);
process.env.LLMS_BRIDGE_HOME = HOME;
process.env.LLMS_BRIDGE_BEAT_MS = '200';

const { startUi, buildState } = await import('../src/ui.ts');
const { Scheduler } = await import('../src/scheduler.ts');

function makeAdapter() {
  return {
    id: 'stub',
    tier: 3,
    displayName: 'Stub worker',
    supportedApprovals: ['read-only'],
    detect: async () => ({ available: true, version: 'stub-1' }),
    plan: () => ({ command: process.execPath, args: ['-e', "console.log('hi')"] }),
    createRun: (spec, taskId) => ({
      parseLine: (line) =>
        line === 'hi' ? [{ taskId, seq: 0, harness: 'stub', tier: 3, type: 'message', at: Date.now(), text: 'hi' }] : [],
      finalize: () => ({ text: '面板测试产出', usage: { inputTokens: 120, outputTokens: 30 } }),
    }),
  };
}

async function seededRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-ui-'));
  const scheduler = new Scheduler([makeAdapter()]);
  const ack = await scheduler.dispatch({
    taskId: crypto.randomUUID(),
    harness: 'stub',
    prompt: '给面板用的一条',
    cwd: dir,
    approval: 'read-only',
    budget: { maxWallMs: 30_000 },
    session: { mode: 'fresh' },
  });
  await scheduler.collect(ack.taskId);
  return dir;
}

test('拒绝监听非回环地址', async () => {
  await assert.rejects(() => startUi({ host: '0.0.0.0' }), /只允许监听回环/);
});

test('端口由系统分配,两次启动不会撞同一个号', async () => {
  const a = await startUi();
  const b = await startUi();
  try {
    assert.ok(a.port > 0 && b.port > 0);
    assert.notEqual(a.port, b.port, `两次都拿到 ${a.port} —— 那不是临时端口`);
    assert.match(a.url, /^http:\/\/127\.0\.0\.1:\d+\/$/, `url=${a.url}`);
  } finally {
    await a.close();
    await b.close();
  }
});

test('面板没有写接口:POST 一律 405', async () => {
  const ui = await startUi();
  try {
    const res = await fetch(`${ui.url}api/state`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 405);
    const text = await res.text();
    assert.match(text, /只读/);
  } finally {
    await ui.close();
  }
});

test('/ 返回页面骨架,/api/state 返回结构化账本,未知路径 404', async () => {
  const ui = await startUi();
  try {
    const page = await fetch(ui.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await page.text(), /只读观测面/);

    const api = await fetch(`${ui.url}api/state`);
    assert.equal(api.status, 200);
    assert.match(api.headers.get('cache-control') ?? '', /no-store/, '缓存快照会把"已失联"显示成"在跑"');
    assert.deepEqual((await api.json()).totals.all >= 0, true);

    assert.equal((await fetch(`${ui.url}nope`)).status, 404);
  } finally {
    await ui.close();
  }
});

test('跑完一条桩任务后面板能汇总到它,并把用量与档位一起带出', async () => {
  await seededRepo();
  const s = buildState();
  assert.ok(s.totals.finished >= 1, JSON.stringify(s.totals));
  const u = s.byHarness.find((x) => x.harness === 'stub');
  assert.ok(u, `没有 stub:${JSON.stringify(s.byHarness)}`);
  assert.equal(u.ok, 1);
  assert.equal(u.tokens, 150, 'in+out 应合计');
  assert.equal(u.unreported, 0);
  const task = s.tasks.find((t) => t.harness === 'stub');
  assert.equal(task.approval, 'read-only');
  assert.equal(task.isolated, false, '只读档不该被显示成隔离了');
  assert.equal(task.liveness, 'finished');
  assert.match(task.text ?? '', /面板测试产出/);
});

test('没自报用量的任务计入 unreported,不算"用了 0 token 的成功任务"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-ui-'));
  const scheduler = new Scheduler([{
    ...makeAdapter(),
    id: 'quiet',
    createRun: (spec, taskId) => ({
      parseLine: () => [],
      finalize: () => ({ text: '没有 usage' }),
    }),
  }]);
  await scheduler.dispatch({
    taskId: crypto.randomUUID(),
    harness: 'quiet',
    prompt: 'p',
    cwd: dir,
    approval: 'read-only',
    budget: { maxWallMs: 30_000 },
    session: { mode: 'fresh' },
  }).then((a) => scheduler.collect(a.taskId));
  try {
    const u = buildState().byHarness.find((x) => x.harness === 'quiet');
    assert.equal(u.tasks, 1);
    assert.equal(u.tokens, 0);
    assert.equal(u.unreported, 1, '必须把"它没报"和"它没用"分开');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
