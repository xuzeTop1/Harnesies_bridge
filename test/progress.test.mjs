/**
 * 心跳与判活的用例。
 *
 * 要钉的是这件事:**面板宁可什么都不显示,也不能把已经死了的任务显示成"在跑"**。
 * 账本的 status 在进程被杀时会永远停在 running(这正是当初建账本的原因),
 * 所以"在跑"这个结论只能由心跳的新鲜度支撑,而不能由 status 支撑。
 *
 * 零模型额度:全程 node 子进程当桩 worker。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LLMS_BRIDGE_HOME = join(tmpdir(), `llms-bridge-test-home-${process.pid}`);
// 心跳 3 秒一跳太慢,用例里压到 400ms;判活阈值同步缩小,否则测不出"过期"。
process.env.LLMS_BRIDGE_BEAT_MS = '400';
process.env.LLMS_BRIDGE_BEAT_STALE_MS = '1500';

const { Scheduler } = await import('../src/scheduler.ts');
const { judgeLiveness, readTaskBeat, BEAT_STALE_MS } = await import('../src/journal.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 桩 worker 的形态:
 * @param emitLines 每 300ms 打印一行(共 N 行)—— 让"最后一条事件"持续往前推,
 *                  用例就不用赌进程启动延迟,否则同一秒里 running/awaiting 两种答案都对。
 * @param idleMs   只睡觉不输出,用来造"活着但没产出"
 */
function makeAdapter({ emitLines = 0, idleMs = 0 }) {
  return {
    id: 'stub',
    tier: 3,
    displayName: 'Stub worker',
    supportedApprovals: ['read-only'],
    detect: async () => ({ available: true, version: 'stub-1' }),
    plan() {
      const script =
        `const s = (ms) => new Promise(r => setTimeout(r, ms));\n` +
        `for (let i = 0; i < ${emitLines}; i++) { console.log('EVT' + i); await s(300); }\n` +
        `await s(${idleMs});`;
      return { command: process.execPath, args: ['--input-type=module', '-e', script] };
    },
    createRun(spec, taskId) {
      let n = 0;
      return {
        parseLine: (line) =>
          line.startsWith('EVT')
            ? [{ taskId, seq: n++, harness: 'stub', tier: 3, type: 'message', at: Date.now(), text: line }]
            : [],
        finalize: () => ({ text: 'done' }),
      };
    },
  };
}

async function withRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-beat-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const dispatch = (scheduler, cwd, taskId) =>
  scheduler.dispatch({
    taskId,
    harness: 'stub',
    prompt: 'p',
    cwd,
    approval: 'read-only',
    budget: { maxWallMs: 30_000 },
    session: { mode: 'fresh' },
  });

test('任务活着但在等输出:心跳新鲜,判成 awaiting_output 而不是"在跑"', async () => {
  await withRepo(async (dir) => {
    const scheduler = new Scheduler([makeAdapter({ emitLines: 0, idleMs: 3000 })]);
    const { taskId } = await dispatch(scheduler, dir, crypto.randomUUID());
    await sleep(1200);
    const snap = scheduler.poll(taskId);
    assert.equal(snap.finished, false, '桩任务应还在跑');
    assert.equal(snap.progress.events, 0);
    assert.equal(snap.progress.liveness, 'awaiting_output');
    assert.match(snap.progress.note, /桥还在看着它/);
    await scheduler.collect(taskId);
  });
});

test('任务在出事件:判成 running,且带最后一条事件的类型', async () => {
  await withRepo(async (dir) => {
    const scheduler = new Scheduler([makeAdapter({ emitLines: 8 })]);
    const { taskId } = await dispatch(scheduler, dir, crypto.randomUUID());
    await sleep(1000);
    const p = scheduler.poll(taskId).progress;
    assert.equal(p.liveness, 'running', `note=${p.note}`);
    assert.equal(p.lastType, 'message');
    assert.ok(p.events >= 1);
    await scheduler.collect(taskId);
  });
});

/**
 * 最关键的一条:任务结束后心跳必须**停**。
 * 定时器漏停的话,一个结束的任务会一直跳心跳,面板就会永远显示它在跑。
 */
test('任务结束后心跳必须停止增长', async () => {
  await withRepo(async (dir) => {
    const scheduler = new Scheduler([makeAdapter({ emitLines: 1 })]);
    const { taskId } = await dispatch(scheduler, dir, crypto.randomUUID());
    const result = await scheduler.collect(taskId);
    assert.equal(result.status, 'ok', `reason=${result.reason}`);
    const first = await readTaskBeat(dir, taskId);
    await sleep(1600); // 跨过好几个心跳周期
    const later = await readTaskBeat(dir, taskId);
    assert.equal(later.beatAt, first.beatAt, `心跳没停:${first.beatAt} → ${later.beatAt}`);
    assert.equal(scheduler.poll(taskId).progress.liveness, 'finished');
  });
});

test('status 停在 running 但心跳断了:必须判成 heartbeat_lost,不能算在跑', async () => {
  await withRepo(async (dir) => {
    const scheduler = new Scheduler([makeAdapter({ emitLines: 2 })]);
    const taskId = crypto.randomUUID();
    await dispatch(scheduler, dir, taskId);
    await scheduler.collect(taskId);
    // 手工把记录改回 running,并把心跳写到过期之前 —— 模拟"桥进程被杀,账本停在 running"。
    const recPath = join(dir, '.llms-bridge', 'tasks', `${taskId}.json`);
    const rec = JSON.parse(await readFile(recPath, 'utf8'));
    rec.status = 'running';
    await writeFile(recPath, JSON.stringify(rec, null, 2), 'utf8');
    const beatPath = join(dir, '.llms-bridge', 'tasks', `${taskId}.beat.json`);
    const beat = JSON.parse(await readFile(beatPath, 'utf8'));
    beat.beatAt = Date.now() - BEAT_STALE_MS - 5000;
    await writeFile(beatPath, JSON.stringify(beat), 'utf8');

    // 换一个**新的** Scheduler 再 poll:模拟"桥进程重启,内存里没这个任务了",
    // 才会走账本兜底那条路。留在原进程里 poll 会优先信内存态 —— 那是对的,
    // 内存里的终态本来就该盖过一份被改坏的盘上记录。
    const restarted = new Scheduler([makeAdapter({ emitLines: 1 })]);
    const p = restarted.poll(taskId).progress;
    assert.equal(p.liveness, 'heartbeat_lost');
    assert.match(p.note, /别按"在跑"处理/);
  });
});

test('从没跳过心跳的 running 记录:如实说"分不开",不许猜一个结论', () => {
  const v = judgeLiveness({ status: 'running', startedAt: Date.now() - 60_000 }, null);
  assert.equal(v.state, 'heartbeat_lost');
  assert.match(v.note, /分不开/);
});

test('心跳文件不参与账本索引,坏掉也不该影响 poll', async () => {
  await withRepo(async (dir) => {
    const scheduler = new Scheduler([makeAdapter({ emitLines: 1 })]);
    const { taskId } = await dispatch(scheduler, dir, crypto.randomUUID());
    await scheduler.collect(taskId);
    await writeFile(join(dir, '.llms-bridge', 'tasks', `${taskId}.beat.json`), '{ 坏 JSON', 'utf8');
    const p = scheduler.poll(taskId).progress;
    assert.equal(p.liveness, 'finished', '读不到心跳时终态任务仍应给出正确结论');
  });
});
