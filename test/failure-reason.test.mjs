/**
 * 失败原因必须来自**对方的原话**,而不是一句我们编的通用句子。
 *
 * 为什么单独测:2026-09-24 一次 opencode 派发失败只回"退出码 1 且无文本输出" ——
 * 真因(HTTP 401 Invalid API key)其实已经被对方写在 stdout 事件里,而 `stderrTail`
 * 更是**采集了却全仓没人用**。这两处都会让"一句话能说清的事"变成一轮白排查,
 * 而失败原因正是调用方决定"重试 / 换通道 / 放弃"的唯一依据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LLMS_BRIDGE_HOME = join(tmpdir(), `llms-bridge-test-home-${process.pid}`);

const { Scheduler } = await import('../src/scheduler.ts');

/**
 * 任务 cwd 用临时目录:账本记录与心跳**按任务 cwd** 落盘,
 * 用 process.cwd() 会把测试垃圾写进本仓库的 .llms-bridge/tasks/。
 * 重定向 LLMS_BRIDGE_HOME 只挡住索引,挡不住这个。
 */

/** 桩:退出码非零,且把原因写在 stderr 上。 */
function makeStderrStub() {
  return {
    id: 'stub-stderr',
    tier: 3,
    displayName: 'Stub (stderr)',
    supportedApprovals: ['read-only'],
    detect: async () => ({ available: true, version: 'stub-1' }),
    plan: () => ({
      command: process.execPath,
      args: ['-e', "process.stderr.write('VENDOR_SAYS: no credit left\\n'); process.exit(3)"],
    }),
    createRun: () => ({ parseLine: () => [], finalize: () => ({ text: undefined }) }),
  };
}

test('非零退出:把 stderr 原话带进 reason,而不是只说"退出码 N"', async () => {
  const scheduler = new Scheduler([makeStderrStub()]);
  const cwd = await mkdtemp(join(tmpdir(), 'llms-bridge-fr-'));
  const ack = await scheduler.dispatch({
    taskId: 'stderr-1',
    harness: 'stub-stderr',
    prompt: 'x',
    cwd,
    approval: 'read-only',
    budget: { maxWallMs: 20_000 },
    session: { mode: 'fresh' },
  });
  const result = await scheduler.collect(ack.taskId);
  await rm(cwd, { recursive: true, force: true });

  assert.equal(result.status, 'failed');
  assert.equal(result.endedAt !== undefined, true, '这是桥自己观测到的结束,结束时间必须有');
  assert.match(result.reason ?? '', /VENDOR_SAYS: no credit left/, 'stderr 原话必须转达');
  assert.match(result.reason ?? '', /退出码 3/, '我们自己的判断也要保留');
});

test('成功时不该被 stderr 噪音污染(有的 CLI 正常跑也会往 stderr 写)', async () => {
  const noisy = {
    ...makeStderrStub(),
    id: 'stub-noisy',
    plan: () => ({
      command: process.execPath,
      args: ['-e', "process.stderr.write('just a warning\\n'); console.log('done')"],
    }),
    createRun: () => ({ parseLine: () => [], finalize: () => ({ text: 'RESULT' }) }),
  };
  const scheduler = new Scheduler([noisy]);
  const cwd = await mkdtemp(join(tmpdir(), 'llms-bridge-fr-'));
  const ack = await scheduler.dispatch({
    taskId: 'stderr-2',
    harness: 'stub-noisy',
    prompt: 'x',
    cwd,
    approval: 'read-only',
    budget: { maxWallMs: 20_000 },
    session: { mode: 'fresh' },
  });
  const result = await scheduler.collect(ack.taskId);
  await rm(cwd, { recursive: true, force: true });

  assert.equal(result.status, 'ok');
  assert.equal(result.reason, undefined, '成功任务不该带 reason');
});
