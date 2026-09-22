/**
 * 出口自报(egress)的用例。全程零额度:只读临时 fixture 文件,不启动任何模型。
 *
 * 为什么必须有用例:这道闸门管的是"用户磁盘上的内容被发往哪个主机"。
 * 它最容易被改坏的方式恰好是"顺手多打印一点上下文方便调试"——那正是泄凭证的形状。
 * 所以除了分类正确,还**必须断言哨兵值不出现在任何返回字段里**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { claudeEgress, proxyCluesFromEnv } = await import('../src/egress.ts');
const { Scheduler } = await import('../src/scheduler.ts');

/** 假 token:任何一次输出里出现它都算失败。 */
const SENTINEL = 'sk-ANTHROPIC-SENTINEL-DO-NOT-LEAK';

async function fixtureSettings(env) {
  const dir = await mkdtemp(join(tmpdir(), 'egress-'));
  const file = join(dir, 'settings.json');
  await writeFile(file, JSON.stringify({ env: { ...env, ANTHROPIC_AUTH_TOKEN: SENTINEL } }), 'utf8');
  return { dir, file };
}

test('settings.json 里的第三方端点:报主机、判为非原生、且不吐凭证', async () => {
  const { dir, file } = await fixtureSettings({
    ANTHROPIC_BASE_URL: 'https://llm-abc123.cn-beijing.maas.aliyuncs.com/compatible',
  });
  try {
    const r = await claudeEgress({ settingsPath: file, env: {}, readProxyClues: false });
    assert.equal(r.endpointHost, 'llm-abc123.cn-beijing.maas.aliyuncs.com');
    assert.equal(r.nativeAnthropic, false);
    assert.match(r.source, /settings\.json/);
    // 路径段(/compatible)也不许带出去 —— 里面可能藏东西
    assert.ok(!JSON.stringify(r).includes('/compatible'));
    assert.ok(!JSON.stringify(r).includes(SENTINEL));
    assert.match(r.notice, /第三方端点/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('进程 env 优先于 settings.json,并能判出原生 Anthropic', async () => {
  const { dir, file } = await fixtureSettings({ ANTHROPIC_BASE_URL: 'https://relay.example.com' });
  try {
    const r = await claudeEgress({
      settingsPath: file,
      env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
      readProxyClues: false,
    });
    assert.equal(r.endpointHost, 'api.anthropic.com');
    assert.equal(r.nativeAnthropic, true);
    assert.match(r.source, /进程 env/);
    assert.match(r.notice, /原生 Anthropic/);
    assert.ok(!JSON.stringify(r).includes(SENTINEL));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('没配端点 = 按默认原生处理,并说明来源是默认值(不许假装读到了配置)', async () => {
  const r = await claudeEgress({
    settingsPath: join(tmpdir(), 'egress-不存在', 'settings.json'),
    env: {},
    readProxyClues: false,
  });
  assert.equal(r.nativeAnthropic, true);
  assert.match(r.source, /默认/);
});

test('带账号密码的代理地址会被剥掉,只留主机', () => {
  const joined = proxyCluesFromEnv({ HTTPS_PROXY: 'http://user:ppprrr@127.0.0.1:7897' }).join('|');
  assert.ok(!joined.includes('user'), joined);
  assert.ok(!joined.includes('ppprrr'), joined);
  assert.match(joined, /127\.0\.0\.1:7897/);
  assert.match(joined, /http_proxy 未设置/);
});

/** 桩 harness:验证调度器把出口报告带到 ack / harness_list,以及取不到时的降级。 */
function stubWithEgress(seen, egressImpl) {
  return {
    id: 'stubegress',
    tier: 3,
    displayName: 'Stub',
    supportedApprovals: ['read-only'],
    detect: async () => ({ available: true, version: 'stub-1' }),
    egress: egressImpl,
    plan(spec) {
      return { command: process.execPath, args: ['-e', 'console.log(1)'] };
    },
    createRun(spec, taskId) {
      seen.push(spec);
      return { parseLine: () => [], finalize: () => ({ text: 'done', status: 'ok' }) };
    },
  };
}

/** 等桩任务真跑完:否则子进程会在用例结束后才动,Windows 上报成异步活动错误。 */
async function settle(s, taskId, deadlineMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (s.poll(taskId)?.finished) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`任务 ${taskId} 未在 ${deadlineMs}ms 内结束`);
}

test('派发 ack 带本次出口报告与实际外发字节数', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'egress-task-'));
  const seen = [];
  const s = new Scheduler([
    stubWithEgress(seen, async () => ({
      endpointHost: 'api.anthropic.com',
      nativeAnthropic: true,
      source: 'fixture',
      proxyClues: ['HTTPS_PROXY 未设置'],
      notice: '原生端点',
    })),
  ]);
  try {
    const ack = await s.dispatch({
      taskId: 't1',
      harness: 'stubegress',
      prompt: '中文提示词abc',
      cwd: dir,
      approval: 'read-only',
      budget: { maxWallMs: 60_000 },
      session: { mode: 'fresh' },
    });
    assert.equal(ack.egress.endpointHost, 'api.anthropic.com');
    assert.equal(ack.egress.promptBytes, Buffer.byteLength('中文提示词abc', 'utf8'));
    await settle(s, 't1');
    const [report] = await s.detectAll();
    assert.equal(report.egress.nativeAnthropic, true);
  } finally {
    // 不删临时目录:被派发任务的子进程 cwd 还压在上面,Windows 会 EBUSY。
    // 留在 %TEMP% 无害,比让用例假失败好。
  }
});

test('egress() 抛错不影响可用性,也不许伪造一份报告', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'egress-fail-'));
  const s = new Scheduler([
    stubWithEgress([], async () => {
      throw new Error('配置文件被锁');
    }),
  ]);
  try {
    const ack = await s.dispatch({
      taskId: 't2',
      harness: 'stubegress',
      prompt: 'x',
      cwd: dir,
      approval: 'read-only',
      budget: { maxWallMs: 60_000 },
      session: { mode: 'fresh' },
    });
    assert.ok(ack.taskId);
    assert.equal(ack.egress, undefined);
    await settle(s, 't2');
    const [report] = await s.detectAll();
    assert.equal(report.available, true, '探测不该因为出口自报失败而判不可用');
    assert.equal(report.egress, undefined);
  } finally {
    // 同上:子进程占着 cwd,不删。
  }
});
