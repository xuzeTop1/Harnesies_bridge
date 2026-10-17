/**
 * Regression tests (2026-10-16) for defects reproduced on macOS before the fix:
 *  - a 1.2 MB prompt crashed the whole bridge (`spawn E2BIG` became an unhandled rejection);
 *  - a read-only dispatch to a directory without write permission crashed it (EACCES thrown inside
 *    the stdout handler);
 *  - on POSIX the wall-clock timeout killed only the direct child: a grandchild kept running and the
 *    task "timed out" after 8.0 s with a 1 s budget;
 *  - there was no way to cancel a task.
 * Stub workers only (node / sh); no model, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isAlive, sleep, spec, stubAdapter, tempDir } from './helpers.mjs';

process.env.LLMS_BRIDGE_HOME = join(tmpdir(), `llms-bridge-test-home-${process.pid}`);
const { Scheduler } = await import('../src/scheduler.ts');

const posix = process.platform !== 'win32';

test('超长 prompt(spawn 同步抛 E2BIG)只让该任务失败,桥进程不崩', async () => {
  const dir = await tempDir('llms-bridge-e2big-');
  try {
    const s = new Scheduler([stubAdapter({ plan: (sp) => ({ command: process.execPath, args: ['-e', '0', sp.prompt] }) })]);
    await s.dispatch(spec(dir, 'e2big', { prompt: 'x'.repeat(1_200_000) }));
    const r = await s.collect('e2big');
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /没能启动|E2BIG|ENAMETOOLONG/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('只读任务的 cwd 不可写:任务照常结束,事件写盘失败不杀桥', { skip: posix ? false : 'POSIX permissions' }, async () => {
  const dir = await tempDir('llms-bridge-ro-');
  await chmod(dir, 0o555);
  try {
    const s = new Scheduler([stubAdapter({ plan: () => ({ command: process.execPath, args: ['-e', 'console.log("hello")'] }) })]);
    await s.dispatch(spec(dir, 'locked'));
    const r = await s.collect('locked');
    assert.equal(r.status, 'ok', r.reason);
    assert.ok(s.events('locked').some((e) => e.text === 'hello'), '事件仍在内存里,可以交回主脑');
  } finally {
    await chmod(dir, 0o755);
    await rm(dir, { recursive: true, force: true });
  }
});

test('解析器对某一行抛错:记一条 error 事件,任务继续并收尾', async () => {
  const dir = await tempDir('llms-bridge-parse-');
  try {
    const s = new Scheduler([
      stubAdapter({
        throwOn: 'BAD',
        plan: () => ({ command: process.execPath, args: ['-e', 'console.log("ok1");console.log("BAD");console.log("ok2")'] }),
      }),
    ]);
    await s.dispatch(spec(dir, 'parse'));
    const r = await s.collect('parse');
    const ev = s.events('parse');
    assert.ok(ev.some((e) => e.type === 'error' && /parser error/.test(e.text)));
    assert.ok(ev.some((e) => e.text === 'ok2'), '出错行之后的输出照样处理');
    assert.match(r.reason ?? '', /解析出错/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('超时结束整棵进程树:孙进程被杀,任务在预算附近结束', { skip: posix ? false : 'POSIX process groups' }, async () => {
  const dir = await tempDir('llms-bridge-tree-');
  try {
    const s = new Scheduler([
      stubAdapter({ plan: () => ({ command: '/bin/sh', args: ['-c', 'sleep 30 & echo "$!"; wait'] }) }),
    ]);
    const t0 = Date.now();
    await s.dispatch(spec(dir, 'tree', { budget: { maxWallMs: 800 } }));
    const r = await s.collect('tree');
    const elapsed = Date.now() - t0;
    const grandchild = Number(s.events('tree').find((e) => /^\d+$/.test(e.text ?? ''))?.text);
    assert.equal(r.status, 'timeout');
    assert.ok(elapsed < 5_000, `任务应在预算 + 宽限内结束,实际 ${elapsed} ms(修复前 = 孙进程自己退出的时刻)`);
    assert.ok(grandchild > 0, '桩应打印孙进程 pid');
    await sleep(200);
    assert.equal(isAlive(grandchild), false, `孙进程 ${grandchild} 应已被结束`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('worker 正常退出但留下占着 stdout 的后台进程:不再一直等,并结束它', { skip: posix ? false : 'POSIX process groups' }, async () => {
  const dir = await tempDir('llms-bridge-left-');
  try {
    const s = new Scheduler([
      stubAdapter({ plan: () => ({ command: '/bin/sh', args: ['-c', '(sleep 30 & echo "$!") ; echo done'] }) }),
    ]);
    const t0 = Date.now();
    await s.dispatch(spec(dir, 'left', { budget: { maxWallMs: 60_000 } }));
    const r = await s.collect('left');
    const leftover = Number(s.events('left').find((e) => /^\d+$/.test(e.text ?? ''))?.text);
    assert.ok(Date.now() - t0 < 5_000, '不能等到后台进程自己退出');
    assert.equal(r.status, 'ok');
    assert.ok(s.events('left').some((e) => /占着 stdout/.test(e.text ?? '')), '要说明为什么提前停止读取');
    await sleep(200);
    assert.equal(isAlive(leftover), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancel():结束整棵进程树,状态为 cancelled 并带原因', async () => {
  const dir = await tempDir('llms-bridge-cancel-');
  try {
    const script = posix ? ['-c', 'sleep 30 & echo "$!"; wait'] : null;
    const s = new Scheduler([
      stubAdapter({
        plan: () =>
          script
            ? { command: '/bin/sh', args: script }
            : { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'] },
      }),
    ]);
    await s.dispatch(spec(dir, 'cxl', { budget: { maxWallMs: 60_000 } }));
    await sleep(400);
    assert.equal(s.cancel('cxl', 'user changed their mind'), true);
    const t0 = Date.now();
    const r = await s.collect('cxl');
    assert.ok(Date.now() - t0 < 5_000);
    assert.equal(r.status, 'cancelled');
    assert.equal(r.reason, 'user changed their mind');
    if (posix) {
      const grandchild = Number(s.events('cxl').find((e) => /^\d+$/.test(e.text ?? ''))?.text);
      await sleep(200);
      assert.equal(isAlive(grandchild), false);
    }
    assert.equal(s.cancel('cxl'), false, '已结束的任务再取消返回 false');
    assert.throws(() => s.cancel('no-such-task'), /未知 taskId/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('不存在的 cwd 当场拒绝,而不是被账本 mkdir -p 凭空建出来', async () => {
  const s = new Scheduler([stubAdapter({ plan: () => ({ command: process.execPath, args: ['-e', '0'] }) })]);
  const missing = join(tmpdir(), `llms-bridge-missing-${process.pid}`, 'nope');
  await assert.rejects(() => s.dispatch(spec(missing, 'missing')), /不存在或不是目录/);
});
